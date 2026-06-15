import * as vscode from 'vscode';
import { getOutputRateChartStyle, getOutputRateTooltipRefreshSeconds, getResponsesMaxNoFeedbackReconnectAttempts, getResponsesNoFeedbackReconnectEnabled, getResponsesNoFeedbackReconnectSeconds, getWaitingForResponseThresholdSeconds } from './config';
import { CONFIG_SECTION } from './consts';
import { t } from './i18n';

/**
 * Token usage status bar — shows real-time token stats in the bottom-right.
 * Clicking opens the provider configuration panel.
 */

let statusBarItem: vscode.StatusBarItem | undefined;
let outputRateStatusBarItem: vscode.StatusBarItem | undefined;
let outputRateTimer: NodeJS.Timeout | undefined;
let outputRateSessionId = 0;
let outputRateStartedAt = 0;
let outputRateChars = 0;
let outputRateCharsPerToken = 4;
let outputRateFirstTokenAt = 0;
let outputRateLastSampleTokens = 0;
let outputRateLastSampleAt = 0;
let outputRateLastInstantRate = 0;
let outputRateSmoothedRate = 0;
let outputRateSamples: OutputRateSample[] = [];
let lastOutputRateSnapshot: OutputRateSnapshot | undefined;
let outputRateWaitingThresholdMs = 15_000;
let outputRateStopped = false;
let outputRateResetTimer: NodeJS.Timeout | undefined;
let outputRateConnectionState: OutputRateConnectionState = 'none';
let outputRateConnectionStartedAt = 0;
let outputRateConnectionAttempt = 0;
let outputRateConnectionMaxAttempts = 0;
let outputRateConnectionMessage = '';
let outputRateStreamKind: OutputRateStreamKind = 'idle';
let outputRateToolSeq = 0;
let outputRateActiveToolKey: string | undefined;
let outputRateTools = new Map<string, OutputRateToolState>();

const OUTPUT_RATE_UPDATE_MS = 100;
const OUTPUT_RATE_IDLE_RESET_MS = 2_000;
const OUTPUT_RATE_HISTORY_MS = 3 * 60 * 1000;
export const OPEN_OUTPUT_RATE_PANEL_COMMAND = 'mimo-copilot.openOutputRatePanel';

let outputRateTooltipLastUpdatedAt = 0;
let outputRateCachedTooltip = '';

export type OutputRateStreamKind = 'idle' | 'text' | 'thinking' | 'tool';

type OutputRateConnectionState = 'none' | 'reset' | 'error';

export interface OutputRateToolDeltaInfo {
	id?: string;
	index?: number;
	name?: string;
	field?: 'name' | 'arguments';
}

interface OutputRateToolState {
	id: string;
	index?: number;
	name: string;
	argumentChars: number;
	updatedAt: number;
}

interface OutputRateSample {
	at: number;
	rate: number;
	averageRate: number;
	currentRate: number;
	smoothedRate: number;
	outputTokens: number;
	sessionId: number;
	active: boolean;
	waiting: boolean;
	streamKind: OutputRateStreamKind;
	connectionState: OutputRateConnectionState;
	activeToolName?: string;
	toolCount: number;
}

interface ResponsesRuntimeSettings {
	waitingForResponseThresholdSeconds: number;
	enableNoFeedbackReconnect: boolean;
	noFeedbackReconnectSeconds: number;
	maxNoFeedbackReconnectAttempts: number;
	outputRateTooltipRefreshSeconds: number;
	outputRateChartStyle: 'classic' | 'neon' | 'hybrid';
}

export interface TokenCompressionDetails {
	beforePromptTokensEstimate?: number;
	afterPromptTokens?: number;
	ratio?: number;
	description?: string;
	notice?: string;
}

interface OutputRateSnapshot {
	active: boolean;
	averageRate: number;
	currentRate: number;
	smoothedRate: number;
	firstTokenMs?: number;
	outputTokens: number;
	outputChars: number;
	elapsedSeconds: number;
	charsPerToken: number;
	updateMs: number;
	samples: OutputRateSample[];
	updatedAt: number;
	waiting: boolean;
	waitingSeconds: number;
	waitingThresholdSeconds: number;
	streamKind: OutputRateStreamKind;
	connectionState: OutputRateConnectionState;
	connectionAttempt: number;
	connectionMaxAttempts: number;
	connectionMessage: string;
	activeToolName?: string;
	tools: OutputRateToolState[];
}

/** Create and register the token usage status bar item. */
export function initStatusBar(context: vscode.ExtensionContext): void {
	statusBarItem = vscode.window.createStatusBarItem('mimo-copilot.tokenUsage', vscode.StatusBarAlignment.Right, 100);
	statusBarItem.name = 'MiMo Token Usage';
	statusBarItem.text = '$(symbol-numeric) Ready';
	statusBarItem.tooltip = 'Token usage — Click to open Provider Config';
	statusBarItem.command = 'mimo-copilot.openConfigView';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	outputRateStatusBarItem = vscode.window.createStatusBarItem('mimo-copilot.outputTokenRate', vscode.StatusBarAlignment.Right, 110);
	outputRateStatusBarItem.name = 'MiMo Output Token Rate';
	outputRateStatusBarItem.text = formatCompactOutputRateStatus('idle', 0);
	refreshOutputRateTooltip(true);
	outputRateStatusBarItem.command = OPEN_OUTPUT_RATE_PANEL_COMMAND;
	outputRateStatusBarItem.show();
	context.subscriptions.push(outputRateStatusBarItem);
}

export function openOutputRatePanel(): void {
	OutputRatePanel.open();
}

export function startOutputTokenRate(charsPerToken = 4): number {
	outputRateSessionId += 1;
	outputRateStartedAt = Date.now();
	outputRateChars = 0;
	outputRateCharsPerToken = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : 4;
	outputRateFirstTokenAt = 0;
	outputRateLastSampleTokens = 0;
	outputRateLastSampleAt = outputRateStartedAt;
	outputRateLastInstantRate = 0;
	outputRateSmoothedRate = 0;
	outputRateStreamKind = 'idle';
	resetOutputRateTools();
	pruneOutputRateSamples(outputRateStartedAt);
	outputRateStopped = false;
	clearOutputRateConnectionStatus();
	if (outputRateResetTimer) {
		clearTimeout(outputRateResetTimer);
		outputRateResetTimer = undefined;
	}
	outputRateWaitingThresholdMs = getWaitingForResponseThresholdSeconds() * 1000;
	if (outputRateTimer) {
		clearInterval(outputRateTimer);
	}
	updateOutputRateStatusBar(outputRateSessionId, true);
	outputRateTimer = setInterval(() => {
		updateOutputRateStatusBar(outputRateSessionId, true);
	}, OUTPUT_RATE_UPDATE_MS);
	return outputRateSessionId;
}

export function setOutputTokenRateConnectionStatus(
	sessionId: number,
	status: {
		state: 'reset' | 'error' | 'clear';
		attempt?: number;
		maxAttempts?: number;
		startedAt?: number;
		message?: string;
	},
): void {
	if (sessionId !== outputRateSessionId) {
		return;
	}
	if (status.state === 'clear') {
		clearOutputRateConnectionStatus();
		updateOutputRateStatusBar(sessionId, !outputRateStopped);
		return;
	}
	outputRateConnectionState = status.state;
	outputRateConnectionStartedAt = status.startedAt ?? Date.now();
	outputRateConnectionAttempt = status.attempt ?? 0;
	outputRateConnectionMaxAttempts = status.maxAttempts ?? 0;
	outputRateConnectionMessage = status.message ?? '';
	updateOutputRateStatusBar(sessionId, !outputRateStopped);
}

