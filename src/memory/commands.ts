/**
 * 记忆相关命令注册
 * /mimo-remember, /mimo-forget, /mimo-memory
 */

import * as vscode from 'vscode';
import type { MemoryManager } from './manager';
import { MEMORY_TYPES, type MemoryType } from './types';
import { logger } from '../logger';

/**
 * 注册所有记忆相关命令
 */
export function registerMemoryCommands(
	context: vscode.ExtensionContext,
	memoryManager: MemoryManager,
): void {
	// /mimo-remember — 保存新记忆
	context.subscriptions.push(
		vscode.commands.registerCommand('mimo-copilot.remember', async () => {
			await handleRemember(memoryManager);
		}),
	);

	// /mimo-memory — 查看记忆列表
	context.subscriptions.push(
		vscode.commands.registerCommand('mimo-copilot.showMemory', async () => {
			await handleShowMemory(memoryManager);
		}),
	);

	// /mimo-forget — 删除记忆
	context.subscriptions.push(
		vscode.commands.registerCommand('mimo-copilot.forget', async () => {
			await handleForget(memoryManager);
		}),
	);

	// /mimo-memory stats — 查看记忆统计
	context.subscriptions.push(
		vscode.commands.registerCommand('mimo-copilot.showMemoryStats', async () => {
			await handleShowStats(memoryManager);
		}),
	);

	logger.info('[Memory] Commands registered');
}

/**
 * 处理 /mimo-remember 命令
 */
async function handleRemember(memoryManager: MemoryManager): Promise<void> {
	// 1. 输入记忆内容
	const content = await vscode.window.showInputBox({
		prompt: 'What should I remember?',
		placeHolder: 'e.g., I am a senior backend engineer specializing in Go',
		ignoreFocusOut: true,
	});
	if (!content) return;

	// 2. 选择记忆类型
	const typeItems: vscode.QuickPickItem[] = MEMORY_TYPES.map(t => ({
		label: t,
		description: getTypeDescription(t),
	}));

	const selectedType = await vscode.window.showQuickPick(typeItems, {
		placeHolder: 'Select memory type',
	});
	if (!selectedType) return;

	// 3. 输入描述
	const description = await vscode.window.showInputBox({
		prompt: 'Brief description (for memory index)',
		placeHolder: 'e.g., User role and expertise',
		value: content.substring(0, 80),
		ignoreFocusOut: true,
	});
	if (!description) return;

	// 4. 选择存储范围
	const scopeItems: vscode.QuickPickItem[] = [
		{ label: 'User (global)', description: 'Available across all projects' },
		{ label: 'Project', description: 'Only for current project' },
	];
	const selectedScope = await vscode.window.showQuickPick(scopeItems, {
		placeHolder: 'Where to save this memory?',
	});
	if (!selectedScope) return;

	// 5. 生成名称并保存（支持中文）
	const name = description.substring(0, 40)
		.replace(/[\r\n]/g, ' ')
		.trim()
		|| 'memory';
	const scope = selectedScope.label === 'Project' ? 'project' : 'user';

	try {
		const filePath = await memoryManager.saveMemory(
			name,
			description,
			selectedType.label,
			content,
			scope,
		);
		vscode.window.showInformationMessage(`Memory saved: ${filePath}`);
	} catch (e) {
		vscode.window.showErrorMessage(`Failed to save memory: ${e}`);
	}
}

/**
 * 处理 /mimo-memory 命令 — 显示记忆列表
 */
async function handleShowMemory(memoryManager: MemoryManager): Promise<void> {
	const { user, project } = await memoryManager.listMemories();

	const items: vscode.QuickPickItem[] = [];

	if (user.length > 0) {
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, description: 'User Memories' });
		for (const m of user) {
			const age = memoryAgeShort(m.mtimeMs);
			items.push({
				label: `$(file) ${m.filename}`,
				description: `[${m.type ?? '?'}] ${age}`,
				detail: m.description ?? '',
			});
		}
	}

	if (project.length > 0) {
		items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, description: 'Project Memories' });
		for (const m of project) {
			const age = memoryAgeShort(m.mtimeMs);
			items.push({
				label: `$(file) ${m.filename}`,
				description: `[${m.type ?? '?'}] ${age}`,
				detail: m.description ?? '',
			});
		}
	}

	if (items.length === 0) {
		vscode.window.showInformationMessage('No memories saved yet. Use /mimo-remember to save one.');
		return;
	}

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: `${user.length + project.length} memories`,
	});

	// 选中后打开文件（通过 label 匹配）
	if (selected) {
		const allMemories = [...user, ...project];
		const mem = allMemories.find(m => `$(file) ${m.filename}` === selected.label);
		if (mem) {
			try {
				const doc = await vscode.workspace.openTextDocument(mem.filePath);
				await vscode.window.showTextDocument(doc);
			} catch (e) {
				logger.warn('[Memory] Failed to open memory file:', e);
			}
		}
	}
}

