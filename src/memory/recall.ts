/**
 * 记忆召回引擎
 * 使用配置的记忆模型做 LLM 侧查询（复刻 Claude Code 的 selectRelevantMemories）
 * 降级方案：API 不可用时回退到关键词匹配
 */

import * as fs from 'fs/promises';
import {
    type RecallModelConfig,
    MAX_RECALL_RESULTS,
    createTimeoutSignal
} from './paths';
import { formatMemoryManifest, scanMemoryFiles } from './scanner';
import {
    type MemoryEntry,
    type MemoryHeader,
    type RecallResult,
} from './types';

/** 召回 prompt（复刻 Claude Code 的 SELECT_MEMORIES_SYSTEM_PROMPT） */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful as context for processing a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array containing filenames (up to 5). Only include memories that are clearly useful.
- If unsure, do not include it. Be selective and discerning.
- If no memories are useful, return {"selected_memories": []}.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools. DO still select memories containing warnings, gotchas, or known issues about those tools.
- Memory records can become stale over time. Use memory age as context for what was true at a given point in time. Prefer recent memories over old ones when both are relevant.
- IMPORTANT: Memories and queries may be in Chinese or mixed languages. Judge relevance by semantic meaning, not by language. Chinese and English content about the same topic should be treated as equivalent.
- Prefer memories with higher weight (more recent). Weight is shown in the manifest as (X.Y). A weight of 1.0 means today, 0.1 means very old.
- Return ONLY valid JSON, no other text.`;

/** 召回请求的上下文信息 */
export interface RecallContext {
	/** 用户当前查询 */
	query: string;
	/** 最近使用的工具列表（避免推荐工具文档，但仍推荐工具问题） */
	recentTools?: string[];
	/** 已展示过的记忆（避免重复召回） */
	alreadySurfaced?: Set<string>;
	/** 最近几轮对话摘要（帮助召回与对话历史相关的记忆） */
	conversationSummary?: string;
}

/**
 * 查找与查询相关的记忆
 * 主入口：扫描 → LLM 召回 → 读取内容
 */
export async function findRelevantMemories(
	ctx: RecallContext,
	memoryDir: string,
	config: RecallModelConfig,
): Promise<RecallResult> {
	const startTime = Date.now();

	// 1. 扫描记忆文件
	const allMemories = await scanMemoryFiles(memoryDir);
	const candidates = allMemories.filter(m => !(ctx.alreadySurfaced?.has(m.filePath)));

	if (candidates.length === 0) {
		return { selected: [], tokens: { input: 0, output: 0, cached: 0 }, elapsed: 0, method: 'llm' };
	}

	// 2. LLM 召回（带降级）
	let selectedFilenames: string[];
	let tokens = { input: 0, output: 0, cached: 0 };
	let method: 'llm' | 'keyword' = 'llm';

	try {
		const result = await selectRelevantMemoriesWithLLM(ctx, candidates, config);
		selectedFilenames = result.filenames;
		tokens = result.tokens;
	} catch {
		// 降级：关键词匹配
		selectedFilenames = fallbackKeywordRecall(ctx.query, candidates);
		method = 'keyword';
	}

	// 3. 读取选中记忆的完整内容
	const byFilename = new Map(candidates.map(m => [m.filename, m]));
	const selected: MemoryEntry[] = [];

	for (const filename of selectedFilenames) {
		const header = byFilename.get(filename);
		if (!header) continue;
		try {
			const content = await readMemoryContent(header.filePath);
			selected.push({ ...header, content });
		} catch {
			// 跳过读取失败的文件
		}
	}

	return {
		selected,
		tokens,
		elapsed: Date.now() - startTime,
		method,
	};
}

/**
 * LLM 侧查询：调用配置的记忆模型选择相关记忆
 * 复刻 Claude Code 的 selectRelevantMemories，增强为支持对话上下文
 */
async function selectRelevantMemoriesWithLLM(
	ctx: RecallContext,
	memories: MemoryHeader[],
	config: RecallModelConfig,
): Promise<{ filenames: string[]; tokens: { input: number; output: number; cached: number } }> {
	const manifest = formatMemoryManifest(memories);
	const validFilenames = new Set(memories.map(m => m.filename));

	// 构建增强的 user prompt（包含工具上下文和对话摘要）
	let userPrompt = `Query: ${ctx.query}\n\nAvailable memories:\n${manifest}`;

	if (ctx.recentTools && ctx.recentTools.length > 0) {
		userPrompt += `\n\nRecently used tools: ${ctx.recentTools.join(', ')}`;
	}

	if (ctx.conversationSummary) {
		userPrompt += `\n\nRecent conversation context:\n${ctx.conversationSummary}`;
	}

	const response = await fetch(`${config.baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({
			model: config.model,
			messages: [
				{ role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt },
			],
			max_tokens: 300,
			temperature: 0,
			response_format: { type: 'json_object' },
		}),
		signal: createTimeoutSignal(10_000), // 10s 超时
	});

	if (!response.ok) {
		const errText = await response.text().catch(() => 'unknown');
		throw new Error(`Recall API error ${response.status}: ${errText}`);
	}

	const data = await response.json() as any;
	const content: string = data.choices?.[0]?.message?.content ?? '';
	const usage = data.usage ?? {};

	let parsed: { selected_memories?: string[] };
	try {
		parsed = JSON.parse(content);
	} catch {
		// 尝试从 markdown code block 提取 JSON
		const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			parsed = JSON.parse(jsonMatch[1]);
		} else {
			throw new Error(`Failed to parse recall response: ${content}`);
		}
	}

	const filenames = (parsed.selected_memories ?? [])
		.filter((f: unknown): f is string => typeof f === 'string' && validFilenames.has(f));

	return {
		filenames,
		tokens: {
			input: usage.prompt_tokens ?? 0,
			output: usage.completion_tokens ?? 0,
			cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
		},
	};
}

