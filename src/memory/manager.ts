/**
 * MemoryManager — 记忆管理系统核心
 * 管理记忆的扫描、召回、注入、保存
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { type MemoryEntry, type MemoryHeader, type RecallResult } from './types';
import { getUserMemoryDir, getProjectMemoryDir, type RecallModelConfig, ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from './paths';
import { MODELS } from '../consts';
import { scanMemoryFiles, memoryAge, memoryAgeDays, memoryWeight } from './scanner';
import { findRelevantMemories, type RecallContext } from './recall';
import { SessionMemory } from './sessionMemory';
import { AutoDream } from './autoDream';
import { AutoExtract } from './autoExtract';
import { MemoryStats } from './stats';
import { logger } from '../logger';

/**
 * 召回缓存 — 同一会话内相似查询复用结果
 * 减少 API 调用，降低延迟
 */
class RecallCache {
	private cache = new Map<string, { result: RecallResult; timestamp: number }>();
	private readonly TTL = 60_000; // 60秒
	private readonly MAX_SIZE = 50; // 最大缓存条目

	get(query: string, conversationSummary?: string): RecallResult | null {
		const key = this.fuzzyHash(query, conversationSummary);
		const entry = this.cache.get(key);
		if (!entry) return null;
		if (Date.now() - entry.timestamp > this.TTL) {
			this.cache.delete(key);
			return null;
		}
		return entry.result;
	}

	set(query: string, result: RecallResult, conversationSummary?: string): void {
		// LRU 淘汰：超过大小限制时删除最早的条目
		if (this.cache.size >= this.MAX_SIZE) {
			const oldest = this.cache.keys().next().value;
			if (oldest) this.cache.delete(oldest);
		}
		const key = this.fuzzyHash(query, conversationSummary);
		this.cache.set(key, { result, timestamp: Date.now() });
	}

	private fuzzyHash(query: string, conversationSummary?: string): string {
		// 取前 50 字符 + 长度 + 对话摘要前 20 字符作为模糊 key
		const queryPart = query.substring(0, 50).toLowerCase().trim();
		const ctxPart = conversationSummary?.substring(0, 20).toLowerCase().trim() ?? '';
		return `${queryPart}_${ctxPart}_${query.length}`;
	}
}

/**
 * 记忆管理器
 * 负责记忆的生命周期管理：扫描、召回、注入、保存
 */
export class MemoryManager {
	private userMemoryDir: string;
	private projectMemoryDir: string | null = null;
	private recallConfig: RecallModelConfig | null = null;

	/** 并发控制 */
	private pendingRecall: Promise<RecallResult> | null = null;
	private lastRecallResult: RecallResult | null = null;

	/** 召回缓存 */
	private recallCache = new RecallCache();

	/** 可观测性统计 */
	private stats = new MemoryStats();

