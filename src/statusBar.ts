import * as vscode from 'vscode';

/**
 * Token usage status bar — shows real-time token stats in the bottom-right.
 * Clicking opens the provider configuration panel.
 */

let statusBarItem: vscode.StatusBarItem | undefined;

/** Create and register the token usage status bar item. */
export function initStatusBar(context: vscode.ExtensionContext): void {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusBarItem.name = 'MiMo Token Usage';
	statusBarItem.text = '$(symbol-numeric) Ready';
	statusBarItem.tooltip = 'Token usage — Click to open Provider Config';
	statusBarItem.command = 'mimo-copilot.openConfigView';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);
}

/**
 * Update the status bar with real API usage data.
 * Called from the `onUsage` callback during streaming.
 */
export function updateStatusBarFromUsage(usage: {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}, modelMaxInputTokens: number): void {
	if (!statusBarItem) { return; }

	const promptTokens = usage.prompt_tokens;
	const completionTokens = usage.completion_tokens;
	const totalTokens = usage.total_tokens;
	const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
	const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
	const cacheTotal = cacheHit + cacheMiss;
	const hitRate = cacheTotal > 0 ? ((cacheHit / cacheTotal) * 100).toFixed(0) : 'n/a';

	// Progress bar based on prompt usage vs context window
	const progressBar = createProgressBar(promptTokens, modelMaxInputTokens);
	const usagePercent = Math.min((promptTokens / modelMaxInputTokens) * 100, 100);

	statusBarItem.text = `$(symbol-parameter) ${progressBar}`;
	statusBarItem.tooltip = [
		`Token Usage — Click to open Provider Config`,
		``,
		`${progressBar}`,
		`  Prompt:       ${formatTokenCount(promptTokens)} / ${formatTokenCount(modelMaxInputTokens)} (${usagePercent.toFixed(1)}%)`,
		`  Completion:   ${formatTokenCount(completionTokens)}`,
		`  Total:        ${formatTokenCount(totalTokens)}`,
		`  Cache:        hit=${formatTokenCount(cacheHit)} miss=${formatTokenCount(cacheMiss)} rate=${hitRate}%`,
	].join('\n');

	// Color coding by context usage
	if (usagePercent >= 90) {
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	} else if (usagePercent >= 70) {
		statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else {
		statusBarItem.backgroundColor = undefined;
	}

	statusBarItem.show();
}

/**
 * Reset the status bar to the idle state.
 */
export function resetStatusBar(): void {
	if (!statusBarItem) { return; }
	statusBarItem.text = '$(symbol-numeric) Ready';
	statusBarItem.tooltip = 'Token usage — Click to open Provider Config';
	statusBarItem.backgroundColor = undefined;
}

// ---- Helpers ----

/** Format number to K/M/B shorthand. */
function formatTokenCount(value: number): string {
	if (value >= 1_000_000_000) {
		return (value / 1_000_000_000).toFixed(1) + 'B';
	} else if (value >= 1_000_000) {
		return (value / 1_000_000).toFixed(1) + 'M';
	} else if (value >= 1_000) {
		return (value / 1_000).toFixed(1) + 'K';
	}
	return value.toLocaleString();
}

/** Create a Unicode progress bar. */
function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
	const pct = Math.min((usedTokens / maxTokens) * 100, 100);
	const idx = Math.min(Math.floor((pct / 100) * blocks.length), blocks.length - 1);
	return `${blocks[idx]} ${pct.toFixed(1)}%`;
}
