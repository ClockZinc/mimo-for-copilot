import * as vscode from 'vscode';
import type { ProviderDefinition, UserModelConfig } from '../types';
import { CONFIG_SECTION, MODELS } from '../consts';
import { getProviders } from '../config';
import { updateMiMoModelProviders } from '../auth';

// ---- Types ----

interface InitPayload {
	providers: ProviderDefinition[];
	providerKeys: Record<string, string>;
	models: Array<UserModelConfig & { builtin?: boolean; hidden?: boolean }>;
}

type IncomingMessage =
	| { type: 'requestInit' }
	| { type: 'addProvider'; provider: ProviderDefinition; apiKey?: string }
	| { type: 'updateProvider'; provider: ProviderDefinition; apiKey?: string }
	| { type: 'deleteProvider'; providerId: string }
	| { type: 'addModel'; model: UserModelConfig }
	| { type: 'updateModel'; model: UserModelConfig; originalId: string }
	| { type: 'deleteModel'; modelId: string }
	| { type: 'fetchModels'; providerId: string; baseUrl: string; apiKey: string }
	| { type: 'requestConfirm'; id: string; message: string };

type OutgoingMessage =
	| { type: 'init'; payload: InitPayload }
	| { type: 'modelsFetched'; providerId: string; models: Array<{ id: string; owned_by?: string }> }
	| { type: 'modelsFetchError'; providerId: string; error: string }
	| { type: 'confirmResponse'; id: string; confirmed: boolean };

// ---- Panel ----

export class ConfigViewPanel {
	public static currentPanel: ConfigViewPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly secrets: vscode.SecretStorage;
	private disposables: vscode.Disposable[] = [];