export function recordOutputTokenText(
	sessionId: number,
	text: string,
	kind: Exclude<OutputRateStreamKind, 'idle'> = 'text',
	toolInfo?: OutputRateToolDeltaInfo,
): void {
	if (sessionId !== outputRateSessionId || !text) {
		return;
	}
	if (!outputRateFirstTokenAt) {
		outputRateFirstTokenAt = Date.now();
	}
	outputRateStreamKind = kind;
	if (kind === 'tool') {
		recordOutputRateToolDelta(text, toolInfo);
	}
	outputRateChars += text.length;
}

export function stopOutputTokenRate(sessionId: number, completionTokens?: number): void {
	if (sessionId !== outputRateSessionId) {
		return;
	}
	if (outputRateStopped) {
		return;
	}
	if (outputRateTimer) {
		clearInterval(outputRateTimer);
		outputRateTimer = undefined;
	}
	updateOutputRateStatusBar(sessionId, false, completionTokens);
	outputRateStopped = true;
	scheduleOutputRateIdleReset(sessionId);
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

export function resetOutputTokenRate(): void {
	if (outputRateTimer) {
		clearInterval(outputRateTimer);
		outputRateTimer = undefined;
	}
	outputRateStartedAt = 0;
	outputRateChars = 0;
	outputRateFirstTokenAt = 0;
	outputRateLastSampleTokens = 0;
	outputRateLastSampleAt = 0;
	outputRateLastInstantRate = 0;
	outputRateSmoothedRate = 0;
	outputRateStreamKind = 'idle';
	resetOutputRateTools();
	pruneOutputRateSamples(Date.now());
	outputRateStopped = false;
	clearOutputRateConnectionStatus();
	if (outputRateResetTimer) {
		clearTimeout(outputRateResetTimer);
		outputRateResetTimer = undefined;
	}
	if (!outputRateStatusBarItem) { return; }
	outputRateStatusBarItem.text = formatCompactOutputRateStatus('idle', 0);
	refreshOutputRateTooltip(true);
	outputRateStatusBarItem.backgroundColor = undefined;
	outputRateStatusBarItem.show();
	OutputRatePanel.postSnapshot(lastOutputRateSnapshot);
}

// ---- Helpers ----

function updateOutputRateStatusBar(sessionId: number, active: boolean, completionTokens?: number): void {
	if (!outputRateStatusBarItem || sessionId !== outputRateSessionId) {
		return;
	}
	const elapsedMs = Math.max(1, Date.now() - outputRateStartedAt);
	const elapsedSeconds = elapsedMs / 1000;
	const estimatedTokens = Math.max(0, outputRateChars / outputRateCharsPerToken);
	const now = Date.now();
	const firstTokenMs = outputRateFirstTokenAt > 0 ? outputRateFirstTokenAt - outputRateStartedAt : undefined;
	const waiting = active && firstTokenMs === undefined;
	const rawInstantRate = active
		? sampleOutputRate(now, estimatedTokens, active, waiting)
		: outputRateLastInstantRate;
	const smoothedRate = outputRateSmoothedRate;
	const displayTokens = typeof completionTokens === 'number' && completionTokens >= 0
		? completionTokens
		: estimatedTokens;
	const rate = elapsedSeconds > 0 ? displayTokens / elapsedSeconds : 0;
	const waitingSeconds = waiting ? elapsedSeconds : 0;
	const snapshotStreamKind = firstTokenMs === undefined ? 'idle' : outputRateStreamKind;
	lastOutputRateSnapshot = {
		active,
		averageRate: rate,
		currentRate: rawInstantRate,
		smoothedRate,
		firstTokenMs,
		outputTokens: displayTokens,
		outputChars: outputRateChars,
		elapsedSeconds,
		charsPerToken: outputRateCharsPerToken,
		updateMs: OUTPUT_RATE_UPDATE_MS,
		samples: [...outputRateSamples],
		updatedAt: now,
		waiting,
		waitingSeconds,
		waitingThresholdSeconds: outputRateWaitingThresholdMs / 1000,
		streamKind: snapshotStreamKind,
		connectionState: outputRateConnectionState,
		connectionAttempt: outputRateConnectionAttempt,
		connectionMaxAttempts: outputRateConnectionMaxAttempts,
		connectionMessage: outputRateConnectionMessage,
		activeToolName: getActiveToolName(),
		tools: [...outputRateTools.values()].sort((left, right) => left.updatedAt - right.updatedAt),
	};
	if (outputRateConnectionState === 'error') {
		const errorElapsedMs = outputRateConnectionStartedAt > 0 ? Math.max(0, Date.now() - outputRateConnectionStartedAt) : 0;
		outputRateStatusBarItem.text = formatCompactOutputRateStatus('error', errorElapsedMs, { icon: '$(error)', valueKind: 'time' });
		outputRateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	} else if (outputRateConnectionState === 'reset') {
		const resetElapsedMs = Math.max(0, Date.now() - outputRateConnectionStartedAt);
		const resetLabel = outputRateConnectionMaxAttempts > 0
			? `r${Math.min(9, Math.max(0, outputRateConnectionAttempt))}/${Math.min(9, Math.max(0, outputRateConnectionMaxAttempts))}`
			: 'reset';
		outputRateStatusBarItem.text = formatCompactOutputRateStatus(resetLabel, resetElapsedMs, { icon: '$(sync~spin)', valueKind: 'time' });
		outputRateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else {
		outputRateStatusBarItem.text = formatOutputRateStatusText(lastOutputRateSnapshot);
		outputRateStatusBarItem.backgroundColor = undefined;
	}
	refreshOutputRateTooltip(!active);
	outputRateStatusBarItem.show();
	OutputRatePanel.postSnapshot(lastOutputRateSnapshot);
}

function refreshOutputRateTooltip(force = false): void {
	if (!outputRateStatusBarItem) {
		return;
	}
	const now = Date.now();
	const refreshMs = getOutputRateTooltipRefreshSeconds() * 1000;
	if (!force && outputRateCachedTooltip && now - outputRateTooltipLastUpdatedAt < refreshMs) {
		return;
	}
	outputRateCachedTooltip = getStableOutputRateTooltip();
	outputRateTooltipLastUpdatedAt = now;
	outputRateStatusBarItem.tooltip = outputRateCachedTooltip;
}

function formatOutputRateStatusText(snapshot: OutputRateSnapshot): string {
	if (!snapshot.active) {
		return formatCompactOutputRateStatus('idle', 0);
	}
	if (snapshot.waiting) {
		return formatCompactOutputRateStatus('wait', snapshot.elapsedSeconds * 1000, { icon: '$(watch)', valueKind: 'time' });
	}
	const kind = snapshot.streamKind === 'idle' ? 'text' : snapshot.streamKind;
	if (kind === 'tool') {
		if (snapshot.tools.length > 1) {
			return formatCompactOutputRateStatus(`tl:${formatCompactCount(snapshot.tools.length)}`, snapshot.averageRate);
		}
		const toolLabel = formatOutputRateToolLabel(snapshot.activeToolName);
		return formatCompactOutputRateStatus(toolLabel, snapshot.averageRate);
	}
	return formatCompactOutputRateStatus(kind === 'thinking' ? 'think' : kind, snapshot.averageRate);
}

function formatCompactOutputRateStatus(
	label: string,
	value: number,
	options: { icon?: string; valueKind?: 'rate' | 'time' } = {},
): string {
	const icon = options.icon ?? '$(pulse)';
	const valueText = options.valueKind === 'time'
		? formatCompactDuration(value)
		: formatCompactRate(value);
	return `${icon} ${valueText} ${formatCompactStatusLabel(label)}`;
}

function formatCompactRate(rate: number): string {
	const clamped = Math.min(99.9, Math.max(0, Number.isFinite(rate) ? rate : 0));
	return `${clamped.toFixed(1).padStart(4, ' ')}tk/s`;
}

function formatCompactDuration(ms: number): string {
	const seconds = Math.max(0, Number.isFinite(ms) ? ms / 1000 : 0);
	const clamped = Math.min(99.99, seconds);
	return `${clamped.toFixed(2).padStart(5, ' ')}s`;
}

function formatCompactStatusLabel(label: string): string {
	const normalized = label.trim() || 'idle';
	return normalized.slice(0, 6).padEnd(6, ' ');
}

function formatCompactCount(count: number): string {
	if (count > 9) {
		return '9';
	}
	return String(Math.max(0, count));
}

function formatOutputRateToolLabel(name: string | undefined): string {
	const raw = (name || '').trim();
	if (!raw) {
		return 'tool';
	}
	const aliases: Record<string, string> = {
		read_file: 'read',
		grep_search: 'grep',
		file_search: 'find',
		semantic_search: 'sem',
		apply_patch: 'patch',
		run_in_terminal: 'term',
		get_terminal_output: 'term',
		get_errors: 'errs',
		manage_todo_list: 'todo',
		task_complete: 'done',
		fetch_webpage: 'web',
		vscode_askQuestions: 'ask',
		memory: 'memory',
	};
	if (aliases[raw]) {
		return aliases[raw];
	}
	const compacted = raw
		.replace(/^functions[._-]/i, '')
		.replace(/^vscode[_-]/i, '')
		.replace(/[_\s-]+/g, '')
		.replace(/[^a-zA-Z0-9]/g, '');
	return (compacted || 'tool').slice(0, 6).toLowerCase();
}

function recordOutputRateToolDelta(text: string, info?: OutputRateToolDeltaInfo): void {
	const key = info?.id || (typeof info?.index === 'number' ? `index:${info.index}` : outputRateActiveToolKey) || `tool:${++outputRateToolSeq}`;
	const existing = outputRateTools.get(key);
	const name = info?.field === 'name'
		? `${existing?.name ?? ''}${text}`
		: info?.name ?? existing?.name ?? '';
	const tool: OutputRateToolState = {
		id: key,
		index: info?.index ?? existing?.index,
		name,
		argumentChars: (existing?.argumentChars ?? 0) + (info?.field === 'arguments' || !info?.field ? text.length : 0),
		updatedAt: Date.now(),
	};
	outputRateTools.set(key, tool);
	outputRateActiveToolKey = key;
}

function getActiveToolName(): string | undefined {
	if (!outputRateActiveToolKey) {
		return undefined;
	}
	const name = outputRateTools.get(outputRateActiveToolKey)?.name?.trim();
	return name || undefined;
}

function resetOutputRateTools(): void {
	outputRateToolSeq = 0;
	outputRateActiveToolKey = undefined;
	outputRateTools = new Map<string, OutputRateToolState>();
}

function clearOutputRateConnectionStatus(): void {
	outputRateConnectionState = 'none';
	outputRateConnectionStartedAt = 0;
	outputRateConnectionAttempt = 0;
	outputRateConnectionMaxAttempts = 0;
	outputRateConnectionMessage = '';
}

function scheduleOutputRateIdleReset(sessionId: number): void {
	if (outputRateResetTimer) {
		clearTimeout(outputRateResetTimer);
	}
	outputRateResetTimer = setTimeout(() => {
		if (sessionId === outputRateSessionId && outputRateStopped) {
			resetOutputTokenRate();
		}
	}, OUTPUT_RATE_IDLE_RESET_MS);
}

interface OutputRateQuickPickItem extends vscode.QuickPickItem {
	kind?: vscode.QuickPickItemKind;
}

class OutputRatePeek {
	private static quickPick: vscode.QuickPick<OutputRateQuickPickItem> | undefined;

	static open(): void {
		if (!this.quickPick) {
			const quickPick = vscode.window.createQuickPick<OutputRateQuickPickItem>();
			quickPick.title = 'MiMo Output Rate';
			quickPick.placeholder = '实时输出速率 · 失焦后自动关闭';
			quickPick.matchOnDescription = false;
			quickPick.matchOnDetail = false;
			quickPick.ignoreFocusOut = false;
			quickPick.onDidHide(() => {
				quickPick.dispose();
				this.quickPick = undefined;
			});
			this.quickPick = quickPick;
		}
		this.update(lastOutputRateSnapshot);
		this.quickPick.show();
	}

	static update(snapshot: OutputRateSnapshot | undefined): void {
		if (!this.quickPick) {
			return;
		}
		this.quickPick.busy = !!snapshot?.active && !snapshot.firstTokenMs;
		this.quickPick.items = createOutputRateQuickPickItems(snapshot);
	}
}

function createOutputRateQuickPickItems(snapshot: OutputRateSnapshot | undefined): OutputRateQuickPickItem[] {
	if (!snapshot) {
		return [
			{ label: '$(pulse) idle tok/s', detail: '等待下一次 API 输出。' },
		];
	}
	const firstToken = snapshot.firstTokenMs !== undefined ? formatDuration(snapshot.firstTokenMs) : 'waiting...';
	const sparkline = createSparkline(snapshot.samples.map(sample => sample.rate), 42);
	const outputTokenKind = Number.isInteger(snapshot.outputTokens) ? 'actual/final if API usage arrived' : 'estimated from streamed chars';
	return [
		...(snapshot.waiting ? [{ label: `$(watch) Waiting ${formatDuration(snapshot.elapsedSeconds * 1000)}`, detail: `超过 ${formatDuration(snapshot.waitingThresholdSeconds * 1000)} 未收到首 token。` }] : []),
		{ label: `$(pulse) Average  ${snapshot.averageRate.toFixed(2)} tok/s`, detail: `Total output: ${formatTokenCount(Math.round(snapshot.outputTokens))} tokens · ${snapshot.outputChars} chars` },
		{ label: `$(dashboard) Current  ${snapshot.currentRate.toFixed(2)} tok/s`, detail: `最近 ${(snapshot.updateMs / 1000).toFixed(2)}s 采样窗口，按真实时间差计算。` },
		{ label: `$(watch) First token  ${firstToken}`, detail: '从发出请求到收到首个 token。' },
		{ label: `$(history) Elapsed  ${snapshot.elapsedSeconds.toFixed(2)}s`, detail: snapshot.active ? 'streaming...' : 'final' },
		{ label: `$(graph-line) Last 3 min  ${sparkline}`, detail: '轻量浮层只显示 sparkline；详细 SVG 面板已不再默认打开。' },
		{ label: `$(symbol-keyword) Rate source  ${outputTokenKind}`, detail: `${snapshot.charsPerToken.toFixed(2)} chars/token used for live estimate.` },
	];
}

class OutputRatePanel {
	private static currentPanel: vscode.WebviewPanel | undefined;
	private static closeOnBlurTimer: NodeJS.Timeout | undefined;

	static open(): void {
		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One);
			this.postSnapshot(lastOutputRateSnapshot);
			this.postResponsesRuntimeSettings();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'mimo-copilot.outputRatePanel',
			'MiMo Output Rate',
			vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		this.currentPanel = panel;
		panel.webview.html = this.getHtml();
		panel.webview.onDidReceiveMessage((message: { type?: string; settings?: ResponsesRuntimeSettings }) => {
			if (message.type === 'saveResponsesRuntimeSettings' && message.settings) {
				void this.saveResponsesRuntimeSettings(message.settings);
			}
		});
		panel.onDidChangeViewState((event) => {
			if (!event.webviewPanel.active) {
				this.closeOnBlurTimer = setTimeout(() => {
					if (this.currentPanel && !this.currentPanel.active) {
						this.currentPanel.dispose();
					}
				}, 150);
				return;
			}

			if (this.closeOnBlurTimer) {
				clearTimeout(this.closeOnBlurTimer);
				this.closeOnBlurTimer = undefined;
			}
		});
		panel.onDidDispose(() => {
			if (this.closeOnBlurTimer) {
				clearTimeout(this.closeOnBlurTimer);
				this.closeOnBlurTimer = undefined;
			}
			this.currentPanel = undefined;
		});
		this.postSnapshot(lastOutputRateSnapshot);
		this.postResponsesRuntimeSettings();
	}

	static postSnapshot(snapshot: OutputRateSnapshot | undefined): void {
		this.currentPanel?.webview.postMessage({ type: 'outputRateSnapshot', snapshot });
	}

	private static postResponsesRuntimeSettings(): void {
		this.currentPanel?.webview.postMessage({
			type: 'responsesRuntimeSettings',
			settings: getResponsesRuntimeSettings(),
		});
	}

	private static async saveResponsesRuntimeSettings(settings: ResponsesRuntimeSettings): Promise<void> {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const clamp = (value: number, fallback: number, min: number, max: number) => {
			const numeric = Number(value);
			return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback;
		};
		await config.update(
			'responses.waitingForResponseThresholdSeconds',
			clamp(settings.waitingForResponseThresholdSeconds, 15, 1, 300),
			vscode.ConfigurationTarget.Global,
		);
		await config.update(
			'responses.enableNoFeedbackReconnect',
			settings.enableNoFeedbackReconnect !== false,
			vscode.ConfigurationTarget.Global,
		);
		await config.update(
			'responses.noFeedbackReconnectSeconds',
			clamp(settings.noFeedbackReconnectSeconds, 30, 5, 600),
			vscode.ConfigurationTarget.Global,
		);
		await config.update(
			'responses.maxNoFeedbackReconnectAttempts',
			clamp(settings.maxNoFeedbackReconnectAttempts, 3, 1, 10),
			vscode.ConfigurationTarget.Global,
		);
		await config.update(
			'responses.outputRateTooltipRefreshSeconds',
			clamp(settings.outputRateTooltipRefreshSeconds, 2, 1, 30),
			vscode.ConfigurationTarget.Global,
		);
		await config.update(
			'outputRate.chartStyle',
			settings.outputRateChartStyle === 'neon' || settings.outputRateChartStyle === 'hybrid'
				? settings.outputRateChartStyle
				: 'classic',
			vscode.ConfigurationTarget.Global,
		);
		outputRateWaitingThresholdMs = getWaitingForResponseThresholdSeconds() * 1000;
		vscode.window.showInformationMessage(t('configView.responses.saved'));
		this.postResponsesRuntimeSettings();
	}

	private static getHtml(): string {
		const nonce = String(Date.now());
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>MiMo Output Rate</title>
<style>
	body { margin: 0; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
	.wrap { max-width: 980px; margin: 0 auto; }
	.grid { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 12px; margin-bottom: 18px; }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); }
	.settings { margin-top: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); }
	.settings summary { cursor: pointer; font-weight: 700; }
	.form-grid { display: grid; grid-template-columns: repeat(3, minmax(180px, 1fr)); gap: 12px; margin-top: 12px; }
	.field label { display: block; font-size: 12px; opacity: .82; margin-bottom: 5px; }
	.field input, .field select { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 6px 8px; }
	.field input[type="checkbox"] { width: auto; }
	.hint { opacity: .68; font-size: 12px; margin-top: 5px; line-height: 1.35; }
	.actions { margin-top: 12px; }
	button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; padding: 6px 12px; cursor: pointer; }
	button:hover { background: var(--vscode-button-hoverBackground); }
	.label { opacity: .72; font-size: 12px; margin-bottom: 6px; }
	.value { font-size: 22px; font-weight: 700; white-space: nowrap; }
	.sub { opacity: .72; font-size: 12px; margin-top: 4px; }
	:root {
		--mimo-rainbow-wait: #ff4d6d;
		--mimo-rainbow-thinking: #ff9f1c;
		--mimo-rainbow-text: #ffd166;
		--mimo-rainbow-tool: #2ec4b6;
		--mimo-rainbow-reset: #4dabf7;
		--mimo-rainbow-error: #b197fc;
		--mimo-rainbow-idle: var(--vscode-descriptionForeground);
	}
	.chart { border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 12px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); }
	svg { width: 100%; height: 320px; display: block; overflow: visible; }
	.axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
	.grid-line { stroke: var(--vscode-panel-border); stroke-width: 1; opacity: .35; }
	.line { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
	.area { fill: var(--vscode-charts-blue); opacity: .12; }
	.dot { fill: var(--vscode-charts-blue); }
	.line.thin { stroke-width: 2.5; opacity: .86; }
	.line.glow-base { stroke-width: 7; opacity: .2; filter: drop-shadow(0 0 7px currentColor); }
	.rate-bar { opacity: .18; }
	.rate-bar.state-wait { fill: var(--mimo-rainbow-wait); }
	.rate-bar.state-thinking { fill: var(--mimo-rainbow-thinking); }
	.rate-bar.state-text { fill: var(--mimo-rainbow-text); }
	.rate-bar.state-tool { fill: var(--mimo-rainbow-tool); }
	.rate-bar.state-reset { fill: var(--mimo-rainbow-reset); }
	.rate-bar.state-error { fill: var(--mimo-rainbow-error); }
	.rate-bar.state-idle { fill: var(--mimo-rainbow-idle); }
	.chart.neon .line.thin { stroke-width: 3.2; opacity: .96; filter: drop-shadow(0 0 5px currentColor); }
	.chart.neon .dot { filter: drop-shadow(0 0 4px currentColor); }
	.chart.hybrid .area { opacity: .07; }
	.line.state-wait { stroke: var(--mimo-rainbow-wait); }
	.line.state-thinking { stroke: var(--mimo-rainbow-thinking); }
	.line.state-text { stroke: var(--mimo-rainbow-text); }
	.line.state-tool { stroke: var(--mimo-rainbow-tool); }
	.line.state-reset { stroke: var(--mimo-rainbow-reset); stroke-dasharray: 8 5; }
	.line.state-error { stroke: var(--mimo-rainbow-error); stroke-dasharray: 4 4; opacity: .9; }
	.line.state-idle { stroke: var(--mimo-rainbow-idle); opacity: .48; }
	.dot.state-wait { fill: var(--mimo-rainbow-wait); }
	.dot.state-thinking { fill: var(--mimo-rainbow-thinking); }
	.dot.state-text { fill: var(--mimo-rainbow-text); }
	.dot.state-tool { fill: var(--mimo-rainbow-tool); }
	.dot.state-reset { fill: var(--mimo-rainbow-reset); }
	.dot.state-error { fill: var(--mimo-rainbow-error); }
	.dot.state-idle { fill: var(--mimo-rainbow-idle); opacity: .55; }
	.state-band { opacity: .32; }
	.state-band.state-wait { fill: var(--mimo-rainbow-wait); }
	.state-band.state-thinking { fill: var(--mimo-rainbow-thinking); }
	.state-band.state-text { fill: var(--mimo-rainbow-text); }
	.state-band.state-tool { fill: var(--mimo-rainbow-tool); }
	.state-band.state-reset { fill: var(--mimo-rainbow-reset); }
	.state-band.state-error { fill: var(--mimo-rainbow-error); opacity: .42; }
	.state-band.state-idle { fill: var(--mimo-rainbow-idle); opacity: .18; }
	.legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; font-size: 12px; opacity: .62; }
	.legend-item { display: inline-flex; align-items: center; gap: 5px; }
	.swatch { width: 9px; height: 9px; border-radius: 999px; display: inline-block; opacity: .68; }
	.swatch.state-wait { background: var(--mimo-rainbow-wait); }
	.swatch.state-thinking { background: var(--mimo-rainbow-thinking); }
	.swatch.state-text { background: var(--mimo-rainbow-text); }
	.swatch.state-tool { background: var(--mimo-rainbow-tool); }
	.swatch.state-reset { background: var(--mimo-rainbow-reset); }
	.swatch.state-error { background: var(--mimo-rainbow-error); }
	.swatch.state-idle { background: var(--mimo-rainbow-idle); opacity: .45; }
	.empty { opacity: .65; text-align: center; padding: 48px 0; }
	.footer { opacity: .72; margin-top: 10px; font-size: 12px; }
	.stats { margin-top: 18px; border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 12px; background: color-mix(in srgb, var(--vscode-editor-background) 91%, var(--vscode-foreground) 9%); }
	.stats-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
	.stats-controls { display: inline-flex; align-items: center; gap: 10px; }
	.stats-title strong { font-size: 13px; }
	.stats-title span { font-size: 12px; opacity: .68; }
	.stats-title label { font-size: 12px; opacity: .72; }
	.stats-title select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
	.stats-table { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
	.stats-table th:nth-child(1), .stats-table td:nth-child(1) { width: 32%; }
	.stats-table th:nth-child(2), .stats-table td:nth-child(2) { width: 11%; }
	.stats-table th:nth-child(3), .stats-table td:nth-child(3) { width: 24%; }
	.stats-table th:nth-child(4), .stats-table td:nth-child(4) { width: 10%; }
	.stats-table th:nth-child(5), .stats-table td:nth-child(5) { width: 23%; }
	.stats-table th, .stats-table td { padding: 7px 8px; border-top: 1px solid var(--vscode-panel-border); text-align: right; white-space: nowrap; }
	.stats-table th:first-child, .stats-table td:first-child { text-align: left; }
	.stats-table th { opacity: .68; font-weight: 600; }
	.stats-name { display: inline-flex; align-items: center; gap: 6px; }
	.stats-percent { display: grid; grid-template-columns: minmax(84px, 1fr) 48px; align-items: center; gap: 8px; }
	.stats-bar { width: 100%; height: 7px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-editor-background) 72%, var(--vscode-foreground) 28%); overflow: hidden; display: block; }
	.stats-fill { display: block; height: 100%; border-radius: inherit; background: var(--vscode-charts-blue); }
	.stats-percent-text { text-align: right; font-variant-numeric: tabular-nums; }
	.stats-fill.state-wait { background: var(--mimo-rainbow-wait); }
	.stats-fill.state-thinking { background: var(--mimo-rainbow-thinking); }
	.stats-fill.state-text { background: var(--mimo-rainbow-text); }
	.stats-fill.state-tool { background: var(--mimo-rainbow-tool); }
	.stats-fill.state-reset { background: var(--mimo-rainbow-reset); }
	.stats-fill.state-error { background: var(--mimo-rainbow-error); }
	.stats-fill.state-idle { background: var(--mimo-rainbow-idle); }
	.stats-muted { opacity: .62; }
