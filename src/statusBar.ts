import * as vscode from 'vscode';
import { getWaitingForResponseThresholdSeconds } from './config';

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
let outputRateSamples: Array<{ at: number; rate: number }> = [];
let lastOutputRateSnapshot: OutputRateSnapshot | undefined;
let outputRateWaitingThresholdMs = 15_000;
let outputRateStopped = false;
let outputRateResetTimer: NodeJS.Timeout | undefined;
let outputRateConnectionState: 'none' | 'reset' | 'error' = 'none';
let outputRateConnectionStartedAt = 0;
let outputRateConnectionAttempt = 0;
let outputRateConnectionMaxAttempts = 0;
let outputRateConnectionMessage = '';

const OUTPUT_RATE_UPDATE_MS = 500;
const OUTPUT_RATE_IDLE_RESET_MS = 2_000;
const OUTPUT_RATE_HISTORY_MS = 3 * 60 * 1000;
export const OPEN_OUTPUT_RATE_PANEL_COMMAND = 'mimo-copilot.openOutputRatePanel';

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
	firstTokenMs?: number;
	outputTokens: number;
	outputChars: number;
	elapsedSeconds: number;
	charsPerToken: number;
	updateMs: number;
	samples: Array<{ at: number; rate: number }>;
	updatedAt: number;
	waiting: boolean;
	waitingSeconds: number;
	waitingThresholdSeconds: number;
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

	outputRateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	outputRateStatusBarItem.name = 'MiMo Output Token Rate';
	outputRateStatusBarItem.text = '$(pulse) idle tok/s';
	outputRateStatusBarItem.tooltip = getStableOutputRateTooltip();
	outputRateStatusBarItem.show();
	context.subscriptions.push(outputRateStatusBarItem);
}

