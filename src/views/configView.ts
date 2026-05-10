import * as vscode from 'vscode';
import type { ProviderDefinition, UserModelConfig } from '../types';
import { CONFIG_SECTION, MODELS } from '../consts';
import { getProviders, getRelatedProviders, getToolOutputCompressionSettings, getUserModelKey } from '../config';
import type { ToolOutputCompressionSettings } from '../config';
import { updateMiMoModelProviders } from '../auth';
import { t } from '../i18n';

// ---- Types ----

interface InitPayload {
	providers: ProviderDefinition[];
	providerKeys: Record<string, string>;
	models: Array<UserModelConfig & { builtin?: boolean; hidden?: boolean }>;
	strings: Record<string, string>;
	memorySettings: {
		enabled: boolean;
		recallModel: string;
		modelOptions: Array<{ id: string; name: string }>;
	};
	compressionSettings: ToolOutputCompressionSettings;
}

type IncomingMessage =
	| { type: 'requestInit' }
	| { type: 'saveMemorySettings'; enabled: boolean; recallModel: string }
	| { type: 'saveCompressionSettings'; settings: ToolOutputCompressionSettings }
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
			t('configView.title'),
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
					vscode.window.showErrorMessage(err instanceof Error ? err.message : t('configView.unexpectedError'));
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
			case 'saveMemorySettings':
				await this.saveMemorySettings(message.enabled, message.recallModel);
				break;
			case 'saveCompressionSettings':
				await this.saveCompressionSettings(message.settings);
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
				const yesLabel = t('configView.confirm.yes');
				const noLabel = t('configView.confirm.no');
				const confirmed = await vscode.window.showInformationMessage(
					message.message,
					{ modal: true },
					yesLabel,
					noLabel,
				);
				this.panel.webview.postMessage({
					type: 'confirmResponse',
					id: message.id,
					confirmed: confirmed === yesLabel,
				} as OutgoingMessage);
				break;
			}
		}
	}

	// ---- Init ----

	private async sendInit() {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const strings = this.getWebviewStrings();
		const providers = getProviders();
		const providerKeys: Record<string, string> = {};
		// Also check sibling provider keys (e.g. mimo-tp) even if not in providers config
		const providerIdsToCheck = new Set<string>(providers.map((p) => p.id));
		for (const model of MODELS) {
			if (model.providerId) {
				providerIdsToCheck.add(model.providerId);
				for (const sibling of getRelatedProviders(model.providerId)) {
					providerIdsToCheck.add(sibling);
				}
			}
		}
		for (const id of providerIdsToCheck) {
			const key = await this.secrets.get(`${CONFIG_SECTION}.apiKey.${id}`);
			if (key) {
				providerKeys[id] = '••••••••••••••••••••';
			}
		}

		/** Resolve effective provider with cascade (mimo ↔ mimo-tp). */
		function getEffectiveProviderId(modelProviderId: string | undefined): string {
			if (!modelProviderId || modelProviderId === 'default') { return 'deepseek'; }
			if (providerKeys[modelProviderId]) { return modelProviderId; }
			for (const sibling of getRelatedProviders(modelProviderId)) {
				if (providerKeys[sibling]) { return sibling; }
			}
			return modelProviderId;
		}

		const hiddenModels = this.getHiddenModels();
		const userModels = this.getUserModels();
		const allModels: Array<UserModelConfig & { builtin?: boolean; hidden?: boolean }> = [];

		for (const m of MODELS) {
			const isHidden = hiddenModels.includes(m.id);
			// Merge user overrides for built-in models
			const override = userModels.find((um) => getUserModelKey(um) === m.id || um.id === m.id);
			allModels.push({
				key: override?.key ?? m.id,
				id: m.id,
				name: override?.name || m.name,
				providerId: override?.providerId || getEffectiveProviderId(m.providerId),
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
			if (!MODELS.some((bm) => bm.id === getUserModelKey(m))) {
				allModels.push({ ...m, builtin: false, hidden: false });
			}
		}

		const memorySettings = {
			enabled: config.get<boolean>('agenticMemory', false),
			recallModel: config.get<string>('memory.recallModel', 'mimo-v2-pro'),
			modelOptions: this.getMemoryRecallModelOptions(),
		};
		const compressionSettings = getToolOutputCompressionSettings();

		this.panel.webview.postMessage({
			type: 'init',
			payload: { providers, providerKeys, models: allModels, strings, memorySettings, compressionSettings } satisfies InitPayload,
		} as OutgoingMessage);
	}

	private getWebviewStrings(): Record<string, string> {
		return {
			compressionMasterOffHint: t('configView.compression.masterOffHint'),
			compressionPolicyDisabledHint: t('configView.compression.policyDisabledHint'),
			compressionImageDisabledHint: t('configView.compression.imageDisabledHint'),
			providersEmpty: t('configView.providers.empty'),
			providersApiKeyPresent: t('configView.providers.apiKeyPresent'),
			providersApiKeyMissing: t('configView.providers.apiKeyMissing'),
			providersEditButton: t('configView.providers.editButton'),
			providersDeleteButton: t('configView.providers.deleteButton'),
			providersFormAddTitle: t('configView.providers.form.addTitle'),
			providersFormEditTitle: t('configView.providers.form.editTitle'),
			providersFormApiKeyRetainPlaceholder: t('configView.providers.form.apiKeyRetainPlaceholder'),
			providersFormApiKeyPlaceholder: t('configView.providers.form.apiKeyPlaceholder'),
			providersIdRequired: t('configView.providers.idRequired'),
			providersNameRequired: t('configView.providers.nameRequired'),
			providersBaseUrlRequired: t('configView.providers.baseUrlRequired'),
			providersFetchApiKeyRequired: t('configView.providers.fetchApiKeyRequired'),
			providersNoModelsFound: t('configView.providers.noModelsFound'),
			providersUseAsModel: t('configView.providers.useAsModel'),
			providersDeleteConfirm: t('configView.providers.deleteConfirm'),
			providersFetchFailed: t('configView.providers.fetchFailed'),
			modelsEmpty: t('configView.models.empty'),
			modelsBadgeBuiltin: t('configView.models.badgeBuiltin'),
			modelsBadgeHidden: t('configView.models.badgeHidden'),
			modelsBadgeTools: t('configView.models.badgeTools'),
			modelsBadgeNativeVision: t('configView.models.badgeNativeVision'),
			modelsBadgeEnhancedVision: t('configView.models.badgeEnhancedVision'),
			modelsBadgeThinking: t('configView.models.badgeThinking'),
			modelsShowButton: t('configView.models.showButton'),
			modelsEditButton: t('configView.models.editButton'),
			modelsHideButton: t('configView.models.hideButton'),
			modelsDeleteButton: t('configView.models.deleteButton'),
			modelsMetaProvider: t('configView.models.metaProvider'),
			modelsMetaContext: t('configView.models.metaContext'),
			modelsMetaOutput: t('configView.models.metaOutput'),
			modelsMetaTemp: t('configView.models.metaTemp'),
			modelsMetaTopP: t('configView.models.metaTopP'),
			modelsFormProviderPlaceholder: t('configView.models.form.providerPlaceholder'),
			modelsFormAddTitle: t('configView.models.form.addTitle'),
			modelsFormEditTitle: t('configView.models.form.editTitle'),
			modelsIdRequired: t('configView.models.idRequired'),
			modelsNameRequired: t('configView.models.nameRequired'),
			modelsProviderRequired: t('configView.models.providerRequired'),
			modelsMaxInputRequired: t('configView.models.maxInputRequired'),
			modelsMaxOutputRequired: t('configView.models.maxOutputRequired'),
			modelsHideConfirm: t('configView.models.hideConfirm'),
			modelsDeleteConfirm: t('configView.models.deleteConfirm'),
		};
	}

	private getMemoryRecallModelOptions(): Array<{ id: string; name: string }> {
		const preferredOrder = ['mimo-v2-pro', 'mimo-v2-flash', 'mimo-v2.5', 'mimo-v2.5-pro'];
		const sortRank = new Map(preferredOrder.map((id, index) => [id, index]));
		return MODELS
			.filter((model) => preferredOrder.includes(model.id))
			.sort((left, right) => (sortRank.get(left.id) ?? 999) - (sortRank.get(right.id) ?? 999))
			.map((model) => ({ id: model.id, name: model.name }));
	}

	private isMaskedApiKey(value: string | undefined): boolean {
		if (!value?.trim()) {
			return false;
		}
		const trimmed = value.trim();
		return /^•+$/.test(trimmed) || trimmed.includes('...');
	}

	private async saveMemorySettings(enabled: boolean, recallModel: string) {
		if (!recallModel?.trim()) {
			vscode.window.showErrorMessage(t('configView.memory.required'));
			return;
		}

		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const previousEnabled = config.get<boolean>('agenticMemory', false);
		const previousRecallModel = config.get<string>('memory.recallModel', 'mimo-v2-pro');

		await config.update('agenticMemory', enabled, vscode.ConfigurationTarget.Global);
		await config.update('memory.recallModel', recallModel, vscode.ConfigurationTarget.Global);

		vscode.window.showInformationMessage(t('configView.memory.saved'));
		await this.sendInit();

		if (previousEnabled !== enabled || previousRecallModel !== recallModel) {
			const reloadLabel = t('configView.memory.reload');
			const action = await vscode.window.showInformationMessage(
				t('configView.memory.changed'),
				reloadLabel,
			);
			if (action === reloadLabel) {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		}
	}

	private async saveCompressionSettings(settings: ToolOutputCompressionSettings) {
		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const update = async (key: string, value: unknown) => {
			await config.update(`responses.toolOutputCompression.${key}`, value, vscode.ConfigurationTarget.Global);
		};

		await update('enabled', !!settings.enabled);
		await update('compressImages', !!settings.compressImages);
		await update('truncateLongToolOutputs', !!settings.truncateLongToolOutputs);
		await update('summarizeStructuredOutputs', !!settings.summarizeStructuredOutputs);
		await update('useToolTypePolicies', !!settings.useToolTypePolicies);
		await update('showNotice', !!settings.showCompressionNotice);
		await update('maxToolOutputChars', Math.max(1000, Math.floor(settings.maxToolOutputChars || 8000)));
		await update('smallToolImageBytes', Math.max(16 * 1024, Math.floor(settings.smallToolImageBytes || 256 * 1024)));
		await update('maxCompressedImageBytes', Math.max(32 * 1024, Math.floor(settings.maxCompressedImageBytes || 512 * 1024)));
		await update(
			'imageOutputFormat',
			settings.imageOutputFormat === 'jpeg' || settings.imageOutputFormat === 'webp' || settings.imageOutputFormat === 'png'
				? settings.imageOutputFormat
				: 'auto',
		);
		await update('primaryImageMaxEdge', Math.max(128, Math.floor(settings.primaryImageMaxEdge || 1024)));
		await update('primaryImageQuality', Math.min(100, Math.max(10, Math.floor(settings.primaryImageQuality || 80))));
		await update('fallbackImageMaxEdge', Math.max(128, Math.floor(settings.fallbackImageMaxEdge || 512)));
		await update('fallbackImageQuality', Math.min(100, Math.max(10, Math.floor(settings.fallbackImageQuality || 70))));
		await update('keepOriginalImagesWhenDisabled', !!settings.keepOriginalImagesWhenDisabled);

		vscode.window.showInformationMessage(t('configView.compression.saved'));
		await this.sendInit();
	}

	// ---- Provider CRUD ----

	private async saveProvider(provider: ProviderDefinition, apiKey?: string) {
		if (!provider.id?.trim()) {
			vscode.window.showErrorMessage(t('configView.providers.idRequired'));
			return;
		}
		if (provider.apiMode === 'responses' && !provider.baseUrl?.trim()) {
			vscode.window.showErrorMessage(t('configView.providers.baseUrlRequired'));
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
		if (apiKey && !this.isMaskedApiKey(apiKey)) {
			await this.secrets.store(`${CONFIG_SECTION}.apiKey.${provider.id}`, apiKey);
			await updateMiMoModelProviders(provider.id);
		}
		vscode.window.showInformationMessage(t('configView.providers.saved', provider.name));
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
		vscode.window.showInformationMessage(t('configView.providers.deleted', providerId));
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
		const key = getUserModelKey(model);
		if (models.some((m) => getUserModelKey(m) === key)) {
			vscode.window.showErrorMessage(t('configView.models.duplicate', key));
			return;
		}
		models.push({ ...model, key });
		await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		await this.unhideModel(key);
		vscode.window.showInformationMessage(t('configView.models.added', model.name));
		await this.sendInit();
	}

	private async updateModel(model: UserModelConfig, originalId: string) {
		const config = vscode.workspace.getConfiguration();
		const models = this.getUserModels();
		const key = getUserModelKey(model);
		const idx = models.findIndex((m) => getUserModelKey(m) === originalId);
		if (idx >= 0) {
			models[idx] = { ...model, key };
		} else {
			models.push({ ...model, key });
		}
		await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		await this.unhideModel(originalId);
		vscode.window.showInformationMessage(t('configView.models.updated', model.name));
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
			const models = this.getUserModels().filter((m) => getUserModelKey(m) !== modelId);
			await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		} else {
			const config = vscode.workspace.getConfiguration();
			const models = this.getUserModels().filter((m) => getUserModelKey(m) !== modelId);
			await config.update(`${CONFIG_SECTION}.models`, models, vscode.ConfigurationTarget.Global);
		}
		vscode.window.showInformationMessage(t('configView.models.removed', modelId));
		await this.sendInit();
	}

	// ---- Fetch Models ----

	private async fetchModels(providerId: string, baseUrl: string, apiKey: string) {
		try {
			let realKey = apiKey;
			if (this.isMaskedApiKey(apiKey)) {
				const stored = await this.secrets.get(`${CONFIG_SECTION}.apiKey.${providerId}`);
				if (!stored) throw new Error(t('configView.providers.noStoredApiKey'));
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
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${t('configView.title')}</title>
<link rel="stylesheet" href="${cssUri}"/>
</head>
<body>
<div id="app">
<section><div class="section-header"><h2>${t('configView.providers.sectionTitle')}</h2><button id="addProviderBtn" class="btn primary">${t('configView.providers.addButton')}</button></div><div id="providerList" class="card-list"></div></section>
<section id="providerForm" style="display:none"><div class="section-header"><h2 id="pfTitle">${t('configView.providers.form.addTitle')}</h2></div>
<div class="form-grid">
<div class="field"><label for="pf-id">${t('configView.providers.form.idLabel')}</label><input id="pf-id" type="text" placeholder="${t('configView.providers.form.idPlaceholder')}"/><div class="hint">${t('configView.providers.form.idHint')}</div></div>
<div class="field"><label for="pf-name">${t('configView.providers.form.nameLabel')}</label><input id="pf-name" type="text" placeholder="DeepSeek"/></div>
<div class="field"><label for="pf-apiMode">${t('configView.providers.form.apiModeLabel')}</label><select id="pf-apiMode"><option value="chat-completions">${t('configView.providers.form.apiModeChatCompletions')}</option><option value="responses">${t('configView.providers.form.apiModeResponses')}</option></select><div class="hint">${t('configView.providers.form.apiModeHint')}</div></div>
<div class="field"><label for="pf-baseUrl">${t('configView.providers.form.baseUrlLabel')}</label><input id="pf-baseUrl" type="text" placeholder="https://api.deepseek.com"/><div class="hint">${t('configView.providers.form.baseUrlHint')}</div></div>
<div class="field"><label for="pf-apiKey">${t('configView.providers.form.apiKeyLabel')}</label><div class="input-with-toggle"><input id="pf-apiKey" type="password" placeholder="${t('configView.providers.form.apiKeyPlaceholder')}"/><button id="pf-apiKey-toggle" class="btn secondary small toggle-eye" title="${t('configView.providers.form.apiKeyToggle')}">*</button></div><div class="hint">${t('configView.providers.form.apiKeyHint')}</div></div>
</div>
<div class="hint">${t('configView.providers.form.responsesHint')}</div>
<div class="form-actions"><button id="pf-save" class="btn primary">${t('configView.providers.form.save')}</button><button id="pf-cancel" class="btn secondary">${t('configView.providers.form.cancel')}</button><button id="pf-fetchModels" class="btn secondary">${t('configView.providers.form.fetchModels')}</button></div>
<div id="fetchedModels" style="display:none"><h3>${t('configView.providers.availableModels')}</h3><div id="fetchedModelsList"></div></div>
</section>
<section><div class="section-header"><h2>${t('configView.models.sectionTitle')}</h2><button id="addModelBtn" class="btn primary">${t('configView.models.addButton')}</button></div><div id="modelList" class="card-list"></div></section>
<section id="modelForm" style="display:none"><div class="section-header"><h2 id="mfTitle">${t('configView.models.form.addTitle')}</h2></div>
<div class="form-grid">
<div class="field"><label for="mf-id">${t('configView.models.form.idLabel')}</label><input id="mf-id" type="text" placeholder="mimo-v2.5-pro"/><div class="hint">${t('configView.models.form.idHint')}</div></div>
<div class="field"><label for="mf-name">${t('configView.models.form.nameLabel')}</label><input id="mf-name" type="text" placeholder="MiMo V2.5 Pro"/></div>
<div class="field"><label for="mf-providerId">${t('configView.models.form.providerLabel')}</label><select id="mf-providerId"><option value="">${t('configView.models.form.providerPlaceholder')}</option></select></div>
<div class="field"><label for="mf-maxInputTokens">${t('configView.models.form.maxInputLabel')}</label><input id="mf-maxInputTokens" type="number" min="1" placeholder="131072"/></div>
<div class="field"><label for="mf-maxOutputTokens">${t('configView.models.form.maxOutputLabel')}</label><input id="mf-maxOutputTokens" type="number" min="1" placeholder="32768"/></div>
<div class="field"><label for="mf-temperature">${t('configView.models.form.temperatureLabel')}</label><input id="mf-temperature" type="number" min="0" max="2" step="0.1" placeholder="${t('configView.models.form.defaultPlaceholder')}"/></div>
<div class="field"><label for="mf-topP">${t('configView.models.form.topPLabel')}</label><input id="mf-topP" type="number" min="0" max="1" step="0.05" placeholder="${t('configView.models.form.defaultPlaceholder')}"/></div>
<div class="field"><label for="mf-toolCalling">${t('configView.models.form.toolCallingLabel')}</label><select id="mf-toolCalling"><option value="true">${t('configView.common.yes')}</option><option value="false">${t('configView.common.no')}</option></select></div>
<div class="field"><label for="mf-nativeVision">${t('configView.models.form.nativeVisionLabel')}</label><select id="mf-nativeVision"><option value="false">${t('configView.common.no')}</option><option value="true">${t('configView.common.yes')}</option></select><div class="hint">${t('configView.models.form.nativeVisionHint')}</div></div>
<div class="field"><label for="mf-enhancedVision">${t('configView.models.form.enhancedVisionLabel')}</label><select id="mf-enhancedVision"><option value="false">${t('configView.common.no')}</option><option value="true">${t('configView.common.yes')}</option></select><div class="hint">${t('configView.models.form.enhancedVisionHint')}</div></div>
<div class="field"><label for="mf-thinking">${t('configView.models.form.thinkingLabel')}</label><select id="mf-thinking"><option value="true">${t('configView.common.yes')}</option><option value="false">${t('configView.common.no')}</option></select></div>
<div class="field"><label for="mf-requiresThinkingParam">${t('configView.models.form.requiresThinkingParamLabel')}</label><select id="mf-requiresThinkingParam"><option value="true">${t('configView.common.yes')}</option><option value="false">${t('configView.common.no')}</option></select><div class="hint">${t('configView.models.form.requiresThinkingParamHint')}</div></div>
</div>
<div class="form-actions"><button id="mf-save" class="btn primary">${t('configView.models.form.save')}</button><button id="mf-cancel" class="btn secondary">${t('configView.models.form.cancel')}</button></div>
</section>
<section><div class="section-header"><h2>${t('configView.memory.section')}</h2></div>
<div class="form-grid">
<div class="field"><label for="memoryEnabled">${t('configView.memory.enableLabel')}</label><div class="checkbox-row"><input id="memoryEnabled" type="checkbox"/><span>${t('configView.memory.enableText')}</span></div><div class="hint">${t('configView.memory.enableHint')}</div></div>
<div class="field"><label for="memoryRecallModel">${t('configView.memory.modelLabel')}</label><select id="memoryRecallModel"></select><div class="hint">${t('configView.memory.modelHint')}</div></div>
</div>
<div class="form-actions"><button id="memorySaveBtn" class="btn primary">${t('configView.memory.save')}</button></div>
</section>
<section><div class="section-header"><h2>${t('configView.compression.section')}</h2></div>
<div class="hint">${t('configView.compression.description')}</div>
<div class="form-grid compression-grid">
<div class="field"><label for="compressionEnabled">${t('configView.compression.enabledLabel')}</label><div class="checkbox-row"><input id="compressionEnabled" type="checkbox"/><span>${t('configView.compression.enabledText')}</span></div><div class="hint">${t('configView.compression.enabledHint')}</div></div>
<div class="field"><label for="compressionNotice">${t('configView.compression.noticeLabel')}</label><div class="checkbox-row"><input id="compressionNotice" type="checkbox"/><span>${t('configView.compression.noticeText')}</span></div></div>
<div class="field"><label for="compressionImages">${t('configView.compression.imagesLabel')}</label><div class="checkbox-row"><input id="compressionImages" type="checkbox"/><span>${t('configView.compression.imagesText')}</span></div><div class="hint">${t('configView.compression.imagesHint')}</div></div>
<div class="field"><label for="compressionStructured">${t('configView.compression.structuredLabel')}</label><div class="checkbox-row"><input id="compressionStructured" type="checkbox"/><span>${t('configView.compression.structuredText')}</span></div></div>
<div class="field"><label for="compressionTruncate">${t('configView.compression.truncateLabel')}</label><div class="checkbox-row"><input id="compressionTruncate" type="checkbox"/><span>${t('configView.compression.truncateText')}</span></div><div class="hint">${t('configView.compression.truncateHint')}</div></div>
<div class="field"><label for="compressionToolPolicies">${t('configView.compression.toolPoliciesLabel')}</label><div class="checkbox-row"><input id="compressionToolPolicies" type="checkbox"/><span>${t('configView.compression.toolPoliciesText')}</span></div><div class="hint">${t('configView.compression.toolPoliciesHint')}</div></div>
<div class="field"><label for="compressionMaxChars">${t('configView.compression.maxCharsLabel')}</label><input id="compressionMaxChars" type="number" min="1000" max="100000" step="1000"/><div class="hint">${t('configView.compression.maxCharsHint')}</div></div>
<div class="field"><label for="compressionSmallImageKb">${t('configView.compression.smallImageLabel')}</label><input id="compressionSmallImageKb" type="number" min="16" max="10240" step="16"/><div class="hint">${t('configView.compression.smallImageHint')}</div></div>
<div class="field"><label for="compressionImageOutputFormat">${t('configView.compression.imageFormatLabel')}</label><select id="compressionImageOutputFormat"><option value="auto">${t('configView.compression.imageFormatAuto')}</option><option value="jpeg">${t('configView.compression.imageFormatJpeg')}</option><option value="webp">${t('configView.compression.imageFormatWebp')}</option><option value="png">${t('configView.compression.imageFormatPng')}</option></select><div class="hint">${t('configView.compression.imageFormatHint')}</div></div>
<div class="field"><label for="compressionMaxImageKb">${t('configView.compression.maxImageLabel')}</label><input id="compressionMaxImageKb" type="number" min="32" max="10240" step="16"/><div class="hint">${t('configView.compression.maxImageHint')}</div></div>
<div class="field"><label for="compressionPrimaryImageMaxEdge">${t('configView.compression.primaryImageMaxEdgeLabel')}</label><input id="compressionPrimaryImageMaxEdge" type="number" min="128" max="4096" step="64"/><div class="hint">${t('configView.compression.primaryImageMaxEdgeHint')}</div></div>
<div class="field"><label for="compressionPrimaryImageQuality">${t('configView.compression.primaryImageQualityLabel')}</label><input id="compressionPrimaryImageQuality" type="number" min="10" max="100" step="5"/><div class="hint">${t('configView.compression.primaryImageQualityHint')}</div></div>
<div class="field"><label for="compressionFallbackImageMaxEdge">${t('configView.compression.fallbackImageMaxEdgeLabel')}</label><input id="compressionFallbackImageMaxEdge" type="number" min="128" max="4096" step="64"/><div class="hint">${t('configView.compression.fallbackImageMaxEdgeHint')}</div></div>
<div class="field"><label for="compressionFallbackImageQuality">${t('configView.compression.fallbackImageQualityLabel')}</label><input id="compressionFallbackImageQuality" type="number" min="10" max="100" step="5"/><div class="hint">${t('configView.compression.fallbackImageQualityHint')}</div></div>
<div class="field"><label for="compressionKeepOriginalImages">${t('configView.compression.keepOriginalImagesLabel')}</label><div class="checkbox-row"><input id="compressionKeepOriginalImages" type="checkbox"/><span>${t('configView.compression.keepOriginalImagesText')}</span></div><div class="hint">${t('configView.compression.keepOriginalImagesHint')}</div></div>
</div>
<div id="compressionCouplingHint" class="notice"></div>
<div class="form-actions"><button id="compressionSaveBtn" class="btn primary">${t('configView.compression.save')}</button></div>
</section>
</div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}
}