</style>
</head>
<body>
<div class="wrap">
	<h2>MiMo Output Rate</h2>
	<div class="grid">
		<div class="card"><div class="label">Average Rate</div><div id="avg" class="value">—</div><div class="sub">tokens / second</div></div>
		<div class="card"><div class="label">Current Rate</div><div id="cur" class="value">—</div><div class="sub">last 0.5s window</div></div>
		<div class="card"><div class="label">First Token</div><div id="first" class="value">—</div><div class="sub">request → first token</div></div>
		<div class="card"><div class="label">Elapsed</div><div id="elapsed" class="value">—</div><div class="sub" id="active">idle</div></div>
	</div>
	<div class="chart" id="chart">
		<svg id="svg" viewBox="0 0 920 320" preserveAspectRatio="none"></svg>
		<div id="empty" class="empty">Waiting for output rate samples…</div>
		<div class="legend" aria-label="stream states">
			<span class="legend-item"><span class="swatch state-wait"></span>wait</span>
			<span class="legend-item"><span class="swatch state-thinking"></span>think</span>
			<span class="legend-item"><span class="swatch state-text"></span>text</span>
			<span class="legend-item"><span class="swatch state-tool"></span>tool</span>
			<span class="legend-item"><span class="swatch state-reset"></span>reset</span>
			<span class="legend-item"><span class="swatch state-error"></span>error</span>
		</div>
	</div>
	<div class="footer" id="meta">Recent 3 minutes · average rate curve</div>
	<div class="stats">
		<div class="stats-title"><strong>Time / Token Breakdown</strong><span class="stats-controls"><label for="statsSort">Sort</label><select id="statsSort"><option value="time" selected>Time %</option><option value="tokens">Token %</option><option value="name">Name</option></select><span id="statsSummary">waiting for samples…</span></span></div>
		<table class="stats-table" aria-label="time and token percentage breakdown">
			<thead><tr><th>State / Tool</th><th>Time</th><th>Time %</th><th>Tokens</th><th>Token %</th></tr></thead>
			<tbody id="statsBody"><tr><td colspan="5" class="stats-muted">Waiting for samples…</td></tr></tbody>
		</table>
	</div>
	<details class="settings">
		<summary>${escapeHtml(t('configView.responses.runtimeSection'))}</summary>
		<div class="hint">${escapeHtml(t('configView.responses.runtimeDescription'))}</div>
		<div class="form-grid">
			<div class="field"><label for="waitingForResponseThresholdSeconds">${escapeHtml(t('configView.responses.waitThresholdLabel'))}</label><input id="waitingForResponseThresholdSeconds" type="number" min="1" max="300" step="1"/><div class="hint">${escapeHtml(t('configView.responses.waitThresholdHint'))}</div></div>
			<div class="field"><label for="enableNoFeedbackReconnect">${escapeHtml(t('configView.responses.enableReconnectLabel'))}</label><input id="enableNoFeedbackReconnect" type="checkbox"/><div class="hint">${escapeHtml(t('configView.responses.enableReconnectHint'))}</div></div>
			<div class="field"><label for="noFeedbackReconnectSeconds">${escapeHtml(t('configView.responses.noFeedbackReconnectLabel'))}</label><input id="noFeedbackReconnectSeconds" type="number" min="5" max="600" step="1"/><div class="hint">${escapeHtml(t('configView.responses.noFeedbackReconnectHint'))}</div></div>
			<div class="field"><label for="maxNoFeedbackReconnectAttempts">${escapeHtml(t('configView.responses.maxReconnectAttemptsLabel'))}</label><input id="maxNoFeedbackReconnectAttempts" type="number" min="1" max="10" step="1"/><div class="hint">${escapeHtml(t('configView.responses.maxReconnectAttemptsHint'))}</div></div>
			<div class="field"><label for="outputRateTooltipRefreshSeconds">${escapeHtml(t('configView.responses.tooltipRefreshLabel'))}</label><input id="outputRateTooltipRefreshSeconds" type="number" min="1" max="30" step="1"/><div class="hint">${escapeHtml(t('configView.responses.tooltipRefreshHint'))}</div></div>
			<div class="field"><label for="outputRateChartStyle">${escapeHtml(t('configView.responses.chartStyleLabel'))}</label><select id="outputRateChartStyle"><option value="classic">Classic</option><option value="neon">Neon</option><option value="hybrid" selected>Hybrid</option></select><div class="hint">${escapeHtml(t('configView.responses.chartStyleHint'))}</div></div>
		</div>
		<div class="actions"><button id="responsesRuntimeSaveBtn">${escapeHtml(t('configView.responses.save'))}</button></div>
	</details>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const chart = document.getElementById('chart');
