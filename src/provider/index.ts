import vscode from 'vscode';
import { AuthManager } from '../auth';
import { DeepSeekClient } from '../client';
import {
	getApiModelId,
	getMaxTokens,
	getRelatedProviders,
	resolveProviderForModel,
	getUserModels,
	getHiddenModels,
} from '../config';
import { MODELS } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import type { DeepSeekToolCall, ModelDefinition } from '../types';
import { type ReasoningEntry, pruneReasoningCache } from './cache';
import { convertMessages, convertTools, countMessageChars } from './convert';
import { createVisionModelGetter, resolveImageMessages, setVisionProxyModel } from './vision';
import { updateStatusBarFromUsage } from '../statusBar';

/**
 * NOTE: Non-public API surface.
 *
 * The fields below (`configurationSchema` on chat info, `modelConfiguration`
 * on response options, plus `isUserSelectable` / `statusIcon`) are not part
 * of the stable `vscode.LanguageModelChat*` typings yet. They are the same
 * shape currently consumed by GitHub Copilot Chat to render a per-model
 * config dropdown in the model picker (see Copilot Chat's built-in
 * providers, e.g. its OpenAI/Anthropic providers using `reasoningEffort`).
 *
 * If/when VS Code stabilizes these as proposed API, switch to the official
 * types and drop the casts below.
 */

type ThinkingEffort = 'none' | 'high' | 'max' | 'on' | 'off';

/**
 * Non-public: Copilot Chat passes the user's per-model picker selections
 * back to providers via `modelConfiguration` (newer hosts) / `configuration`
 * (older hosts) on the response options. Both names are checked at runtime.
 */
type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

/**
 * Non-public: extra fields on `LanguageModelChatInformation` consumed by the
 * Copilot Chat model picker — `isUserSelectable` controls picker visibility,
 * `statusIcon` renders a leading icon (e.g. warning when key missing), and
 * `configurationSchema` declares the per-model dropdown schema.
 */
/** Shape of the per-model configuration schema rendered by Copilot Chat's model picker. */
type ThinkingEffortConfigurationSchema = ReturnType<typeof buildThinkingEffortSchema>;

type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable: boolean;
	readonly statusIcon?: vscode.ThemeIcon;
	readonly configurationSchema?: ThinkingEffortConfigurationSchema;
};

/**
 * DeepSeek Chat Provider — implements vscode.LanguageModelChatProvider so
 * DeepSeek V4 models appear directly in the Copilot Chat model picker.
 */