	public static openPanel(extensionUri: vscode.Uri, secrets: vscode.SecretStorage) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;
		if (ConfigViewPanel.currentPanel) {
			ConfigViewPanel.currentPanel.panel.reveal(column);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			'mimo-copilot.configView',
			'Provider & Model Configuration',
			column || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
			},
		);
		ConfigViewPanel.currentPanel = new ConfigViewPanel(panel, extensionUri, secrets);
	}

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		secrets: vscode.SecretStorage,
	) {
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.secrets = secrets;
		this.update();
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
		this.panel.webview.onDidReceiveMessage(
			async (message: IncomingMessage) => {
				try {
					await this.handleMessage(message);
				} catch (err) {
					console.error('[ConfigView] handleMessage failed', err);
					vscode.window.showErrorMessage(err instanceof Error ? err.message : 'Unexpected error');
				}
			},
			null,
			this.disposables,
		);
		this.sendInit();
	}

	private async update() {
		this.panel.webview.html = await this.getHtml(this.panel.webview);
	}

	public dispose() {
		ConfigViewPanel.currentPanel = undefined;
		this.panel.dispose();
		while (this.disposables.length) {
			this.disposables.pop()?.dispose();
		}
	}

	// ---- Message handler ----

	async handleMessage(message: IncomingMessage) {
		switch (message.type) {
			case 'requestInit':
				await this.sendInit();
				break;
			case 'addProvider':
			case 'updateProvider':
				await this.saveProvider(message.provider, message.apiKey);
				break;
			case 'deleteProvider':
				await this.deleteProvider(message.providerId);
				break;
			case 'addModel':
				await this.addModel(message.model);
				break;
			case 'updateModel':
				await this.updateModel(message.model, message.originalId);
				break;
			case 'deleteModel':
				await this.deleteModel(message.modelId);
				break;
			case 'fetchModels':
				await this.fetchModels(message.providerId, message.baseUrl, message.apiKey);
				break;
			case 'requestConfirm': {
				const confirmed = await vscode.window.showInformationMessage(
					message.message,
					{ modal: true },
					'Yes',
					'No',
				);
				this.panel.webview.postMessage({
					type: 'confirmResponse',
					id: message.id,
					confirmed: confirmed === 'Yes',
				} as OutgoingMessage);
				break;
			}
		}
	}

	// ---- Init ----

	private async sendInit() {
		const providers = getProviders();
		const providerKeys: Record<string, string> = {};
		for (const p of providers) {
			const key = await this.secrets.get(`${CONFIG_SECTION}.apiKey.${p.id}`);
			if (key) {
				providerKeys[p.id] = '••••••••••••••••••••';
			}
		}

		const hiddenModels = this.getHiddenModels();
		const userModels = this.getUserModels();
		const allModels: Array<UserModelConfig & { builtin?: boolean; hidden?: boolean }> = [];

		for (const m of MODELS) {
			const isHidden = hiddenModels.includes(m.id);
			// Merge user overrides for built-in models
			const override = userModels.find((um) => um.id === m.id);
			allModels.push({
				id: m.id,
				name: override?.name || m.name,
				providerId: override?.providerId || m.providerId || 'deepseek',
				maxInputTokens: override?.maxInputTokens || m.maxInputTokens,
				maxOutputTokens: override?.maxOutputTokens || m.maxOutputTokens,
				toolCalling: override?.toolCalling ?? m.capabilities.toolCalling,
				nativeVision: override?.nativeVision ?? m.capabilities.nativeVision,
				enhancedVision: override?.enhancedVision ?? m.enhancedVision,
				thinking: override?.thinking ?? m.capabilities.thinking,
				temperature: override?.temperature ?? m.temperature,
				topP: override?.topP ?? m.topP,
				requiresThinkingParam: override?.requiresThinkingParam ?? m.requiresThinkingParam,
				builtin: true,
				hidden: isHidden,
			});
		}

		for (const m of userModels) {
			if (!MODELS.some((bm) => bm.id === m.id)) {
				allModels.push({ ...m, builtin: false, hidden: false });
			}
		}

		this.panel.webview.postMessage({
			type: 'init',
			payload: { providers, providerKeys, models: allModels } satisfies InitPayload,
		} as OutgoingMessage);
	}

	// ---- Provider CRUD ----

	private async saveProvider(provider: ProviderDefinition, apiKey?: string) {
		if (!provider.id?.trim()) {
			vscode.window.showErrorMessage('Provider ID is required.');
			return;
		}
		const config = vscode.workspace.getConfiguration();
		const providers = getProviders();
		const idx = providers.findIndex((p) => p.id === provider.id);
		if (idx >= 0) {
			providers[idx] = provider;
		} else {
			providers.push(provider);
		}
		await config.update(
			`${CONFIG_SECTION}.providers`,
			providers,
			vscode.ConfigurationTarget.Global,
		);
		if (apiKey && !apiKey.includes('...')) {
			await this.secrets.store(`${CONFIG_SECTION}.apiKey.${provider.id}`, apiKey);
		}
		vscode.window.showInformationMessage(`Provider "${provider.name}" saved.`);
		await this.sendInit();
	}

	private async deleteProvider(providerId: string) {
		const config = vscode.workspace.getConfiguration();
		const providers = getProviders().filter((p) => p.id !== providerId);
		await config.update(
			`${CONFIG_SECTION}.providers`,
			providers,
			vscode.ConfigurationTarget.Global,
		);
		await this.secrets.delete(`${CONFIG_SECTION}.apiKey.${providerId}`);
		vscode.window.showInformationMessage(`Provider "${providerId}" deleted.`);
		await this.sendInit();
	}

	// ---- Model CRUD ----

	private getUserModels(): UserModelConfig[] {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		return config.get<UserModelConfig[]>('models') ?? [];
	}

	private getHiddenModels(): string[] {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		return config.get<string[]>('hiddenModels') ?? [];
	}

	private async unhideModel(modelId: string) {
		const config = vscode.workspace.getConfiguration();
		const hidden = this.getHiddenModels().filter((id) => id !== modelId);
		await config.update(
			`${CONFIG_SECTION}.hiddenModels`,
			hidden,
			vscode.ConfigurationTarget.Global,
		);
	}

	private async addModel(model: UserModelConfig) {
		const config = vscode.workspace.getConfiguration();
		const models = this.getUserModels();
		if (models.some((m) => m.id === model.id)) {
			vscode.window.showErrorMessage(`Model "${model.id}" already exists.`);
			return;
		}
		models.push(model);
		await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		await this.unhideModel(model.id);
		vscode.window.showInformationMessage(`Model "${model.name}" added.`);
		await this.sendInit();
	}

	private async updateModel(model: UserModelConfig, originalId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = this.getUserModels();
		const idx = models.findIndex((m) => m.id === originalId);
		if (idx >= 0) {
			models[idx] = model;
		} else {
			models.push(model);
		}
		await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		await this.unhideModel(originalId);
		vscode.window.showInformationMessage(`Model "${model.name}" updated.`);
		await this.sendInit();
	}

	private async deleteModel(modelId: string) {
		const isBuiltin = MODELS.some((m) => m.id === modelId);
		if (isBuiltin) {
			const config = vscode.workspace.getConfiguration();
			const hidden = this.getHiddenModels();
			if (!hidden.includes(modelId)) {
				hidden.push(modelId);
			}
			await config.update(
				`${CONFIG_SECTION}.hiddenModels`,
				hidden,
				vscode.ConfigurationTarget.Global,
			);
			const models = this.getUserModels().filter((m) => m.id !== modelId);
			await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		} else {
			const config = vscode.workspace.getConfiguration();
			const models = this.getUserModels().filter((m) => m.id !== modelId);
			await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		}
		vscode.window.showInformationMessage(`Model "${modelId}" removed.`);
		await this.sendInit();
	}

	// ---- Fetch Models ----

	private async fetchModels(providerId: string, baseUrl: string, apiKey: string) {
		try {
			let realKey = apiKey;
			if (apiKey.includes('...')) {
				const stored = await this.secrets.get(`${CONFIG_SECTION}.apiKey.${providerId}`);
				if (!stored) throw new Error('No API key stored for this provider.');
				realKey = stored;
			}
			const url = `${baseUrl.replace(/\/+$/, '')}/models`;
			const res = await fetch(url, { headers: { Authorization: `Bearer ${realKey}` } });
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
			const data = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> };
			this.panel.webview.postMessage({
				type: 'modelsFetched',
				providerId,
				models: data.data ?? [],
			} as OutgoingMessage);
		} catch (err) {
			this.panel.webview.postMessage({
				type: 'modelsFetchError',
				providerId,
				error: err instanceof Error ? err.message : String(err),
			} as OutgoingMessage);
		}
	}

	// ---- HTML ----

	private async getHtml(webview: vscode.Webview): Promise<string> {
		const nonce = Array.from({ length: 16 }, () =>
			Math.floor(Math.random() * 36).toString(36),
		).join('');
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'assets', 'configView', 'configView.css'),
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'assets', 'configView', 'configView.js'),
		);
		const csp = `default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';`;
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Provider & Model Configuration</title>
<link rel="stylesheet" href="${cssUri}"/>
</head>
<body>
<div id="app">
<section><div class="section-header"><h2>API Providers</h2><button id="addProviderBtn" class="btn primary">+ Add Provider</button></div><div id="providerList" class="card-list"></div></section>
<section id="providerForm" style="display:none"><div class="section-header"><h2 id="pfTitle">Add Provider</h2></div>
<div class="form-grid">
<div class="field"><label for="pf-id">Provider ID</label><input id="pf-id" type="text" placeholder="e.g. deepseek, mimo"/><div class="hint">Unique identifier</div></div>
<div class="field"><label for="pf-name">Display Name</label><input id="pf-name" type="text" placeholder="DeepSeek"/></div>
<div class="field"><label for="pf-baseUrl">Base URL</label><input id="pf-baseUrl" type="text" placeholder="https://api.deepseek.com"/><div class="hint">API endpoint (supports proxy)</div></div>
<div class="field"><label for="pf-apiKey">API Key</label><div class="input-with-toggle"><input id="pf-apiKey" type="password" placeholder="sk-..."/><button id="pf-apiKey-toggle" class="btn secondary small toggle-eye" title="Show/Hide">*</button></div><div class="hint">Leave empty to keep existing key</div></div>
</div>
<div class="form-actions"><button id="pf-save" class="btn primary">Save</button><button id="pf-cancel" class="btn secondary">Cancel</button><button id="pf-fetchModels" class="btn secondary">Fetch Models</button></div>
<div id="fetchedModels" style="display:none"><h3>Available Models</h3><div id="fetchedModelsList"></div></div>
</section>
<section><div class="section-header"><h2>Model Management</h2><button id="addModelBtn" class="btn primary">+ Add Model</button></div><div id="modelList" class="card-list"></div></section>
<section id="modelForm" style="display:none"><div class="section-header"><h2 id="mfTitle">Add Model</h2></div>
<div class="form-grid">
<div class="field"><label for="mf-id">Model ID *</label><input id="mf-id" type="text" placeholder="mimo-v2.5-pro"/><div class="hint">ID sent to the API</div></div>
<div class="field"><label for="mf-name">Display Name *</label><input id="mf-name" type="text" placeholder="MiMo V2.5 Pro"/></div>
<div class="field"><label for="mf-providerId">Provider *</label><select id="mf-providerId"><option value="">Select Provider</option></select></div>
<div class="field"><label for="mf-maxInputTokens">Context Window (tokens)</label><input id="mf-maxInputTokens" type="number" min="1" placeholder="131072"/></div>
<div class="field"><label for="mf-maxOutputTokens">Max Output Tokens</label><input id="mf-maxOutputTokens" type="number" min="1" placeholder="32768"/></div>
<div class="field"><label for="mf-temperature">Temperature (0-2)</label><input id="mf-temperature" type="number" min="0" max="2" step="0.1" placeholder="(default)"/></div>
<div class="field"><label for="mf-topP">Top P (0-1)</label><input id="mf-topP" type="number" min="0" max="1" step="0.05" placeholder="(default)"/></div>
<div class="field"><label for="mf-toolCalling">Tool Calling</label><select id="mf-toolCalling"><option value="true">Yes</option><option value="false">No</option></select></div>
<div class="field"><label for="mf-nativeVision">Native Vision</label><select id="mf-nativeVision"><option value="false">No</option><option value="true">Yes</option></select><div class="hint">Model natively supports image input</div></div>
<div class="field"><label for="mf-enhancedVision">Enhanced Vision</label><select id="mf-enhancedVision"><option value="false">No</option><option value="true">Yes</option></select><div class="hint">用 Copilot 代理描述图片（会增加响应延迟，建议保持关闭）</div></div>
<div class="field"><label for="mf-thinking">Thinking</label><select id="mf-thinking"><option value="true">Yes</option><option value="false">No</option></select></div>
</div>
<div class="form-actions"><button id="mf-save" class="btn primary">Save</button><button id="mf-cancel" class="btn secondary">Cancel</button></div>
</section>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}
}