const svg = document.getElementById('svg');
const empty = document.getElementById('empty');
const avg = document.getElementById('avg');
const cur = document.getElementById('cur');
const first = document.getElementById('first');
const elapsed = document.getElementById('elapsed');
const active = document.getElementById('active');
const meta = document.getElementById('meta');
const statsBody = document.getElementById('statsBody');
const statsSummary = document.getElementById('statsSummary');
const statsSort = document.getElementById('statsSort');
const waitingForResponseThresholdSeconds = document.getElementById('waitingForResponseThresholdSeconds');
const enableNoFeedbackReconnect = document.getElementById('enableNoFeedbackReconnect');
const noFeedbackReconnectSeconds = document.getElementById('noFeedbackReconnectSeconds');
const maxNoFeedbackReconnectAttempts = document.getElementById('maxNoFeedbackReconnectAttempts');
const outputRateTooltipRefreshSeconds = document.getElementById('outputRateTooltipRefreshSeconds');
const outputRateChartStyle = document.getElementById('outputRateChartStyle');
const responsesRuntimeSaveBtn = document.getElementById('responsesRuntimeSaveBtn');
let chartScaleMax = 1;
let pendingSnapshot = undefined;
let pendingFrame = 0;
let chartWindowStart = undefined;
let chartWindowEnd = undefined;
let lastVisibleSamples = [];