export class DeepSeekChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private isActive = true;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	/** reasoning text → tool_call IDs cache. */
	private readonly reasoningCache = new Map<string, ReasoningEntry>();

	/** Vision proxy: resolver + cached model. */
	private readonly vision = createVisionModelGetter();

	/**
	 * Adaptive chars-per-token ratio, calibrated from actual usage data.
	 * Updated via exponential moving average each time the API reports real token counts.
	 */
	private charsPerToken = 4.0;

	constructor(context: vscode.ExtensionContext) {
		this.authManager = new AuthManager(context);

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			// Settings-based fallback API key + vision model changes.
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration('mimo-copilot.apiKey') ||
					e.affectsConfiguration('mimo-copilot.providers') ||
					e.affectsConfiguration('mimo-copilot.models')
				) {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}

				if (e.affectsConfiguration('mimo-copilot.visionModel')) {
					this.vision.reset();
				}
			}),
			// Multi-window: SecretStorage changes don't fire onDidChangeConfiguration.
			// When another window sets/clears the API key, refresh this window's
			// model picker so the warning state stays in sync.
			context.secrets.onDidChange((e) => {
				if (e.key === 'mimo-copilot.apiKey' || e.key.startsWith('mimo-copilot.apiKey.')) {
					this.onDidChangeLanguageModelChatInformationEmitter.fire();
				}
			}),
		);
	}

	// ---- Public commands ----

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.onDidChangeLanguageModelChatInformationEmitter.fire();
		}
	}

	async clearApiKey(): Promise<void> {
		const config = vscode.workspace.getConfiguration('mimo-copilot');
		const providers: Array<{ id: string; name: string }> =
			config.get<Array<{ id: string; name: string }>>('providers') ?? [];
		const items: vscode.QuickPickItem[] = [
			{ label: t('auth.allProviders'), description: 'Global + All Providers' },
			...providers.map((p) => ({ label: p.name, description: p.id })),
		];
		const chosen = await vscode.window.showQuickPick(items, {
			placeHolder: t('auth.chooseProviderToClear'),
			title: t('auth.clearProviderTitle'),
		});
		if (!chosen) {
			return;
		}

		if (chosen.label === t('auth.allProviders')) {
			await this.authManager.deleteApiKey();
			for (const p of providers) {
				await this.authManager.deleteProviderKey(p.id);
			}
		} else {
			await this.authManager.deleteProviderKey(chosen.description!);
		}
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	/** Check if a specific provider has an API key. */
	async hasProviderApiKey(providerId: string): Promise<boolean> {
		const key = await this.authManager.getApiKeyForProvider(providerId);
		return key !== undefined && key.length > 0;
	}

	/** Force Copilot Chat to re-query model information (including configurationSchema). */
	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeLanguageModelChatInformationEmitter.fire();

		// Force the host to re-pull `provideLanguageModelChatInformation` synchronously
		// before the extension unloads. With `isActive = false` we now return [],
		// which makes Copilot Chat drop DeepSeek models from the picker immediately
		// instead of leaving stale entries behind after deactivate. The returned
		// model list itself is unused — we only call this for its side effect.
		try {
			await vscode.lm.selectChatModels({ vendor: 'mimo' });
		} catch (error) {
			logger.warn('Failed to refresh DeepSeek models during deactivate', error);
		}
	}

	/** See provider/vision.ts */
	async setVisionProxyModel(): Promise<void> {
		await setVisionProxyModel();
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}

		const hiddenModels = getHiddenModels();

		// Check per-provider keys
		const providerKeyStatus = new Map<string, boolean>();
		const config = vscode.workspace.getConfiguration('mimo-copilot');
		const providers = config.get<Array<{ id: string }>>('providers') ?? [];
		for (const p of providers) {
			providerKeyStatus.set(p.id, await this.hasProviderApiKey(p.id));
		}

		// Only the actual global key (mimo-copilot.apiKey) counts as global fallback
		const hasGlobalKey = !!(await this.authManager.getApiKey());

		function hasKeyForModel(providerId: string | undefined): boolean {
			if (!providerId || providerId === 'default') {
				return hasGlobalKey;
			}
			// Check this provider's key first
			if (providerKeyStatus.get(providerId)) { return true; }
			// Cascade: mimo ↔ mimo-tp
			for (const sibling of getRelatedProviders(providerId)) {
				if (providerKeyStatus.get(sibling)) { return true; }
			}
			// Fall back to global key only
			return hasGlobalKey;
		}

		function getEffectiveProviderId(modelProviderId: string | undefined): string {
			if (!modelProviderId || modelProviderId === 'default') { return 'default'; }
			if (providerKeyStatus.get(modelProviderId)) { return modelProviderId; }
			for (const sibling of getRelatedProviders(modelProviderId)) {
				if (providerKeyStatus.get(sibling)) { return sibling; }
			}
			return modelProviderId;
		}

		const builtinInfos = MODELS.filter((model) => !hiddenModels.includes(model.id)).map((model) =>
			toChatInfo(model, hasKeyForModel(model.providerId), getEffectiveProviderId(model.providerId)),
		);

		const userModels = getUserModels();

		// Apply user overrides to built-in models (e.g. context window, provider)
		const overriddenBuiltins = builtinInfos.map((info) => {
			const override = userModels.find((um) => um.id === info.id);
			if (!override) {
				return info;
			}
			return {
				...info,
				name: override.name || info.name,
				maxInputTokens: override.maxInputTokens || info.maxInputTokens,
				maxOutputTokens: override.maxOutputTokens || info.maxOutputTokens,
			};
		});
		const userInfos: ModelPickerChatInformation[] = userModels
			.filter((m) => !hiddenModels.includes(m.id) && !MODELS.some((bm) => bm.id === m.id))
			.map((m) => {
				const hasKey = hasKeyForModel(m.providerId);
				return {
					id: m.id,
					name: m.name,
					family: 'mimo-custom',
					version: 'custom',
					detail: hasKey
						? `${m.providerId} · ${m.maxInputTokens.toLocaleString()} tokens`
						: t('auth.apiKeyRequiredDetail'),
					maxInputTokens: m.maxInputTokens,
					maxOutputTokens: m.maxOutputTokens,
					isDefault: false,
					isUserSelectable: true,
					capabilities: {
						toolCalling: m.toolCalling,
						imageInput: m.nativeVision,
					},
					...(m.thinking && m.requiresThinkingParam ? { configurationSchema: buildThinkingEffortSchema() } : {}),
				};
			});

		return [...overriddenBuiltins, ...userInfos];
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const modelDef = MODELS.find((m) => m.id === modelInfo.id);
		const userModelDef = !modelDef ? getUserModels().find((m) => m.id === modelInfo.id) : undefined;
		const isThinkingModel = modelDef?.capabilities.thinking ?? userModelDef?.thinking ?? false;
		const isMiMo = modelDef?.thinkingParamStyle === 'mimo';
		const needsThinkingParam = modelDef?.requiresThinkingParam ?? userModelDef?.requiresThinkingParam ?? true;
		const thinkingEffort = getConfiguredThinkingEffort(options as ModelConfigurationOptions);
		const maxTokens = getMaxTokens();

		// Vision: native vision skips proxy, enhancedVision uses Copilot proxy
		// NOTE: 默认关闭 enhancedVision 以加快首字响应速度
		const nativeVision = modelDef?.capabilities.nativeVision ?? userModelDef?.nativeVision ?? false;
		const enhancedVision = modelDef?.enhancedVision ?? userModelDef?.enhancedVision ?? false;

		// Resolve provider-specific settings (baseUrl + apiKey) with cascade
		const modelProviderId = modelDef?.providerId ?? userModelDef?.providerId;
		// Build key status from providers config AND secretStorage for cascade siblings
		const providerKeyStatus = new Map<string, boolean>();
		const allProviders = vscode.workspace.getConfiguration('mimo-copilot').get<Array<{ id: string }>>('providers') ?? [];
		for (const p of allProviders) {
			providerKeyStatus.set(p.id, await this.hasProviderApiKey(p.id));
		}
		// Also check cascade siblings that might not be in providers config
		for (const fam of ['mimo', 'mimo-tp']) {
			if (!providerKeyStatus.has(fam)) {
				providerKeyStatus.set(fam, await this.hasProviderApiKey(fam));
			}
		}
		logger.debug(`[Request] providerKeyStatus: ${JSON.stringify(Object.fromEntries(providerKeyStatus))}`);
		const { baseUrl, providerId } = resolveProviderForModel(modelProviderId, providerKeyStatus);
		logger.debug(`[Request] model=${modelInfo.id} inputProvider=${modelProviderId ?? '(none)'} → resolved provider=${providerId} baseUrl=${baseUrl}`);
		const apiKey = await this.authManager.getApiKeyForProvider(providerId);
		logger.debug(`[Request] apiKey found for provider=${providerId}: ${apiKey ? 'YES' : 'NO'}`);
		if (!apiKey) {
			throw new Error(t('auth.notConfigured') + ` (provider: ${providerId})`);
		}

		const client = new DeepSeekClient(baseUrl, apiKey);

		// Heuristic: detect conversation start to clear stale cache.
		if (messages.length <= 2) {
			pruneReasoningCache(this.reasoningCache, true);
		}

		// Vision: native vision → keep images; enhanced → proxy; neither → strip
		const resolvedMessages = nativeVision
			? messages
			: enhancedVision
				? await resolveImageMessages(messages, token, () => this.vision.get())
				: messages;
		const deepseekMessages = convertMessages(
			resolvedMessages,
			isThinkingModel,
			this.reasoningCache,
			nativeVision,
		);
		const canUseTools = modelDef?.capabilities.toolCalling ?? userModelDef?.toolCalling ?? true;
		const tools = canUseTools ? convertTools(options.tools) : undefined;

		// Temperature / topP: user override > model default
		const userTemp = userModelDef?.temperature ?? modelDef?.temperature;
		const userTopP = userModelDef?.topP ?? modelDef?.topP;

		const totalRequestChars = countMessageChars(deepseekMessages);

		let accumulatedReasoning = '';
		const pendingToolCallIds: string[] = [];
		let responseMessageId: string | undefined;

		return new Promise<void>((resolve, reject) => {
			client.streamChatCompletion(
				{
					model: getApiModelId(modelInfo.id),
					messages: deepseekMessages,
					stream: true,
					tools,
					tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
					max_tokens: maxTokens,
					...(userTemp !== undefined ? { temperature: userTemp } : {}),
					...(userTopP !== undefined ? { top_p: userTopP } : {}),
					...(isThinkingModel && needsThinkingParam
					? (isMiMo
						? { thinking: { type: thinkingEffort !== 'none' ? 'enabled' as const : 'disabled' as const } }
						: { thinking: { type: thinkingEffort === 'none' ? 'disabled' as const : 'enabled' as const },
							...(thinkingEffort !== 'none' ? { reasoning_effort: thinkingEffort as 'high' | 'max' } : {}) }
					) as Record<string, unknown>
						: {}),
				},
				{
					onContent: (content: string) => {
						progress.report(new vscode.LanguageModelTextPart(content));
					},

					onThinking: (text: string) => {
						accumulatedReasoning += text;

						// LanguageModelThinkingPart is a proposed API — the class
						// exists at runtime in both stable and Insiders, but the
						// stable vscode.d.ts doesn't include it. The .d.ts
						// augmentation in the project root provides type safety.
						progress.report(
							new vscode.LanguageModelThinkingPart(
								text,
							) as unknown as vscode.LanguageModelResponsePart,
						);
					},

					onToolCall: (toolCall: DeepSeekToolCall) => {
						pendingToolCallIds.push(toolCall.id);

						// Cache reasoning keyed by tool_call ID
						if (isThinkingModel && accumulatedReasoning) {
							this.reasoningCache.set(toolCall.id, {
								text: accumulatedReasoning,
								timestamp: Date.now(),
							});
						}

						try {
							const args = JSON.parse(toolCall.function.arguments);
							progress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args),
							);
						} catch {
							progress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}),
							);
						}
					},

					onError: (error: Error) => {
						reject(error);
					},

					onDone: () => {
						// Cache reasoning for the final response (non-tool-call case).
						if (isThinkingModel && accumulatedReasoning && pendingToolCallIds.length === 0) {
							responseMessageId = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
							this.reasoningCache.set(responseMessageId, {
								text: accumulatedReasoning,
								timestamp: Date.now(),
							});
						}

						pruneReasoningCache(this.reasoningCache, false);
						resolve();
					},

					onUsage: (usage) => {
						// Calibrate chars-per-token ratio from real API usage data.
						if (totalRequestChars > 0 && usage.prompt_tokens > 0) {
							const observedRatio = totalRequestChars / usage.prompt_tokens;
							this.charsPerToken = this.charsPerToken * 0.7 + observedRatio * 0.3;
						}

						// Log KV cache hit stats for observability.
						const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
						const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
						const cacheTotal = cacheHit + cacheMiss;
						const hitRate = cacheTotal > 0 ? ((cacheHit / cacheTotal) * 100).toFixed(0) : 'n/a';
						logger.info(
							`tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}` +
								` | cache: hit=${cacheHit} miss=${cacheMiss} rate=${hitRate}%` +
								` | chars/tok=${this.charsPerToken.toFixed(2)}`,
						);

						// Update status bar with real token usage
						updateStatusBarFromUsage(usage, modelInfo.maxInputTokens);
					},
				},
				token,
			);
		});
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		if (typeof text === 'string') {
			return Math.max(1, Math.ceil(text.length / this.charsPerToken));
		}

		if (!text?.content || !Array.isArray(text.content)) {
			return 1;
		}

		let total = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += part.value.length;
			}
		}
		return Math.max(1, Math.ceil(total / this.charsPerToken));
	}
}

