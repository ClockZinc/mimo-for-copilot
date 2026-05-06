/**
 * 记忆文件扫描
 * 复刻 Claude Code 的 memoryScan.ts
 * 扫描记忆目录，解析 frontmatter，返回 MemoryHeader 列表
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
	type MemoryHeader,
	type MemoryType,
	parseMemoryType,
} from './types';
import {
	ENTRYPOINT_NAME,
	FRONTMATTER_MAX_LINES,
	MAX_MEMORY_FILES,
} from './paths';

/**
 * 扫描记忆目录中的所有 .md 文件，解析 frontmatter
 * 按修改时间排序（最新优先），最多 MAX_MEMORY_FILES 个
 */
export async function scanMemoryFiles(memoryDir: string): Promise<MemoryHeader[]> {
	try {
		await fs.mkdir(memoryDir, { recursive: true });
		const entries = await fs.readdir(memoryDir, { recursive: true });
		const mdFiles = entries
			.filter((f): f is string => typeof f === 'string' && f.endsWith('.md') && path.basename(f) !== ENTRYPOINT_NAME);

		const results = await Promise.allSettled(
			mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
				const filePath = path.join(memoryDir, relativePath);
				const stat = await fs.stat(filePath);
				const content = await readFileHead(filePath, FRONTMATTER_MAX_LINES);
				const { description, type } = parseFrontmatter(content);
				return {
					filename: relativePath,
					filePath,
					mtimeMs: stat.mtimeMs,
					description,
					type,
				};
			}),
		);

		return results
			.filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === 'fulfilled')
			.map(r => r.value)
			.sort((a, b) => b.mtimeMs - a.mtimeMs)
			.slice(0, MAX_MEMORY_FILES);
	} catch {
		return [];
	}
}

/**
 * 读取文件头部 N 行
 */
async function readFileHead(filePath: string, maxLines: number): Promise<string> {
	try {
		const fh = await fs.open(filePath, 'r');
		try {
			const buffer = Buffer.alloc(4096); // 4KB 足够读 frontmatter
			const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
			// 安全截断：避免在多字节 UTF-8 字符中间截断
			let end = bytesRead;
			while (end > 0 && (buffer[end - 1] & 0xC0) === 0x80) end--;
			if (end > 0 && (buffer[end - 1] & 0xC0) === 0xC0) end--;
			const content = buffer.toString('utf-8', 0, end);
			const lines = content.split(/\r?\n/);
			return lines.slice(0, maxLines).join('\n');
		} finally {
			await fh.close();
		}
	} catch {
		return '';
	}
}

/**
 * 解析 frontmatter 中的 description 和 type 字段
 */
function parseFrontmatter(content: string): {
	description: string | null;
	type: MemoryType | undefined;
} {
	// 兼容 \r\n、\n、\r（旧版 Mac 格式）
	const match = content.match(/^---(?:\r?\n|\r)([\s\S]*?)(?:\r?\n|\r)---/);
	if (!match) return { description: null, type: undefined };

	const fm = match[1];
	const descMatch = fm.match(/description:\s*(.+)/);
	const typeMatch = fm.match(/type:\s*(\w+)/);

	return {
		description: descMatch?.[1]?.trim() ?? null,
		type: parseMemoryType(typeMatch?.[1]),
	};
}

/**
 * 格式化记忆清单文本（注入到召回 prompt 中）
 * 复刻 Claude Code 的 formatMemoryManifest
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
	return memories.map(m => {
		const age = memoryAge(m.mtimeMs);
		const weight = memoryWeight(m.mtimeMs);
		const type = m.type ?? 'unknown';
		const desc = m.description ?? 'no description';
		return `- [${type}] ${m.filename} (${age}, w=${weight.toFixed(1)}): ${desc}`;
	}).join('\n');
}

/**
 * 记忆文件的可读年龄
 */
export function memoryAge(mtimeMs: number): string {
	const days = memoryAgeDays(mtimeMs);
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	return `${days} days ago`;
}

/**
 * 记忆文件的年龄（天数）
 */
export function memoryAgeDays(mtimeMs: number): number {
	return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
}

/**
 * 记忆衰减权重（0.1-1.0）
 * 越新的记忆权重越高，用于注入排序和 LLM 提示
 */
export function memoryWeight(mtimeMs: number): number {
	const days = memoryAgeDays(mtimeMs);
	if (days === 0) return 1.0;
	if (days === 1) return 0.9;
	if (days <= 7) return 0.7;
	if (days <= 30) return 0.4;
	if (days <= 90) return 0.2;
	return 0.1;
}