const CHART_HISTORY_MS = 180000;
const CHART_MAX_POINTS = 600;
const CHART_SCALE_HEADROOM = 1.15;
const CHART_SCROLL_STEP_MS = 100;

function fmtRate(value) { return Number.isFinite(value) ? value.toFixed(1) + ' tok/s' : '—'; }
function fmtDuration(ms) { return ms == null ? 'waiting…' : (Math.max(0, ms) / 1000).toFixed(2) + 's'; }
function fmtSeconds(seconds) { return Number.isFinite(seconds) ? Math.max(0, seconds).toFixed(2) + 's' : '—'; }

function sampleState(sample) {
	if (!sample) return 'idle';
	if (sample.connectionState === 'error') return 'error';
	if (sample.connectionState === 'reset') return 'reset';
	if (sample.waiting) return 'wait';
	if (sample.streamKind === 'tool') return 'tool';
	if (sample.streamKind === 'thinking') return 'thinking';
	if (sample.streamKind === 'text') return 'text';
	return sample.active ? 'text' : 'idle';
}

function stateLabel(state) {
	return state === 'thinking' ? 'think' : state;
}

function statsKey(sample) {
	const state = sampleState(sample);
	if (state === 'tool') return 'tool: ' + (sample.activeToolName || 'pending');
	return stateLabel(state);
}

