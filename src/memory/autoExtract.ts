/**
 * Auto Extract — 自动记忆提取
 * 复刻 Claude Code 的 extractMemories 系统
 *
 * 分析对话历史，自动提取值得保存的记忆
 * 使用 agent 模型判断哪些信息应该持久化
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { RecallModelConfig } from './paths';
import { createTimeoutSignal } from './paths';
import { formatMemoryManifest, scanMemoryFiles } from './scanner';
import { TYPES_GUIDANCE, WHAT_NOT_TO_SAVE, MEMORY_TYPES, type MemoryType } from './types';
import { logger } from '../logger';

/** 路径安全清洗 — 防止 LLM 返回的文件名导致路径穿越，保留中文 */
function sanitizeFilename(name: string): string {
	return name
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
		.replace(/\.\./g, '_')
		.replace(/^\.+/, '')
		.replace(/\s+/g, '_')
		.substring(0, 64)
		|| 'unnamed';
}

/** 类型校验 */
function isValidMemoryType(t: unknown): t is MemoryType {
	return typeof t === 'string' && (MEMORY_TYPES as readonly string[]).includes(t);
}

/** 提取 prompt（复刻 Claude Code 的 buildExtractAutoOnlyPrompt） */
const EXTRACT_PROMPT = `You are a memory extraction agent. Analyze the conversation below and extract durable memories worth saving.

${TYPES_GUIDANCE}

${WHAT_NOT_TO_SAVE}

IMPORTANT: The conversation may be in Chinese, English, or mixed languages. Correctly understand Chinese semantics, idioms, and abbreviations. Extract memories regardless of language.

## How to save memories

Write each memory to its own file using this frontmatter format:
\`\`\`markdown
---
name: {{memory name}}
description: {{one-line description}}
type: {{user, feedback, project, reference}}
---

{{memory content}}
\`\`\`

## Rules
- Only extract information that is NOT derivable from the current project state
- Do NOT save code patterns, architecture, git history, or file paths
- Do NOT save ephemeral task details or in-progress work
- Do NOT duplicate existing memories (check the manifest below)
- If the user explicitly asks to remember something, save it immediately
- Convert relative dates to absolute dates (e.g., "Thursday" → "2026-05-08")

Return a JSON object:
{
  "shouldSave": true/false,
  "memories": [
    {
      "name": "memory-name",
      "description": "one-line description",
      "type": "user|feedback|project|reference",
      "content": "memory content"
    }
  ]
}

If nothing worth saving, return {"shouldSave": false, "memories": []}.
Return ONLY valid JSON.`;

/** 触发提取的阈值 */
const EXTRACT_INTERVAL_MESSAGES = 15; // 每15条消息检查一次

export class AutoExtract {
	private messageCount = 0;
	private lastExtractTime = 0;
	private isRunning = false;

	constructor(
		private readonly config: RecallModelConfig,
		private readonly memoryDir: string,
	) {}

	/**
	 * 检查是否应该触发提取
	 */
	shouldExtract(newMessageCount: number): boolean {
		this.messageCount += newMessageCount;
		const sinceLastExtract = this.messageCount - this.lastExtractTime;
		return sinceLastExtract >= EXTRACT_INTERVAL_MESSAGES && !this.isRunning;
	}

	/**
	 * 从对话中提取记忆
	 */
	async extract(messages: Array<{ role: string; content: string }>): Promise<number> {
		if (this.isRunning || messages.length === 0) return 0;

		this.isRunning = true;
		const startTime = Date.now();

		try {
			// 1. 获取现有记忆清单（避免重复）
			const existingMemories = await scanMemoryFiles(this.memoryDir);
			const manifest = existingMemories.length > 0
				? `\n\nExisting memories (do NOT duplicate):\n${formatMemoryManifest(existingMemories)}`
				: '';

			// 2. 构建对话文本
			const conversationText = messages
				.map(m => `${m.role}: ${m.content}`)
				.join('\n\n')
				.substring(0, 10000);

			// 3. 调用 agent 模型提取
			const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify({
					model: this.config.model,
					messages: [
						{ role: 'system', content: EXTRACT_PROMPT + manifest },
						{ role: 'user', content: `Conversation to analyze:\n${conversationText}` },
					],
					max_tokens: 2000,
					temperature: 0,
					response_format: { type: 'json_object' },
				}),
				signal: createTimeoutSignal(20_000),
			});

			if (!response.ok) {
				throw new Error(`Extract API error: ${response.status}`);
			}

			const data = await response.json() as any;
			const content = data.choices?.[0]?.message?.content ?? '{}';
			const parsed = JSON.parse(content);

			if (!parsed.shouldSave || !parsed.memories || parsed.memories.length === 0) {
				logger.info('[AutoExtract] No memories to save');
				return 0;
			}

			// 4. 保存提取的记忆
			let savedCount = 0;
			await fs.mkdir(this.memoryDir, { recursive: true });

			for (const mem of parsed.memories) {
				// 校验类型
				if (!isValidMemoryType(mem.type)) {
					logger.warn(`[AutoExtract] Invalid memory type: ${mem.type}, skipping`);
					continue;
				}
				try {
					const safeName = sanitizeFilename(mem.name || 'unnamed');
					const filename = `${mem.type}_${safeName}.md`;
					const filePath = path.join(this.memoryDir, filename);

					const fileContent = [
						'---',
						`name: ${mem.name}`,
						`description: ${mem.description}`,
						`type: ${mem.type}`,
						'---',
						'',
						mem.content,
					].join('\n');

					await fs.writeFile(filePath, fileContent, 'utf-8');

					// 更新 MEMORY.md 索引
					await this.updateIndex(filename, mem.description);

					savedCount++;
					logger.info(`[AutoExtract] Saved: ${filename}`);
				} catch (e) {
					logger.warn(`[AutoExtract] Failed to save memory:`, e);
				}
			}

			this.lastExtractTime = this.messageCount;
			const elapsed = Date.now() - startTime;
			logger.info(`[AutoExtract] Extracted ${savedCount} memories in ${elapsed}ms`);

			return savedCount;
		} catch (e) {
			logger.warn('[AutoExtract] Extraction failed:', e);
			return 0;
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * 更新 MEMORY.md 索引
	 */
	private async updateIndex(filename: string, description: string): Promise<void> {
		const indexPath = path.join(this.memoryDir, 'MEMORY.md');
		let indexContent = '';

		try {
			indexContent = await fs.readFile(indexPath, 'utf-8');
		} catch {
			indexContent = '# Memory Index\n\n';
		}

		const entry = `- [${filename.replace('.md', '')}](${filename}) — ${description}`;
		const lines = indexContent.split('\n');
		const existingIdx = lines.findIndex(l => l.includes(`](${filename})`));

		if (existingIdx >= 0) {
			lines[existingIdx] = entry;
		} else {
			lines.push(entry);
		}

		await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');
	}
}