/**
 * 降级方案：关键词匹配
 * 当 LLM API 不可用时使用（支持中文 bigram 分词）
 */
export function fallbackKeywordRecall(query: string, memories: MemoryHeader[]): string[] {
	const words = tokenize(query);
	if (words.length === 0) return [];

	return memories
		.map(m => {
			const text = `${m.filename} ${m.description ?? ''} ${m.type ?? ''}`.toLowerCase();
			const memTokens = tokenize(text);
			const hits = words.filter(w => memTokens.includes(w)).length;
			return { mem: m, score: hits / words.length };
		})
		.filter(s => s.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_RECALL_RESULTS)
		.map(s => s.mem.filename);
}

/**
 * 分词器：英文按空格（>2字符），中文按 bigram
 */
function tokenize(text: string): string[] {
	const lower = text.toLowerCase();
	const tokens: string[] = [];

	// 英文单词（≥2字符，支持 go/js 等缩写）
	const enWords = lower.match(/[a-z_]{2,}/g);
	if (enWords) tokens.push(...enWords);

	// 中文 bigram（相邻两字一组）
	const zhSegments = lower.match(/[\u4e00-\u9fff]{2,}/g);
	if (zhSegments) {
		for (const seg of zhSegments) {
			for (let i = 0; i < seg.length - 1; i++) {
				tokens.push(seg.substring(i, i + 2));
			}
		}
	}

	return tokens;
}

/**
 * 读取记忆文件内容（移除 frontmatter）
 */
async function readMemoryContent(filePath: string): Promise<string> {
	const raw = await fs.readFile(filePath, 'utf-8');
	// 移除 frontmatter（兼容 \r\n、\n、\r）
	return raw.replace(/^---(?:\r?\n|\r)[\s\S]*?(?:\r?\n|\r)---\r?\n?/, '').trim();
}