function fmtPercent(value) {
	return Number.isFinite(value) ? value.toFixed(1) + '%' : '0.0%';
}

function barWidth(value) {
	const clamped = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
	if (clamped > 0 && clamped < 1.2) return '1.2%';
	return clamped.toFixed(1) + '%';
}

function escapeText(value) {
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderBreakdown(samples) {
	if (!statsBody || !statsSummary) return;
	if (!samples || samples.length < 2) {
		statsSummary.textContent = 'waiting for samples…';
		statsBody.innerHTML = '<tr><td colspan="5" class="stats-muted">Waiting for samples…</td></tr>';
		return;
	}
	const rows = new Map();
	let totalMs = 0;
	let totalTokens = 0;
	for (let index = 1; index < samples.length; index++) {
		const previous = samples[index - 1];
		const current = samples[index];
		if (!previous || !current || current.sessionId !== previous.sessionId) continue;
		const dt = Math.max(0, Math.min(10000, current.at - previous.at));
		const tokenDelta = Math.max(0, (current.outputTokens || 0) - (previous.outputTokens || 0));
		if (dt === 0 && tokenDelta === 0) continue;
		const key = statsKey(current);
		const row = rows.get(key) || { name: key, state: sampleState(current), ms: 0, tokens: 0 };
		row.ms += dt;
		row.tokens += tokenDelta;
		rows.set(key, row);
		totalMs += dt;
		totalTokens += tokenDelta;
	}
	const sortMode = statsSort?.value || 'time';
	const sorted = Array.from(rows.values()).sort((left, right) => {
		if (sortMode === 'tokens') return right.tokens - left.tokens || right.ms - left.ms || left.name.localeCompare(right.name);
		if (sortMode === 'name') return left.name.localeCompare(right.name);
		return right.ms - left.ms || right.tokens - left.tokens || left.name.localeCompare(right.name);
	});
	if (!sorted.length) {
		statsSummary.textContent = 'no breakdown yet';
		statsBody.innerHTML = '<tr><td colspan="5" class="stats-muted">No state or token deltas yet.</td></tr>';
		return;
	}
	statsSummary.textContent = fmtSeconds(totalMs / 1000) + ' · ' + Math.round(totalTokens) + ' tokens';
	statsBody.innerHTML = sorted.map(row => {
		const timePercent = totalMs > 0 ? row.ms / totalMs * 100 : 0;
		const tokenPercent = totalTokens > 0 ? row.tokens / totalTokens * 100 : 0;
		return '<tr>'
			+ '<td><span class="stats-name"><span class="swatch state-' + row.state + '"></span>' + escapeText(row.name) + '</span></td>'
			+ '<td>' + fmtSeconds(row.ms / 1000) + '</td>'
			+ '<td><span class="stats-percent"><span class="stats-bar"><span class="stats-fill state-' + row.state + '" style="width:' + barWidth(timePercent) + '"></span></span><span class="stats-percent-text">' + fmtPercent(timePercent) + '</span></span></td>'
			+ '<td>' + Math.round(row.tokens) + '</td>'
			+ '<td><span class="stats-percent"><span class="stats-bar"><span class="stats-fill state-' + row.state + '" style="width:' + barWidth(tokenPercent) + '"></span></span><span class="stats-percent-text">' + fmtPercent(tokenPercent) + '</span></span></td>'
			+ '</tr>';
	}).join('');
}

function pathFromPoints(points) {
	if (points.length === 0) return '';
	if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;
	if (points.length < 4) return points.map((point, index) => (index === 0 ? 'M ' : ' L ') + point.x + ' ' + point.y).join('');
	let d = 'M ' + points[0].x + ' ' + points[0].y;
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(points.length - 1, i + 2)];
		const c1x = p1.x + (p2.x - p0.x) / 6;
		const c1y = p1.y + (p2.y - p0.y) / 6;
		const c2x = p2.x - (p3.x - p1.x) / 6;
		const c2y = p2.y - (p3.y - p1.y) / 6;
		d += ' C ' + c1x + ' ' + c1y + ', ' + c2x + ' ' + c2y + ', ' + p2.x + ' ' + p2.y;
	}
	return d;
}

function createSvgElement(tag, attrs) {
	const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const key of Object.keys(attrs || {})) {
		element.setAttribute(key, String(attrs[key]));
	}
	return element;
}

function downsampleSamples(samples, maxPoints, start, end) {
	if (!samples || samples.length <= maxPoints) return samples || [];
	const bucketMs = Math.max(1, Math.ceil((end - start) / maxPoints));
	const result = [];
	let bucket = -1;
	let chosen = undefined;
	for (const sample of samples) {
		const nextBucket = Math.floor((sample.at - start) / bucketMs);
		if (nextBucket !== bucket) {
			if (chosen) result.push(chosen);
			bucket = nextBucket;
		}
		chosen = sample;
	}
	if (chosen) result.push(chosen);
	return result;
}

function getChartWindow(samples, anchorAt) {
	const last = samples[samples.length - 1];
	const now = Number.isFinite(anchorAt) ? anchorAt : (last?.at || Date.now());
	const latestAt = last?.at || now;
	const oldestAt = samples[0]?.at || Math.max(0, now - CHART_HISTORY_MS);
	const steppedEnd = Math.max(
		oldestAt + CHART_SCROLL_STEP_MS,
		Math.floor(latestAt / CHART_SCROLL_STEP_MS) * CHART_SCROLL_STEP_MS,
	);
	if (!Number.isFinite(chartWindowStart) || !Number.isFinite(chartWindowEnd)) {
		chartWindowStart = Math.max(0, oldestAt);
		chartWindowEnd = chartWindowStart + CHART_HISTORY_MS;
	}
	if (steppedEnd > chartWindowEnd) {
		chartWindowEnd = steppedEnd;
		chartWindowStart = Math.max(0, chartWindowEnd - CHART_HISTORY_MS);
	}
	if (chartWindowEnd < oldestAt || chartWindowStart > latestAt + CHART_HISTORY_MS) {
		chartWindowEnd = steppedEnd;
		chartWindowStart = Math.max(0, chartWindowEnd - CHART_HISTORY_MS);
	}
	return { start: chartWindowStart, end: chartWindowEnd };
}