/**
 * 处理 /mimo-forget 命令 — 删除记忆
 */
async function handleForget(memoryManager: MemoryManager): Promise<void> {
	const { user, project } = await memoryManager.listMemories();
	const all = [...user, ...project];

	if (all.length === 0) {
		vscode.window.showInformationMessage('No memories to forget.');
		return;
	}

	// 用 Map 建立 label → filePath 映射，避免同名文件误删
	const labelToPath = new Map<string, string>();
	const items: vscode.QuickPickItem[] = all.map(m => {
		const key = `${m.filename} [${m.type ?? '?'}]`;
		labelToPath.set(key, m.filePath);
		return {
			label: m.filename,
			description: `[${m.type ?? '?'}] ${m.description ?? ''}`,
		};
	});

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: 'Select memory to forget',
		canPickMany: true,
	});

	if (!selected || selected.length === 0) return;

	const confirm = await vscode.window.showWarningMessage(
		`Forget ${selected.length} memor${selected.length > 1 ? 'ies' : 'y'}?`,
		{ modal: true },
		'Forget',
	);

	if (confirm !== 'Forget') return;

	for (const item of selected) {
		// 通过 label 匹配（文件名通常唯一，同名文件极少）
		const mem = all.find(m => m.filename === item.label);
		if (mem) {
			try {
				await memoryManager.deleteMemory(mem.filePath);
			} catch (e) {
				logger.warn(`[Memory] Failed to delete ${mem.filePath}:`, e);
			}
		}
	}

	vscode.window.showInformationMessage(`Forgot ${selected.length} memor${selected.length > 1 ? 'ies' : 'y'}.`);
}

function getTypeDescription(type: MemoryType): string {
	switch (type) {
		case 'user': return 'Role, goals, knowledge level';
		case 'feedback': return 'Work approach guidance';
		case 'project': return 'Ongoing work context';
		case 'reference': return 'External system pointers';
	}
}

function memoryAgeShort(mtimeMs: number): string {
	const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	return `${days}d ago`;
}

/**
 * 处理 /mimo-memory stats 命令 — 显示记忆统计面板
 */
async function handleShowStats(memoryManager: MemoryManager): Promise<void> {
	const snapshot = await memoryManager.getStatsSnapshot();

	const items: vscode.QuickPickItem[] = [
		{ label: '📊 Memory Statistics', kind: vscode.QuickPickItemKind.Separator, description: '' },
		{ label: `Cache Hit Rate`, description: `${(snapshot.cache_hit_rate * 100).toFixed(1)}% (${snapshot.cache_hits}/${snapshot.cache_total})` },
		{ label: `Recall Latency P50`, description: `${snapshot.latency_p50.toFixed(0)}ms` },
		{ label: `Recall Latency P95`, description: `${snapshot.latency_p95.toFixed(0)}ms` },
		{ label: `Recall Latency P99`, description: `${snapshot.latency_p99.toFixed(0)}ms` },
		{ label: `Injection Tokens P50`, description: `${snapshot.token_p50.toFixed(0)} tokens` },
		{ label: `Injection Tokens P95`, description: `${snapshot.token_p95.toFixed(0)} tokens` },
		{ label: `Total Recalls`, description: `${snapshot.total_recalls}` },
		{ label: `Total Injections`, description: `${snapshot.total_injections}` },
		{ label: '', kind: vscode.QuickPickItemKind.Separator, description: '' },
		{ label: `User Memories`, description: `${snapshot.memory_count.user}` },
		{ label: `Project Memories`, description: `${snapshot.memory_count.project}` },
	];

	await vscode.window.showQuickPick(items, {
		placeHolder: `Last updated: ${new Date(snapshot.timestamp).toLocaleTimeString()}`,
	});
}
