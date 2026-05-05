/**
 * 记忆存储路径解析
 * 支持用户级 + 项目级双层目录
 */

import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/** 记忆目录根 */
const MEMORY_ROOT = '.mimo';

/**
 * 用户级记忆目录（全局共享偏好）
 * 位置: ~/.mimo/memory/
 */
export function getUserMemoryDir(): string {
	return path.join(os.homedir(), MEMORY_ROOT, 'memory');
}

/**
 * 项目级记忆目录（按 git root 隔离）
 * 位置: ~/.mimo/projects/<sanitized-git-root>/memory/
 */
export function getProjectMemoryDir(workspaceRoot: string): string {
	const sanitized = sanitizePathForDir(workspaceRoot);
	return path.join(os.homedir(), MEMORY_ROOT, 'projects', sanitized, 'memory');
}

/**
 * 将路径转为安全的目录名
 * 复刻 Claude Code 的 sanitizePath 逻辑
 */
function sanitizePathForDir(p: string): string {
	// 取路径的 hash 前12位 + 最后一级目录名
	const hash = crypto.createHash('sha256').update(path.resolve(p)).digest('hex').slice(0, 12);
	const basename = path.basename(p) || 'root';
	return `${basename}-${hash}`;
}

/**
 * MEMORY.md 入口文件名
 */
export const ENTRYPOINT_NAME = 'MEMORY.md';

/**
 * MEMORY.md 最大行数
 */
export const MAX_ENTRYPOINT_LINES = 200;

/**
 * MEMORY.md 最大字节数
 */
export const MAX_ENTRYPOINT_BYTES = 25_000;

/**
 * 记忆文件扫描最大数量
 */
export const MAX_MEMORY_FILES = 200;

/**
 * frontmatter 最大读取行数
 */
export const FRONTMATTER_MAX_LINES = 30;

/**
 * 召回最大结果数
 */
export const MAX_RECALL_RESULTS = 5;

/**
 * 召回模型配置
 */
export interface RecallModelConfig {
	model: string;
	baseUrl: string;
	apiKey: string;
}

/**
 * AbortSignal.timeout 兼容 polyfill
 * VS Code 扩展可能运行在较旧的 Electron Node 上
 */
export function createTimeoutSignal(ms: number): AbortSignal {
	if (typeof AbortSignal.timeout === 'function') {
		return AbortSignal.timeout(ms);
	}
	const controller = new AbortController();
	setTimeout(() => controller.abort(), ms);
	return controller.signal;
}