function splitSegments(points) {
	const segments = [];
	let current = [];
	for (const point of points) {
		const previous = current[current.length - 1];
		const breaks = previous && (
			point.sessionId !== previous.sessionId ||
			point.state !== previous.state ||
			point.at - previous.at > 3500
		);
		if (breaks && current.length) {
			segments.push(current);
			current = [];
		}
		current.push(point);
	}
	if (current.length) segments.push(current);
	return segments;
}

function drawStateBands(points, width, height, pad, bandTop, bandHeight) {
	if (!points.length) return;
	let start = points[0];
	for (let index = 1; index <= points.length; index++) {
		const point = points[index];
		const shouldFlush = !point || point.state !== start.state || point.sessionId !== start.sessionId || point.at - points[index - 1].at > 3500;
		if (!shouldFlush) continue;
		const end = points[index - 1];
		const x = Math.max(pad, Math.min(width - pad, start.x));
		const endX = Math.max(x + 2, Math.min(width - pad, end.x + 2));
		const rect = createSvgElement('rect', {
			x,
			y: bandTop,
			width: endX - x,
			height: bandHeight,
			rx: 3,
			class: 'state-band state-' + start.state,
		});
		const title = createSvgElement('title', {});
		title.textContent = stateLabel(start.state) + ' · ' + new Date(start.at).toLocaleTimeString();
		rect.appendChild(title);
		svg.appendChild(rect);
		start = point;
	}
}

function getStableMaxRate(rawMaxRate) {
	const target = Math.max(1, rawMaxRate * CHART_SCALE_HEADROOM);
	if (!Number.isFinite(chartScaleMax) || chartScaleMax <= 0) {
		chartScaleMax = target;
		return chartScaleMax;
	}
	if (target > chartScaleMax) {
		chartScaleMax = target;
	} else if (target < chartScaleMax * 0.72) {
		chartScaleMax = chartScaleMax * 0.96 + target * 0.04;
	}
	return Math.max(1, chartScaleMax);
}

function currentChartStyle() {
	const value = outputRateChartStyle?.value || 'hybrid';
	return value === 'neon' || value === 'hybrid' ? value : 'classic';
}

function applyChartStyle(style) {
	if (!chart) return;
	chart.classList.toggle('neon', style === 'neon');
	chart.classList.toggle('hybrid', style === 'hybrid');
}

function drawHybridBars(points, plotBottom, pad) {
	if (points.length < 2) return;
	const width = Math.max(1, Math.min(10, (points[1].x - points[0].x) * 0.72));
	for (const point of points) {
		const top = Math.min(point.y, plotBottom);
		const rect = createSvgElement('rect', {
			x: point.x - width / 2,
			y: top,
			width,
			height: Math.max(1, plotBottom - top),
			rx: 2,
			class: 'rate-bar state-' + point.state,
		});
		svg.appendChild(rect);
	}
}

function draw(samples, anchorAt) {
	const width = 920, height = 320, pad = 28, bandTop = 288, bandHeight = 10;
	const style = currentChartStyle();
	applyChartStyle(style);
	svg.innerHTML = '';
	if (!samples || samples.length === 0) { empty.style.display = 'block'; lastVisibleSamples = []; return []; }
	empty.style.display = 'none';
	const windowRange = getChartWindow(samples, anchorAt);
	const start = windowRange.start;
	const end = windowRange.end;
	const visibleSamples = downsampleSamples(samples.filter(s => s && s.at >= start && s.at <= end), CHART_MAX_POINTS, start, end);
	lastVisibleSamples = visibleSamples;
	if (visibleSamples.length === 0) { empty.style.display = 'block'; return []; }
	const rawMaxRate = Math.max(1, ...visibleSamples.map(s => s.averageRate || s.rate || 0));
	const maxRate = getStableMaxRate(rawMaxRate);
	const plotBottom = bandTop - 14;
	const points = visibleSamples.map(s => ({
		x: pad + Math.max(0, Math.min(1, (s.at - start) / (end - start))) * (width - pad * 2),
		y: plotBottom - Math.max(0, Math.min(1, ((s.averageRate || s.rate || 0) / maxRate))) * (plotBottom - pad),
		at: s.at,
		rate: s.averageRate || s.rate || 0,
		sessionId: s.sessionId || 0,
		state: sampleState(s),
		tool: s.activeToolName || '',
	}));
	for (let i = 0; i <= 4; i++) {
		const y = pad + i * (plotBottom - pad) / 4;
		svg.appendChild(createSvgElement('line', { x1: pad, x2: width - pad, y1: y, y2: y, class: 'grid-line' }));
	}
	if (style === 'hybrid') {
		drawHybridBars(points, plotBottom, pad);
	}
	drawStateBands(points, width, height, pad, bandTop, bandHeight);
	const segments = splitSegments(points);
	for (const segment of segments) {
		if (segment.length === 1) {
			const point = segment[0];
			const dot = createSvgElement('circle', { cx: point.x, cy: point.y, r: 2.5, class: 'dot state-' + point.state });
			svg.appendChild(dot);
			continue;
		}
		const d = pathFromPoints(segment);
		if (style === 'neon') {
			const glow = createSvgElement('path', { d, class: 'line glow-base state-' + segment[0].state });
			svg.appendChild(glow);
		}
		const area = createSvgElement('path', {
			d: d + ' L ' + segment[segment.length - 1].x + ' ' + plotBottom + ' L ' + segment[0].x + ' ' + plotBottom + ' Z',
			class: 'area',
		});
		if (segment[0].state === 'idle' || segment[0].state === 'wait') area.style.opacity = '.05';
		svg.appendChild(area);
		const path = createSvgElement('path', { d, class: 'line thin state-' + segment[0].state });
		const title = createSvgElement('title', {});
		title.textContent = stateLabel(segment[0].state) + (segment[0].tool ? ' · ' + segment[0].tool : '') + ' · ' + segment.length + ' samples';
		path.appendChild(title);
		svg.appendChild(path);
	}
	for (const p of points.slice(-24)) {
		const dot = createSvgElement('circle', { cx: p.x, cy: p.y, r: 2, class: 'dot state-' + p.state });
		const title = createSvgElement('title', {});
		title.textContent = stateLabel(p.state) + ' · ' + p.rate.toFixed(2) + ' tok/s' + (p.tool ? ' · ' + p.tool : '');
		dot.appendChild(title);
		svg.appendChild(dot);
	}
	return visibleSamples;
}

function renderSnapshot(snapshot) {
	if (!snapshot) { avg.textContent = '—'; cur.textContent = '—'; first.textContent = '—'; elapsed.textContent = '—'; active.textContent = 'idle'; draw([], Date.now()); renderBreakdown([]); return; }
	avg.textContent = fmtRate(snapshot.averageRate);
	cur.textContent = fmtRate(snapshot.currentRate);
	first.textContent = snapshot.waiting ? 'waiting ' + fmtSeconds(snapshot.waitingSeconds) : fmtDuration(snapshot.firstTokenMs);
	elapsed.textContent = fmtSeconds(snapshot.elapsedSeconds);
	const stateText = snapshot.connectionState === 'error' ? 'error'
		: snapshot.connectionState === 'reset' ? 'reset r' + snapshot.connectionAttempt + '/' + snapshot.connectionMaxAttempts
		: snapshot.waiting ? 'waiting for first token'
		: snapshot.streamKind === 'thinking' ? 'thinking'
		: snapshot.streamKind === 'tool' ? 'tool' + (snapshot.activeToolName ? ': ' + snapshot.activeToolName : '')
		: snapshot.active ? snapshot.streamKind : 'final';
	active.textContent = stateText;
	const visibleSamples = draw(snapshot.samples, snapshot.updatedAt);
	meta.textContent = 'Session view · ' + visibleSamples.length + ' visible · ' + snapshot.samples.length + ' retained · split by session/state · ' + currentChartStyle() + ' · updated ' + new Date(snapshot.updatedAt).toLocaleTimeString();
	renderBreakdown(visibleSamples);
}

