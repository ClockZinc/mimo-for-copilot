import * as vscode from 'vscode';

/**
 * Token usage status bar — shows real-time token stats in the bottom-right.
 * Clicking opens the provider configuration panel.
 */

let statusBarItem: vscode.StatusBarItem | undefined;

export interface TokenCompressionDetails {
	beforePromptTokensEstimate?: number;
	afterPromptTokens?: number;
	ratio?: number;
	description?: string;
	notice?: string;
}

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
}, modelMaxInputTokens: number, compression?: TokenCompressionDetails): void {
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
	const compressionLines = formatCompressionTooltipLines(promptTokens, compression);
	statusBarItem.tooltip = [
		`Token Usage — Click to open Provider Config`,
		``,
		`${progressBar}`,
		`  Prompt:       ${formatTokenCount(promptTokens)} / ${formatTokenCount(modelMaxInputTokens)} (${usagePercent.toFixed(1)}%) actual after compression`,
		`  Completion:   ${formatTokenCount(completionTokens)}`,
		`  Total:        ${formatTokenCount(totalTokens)}`,
		`  Cache:        hit=${formatTokenCount(cacheHit)} miss=${formatTokenCount(cacheMiss)} rate=${hitRate}%`,
		``,
		...compressionLines,
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

function formatCompressionTooltipLines(
	promptTokens: number,
	compression?: TokenCompressionDetails,
): string[] {
	const fallbackRatio = compression?.ratio && Number.isFinite(compression.ratio) && compression.ratio > 0
		? compression.ratio
		: 1;
	if (!compression || !compression.beforePromptTokensEstimate || compression.beforePromptTokensEstimate <= promptTokens) {
		return [
			'Compression:',
			`  Prompt tokens shown above are the actual API value after MiMo preprocessing/compression.`,
			`  Compression ratio:             ${fallbackRatio.toFixed(2)}x${fallbackRatio === 1 ? ' (no MiMo compression detected for this request)' : ''}`,
			compression?.notice
				? `  ${compression.notice}`
				: `  Compression chat notices can be turned off in the Provider Configuration UI.`,
		];
	}

	const before = Math.max(promptTokens, Math.round(compression.beforePromptTokensEstimate));
	const after = Math.max(1, Math.round(compression.afterPromptTokens ?? promptTokens));
	const ratio = compression.ratio && Number.isFinite(compression.ratio) && compression.ratio > 0
		? compression.ratio
		: before / after;
	const savedPercent = Math.max(0, Math.min(99.9, (1 - after / before) * 100));
	return [
		`Compression${compression.description ? ` — ${compression.description}` : ''}:`,
		`  Before compression (estimated): ${formatTokenCount(before)}`,
		`  After compression (actual):    ${formatTokenCount(after)}`,
		`  Compression ratio:             ${ratio.toFixed(2)}x (${savedPercent.toFixed(1)}% saved)`,
		compression.notice
			? `  ${compression.notice}`
			: `  Compression chat notices can be turned off in the Provider Configuration UI.`,
	];
}

/** Create a Unicode progress bar. */
function createProgressBar(usedTokens: number, maxTokens: number): string {
	const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
	const pct = Math.min((usedTokens / maxTokens) * 100, 100);
	const idx = Math.min(Math.floor((pct / 100) * blocks.length), blocks.length - 1);
	return `${blocks[idx]} ${pct.toFixed(1)}%`;
}