	/** 子系统 */
	private sessionMemory: SessionMemory | null = null;
	private autoDream: AutoDream | null = null;
	private autoExtract: AutoExtract | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.userMemoryDir = getUserMemoryDir();
	}

	/**
	 * 初始化：设置项目目录和召回模型配置
	 */
	initialize(workspaceRoot: string | undefined, apiKey: string | undefined, baseUrl?: string): void {
		if (workspaceRoot) {
			this.projectMemoryDir = getProjectMemoryDir(workspaceRoot);
		}

		if (apiKey) {
			// 从配置读取召回模型，默认用 mimo-v2-pro
			const config = vscode.workspace.getConfiguration('mimo-copilot');
			// 默认用第一个 isUserSelectable=false 的模型（即 agent 模型）
			const agentModel = MODELS.find(m => m.isUserSelectable === false);
			const recallModel = config.get<string>('memory.recallModel', agentModel?.id ?? 'mimo-v2-pro');

			this.recallConfig = {
				model: recallModel,
				baseUrl: baseUrl || 'https://token-plan-sgp.xiaomimimo.com/v1',
				apiKey,
			};

			// 启动子系统
			this.initSubsystems();
		}

		logger.info(`[Memory][PID:${process.pid}] Initialized: userDir=${this.userMemoryDir}, projectDir=${this.projectMemoryDir ?? 'none'}, recallModel=${this.recallConfig?.model ?? 'none'}`);
	}

	/**
	 * 初始化所有子系统
	 */
	private initSubsystems(): void {
		if (!this.recallConfig) return;

		// Session Memory
		this.sessionMemory = new SessionMemory(this.recallConfig);
		this.sessionMemory.initialize().catch(e => logger.warn('[Memory] SessionMemory init failed:', e));

		// Auto Dream
		const dirs = [this.userMemoryDir];
		if (this.projectMemoryDir) dirs.push(this.projectMemoryDir);
		this.autoDream = new AutoDream(this.recallConfig, dirs);

		// Auto Extract
		const extractDir = this.projectMemoryDir || this.userMemoryDir;
		this.autoExtract = new AutoExtract(this.recallConfig, extractDir);
	}

	/**
	 * 处理新消息（触发会话记忆更新、自动提取、Auto Dream）
	 */
	async onNewMessages(messages: Array<{ role: string; content: string }>): Promise<void> {
		if (this.sessionMemory?.shouldUpdate(messages.length)) {
			this.sessionMemory.update(messages).catch(e =>
				logger.warn('[Memory] Session memory update failed:', e)
			);
		}

		if (this.autoExtract?.shouldExtract(messages.length)) {
			this.autoExtract.extract(messages).catch(e =>
				logger.warn('[Memory] Auto extract failed:', e)
			);
		}

		if (this.autoDream?.shouldDream()) {
			this.autoDream.dream().catch(e =>
				logger.warn('[Memory] Auto dream failed:', e)
			);
		}
	}

	/**
	 * 获取会话记忆摘要（用于注入）
	 */
	getSessionSummary(): string {
		return this.sessionMemory?.getSummary() ?? '';
	}

	/**
	 * 记录新会话（用于 Auto Dream 门控）
	 */
	recordSession(): void {
		this.autoDream?.recordSession();
	}

	/**
	 * 核心方法：构建记忆上下文注入文本
	 * 在 provideLanguageModelChatResponse 中调用
	 * 
	 * 优化：先查召回缓存（60s TTL），缓存未命中再执行 LLM 召回
	 */
	async buildMemoryContext(ctx: RecallContext): Promise<string | null> {
		if (!this.recallConfig) {
			logger.debug('[Memory] No recall config, skipping');
			return null;
		}

		try {
			// 先查缓存（同一会话内相似查询复用结果）
			const cached = this.recallCache.get(ctx.query, ctx.conversationSummary);
			if (cached && cached.selected.length > 0) {
				logger.info(`[Memory] Cache hit: ${cached.selected.length} memories`);
				this.lastRecallResult = cached;
				this.stats.recordCache(true);
				this.stats.recordLatency(0); // 缓存命中，延迟为 0
				return this.formatInjection(cached.selected);
			}
			this.stats.recordCache(false);

			// 并发控制：如果已有召回在进行，复用结果
			if (this.pendingRecall) {
				logger.debug('[Memory] Recall already in progress, waiting...');
				await this.pendingRecall;
				if (this.lastRecallResult && this.lastRecallResult.selected.length > 0) {
					return this.formatInjection(this.lastRecallResult.selected);
				}
				return null;
			}

			// 执行召回（项目级 + 用户级合并）
			const recallPromise = this.doRecall(ctx);
			this.pendingRecall = recallPromise;

			try {
				const result = await recallPromise;
				this.lastRecallResult = result;

				// 写入缓存
				this.recallCache.set(ctx.query, result, ctx.conversationSummary);

				// 记录统计
				this.stats.recordLatency(result.elapsed);

				if (result.selected.length === 0) {
					logger.debug('[Memory] No relevant memories found');
					return null;
				}

				logger.info(`[Memory] Recalled ${result.selected.length} memories via ${result.method} in ${result.elapsed}ms`);
				return this.formatInjection(result.selected);
			} finally {
				this.pendingRecall = null;
			}
		} catch (e) {
			logger.warn('[Memory] Recall failed:', e);
			return null;
		}
	}

	/**
	 * 执行记忆召回（合并用户级 + 项目级）
	 */
	private async doRecall(ctx: RecallContext): Promise<RecallResult> {
		if (!this.recallConfig) {
			return { selected: [], tokens: { input: 0, output: 0, cached: 0 }, elapsed: 0, method: 'llm' };
		}

		const userPromise = findRelevantMemories(ctx, this.userMemoryDir, this.recallConfig);

		if (!this.projectMemoryDir) {
			return userPromise;
		}

		// 并行执行用户级和项目级召回（性能优化：原来串行，现在并行）
		const projectPromise = findRelevantMemories(ctx, this.projectMemoryDir, this.recallConfig);
		const [userResult, projectResult] = await Promise.all([userPromise, projectPromise]);

		// 去重：项目级排除用户级已选中的文件路径
		const userPaths = new Set(userResult.selected.map(m => m.filePath));
		const dedupedProjectSelected = projectResult.selected.filter(m => !userPaths.has(m.filePath));

		return {
			selected: [...userResult.selected, ...dedupedProjectSelected],
			tokens: {
				input: userResult.tokens.input + projectResult.tokens.input,
				output: userResult.tokens.output + projectResult.tokens.output,
				cached: userResult.tokens.cached + projectResult.tokens.cached,
			},
			elapsed: Math.max(userResult.elapsed, projectResult.elapsed),
			method: userResult.method,
		};
	}

	/**
	 * 格式化注入文本（Token 预算控制 + 衰减权重 + 精简格式）
	 * 
	 * 核心优化：
	 * 1. MAX_INJECTION_TOKENS 限制总量，防止吃掉上下文窗口
	 * 2. 记忆按权重（新鲜度）排序，优先注入高权重记忆
	 * 3. 精简 XML 格式，节省 ~40% 包装 token
	 */
	private formatInjection(memories: MemoryEntry[]): string {
		const MAX_INJECTION_TOKENS = 3000;

		// 按权重排序（最新优先）
		const sorted = [...memories].sort((a, b) => memoryWeight(b.mtimeMs) - memoryWeight(a.mtimeMs));

		const blocks: string[] = [];
		let totalTokens = 0;

		for (const m of sorted) {
			const block = this.formatMemoryBlock(m);
			const blockTokens = estimateTokens(block);

			if (totalTokens + blockTokens > MAX_INJECTION_TOKENS) {
				// 截断最后一条，保留闭合标签确保格式完整
				const remaining = MAX_INJECTION_TOKENS - totalTokens;
				if (remaining > 100) {
					const truncated = truncateToTokens(block, remaining);
					// 确保截断后仍有 [/MEMORY] 闭合标签
					const withoutClose = truncated.replace(/\[\/MEMORY\]\s*$/, '');
					blocks.push(withoutClose + '\n[/MEMORY]\n...(truncated)');
					totalTokens += remaining;
				}
				break;
			}

			blocks.push(block);
			totalTokens += blockTokens;
		}

		if (blocks.length === 0) return '';

		// 记录注入 token 使用量
		this.stats.recordTokens(totalTokens);

		// 定期写入统计文件
		this.stats.flush().catch(() => {});

		// 会话记忆摘要（也计入预算）
		const sessionSummary = this.getSessionSummary();
		let sessionBlock = '';
		if (sessionSummary) {
			sessionBlock = `\n[SESSION_STATE]\n${sessionSummary}\n[/SESSION_STATE]`;
			const sessionTokens = estimateTokens(sessionBlock);
			if (totalTokens + sessionTokens > MAX_INJECTION_TOKENS) {
				sessionBlock = ''; // 超预算，不注入会话摘要
			} else {
				totalTokens += sessionTokens;
			}
		}

		return `<memory-context>\n${blocks.join('\n\n')}${sessionBlock}\n</memory-context>\n<!-- Injected: ${blocks.length} memories, ~${totalTokens} tokens -->`;
	}

	/**
	 * 格式化单条记忆（精简格式，节省 token）
	 */
	private formatMemoryBlock(m: MemoryEntry): string {
		const age = memoryAge(m.mtimeMs);
		const weight = memoryWeight(m.mtimeMs);
		const ageDays = memoryAgeDays(m.mtimeMs);

		// 渐变 staleness 提醒（替代二值判断）
		let staleness = '';
		if (ageDays > 30) {
			staleness = `<system-reminder>This memory is very stale (${age}). Verify before relying on it.</system-reminder>\n`;
		} else if (ageDays > 7) {
			staleness = `<system-reminder>This memory is moderately stale (${age}). Verify accuracy.</system-reminder>\n`;
		}

		return `[MEMORY:${m.filename} | type=${m.type ?? '?'} | age=${age} | w=${weight.toFixed(1)}]\n${staleness}${m.content}\n[/MEMORY]`;
	}

	/**
	 * 获取最近一次召回结果（用于 UI 展示）
	 */
	getLastRecallResult(): RecallResult | null {
		return this.lastRecallResult;
	}

	/**
	 * 保存新记忆
	 */
	async saveMemory(
		name: string,
		description: string,
		type: string,
		content: string,
		scope: 'user' | 'project' = 'user',
	): Promise<string> {
		const dir = scope === 'project' && this.projectMemoryDir
			? this.projectMemoryDir
			: this.userMemoryDir;

		await fs.mkdir(dir, { recursive: true });

		const filename = `${type}_${name.toLowerCase().replace(/\s+/g, '_')}.md`;
		const filePath = path.join(dir, filename);

		const fileContent = [
			'---',
			`name: ${name}`,
			`description: ${description}`,
			`type: ${type}`,
			'---',
			'',
			content,
		].join('\n');

		await fs.writeFile(filePath, fileContent, 'utf-8');

		// 更新 MEMORY.md 索引
		await this.updateIndex(dir, filename, description);

		logger.info(`[Memory] Saved: ${filePath}`);
		return filePath;
	}

	/**
	 * 删除记忆
	 */
	async deleteMemory(filePath: string): Promise<void> {
		await fs.unlink(filePath);
		logger.info(`[Memory] Deleted: ${filePath}`);
	}

	/**
	 * 更新 MEMORY.md 索引
	 */
	private async updateIndex(dir: string, filename: string, description: string): Promise<void> {
		const indexPath = path.join(dir, ENTRYPOINT_NAME);
		let indexContent = '';

		try {
			indexContent = await fs.readFile(indexPath, 'utf-8');
		} catch {
			indexContent = `# Memory Index\n\n`;
		}

		const entry = `- [${filename.replace('.md', '')}](${filename}) — ${description}`;

		// 检查是否已存在同名条目
		const lines = indexContent.split('\n');
		const existingIdx = lines.findIndex(l => l.includes(`](${filename})`));

		if (existingIdx >= 0) {
			lines[existingIdx] = entry;
		} else {
			lines.push(entry);
		}

		// 截断到最大行数
		const trimmed = lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n');
		await fs.writeFile(indexPath, trimmed, 'utf-8');
	}

	/**
	 * 获取记忆列表（用于 UI 展示）
	 */
	async listMemories(): Promise<{ user: MemoryHeader[]; project: MemoryHeader[] }> {
		const user = await scanMemoryFiles(this.userMemoryDir);
		const project = this.projectMemoryDir
			? await scanMemoryFiles(this.projectMemoryDir)
			: [];

		return { user, project };
	}

	/**
	 * 获取统计快照（用于 /mimo-memory stats 命令）
	 */
	async getStatsSnapshot(): Promise<import('./stats').MemoryStatsSnapshot> {
		const { user, project } = await this.listMemories();
		return this.stats.getSnapshot(user.length, project.length);
	}

	/**
	 * 清除缓存
	 */
	clearCache(): void {
		this.lastRecallResult = null;
	}
}

/**
 * Token 估算（分档：CJK 1.5/char，标点 1.0/char，英文 0.25/char）
 */
function estimateTokens(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const char = text[i];
		// CJK 字符：~1.5 token/char
		if (code >= 0x4e00 && code <= 0x9fff) {
			count += 1.5;
		}
		// 日文假名/韩文：~1.0 token/char
		else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
			count += 1.0;
		}
		// 标点和符号：~1.0 token/char
		else if ('{}[]()=;:,.!?<>|/\\\'"`~@#$%^&*+-'.includes(char)) {
			count += 1.0;
		}
		// 英文/数字/空格：~0.25 token/char（4 chars/token）
		else {
			count += 0.25;
		}
	}
	return Math.ceil(count);
}

/**
 * 截断文本到指定 token 数
 */
function truncateToTokens(text: string, maxTokens: number): string {
	let tokenCount = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		tokenCount += (code >= 0x4e00 && code <= 0x9fff) ? 1.5 : 0.25;
		if (tokenCount > maxTokens) {
			return text.substring(0, i);
		}
	}
	return text;
}