function scheduleRender(snapshot) {
	pendingSnapshot = snapshot;
	if (pendingFrame) return;
	pendingFrame = requestAnimationFrame(() => {
		pendingFrame = 0;
		renderSnapshot(pendingSnapshot);
	});
}

window.addEventListener('message', event => {
	const message = event.data || {};
	if (message.type === 'responsesRuntimeSettings') {
		const settings = message.settings || {};
		waitingForResponseThresholdSeconds.value = settings.waitingForResponseThresholdSeconds || 15;
		enableNoFeedbackReconnect.checked = settings.enableNoFeedbackReconnect !== false;
		noFeedbackReconnectSeconds.value = settings.noFeedbackReconnectSeconds || 30;
		maxNoFeedbackReconnectAttempts.value = settings.maxNoFeedbackReconnectAttempts || 3;
		outputRateTooltipRefreshSeconds.value = settings.outputRateTooltipRefreshSeconds || 2;
		outputRateChartStyle.value = settings.outputRateChartStyle || 'hybrid';
		applyChartStyle(currentChartStyle());
		return;
	}
	scheduleRender(message.snapshot);
});

responsesRuntimeSaveBtn.addEventListener('click', () => {
	vscode.postMessage({
		type: 'saveResponsesRuntimeSettings',
		settings: {
			waitingForResponseThresholdSeconds: parseInt(waitingForResponseThresholdSeconds.value, 10) || 15,
			enableNoFeedbackReconnect: enableNoFeedbackReconnect.checked,
			noFeedbackReconnectSeconds: parseInt(noFeedbackReconnectSeconds.value, 10) || 30,
			maxNoFeedbackReconnectAttempts: parseInt(maxNoFeedbackReconnectAttempts.value, 10) || 3,
			outputRateTooltipRefreshSeconds: parseInt(outputRateTooltipRefreshSeconds.value, 10) || 2,
			outputRateChartStyle: currentChartStyle(),
		},
	});
});

statsSort?.addEventListener('change', () => {
	renderBreakdown(lastVisibleSamples || []);
});

outputRateChartStyle?.addEventListener('change', () => {
	applyChartStyle(currentChartStyle());
	renderSnapshot(pendingSnapshot);
});
</script>
</body>
</html>`;
	}
}

function getResponsesRuntimeSettings(): ResponsesRuntimeSettings {
	return {
		waitingForResponseThresholdSeconds: getWaitingForResponseThresholdSeconds(),
		enableNoFeedbackReconnect: getResponsesNoFeedbackReconnectEnabled(),
		noFeedbackReconnectSeconds: getResponsesNoFeedbackReconnectSeconds(),
		maxNoFeedbackReconnectAttempts: getResponsesMaxNoFeedbackReconnectAttempts(),
		outputRateTooltipRefreshSeconds: getOutputRateTooltipRefreshSeconds(),
		outputRateChartStyle: getOutputRateChartStyle(),
	};
}

function sampleOutputRate(now: number, estimatedTokens: number, active: boolean, waiting: boolean): number {
	if (!outputRateStartedAt) {
		return 0;
	}
	const elapsedSinceLastSampleSeconds = Math.max(0.001, (now - (outputRateLastSampleAt || outputRateStartedAt)) / 1000);
	const elapsedSinceStartSeconds = Math.max(0.001, (now - outputRateStartedAt) / 1000);
	const deltaTokens = Math.max(0, estimatedTokens - outputRateLastSampleTokens);
	const instantRate = deltaTokens > 0 ? deltaTokens / elapsedSinceLastSampleSeconds : 0;
	const averageRate = estimatedTokens / elapsedSinceStartSeconds;
	if (deltaTokens > 0) {
		const alpha = outputRateSmoothedRate > 0 ? 0.35 : 1;
		outputRateSmoothedRate = outputRateSmoothedRate * (1 - alpha) + instantRate * alpha;
	} else {
		outputRateSmoothedRate *= 0.85;
		if (outputRateSmoothedRate < 0.05) {
			outputRateSmoothedRate = 0;
		}
	}
	outputRateLastSampleTokens = estimatedTokens;
	outputRateLastSampleAt = now;
	outputRateLastInstantRate = instantRate;
	const sampleStreamKind = waiting || outputRateFirstTokenAt === 0 ? 'idle' : outputRateStreamKind;
	outputRateSamples.push({
		at: now,
		rate: averageRate,
		averageRate,
		currentRate: instantRate,
		smoothedRate: outputRateSmoothedRate,
		outputTokens: estimatedTokens,
		sessionId: outputRateSessionId,
		active,
		waiting,
		streamKind: sampleStreamKind,
		connectionState: outputRateConnectionState,
		activeToolName: getActiveToolName(),
		toolCount: outputRateTools.size,
	});
	pruneOutputRateSamples(now);
	return instantRate;
}

function pruneOutputRateSamples(now: number): void {
	const cutoff = now - OUTPUT_RATE_HISTORY_MS;
	while (outputRateSamples.length > 0 && outputRateSamples[0].at < cutoff) {
		outputRateSamples.shift();
	}
}

function getStableOutputRateTooltip(): string {
	const snapshot = lastOutputRateSnapshot;
	if (snapshot) {
		if (snapshot.active) {
			return [
				'MiMo Output Token Rate',
				`State: ${snapshot.waiting ? 'waiting' : snapshot.streamKind}`,
				`Live: ${formatOutputRateStatusText(snapshot).replace(/^\$\([^)]*\)\s*/, '')}`,
				'',
				'Click to open the live chart and Responses runtime settings.',
				'Detailed live statistics are shown in the chart to avoid tooltip flicker.',
			].join('\n');
		}
		const firstToken = snapshot.firstTokenMs !== undefined ? formatDuration(snapshot.firstTokenMs) : 'waiting...';
		const toolLines = snapshot.tools.length
			? [
				`Active tool: ${snapshot.activeToolName ?? '(pending)'}`,
				'Tool calls:',
				...snapshot.tools.map(tool => `  ${tool.name || '(pending)'} · ${tool.argumentChars} arg chars`),
			]
			: [];
		return [
			'MiMo Output Token Rate',
			`State: ${snapshot.waiting ? 'waiting' : snapshot.active ? snapshot.streamKind : 'idle'}`,
			`Smoothed: ${snapshot.smoothedRate.toFixed(2)} tok/s`,
			`Raw current: ${snapshot.currentRate.toFixed(2)} tok/s`,
			`Average: ${snapshot.averageRate.toFixed(2)} tok/s`,
			`First token: ${firstToken}`,
			`Elapsed: ${snapshot.elapsedSeconds.toFixed(2)}s`,
			`Output: ${formatTokenCount(Math.round(snapshot.outputTokens))} tokens · ${snapshot.outputChars} chars`,
			`Waiting threshold: ${snapshot.waitingThresholdSeconds}s`,
			...toolLines,
			`Last 3 min: ${createSparkline(snapshot.samples.map(sample => sample.rate), 42)}`,
			'Click to open chart and Responses runtime settings.',
		].join('\n');
	}
	return [
		'MiMo Output Token Rate',
		'State: idle',
		'Waiting for the next API output.',
		'Click to open chart and Responses runtime settings.',
	].join('\n');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function createSparkline(values: number[], width: number): string {
	if (values.length === 0) {
		return 'waiting for samples...';
	}
	const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
	const sampledValues = values.length <= width
		? values
		: values.filter((_value, index) => index % Math.ceil(values.length / width) === 0).slice(-width);
	const max = Math.max(...sampledValues, 1);
	return sampledValues
		.map((value) => blocks[Math.min(blocks.length - 1, Math.floor((value / max) * (blocks.length - 1)))])
		.join('');
}

function formatDuration(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

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