export function openOutputRatePanel(): void {
	// VS Code does not expose a public API for extensions to open a Copilot-style
	// status-bar anchored popover. Keep this command intentionally passive so the
	// status-bar item does not open a top-of-window QuickPick or an editor tab.
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

export function recordOutputTokenText(sessionId: number, text: string): void {
	if (sessionId !== outputRateSessionId || !text) {
		return;
	}
	if (!outputRateFirstTokenAt) {
		outputRateFirstTokenAt = Date.now();
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
	pruneOutputRateSamples(Date.now());
	outputRateStopped = false;
	clearOutputRateConnectionStatus();
	if (outputRateResetTimer) {
		clearTimeout(outputRateResetTimer);
		outputRateResetTimer = undefined;
	}
	if (!outputRateStatusBarItem) { return; }
	outputRateStatusBarItem.text = '$(pulse) idle tok/s';
	outputRateStatusBarItem.tooltip = getStableOutputRateTooltip();
	outputRateStatusBarItem.backgroundColor = undefined;
	outputRateStatusBarItem.show();
	lastOutputRateSnapshot = undefined;
}

// ---- Helpers ----

function updateOutputRateStatusBar(sessionId: number, active: boolean, completionTokens?: number): void {
	if (!outputRateStatusBarItem || sessionId !== outputRateSessionId) {
		return;
	}
	const elapsedMs = Math.max(1, Date.now() - outputRateStartedAt);
	const elapsedSeconds = elapsedMs / 1000;
	const estimatedTokens = Math.max(0, outputRateChars / outputRateCharsPerToken);
	const instantRate = active
		? sampleOutputRate(Date.now(), estimatedTokens)
		: outputRateLastInstantRate;
	const displayTokens = typeof completionTokens === 'number' && completionTokens >= 0
		? completionTokens
		: estimatedTokens;
	const rate = elapsedSeconds > 0 ? displayTokens / elapsedSeconds : 0;
	const firstTokenMs = outputRateFirstTokenAt > 0 ? outputRateFirstTokenAt - outputRateStartedAt : undefined;
	const waiting = active && firstTokenMs === undefined && elapsedMs >= outputRateWaitingThresholdMs;
	const waitingSeconds = waiting ? elapsedSeconds : 0;
	lastOutputRateSnapshot = {
		active,
		averageRate: rate,
		currentRate: instantRate,
		firstTokenMs,
		outputTokens: displayTokens,
		outputChars: outputRateChars,
		elapsedSeconds,
		charsPerToken: outputRateCharsPerToken,
		updateMs: OUTPUT_RATE_UPDATE_MS,
		samples: [...outputRateSamples],
		updatedAt: Date.now(),
		waiting,
		waitingSeconds,
		waitingThresholdSeconds: outputRateWaitingThresholdMs / 1000,
	};
	if (outputRateConnectionState === 'error') {
		outputRateStatusBarItem.text = `$(error) connect Error${outputRateConnectionMessage ? ` · ${outputRateConnectionMessage}` : ''}`;
		outputRateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
	} else if (outputRateConnectionState === 'reset') {
		const resetElapsedMs = Math.max(0, Date.now() - outputRateConnectionStartedAt);
		const attemptText = outputRateConnectionMaxAttempts > 0
			? ` ${outputRateConnectionAttempt}/${outputRateConnectionMaxAttempts}`
			: '';
		outputRateStatusBarItem.text = `$(sync~spin) reset${attemptText} ${formatDuration(resetElapsedMs)}`;
		outputRateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	} else {
		outputRateStatusBarItem.text = waiting
			? `$(watch) waiting ${formatDuration(elapsedMs)}`
			: `$(pulse) ${rate.toFixed(1)} tok/s${firstTokenMs !== undefined ? ` · ${formatDuration(firstTokenMs)} first` : ''}`;
		outputRateStatusBarItem.backgroundColor = undefined;
	}
	outputRateStatusBarItem.tooltip = getStableOutputRateTooltip();
	outputRateStatusBarItem.show();
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
		{ label: `$(dashboard) Current  ${snapshot.currentRate.toFixed(2)} tok/s`, detail: `最近 ${(snapshot.updateMs / 1000).toFixed(1)}s 采样窗口，按真实时间差计算。` },
		{ label: `$(watch) First token  ${firstToken}`, detail: '从发出请求到收到首个 token。' },
		{ label: `$(history) Elapsed  ${snapshot.elapsedSeconds.toFixed(1)}s`, detail: snapshot.active ? 'streaming...' : 'final' },
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
	}

	static postSnapshot(snapshot: OutputRateSnapshot | undefined): void {
		this.currentPanel?.webview.postMessage({ type: 'outputRateSnapshot', snapshot });
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
	.card.waiting { border-color: var(--vscode-statusBarItem-warningBackground); background: color-mix(in srgb, var(--vscode-statusBarItem-warningBackground) 22%, var(--vscode-editor-background) 78%); }
	.label { opacity: .72; font-size: 12px; margin-bottom: 6px; }
	.value { font-size: 22px; font-weight: 700; white-space: nowrap; }
	.sub { opacity: .72; font-size: 12px; margin-top: 4px; }
	.chart { border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 12px; background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); }
	svg { width: 100%; height: 320px; display: block; overflow: visible; }
	.axis { stroke: var(--vscode-panel-border); stroke-width: 1; }
	.grid-line { stroke: var(--vscode-panel-border); stroke-width: 1; opacity: .35; }
	.line { fill: none; stroke: var(--vscode-charts-blue); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
	.area { fill: var(--vscode-charts-blue); opacity: .12; }
	.dot { fill: var(--vscode-charts-blue); }
	.empty { opacity: .65; text-align: center; padding: 48px 0; }
	.footer { opacity: .72; margin-top: 10px; font-size: 12px; }
	.banner { display: none; margin-bottom: 14px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--vscode-statusBarItem-warningBackground); background: color-mix(in srgb, var(--vscode-statusBarItem-warningBackground) 18%, var(--vscode-editor-background) 82%); }
</style>
</head>
<body>
<div class="wrap">
	<h2>MiMo Output Rate</h2>
	<div id="waitingBanner" class="banner">$(watch) Waiting for response…</div>
	<div class="grid">
		<div class="card"><div class="label">Average Rate</div><div id="avg" class="value">—</div><div class="sub">tokens / second</div></div>
		<div class="card"><div class="label">Current Rate</div><div id="cur" class="value">—</div><div class="sub">last 0.5s window</div></div>
		<div class="card" id="firstCard"><div class="label">First Token</div><div id="first" class="value">—</div><div class="sub">request → first token</div></div>
		<div class="card"><div class="label">Elapsed</div><div id="elapsed" class="value">—</div><div class="sub" id="active">idle</div></div>
	</div>
	<div class="chart">
		<svg id="svg" viewBox="0 0 920 320" preserveAspectRatio="none"></svg>
		<div id="empty" class="empty">Waiting for output rate samples…</div>
	</div>
	<div class="footer" id="meta">Recent 3 minutes · smoothed cubic curve</div>
</div>
<script nonce="${nonce}">
const svg = document.getElementById('svg');
const empty = document.getElementById('empty');
const avg = document.getElementById('avg');
const cur = document.getElementById('cur');
const first = document.getElementById('first');
const elapsed = document.getElementById('elapsed');
const active = document.getElementById('active');
const meta = document.getElementById('meta');
const waitingBanner = document.getElementById('waitingBanner');
const firstCard = document.getElementById('firstCard');

function fmtRate(value) { return Number.isFinite(value) ? value.toFixed(1) + ' tok/s' : '—'; }
function fmtDuration(ms) { return ms == null ? 'waiting…' : ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's'; }
function fmtSeconds(seconds) { return Number.isFinite(seconds) ? seconds.toFixed(1) + 's' : '—'; }

function pathFromPoints(points) {
	if (points.length === 0) return '';
	if (points.length === 1) return 'M ' + points[0].x + ' ' + points[0].y;
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

function draw(samples) {
	const width = 920, height = 320, pad = 28;
	svg.innerHTML = '';
	if (!samples || samples.length === 0) { empty.style.display = 'block'; return; }
	empty.style.display = 'none';
	const now = Date.now();
	const start = now - 180000;
	const maxRate = Math.max(1, ...samples.map(s => s.rate || 0));
	const points = samples.map(s => ({
		x: pad + Math.max(0, Math.min(1, (s.at - start) / 180000)) * (width - pad * 2),
		y: height - pad - Math.max(0, Math.min(1, (s.rate || 0) / maxRate)) * (height - pad * 2),
	}));
	for (let i = 0; i <= 4; i++) {
		const y = pad + i * (height - pad * 2) / 4;
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		line.setAttribute('x1', pad); line.setAttribute('x2', width - pad); line.setAttribute('y1', y); line.setAttribute('y2', y); line.setAttribute('class', 'grid-line'); svg.appendChild(line);
	}
	const d = pathFromPoints(points);
	const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	area.setAttribute('d', d + ' L ' + points[points.length - 1].x + ' ' + (height - pad) + ' L ' + points[0].x + ' ' + (height - pad) + ' Z');
	area.setAttribute('class', 'area'); svg.appendChild(area);
	const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	path.setAttribute('d', d); path.setAttribute('class', 'line'); svg.appendChild(path);
	for (const p of points.slice(-24)) {
		const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); dot.setAttribute('r', 2); dot.setAttribute('class', 'dot'); svg.appendChild(dot);
	}
}

window.addEventListener('message', event => {
	const snapshot = event.data && event.data.snapshot;
	if (!snapshot) { avg.textContent = '—'; cur.textContent = '—'; first.textContent = '—'; elapsed.textContent = '—'; active.textContent = 'idle'; waitingBanner.style.display = 'none'; firstCard.classList.remove('waiting'); draw([]); return; }
	avg.textContent = fmtRate(snapshot.averageRate);
	cur.textContent = fmtRate(snapshot.currentRate);
	first.textContent = snapshot.waiting ? 'waiting ' + snapshot.waitingSeconds.toFixed(1) + 's' : fmtDuration(snapshot.firstTokenMs);
	elapsed.textContent = fmtSeconds(snapshot.elapsedSeconds);
	active.textContent = snapshot.waiting ? 'waiting for first token' : (snapshot.active ? 'active' : 'final');
	waitingBanner.style.display = snapshot.waiting ? 'block' : 'none';
	waitingBanner.textContent = '$(watch) Waiting for response · ' + snapshot.waitingSeconds.toFixed(1) + 's elapsed · threshold ' + snapshot.waitingThresholdSeconds + 's';
	firstCard.classList.toggle('waiting', !!snapshot.waiting);
	meta.textContent = 'Recent 3 minutes · ' + snapshot.samples.length + ' samples · token/s is estimated from chars until final API usage · updated ' + new Date(snapshot.updatedAt).toLocaleTimeString();
	draw(snapshot.samples);
});
</script>
</body>
</html>`;
	}
}

function sampleOutputRate(now: number, estimatedTokens: number): number {
	if (!outputRateStartedAt) {
		return 0;
	}
	const elapsedSinceLastSampleSeconds = Math.max(0.001, (now - (outputRateLastSampleAt || outputRateStartedAt)) / 1000);
	const deltaTokens = Math.max(0, estimatedTokens - outputRateLastSampleTokens);
	const instantRate = deltaTokens > 0 ? deltaTokens / elapsedSinceLastSampleSeconds : 0;
	outputRateLastSampleTokens = estimatedTokens;
	outputRateLastSampleAt = now;
	outputRateLastInstantRate = instantRate;
	outputRateSamples.push({ at: now, rate: instantRate });
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
	return [
		'MiMo Output Token Rate',
		'Click to open live output rate details.',
		'The status-bar text refreshes during streaming; this tooltip is kept stable to avoid hover flicker.',
	].join('\n');
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
	if (ms < 1000) {
		return `${Math.max(0, Math.round(ms))}ms`;
	}
	return `${(ms / 1000).toFixed(2)}s`;
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