// ---- Helpers ----

/**
 * Build the thinking effort configuration schema with translated labels.
 * Called inside toChatInfo() so translations reflect the current locale.
 */
function buildThinkingEffortSchema() {
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['none', 'high', 'max'],
				enumItemLabels: [t('thinking.none'), t('thinking.high'), t('thinking.max')],
				enumDescriptions: [
					t('thinking.none.desc'),
					t('thinking.high.desc'),
					t('thinking.max.desc'),
				],
				default: 'high',
				group: 'navigation',
			},
		},
	} as const;
}

/**
 * Derive the i18n key for a model's detail line from the model ID.
 * Returns `undefined` when the key is missing from *both* locales —
 * `toChatInfo()` will then fall back to `m.detail`. When the key exists
 * in English but not the active locale, the English translation is used
 * (per `t()`'s fallback behaviour).
 */
function resolveDetailKey(m: ModelDefinition): string | undefined {
	// Map known DeepSeek V4 models: deepseek-v4-flash → model.flash.detail
	const suffix = m.id.startsWith('deepseek-v4-') ? m.id.slice('deepseek-v4-'.length) : m.id;
	const key = `model.${suffix}.detail`;
	// t() returns the raw key string when no translation is defined in either
	// locale — treat that as "no translation available" and fall back.
	const translated = t(key);
	return translated !== key ? key : undefined;
}

