/**
 * MemoryStats — 记忆系统可观测性
 * 收集核心指标：缓存命中率、召回延迟、Token 使用量
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger';

/** 统计快照 */
export interface MemoryStatsSnapshot {
	timestamp: string;
	cache_hit_rate: number;
	cache_hits: number;
	cache_total: number;
	latency_p50: number;
	latency_p95: number;
	latency_p99: number;
	token_p50: number;
	token_p95: number;
	token_p99: number;
	total_recalls: number;
	total_injections: number;
	memory_count: { user: number; project: number };
}

/**
 * 记忆系统统计收集器
 * 
 * 核心指标：
 * - recall.cache_hit_rate: 缓存命中 / 总召回次数
 * - recall.latency_p95: 召回延迟 p95
 * - injection.token_usage: 每次注入的实际 token 数
 */
export class MemoryStats {
	private cacheHits = 0;
	private cacheTotal = 0;
	private latencies: number[] = [];
	private tokenUsages: number[] = [];
	private totalRecalls = 0;
	private totalInjections = 0;
	private lastFlushTime = 0;
	private readonly FLUSH_INTERVAL = 5 * 60_000; // 5分钟

	/** 记录缓存命中/未命中 */
	recordCache(hit: boolean): void {
		this.cacheTotal++;
		if (hit) this.cacheHits++;
	}

	/** 记录召回延迟 */
	recordLatency(ms: number): void {
		this.latencies.push(ms);
		this.totalRecalls++;
		// 保留最近 1000 个样本
		if (this.latencies.length > 1000) {
			this.latencies = this.latencies.slice(-500);
		}
	}

	/** 记录注入 token 使用量 */
	recordTokens(count: number): void {
		this.tokenUsages.push(count);
		this.totalInjections++;
		if (this.tokenUsages.length > 1000) {
			this.tokenUsages = this.tokenUsages.slice(-500);
		}
	}

	/** 获取当前快照 */
	getSnapshot(userMemoryCount = 0, projectMemoryCount = 0): MemoryStatsSnapshot {
		return {
			timestamp: new Date().toISOString(),
			cache_hit_rate: this.cacheTotal > 0 ? this.cacheHits / this.cacheTotal : 0,
			cache_hits: this.cacheHits,
			cache_total: this.cacheTotal,
			latency_p50: percentile(this.latencies, 0.5),
			latency_p95: percentile(this.latencies, 0.95),
			latency_p99: percentile(this.latencies, 0.99),
			token_p50: percentile(this.tokenUsages, 0.5),
			token_p95: percentile(this.tokenUsages, 0.95),
			token_p99: percentile(this.tokenUsages, 0.99),
			total_recalls: this.totalRecalls,
			total_injections: this.totalInjections,
			memory_count: { user: userMemoryCount, project: projectMemoryCount },
		};
	}

	/** 定期写入文件（5分钟间隔） */
	async flush(userMemoryCount = 0, projectMemoryCount = 0): Promise<void> {
		const now = Date.now();
		if (now - this.lastFlushTime < this.FLUSH_INTERVAL) return;

		try {
			const statsDir = path.join(os.homedir(), '.mimo');
			await fs.mkdir(statsDir, { recursive: true });
			const statsPath = path.join(statsDir, 'stats.json');
			const snapshot = this.getSnapshot(userMemoryCount, projectMemoryCount);
			await fs.writeFile(statsPath, JSON.stringify(snapshot, null, 2), 'utf-8');
			this.lastFlushTime = now;
			logger.debug(`[MemoryStats] Flushed to ${statsPath}`);
		} catch (e) {
			logger.warn('[MemoryStats] Failed to flush:', e);
		}
	}

	/** 重置统计（用于测试） */
	reset(): void {
		this.cacheHits = 0;
		this.cacheTotal = 0;
		this.latencies = [];
		this.tokenUsages = [];
		this.totalRecalls = 0;
		this.totalInjections = 0;
	}
}

/**
 * 计算百分位数
 */
function percentile(arr: number[], p: number): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const idx = Math.ceil(sorted.length * p) - 1;
	return sorted[Math.max(0, idx)];
}
