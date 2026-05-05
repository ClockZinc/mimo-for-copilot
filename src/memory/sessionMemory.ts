/**
 * Session Memory — 当前会话的状态追踪
 * 复刻 Claude Code 的 Session Memory 系统
 *
 * 维护一个结构化的 markdown 文件，记录当前会话的：
 * - 任务状态
 * - 涉及的文件
 * - 遇到的错误
 * - 关键决策
 *
 * 通过 mimo-v2-pro 定期更新（基于消息计数阈值）
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { RecallModelConfig } from './paths';
import { createTimeoutSignal } from './paths';
import { logger } from '../logger';

/** 会话记忆模板（中文化 header，便于用户阅读） */
const SESSION_MEMORY_TEMPLATE = `# 会话标题
_简短描述性标题，5-10个词_

# 当前状态
_正在做什么？待完成的任务？下一步？_

# 任务描述
_用户要求构建什么？设计决策和上下文_

# 涉及的文件
_重要文件、内容、为什么相关_

# 工作流程
_常用命令、如何解读输出_

# 错误与修正
_遇到的错误及修复方法、失败的方案_

# 经验教训
_什么有效？什么要避免？_

# 关键结果
_用户要求的具体输出_

# 工作日志
_逐步记录尝试和完成的内容_
`;

/** 更新 prompt（复刻 Claude Code 的 session memory update prompt） */
const UPDATE_PROMPT = `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message), update the session notes file.

The file has already been read for you. Here are its current contents:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to update the notes file content below. Make all changes in a single response.

CRITICAL RULES:
- Maintain the exact structure with all sections and headers intact
- NEVER modify or delete section headers (lines starting with '#')
- ONLY update the actual content within each section
- Write DETAILED, INFO-DENSE content - include file paths, function names, error messages, commands
- Keep each section under 200 words
- If a section has no new insights, leave it as-is
- Always update "Current State" to reflect the most recent work

Return the COMPLETE updated file content (including all headers). Return ONLY the markdown content, no other text.`;

/** 触发更新的阈值 */
const UPDATE_INTERVAL_MESSAGES = 10; // 每10条消息更新一次

export class SessionMemory {
	private sessionId: string;
	private memoryPath: string;
	private messageCount = 0;
	private lastUpdateTime = 0;
	private currentContent = '';
	private failedUpdateCount = 0;

	constructor(
		private readonly config: RecallModelConfig,
	) {
		this.sessionId = this.generateSessionId();
		this.memoryPath = path.join(os.homedir(), '.mimo', 'sessions', `${this.sessionId}.md`);
	}

	/**
	 * 初始化：创建会话记忆文件
	 */
	async initialize(): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });

			// 创建文件（如果不存在）
			try {
				await fs.access(this.memoryPath);
				this.currentContent = await fs.readFile(this.memoryPath, 'utf-8');
			} catch {
				await fs.writeFile(this.memoryPath, SESSION_MEMORY_TEMPLATE, 'utf-8');
				this.currentContent = SESSION_MEMORY_TEMPLATE;
			}

			logger.info(`[SessionMemory] Initialized: ${this.memoryPath}`);
		} catch (e) {
			logger.warn('[SessionMemory] Failed to initialize:', e);
		}
	}

	/**
	 * 检查是否应该更新会话记忆
	 */
	shouldUpdate(newMessageCount: number): boolean {
		this.messageCount += newMessageCount;
		// 失败退避：连续失败时增加间隔
		const backoff = Math.min(this.failedUpdateCount * UPDATE_INTERVAL_MESSAGES, 50);
		const sinceLastUpdate = this.messageCount - this.lastUpdateTime;
		return sinceLastUpdate >= (UPDATE_INTERVAL_MESSAGES + backoff);
	}

	/**
	 * 更新会话记忆（使用 agent 模型分析对话）
	 */
	async update(messages: Array<{ role: string; content: string }>): Promise<void> {
		if (messages.length === 0) return;

		try {
			// 构建对话文本
			const conversationText = messages
				.map(m => `${m.role}: ${m.content}`)
				.join('\n\n')
				.substring(0, 8000); // 限制长度

			const updatePrompt = UPDATE_PROMPT.replace('{{currentNotes}}', this.currentContent);

			// 调用 agent 模型更新
			const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify({
					model: this.config.model,
					messages: [
						{ role: 'system', content: updatePrompt },
						{ role: 'user', content: `Conversation:\n${conversationText}` },
					],
					max_tokens: 2000,
					temperature: 0,
				}),
				signal: createTimeoutSignal(15_000),
			});

			if (!response.ok) {
				throw new Error(`Session memory update failed: ${response.status}`);
			}

			const data = await response.json() as any;
			const newContent = data.choices?.[0]?.message?.content;

			if (newContent && newContent.length > 100) {
				// 安全清理：只移除开头和结尾的 code block 标记
				let cleaned = newContent;
				if (cleaned.startsWith('```')) {
					cleaned = cleaned.replace(/^```(?:markdown)?\s*\n?/, '');
				}
				if (cleaned.endsWith('```')) {
					cleaned = cleaned.replace(/\n?```\s*$/, '');
				}
				this.currentContent = cleaned;
				await fs.writeFile(this.memoryPath, cleaned, 'utf-8');
				this.lastUpdateTime = this.messageCount;
				this.failedUpdateCount = 0;  // 成功后重置
				logger.info(`[SessionMemory] Updated (${cleaned.length} chars)`);
			}
		} catch (e) {
			this.failedUpdateCount++;
			logger.warn(`[SessionMemory] Update failed (attempt ${this.failedUpdateCount}):`, e);
		}
	}

	/**
	 * 获取当前会话记忆内容（用于注入上下文）
	 */
	getContent(): string {
		return this.currentContent;
	}

	/**
	 * 获取会话记忆的摘要（用于注入）
	 */
	getSummary(): string {
		if (!this.currentContent || this.currentContent === SESSION_MEMORY_TEMPLATE) {
			return '';
		}

		// 提取 Current State 部分作为摘要
		const stateMatch = this.currentContent.match(/# Current State\n([\s\S]*?)(?=\n#|$)/);
		const taskMatch = this.currentContent.match(/# Task specification\n([\s\S]*?)(?=\n#|$)/);
		const errorsMatch = this.currentContent.match(/# Errors & Corrections\n([\s\S]*?)(?=\n#|$)/);

		const parts: string[] = [];
		if (stateMatch?.[1]?.trim()) parts.push(`Current: ${stateMatch[1].trim()}`);
		if (taskMatch?.[1]?.trim()) parts.push(`Task: ${taskMatch[1].trim()}`);
		if (errorsMatch?.[1]?.trim()) parts.push(`Errors: ${errorsMatch[1].trim()}`);

		return parts.join('\n').substring(0, 1000);
	}

	/**
	 * 清理会话记忆
	 */
	async cleanup(): Promise<void> {
		try {
			await fs.unlink(this.memoryPath);
			logger.info(`[SessionMemory] Cleaned up: ${this.memoryPath}`);
		} catch {
			// 文件可能不存在，忽略
		}
	}

	private generateSessionId(): string {
		const timestamp = Date.now().toString(36);
		const random = crypto.randomBytes(4).toString('hex');
		return `session_${timestamp}_${random}`;
	}
}