function toChatInfo(m: ModelDefinition, hasApiKey: boolean, effectiveProviderId?: string): ModelPickerChatInformation {
	const detailKey = resolveDetailKey(m);
	const modelDetail = detailKey ? t(detailKey) : m.detail;
	const isMiMo = m.thinkingParamStyle === 'mimo';
	const showProvider = effectiveProviderId || m.providerId || 'default';
	return {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version,
		detail: hasApiKey ? `${showProvider} · ${modelDetail}` : t('auth.apiKeyRequiredDetail'),
		tooltip: hasApiKey ? undefined : t('auth.apiKeyRequiredDetail'),
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.nativeVision,
		},
		...(m.capabilities.thinking && m.requiresThinkingParam
			? { configurationSchema: (isMiMo ? buildMiMoReasoningSchema() : buildThinkingEffortSchema()) as ThinkingEffortConfigurationSchema }
			: {}),
	};
}

/** Build MiMo on/off reasoning schema (no effort levels, just boolean). */
function buildMiMoReasoningSchema() {
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: 'Reasoning',
				enum: ['on', 'off'],
				enumItemLabels: [t('thinking.on'), t('thinking.off')],
				enumDescriptions: [t('thinking.on.desc'), t('thinking.off.desc')],
				default: 'on',
				group: 'navigation',
			},
		},
	} as const;
}

function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
	const configuredEffort =
		options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;

	// MiMo on/off
	if (configuredEffort === 'on') { return 'on'; }
	if (configuredEffort === 'off') { return 'none'; }

	if (configuredEffort === 'none') { return 'none'; }
	if (configuredEffort === 'high') { return 'high'; }

	return configuredEffort === 'max' ? 'max' : 'high';
}
