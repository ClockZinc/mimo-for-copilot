/**
 * 消息重排优化 — 提升 LLM API 缓存命中率
 *
 * LLM API 的 KV 缓存基于前缀匹配：
 * 前面不变的部分会被缓存，后面变化的部分不会。
 *
 * 策略：把不变的内容放前面，变化的内容放后面
 */

import * as vscode from 'vscode';
import { logger } from '../logger';

/**
 * 优化消息顺序以提升缓存命中率
 *
 * 策略：memory 消息插入到第一条 user 消息之前
 * （第一条 user 消息通常是 system prompt，memory 应在其后、实际对话前）
 */
export function optimizeMessageOrder(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	memoryMessage?: vscode.LanguageModelChatRequestMessage,
): readonly vscode.LanguageModelChatRequestMessage[] {
	if (!memoryMessage) return messages;

	// 过滤掉已有的 memory 消息
	const filtered = messages.filter(m => !isMemoryMessage(m));
	if (filtered.length === 0) return [memoryMessage];

	// 找到第二条 user 消息的位置（第一条通常是 system prompt）
	let userCount = 0;
	let insertIndex = 0;
	for (let i = 0; i < filtered.length; i++) {
		if (filtered[i].role === vscode.LanguageModelChatMessageRole.User) {
			userCount++;
			if (userCount === 2) {
				insertIndex = i;
				break;
			}
		}
	}

	// 如果只有一条 user 消息，插入到末尾
	if (userCount < 2) {
		insertIndex = filtered.length;
	}

	return [
		...filtered.slice(0, insertIndex),
		memoryMessage,
		...filtered.slice(insertIndex),
	];
}

/**
 * 检测是否是记忆注入的消息
 */
function isMemoryMessage(msg: vscode.LanguageModelChatRequestMessage): boolean {
	for (const part of msg.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			if (part.value.includes('<memory-context>')) {
				return true;
			}
		}
	}
	return false;
}

/**
 * 计算消息的 token 估算（用于日志）
 */
export function estimateTokens(messages: readonly vscode.LanguageModelChatRequestMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		for (const part of msg.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += Math.ceil(part.value.length / 4); // 粗略估算
			}
		}
	}
	return total;
}
