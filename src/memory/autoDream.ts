/**
 * Auto Dream — 自动记忆整理
 * 复刻 Claude Code 的 Auto Dream 系统
 *
 * 定期扫描所有记忆，合并重复、删除过时、优化结构
 * 通过门控机制控制频率（时间 + 会话数）
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RecallModelConfig } from './paths';
import { createTimeoutSignal } from './paths';
import { scanMemoryFiles, memoryAge } from './scanner';
import type { MemoryHeader } from './types';
import { logger } from '../logger';

/** 整理 prompt */
const DREAM_PROMPT = `You are a memory curator. Analyze the memories below and identify:
1. Duplicates: overlapping content to merge
2. Stale: outdated memories to remove or update
3. Contradictions: memories that conflict

Return JSON: {"actions": [...], "summary": "..."}
Each action: {"action": "merge|delete|update", "files": [...], "reason": "...", "suggestion": "..."}
If no actions needed: {"actions": [], "summary": "All memories look good"}
Return ONLY valid JSON. Understand Chinese and English content equally.`;

/** 门控配置 */
interface DreamGateConfig {
	minTimeInterval: number;
	minSessionCount: number;
}

/** 从 VS Code 配置读取门控参数 */
function getDreamGateConfig(): DreamGateConfig {
	const config = vscode.workspace.getConfiguration('mimo-copilot');
	return {
		minTimeInterval: (config.get<number>('memory.dreamIntervalHours', 24)) * 60 * 60 * 1000,
		minSessionCount: config.get<number>('memory.dreamMinSessions', 5),
	};
}

export class AutoDream {
	private lastDreamTime = 0;
	private sessionCount = 0;
	private isRunning = false;
	private gateConfig: DreamGateConfig;

	constructor(
		private readonly config: RecallModelConfig,
		private readonly memoryDirs: string[],
	) {
		this.gateConfig = getDreamGateConfig();
	}

	/**
	 * 记录新会话（用于门控判断）
	 */
	recordSession(): void {
		this.sessionCount++;
	}

	/**
	 * 检查是否应该触发整理
	 */
	shouldDream(): boolean {
		if (this.isRunning) return false;

		// 每次检查时重新读取配置（支持热更新）
		this.gateConfig = getDreamGateConfig();

		const now = Date.now();
		const timeSinceLastDream = now - this.lastDreamTime;

		return (
			timeSinceLastDream >= this.gateConfig.minTimeInterval &&
			this.sessionCount >= this.gateConfig.minSessionCount
		);
	}

	/**
	 * 执行自动整理
	 */
	async dream(): Promise<{ actions: number; summary: string }> {
		if (this.isRunning) {
			return { actions: 0, summary: 'Already running' };
		}

		this.isRunning = true;
		const startTime = Date.now();

		try {
			// 1. 扫描所有记忆目录
			const allMemories: MemoryHeader[] = [];
			for (const dir of this.memoryDirs) {
				const memories = await scanMemoryFiles(dir);
				allMemories.push(...memories);
			}

			if (allMemories.length < 2) {
				return { actions: 0, summary: 'Not enough memories to analyze' };
			}

			// 2. 构建记忆清单
			const manifest = allMemories.map(m => {
				const age = memoryAge(m.mtimeMs);
				return `- [${m.type ?? '?'}] ${m.filename} (${age}): ${m.description ?? 'no description'}`;
			}).join('\n');

			// 3. 调用 agent 模型分析
			const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify({
					model: this.config.model,
					messages: [
						{ role: 'system', content: DREAM_PROMPT },
						{ role: 'user', content: `Memories to analyze:\n${manifest}` },
					],
					max_tokens: 1000,
					temperature: 0,
					response_format: { type: 'json_object' },
				}),
				signal: createTimeoutSignal(30_000),
			});

			if (!response.ok) {
				throw new Error(`Dream API error: ${response.status}`);
			}

			const data = await response.json() as any;
			const content = data.choices?.[0]?.message?.content ?? '{}';

			// JSON 解析容错：先尝试标准解析，失败后提取 code block
			let parsed: any;
			try {
				parsed = JSON.parse(content);
			} catch {
				const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
				if (jsonMatch) {
					parsed = JSON.parse(jsonMatch[1]);
				} else {
					throw new Error(`Failed to parse Dream response: ${content.substring(0, 200)}`);
				}
			}
			const actions = parsed.actions ?? [];

			// 4. 执行建议的操作（目前只记录，不自动执行）
			let actionCount = 0;
			for (const action of actions) {
				if (action.action === 'delete' && action.files) {
					for (const file of action.files) {
						logger.info(`[AutoDream] Suggested delete: ${file} — ${action.reason}`);
						actionCount++;
					}
				} else if (action.action === 'merge' && action.files) {
					logger.info(`[AutoDream] Suggested merge: ${action.files.join(' + ')} — ${action.reason}`);
					actionCount++;
				} else if (action.action === 'update' && action.files) {
					logger.info(`[AutoDream] Suggested update: ${action.files.join(', ')} — ${action.suggestion}`);
					actionCount++;
				}
			}

			// 4. 将建议写入文件供用户审核
			if (actionCount > 0) {
				await this.writeSuggestionsFile(actions, parsed.summary || 'Analysis complete');
			}

			this.lastDreamTime = Date.now();
			this.sessionCount = 0;

			const elapsed = Date.now() - startTime;
			logger.info(`[AutoDream] Completed in ${elapsed}ms: ${actionCount} actions suggested`);

			return {
				actions: actionCount,
				summary: parsed.summary || 'Analysis complete',
			};
		} catch (e) {
			logger.warn('[AutoDream] Failed:', e);
			return { actions: 0, summary: `Error: ${e}` };
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * 将建议写入文件供用户审核
	 */
	private async writeSuggestionsFile(actions: any[], summary: string): Promise<void> {
		try {
			const suggestionsDir = this.memoryDirs[0];
			const filePath = path.join(suggestionsDir, '_dream-suggestions.md');
			const today = new Date().toISOString().split('T')[0];

			// 追加模式（不覆盖历史建议）
			let existingContent = '';
			try {
				existingContent = await fs.readFile(filePath, 'utf-8');
			} catch { /* 文件不存在 */ }

			// 检查是否已有当日 section
			if (existingContent.includes(`# ${today}`)) {
				logger.info('[AutoDream] Today\'s suggestions already exist, skipping');
				return;
			}

			const newSection = [
				'',
				`# ${today}`,
				'',
				`Summary: ${summary}`,
				'',
				'## Suggested Actions',
				'',
			];

			for (const action of actions) {
				if (action.action === 'merge') {
					newSection.push(`### Merge`);
					newSection.push(`- Files: ${(action.files || []).join(' + ')}`);
					newSection.push(`- Reason: ${action.reason || 'Overlapping content'}`);
					newSection.push('');
				} else if (action.action === 'delete') {
					newSection.push(`### Delete`);
					newSection.push(`- Files: ${(action.files || []).join(', ')}`);
					newSection.push(`- Reason: ${action.reason || 'Stale or outdated'}`);
					newSection.push('');
				} else if (action.action === 'update') {
					newSection.push(`### Update`);
					newSection.push(`- Files: ${(action.files || []).join(', ')}`);
					newSection.push(`- Suggestion: ${action.suggestion || 'Update content'}`);
					newSection.push('');
				}
			}

			await fs.writeFile(filePath, existingContent + newSection.join('\n'), 'utf-8');
			logger.info(`[AutoDream] Suggestions appended to ${filePath}`);
		} catch (e) {
			logger.warn('[AutoDream] Failed to write suggestions file:', e);
		}
	}
}
