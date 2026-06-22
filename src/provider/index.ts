import vscode from 'vscode';
import { AuthManager } from '../auth';
import { DeepSeekClient } from '../client';
import {
    getApiModelId,
    getCandidateProvidersForModel,
    getHiddenModels,
    getMaxTokens,
    getProviderApiMode,
    getProviderById,
    getUserModelKey,
    getUserModels,
    resolveProviderForModel
} from '../config';
import { MODELS, getBaseModelId, getBuiltinModelByPickerId, getBuiltinModelKey } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import { recordOutputTokenText, startOutputTokenRate, stopOutputTokenRate, updateStatusBarFromUsage } from '../statusBar';
import type { DeepSeekToolCall, ModelDefinition, ReasoningEffortOption, UserModelConfig } from '../types';
import { type ReasoningEntry, pruneReasoningCache } from './cache';
import { convertMessages, convertTools, countMessageChars } from './convert';
import {
    buildResponsesConfigurationSchema,
    handleResponsesChatRequest,
} from './responses';
import { createVisionModelGetter, resolveImageMessages, setVisionProxyModel } from './vision';

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

type ThinkingEffort = 'none' | 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'on' | 'off' | undefined;

type EffectiveModelConfig = Pick<
	ModelDefinition | UserModelConfig,
	| 'id'
	| 'name'
	| 'maxInputTokens'
	| 'maxOutputTokens'
	| 'providerId'
	| 'enhancedVision'
	| 'requiresThinkingParam'
	| 'temperature'
	| 'topP'
	| 'supportedApiModes'
	| 'reasoningEfforts'
	| 'defaultReasoningEffort'
	| 'verbosityOptions'
	| 'defaultVerbosity'
> & {
	capabilities: { toolCalling: boolean; nativeVision: boolean; thinking: boolean };
	thinkingParamStyle?: ModelDefinition['thinkingParamStyle'];
	family?: string;
	version?: string;
	detail?: string;
};

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
type ThinkingEffortConfigurationSchema = { readonly properties: Record<string, unknown> };

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
	private readonly responsesPreviousResponseIdUnsupportedBaseUrls = new Set<string>();
	private readonly responsesPreviousResponseIdsByConversation = new Map<string, string>();
	private readonly responsesReportedCompressionNotices = new Set<string>();
	private activeResponseCount = 0;
	private hasDeferredModelPickerRefresh = false;

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
					this.refreshModelPicker();
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
					this.refreshModelPicker();
				}
			}),
		);
	}

	private beginResponse(): void {
		this.activeResponseCount += 1;
	}

	private endResponse(): void {
		this.activeResponseCount = Math.max(0, this.activeResponseCount - 1);
		if (this.activeResponseCount === 0 && this.hasDeferredModelPickerRefresh) {
			this.hasDeferredModelPickerRefresh = false;
			this.onDidChangeLanguageModelChatInformationEmitter.fire();
		}
	}

	private safeProgress(
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		modelId: string,
	): vscode.Progress<vscode.LanguageModelResponsePart> {
		return {
			report: (part) => {
				try {
					progress.report(part);
				} catch (error) {
					logger.warn(`[Request] progress.report ignored for stale response model=${modelId}`, error);
				}
			},
		};
	}

	// ---- Public commands ----

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.refreshModelPicker();
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
		this.refreshModelPicker();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	/** Check if a specific provider has an API key. */
	async hasProviderApiKey(providerId: string): Promise<boolean> {
		return this.authManager.hasProviderSpecificKey(providerId);
	}

	/** Force Copilot Chat to re-query model information (including configurationSchema). */
	refreshModelPicker(): void {
		if (this.activeResponseCount > 0) {
			this.hasDeferredModelPickerRefresh = true;
			return;
		}
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
		const hasDeepSeekKey = !!providerKeyStatus.get('deepseek') || hasGlobalKey;
		const hasResponsesKey = !!providerKeyStatus.get('openai-responses');
		/**
		 * A responses-family model (gpt-5.x) can be served by any provider whose
		 * id is `openai-responses` — whether the user set it to `responses` or
		 * `chat-completions` mode (relay / proxy scenario).
		 */
		const hasOpenaiProviderConfigured = (() => {
			const p = getProviderById('openai-responses');
			return !!p?.baseUrl?.trim()
				&& (getProviderApiMode(p) === 'responses' || getProviderApiMode(p) === 'chat-completions')
				&& hasResponsesKey;
		})();
		const hasAnyResponsesProvider = providers.some((provider) => {
			const fullProvider = getProviderById(provider.id);
			return !!fullProvider?.baseUrl?.trim()
				&& getProviderApiMode(fullProvider) === 'responses'
				&& !!providerKeyStatus.get(provider.id);
		}) || hasOpenaiProviderConfigured;

		function hasKeyForModel(modelId: string, providerId: string | undefined): boolean {
			if (!providerId || providerId === 'default') {
				return hasGlobalKey;
			}
			for (const candidateProviderId of getCandidateProvidersForModel(modelId, providerId)) {
				if (providerKeyStatus.get(candidateProviderId)) { return true; }
			}
			// Do NOT fall back to the global (DeepSeek) key for openai-responses —
			// it needs its own per-provider key (relay / proxy scenario).
			if (providerId === 'openai-responses') {
				return false;
			}
			// Fall back to global key only
			return hasGlobalKey;
		}

		function getEffectiveProviderId(modelId: string, modelProviderId: string | undefined): string {
			if (!modelProviderId || modelProviderId === 'default') { return 'default'; }
			for (const candidateProviderId of getCandidateProvidersForModel(modelId, modelProviderId)) {
				if (providerKeyStatus.get(candidateProviderId)) { return candidateProviderId; }
			}
			const fallbackCandidate = getCandidateProvidersForModel(modelId, modelProviderId)[0];
			return fallbackCandidate ?? modelProviderId;
		}

		const userModels = getUserModels();
		const getBuiltinOverride = (model: ModelDefinition): UserModelConfig | undefined => userModels.find((um) => {
			const userKey = getUserModelKey(um);
			const builtinKey = getBuiltinModelKey(model);
			return userKey === builtinKey || userKey === model.id || um.id === model.id;
		});

		const builtinInfos = MODELS
			.filter((model) => !hiddenModels.includes(model.id))
			.filter((model) => model.family !== 'deepseek' || hasDeepSeekKey)
			.filter((model) => model.family !== 'openai-responses' || hasAnyResponsesProvider || !!getBuiltinOverride(model)?.providerId)
			.map((model) => {
				const effective = mergeModelOverride(model, getBuiltinOverride(model));
				return toChatInfo(
					effective,
					hasKeyForModel(effective.id, effective.providerId),
					getEffectiveProviderId(effective.id, effective.providerId),
				);
			});
		const userInfos: ModelPickerChatInformation[] = userModels
			.filter((m) => !hiddenModels.includes(m.key || m.id) && !MODELS.some((bm) => bm.id === (m.key || m.id)))
			.filter((m) => m.providerId !== 'deepseek' || hasDeepSeekKey)
			.filter((m) => m.providerId !== 'openai-responses' || hasOpenaiProviderConfigured)
			.map((m) => {
				const hasKey = hasKeyForModel(m.id, m.providerId);
				const providerApiMode = m.providerId ? getProviderById(m.providerId)?.apiMode : undefined;
				return {
					id: m.key || m.id,
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
					...(m.thinking && m.requiresThinkingParam
						? {
							configurationSchema: (providerApiMode === 'responses'
								? buildResponsesConfigurationSchema(m.id, m)
								: buildThinkingEffortSchema(m)) as ThinkingEffortConfigurationSchema,
						}
						: {}),
				};
			});

		return [...builtinInfos, ...userInfos];
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const safeProgress = this.safeProgress(progress, modelInfo.id);
		const modelDef = getBuiltinModelByPickerId(modelInfo.id);
		const baseModelId = modelDef?.id ?? getBaseModelId(modelInfo.id);
		const userModelDef = getUserModels().find((m) => {
			const userKey = getUserModelKey(m);
			return userKey === modelInfo.id || m.id === modelInfo.id || userKey === baseModelId || m.id === baseModelId;
		});
		const resolvedModelId = userModelDef?.id ?? modelDef?.id ?? baseModelId;
		const configuredProviderId = userModelDef?.providerId ?? modelDef?.providerId;
		const effectiveModel = modelDef ? mergeModelOverride(modelDef, userModelDef) : userModelToEffectiveModel(userModelDef);
		const isThinkingModel = effectiveModel?.capabilities.thinking ?? false;
		const isMiMo = effectiveModel?.thinkingParamStyle === 'mimo';
		const needsThinkingParam = effectiveModel?.requiresThinkingParam ?? true;
		const thinkingEffort = getConfiguredThinkingEffort(options as ModelConfigurationOptions);
		const maxTokens = getMaxTokens();

		// Vision: native vision skips proxy, enhancedVision uses Copilot proxy
		// NOTE: 默认关闭 enhancedVision 以加快首字响应速度
		const nativeVision = effectiveModel?.capabilities.nativeVision ?? false;
		const enhancedVision = effectiveModel?.enhancedVision ?? false;
		const userTemp = effectiveModel?.temperature;
		const userTopP = effectiveModel?.topP;

		// Resolve provider-specific settings (baseUrl + apiKey) with cascade
		const modelProviderId = configuredProviderId;
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
		const { baseUrl, providerId } = resolveProviderForModel(modelProviderId, providerKeyStatus, resolvedModelId);
		const resolvedProvider = getProviderById(providerId);
		const isResponses = getProviderApiMode(resolvedProvider) === 'responses';
		const usePreviousResponseId = resolvedProvider?.usePreviousResponseId === true;
		logger.debug(`[Request] model=${modelInfo.id} rawModel=${resolvedModelId} inputProvider=${modelProviderId ?? '(none)'} → resolved provider=${providerId} baseUrl=${baseUrl}`);
		const apiKey = await this.authManager.getApiKeyForProvider(providerId);
		logger.debug(`[Request] apiKey found for provider=${providerId}: ${apiKey ? 'YES' : 'NO'}`);
		if (!apiKey) {
			throw new Error(t('auth.notConfigured') + ` (provider: ${providerId})`);
		}

		const client = new DeepSeekClient(baseUrl, apiKey, {
			skipStreamOptions: isMiMo || isResponses,
			providerLabel: isResponses ? 'OpenAI Responses' : isMiMo ? 'MiMo' : 'DeepSeek',
		});

		// Heuristic: detect conversation start to clear stale cache.
		if (messages.length <= 2) {
			pruneReasoningCache(this.reasoningCache, true);
			this.responsesPreviousResponseIdsByConversation.clear();
			this.responsesReportedCompressionNotices.clear();
		}

		// Vision: native vision → keep images; enhanced → proxy; neither → strip
		const resolvedMessages = nativeVision
			? messages
			: enhancedVision
				? await resolveImageMessages(messages, token, () => this.vision.get())
				: messages;
		const isAutopilotLike = options.tools?.some((tool) => tool.name === 'task_complete') ?? false;

		if (isResponses) {
			this.beginResponse();
			try {
				return await handleResponsesChatRequest({
					baseUrl,
					apiKey,
					usePreviousResponseId,
					modelInfo,
					modelDef,
					userModelDef,
					messages: resolvedMessages,
					options,
					progress: safeProgress,
					token,
					maxTokens,
					thinkingEffort,
					unsupportedPreviousResponseIdBaseUrls: this.responsesPreviousResponseIdUnsupportedBaseUrls,
					previousResponseIdsByConversation: this.responsesPreviousResponseIdsByConversation,
					reportedCompressionNotices: this.responsesReportedCompressionNotices,
					updateCharsPerToken: (observedRatio: number) => {
						this.charsPerToken = this.charsPerToken * 0.7 + observedRatio * 0.3;
					},
				});
			} finally {
				this.endResponse();
			}
		}
		const deepseekMessages = convertMessages(
			resolvedMessages,
			isThinkingModel,
			this.reasoningCache,
			nativeVision,
			isAutopilotLike,
		);
		const canUseTools = effectiveModel?.capabilities.toolCalling ?? true;
		const tools = canUseTools ? convertTools(options.tools) : undefined;

		const totalRequestChars = countMessageChars(deepseekMessages);

		let accumulatedReasoning = '';
		const pendingToolCallIds: string[] = [];
		let responseMessageId: string | undefined;
		const outputRateSessionId = startOutputTokenRate(this.charsPerToken);
		let finalCompletionTokens: number | undefined;

		this.beginResponse();
		return new Promise<void>((resolve, reject) => {
			client.streamChatCompletion(
				{
					model: getApiModelId(userModelDef?.id ?? modelDef?.id ?? modelInfo.id),
					messages: deepseekMessages,
					stream: true,
					tools,
					tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
					...(isMiMo
						? { max_completion_tokens: maxTokens }
						: { max_tokens: maxTokens }),
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
						recordOutputTokenText(outputRateSessionId, content, 'text');
						safeProgress.report(new vscode.LanguageModelTextPart(content));
					},

					onThinking: (text: string) => {
						recordOutputTokenText(outputRateSessionId, text, 'thinking');
						accumulatedReasoning += text;

						// Reasoning/thinking belongs in VS Code's thinking/steps area,
						// not in the normal assistant text stream.
						safeProgress.report(
							new vscode.LanguageModelThinkingPart(
								text,
							) as unknown as vscode.LanguageModelResponsePart,
						);
					},

					onToolDelta: (text, info) => {
						recordOutputTokenText(outputRateSessionId, text, 'tool', info);
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
							safeProgress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args),
							);
						} catch {
							safeProgress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}),
							);
						}
					},

					onError: (error: Error) => {
						stopOutputTokenRate(outputRateSessionId, finalCompletionTokens);
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
						stopOutputTokenRate(outputRateSessionId, finalCompletionTokens);
						resolve();
					},

					onUsage: (usage) => {
						finalCompletionTokens = usage.completion_tokens;
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
						updateStatusBarFromUsage(usage, modelInfo.maxInputTokens, {
							afterPromptTokens: usage.prompt_tokens,
							ratio: 1,
							notice: 'Compression notices can be turned off in the Provider Configuration UI.',
						});
					},
				},
				token,
			);
		}).finally(() => {
			stopOutputTokenRate(outputRateSessionId, finalCompletionTokens);
			this.endResponse();
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
function buildThinkingEffortSchema(model?: Pick<ModelDefinition | UserModelConfig, 'reasoningEfforts' | 'defaultReasoningEffort'>) {
	const configuredEfforts = model?.reasoningEfforts?.filter((effort): effort is Exclude<ReasoningEffortOption, 'on' | 'off'> =>
		effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max' || effort === 'xhigh',
	);
	const efforts = configuredEfforts?.length ? [...new Set(configuredEfforts)] : ['none', 'high', 'max'];
	const defaultEffort = model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort as Exclude<ReasoningEffortOption, 'on' | 'off'>)
		? model.defaultReasoningEffort
		: efforts.includes('high') ? 'high' : efforts[0];
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: efforts,
				enumItemLabels: efforts.map((effort) => t(`thinking.${effort}`)),
				enumDescriptions: efforts.map((effort) => t(`thinking.${effort}.desc`)),
				default: defaultEffort,
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
function resolveDetailKey(m: Pick<ModelDefinition, 'id'>): string | undefined {
	// Map known DeepSeek V4 models: deepseek-v4-flash → model.flash.detail
	const suffix = m.id.startsWith('deepseek-v4-') ? m.id.slice('deepseek-v4-'.length) : m.id;
	const key = `model.${suffix}.detail`;
	// t() returns the raw key string when no translation is defined in either
	// locale — treat that as "no translation available" and fall back.
	const translated = t(key);
	return translated !== key ? key : undefined;
}

function toChatInfo(m: EffectiveModelConfig, hasApiKey: boolean, effectiveProviderId?: string): ModelPickerChatInformation {
	const detailKey = resolveDetailKey(m);
	const modelDetail = detailKey ? t(detailKey) : m.detail ?? '';
	const isMiMo = m.thinkingParamStyle === 'mimo';
	const isResponses = getProviderApiMode(getProviderById(effectiveProviderId || m.providerId || '')) === 'responses';
	const showProvider = effectiveProviderId || m.providerId || 'default';
	return {
		id: m.providerId ? getBuiltinModelKey(m) : m.id,
		name: m.name,
		family: m.family ?? 'mimo-custom',
		version: m.version ?? 'custom',
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
			? { configurationSchema: (isResponses ? buildResponsesConfigurationSchema(m.id, m) : isMiMo ? buildMiMoReasoningSchema() : buildThinkingEffortSchema(m)) as ThinkingEffortConfigurationSchema }
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

function mergeModelOverride(model: ModelDefinition, override: UserModelConfig | undefined): EffectiveModelConfig {
	return {
		...model,
		...(override ?? {}),
		id: model.id,
		name: override?.name || model.name,
		providerId: override?.providerId ?? model.providerId,
		maxInputTokens: override?.maxInputTokens || model.maxInputTokens,
		maxOutputTokens: override?.maxOutputTokens || model.maxOutputTokens,
		capabilities: {
			toolCalling: override?.toolCalling ?? model.capabilities.toolCalling,
			nativeVision: override?.nativeVision ?? model.capabilities.nativeVision,
			thinking: override?.thinking ?? model.capabilities.thinking,
		},
		enhancedVision: override?.enhancedVision ?? model.enhancedVision,
		requiresThinkingParam: override?.requiresThinkingParam ?? model.requiresThinkingParam,
		temperature: override?.temperature ?? model.temperature,
		topP: override?.topP ?? model.topP,
		supportedApiModes: override?.supportedApiModes?.length ? override.supportedApiModes : model.supportedApiModes,
		reasoningEfforts: override?.reasoningEfforts?.length ? override.reasoningEfforts : model.reasoningEfforts,
		defaultReasoningEffort: override?.defaultReasoningEffort ?? model.defaultReasoningEffort,
		verbosityOptions: override?.verbosityOptions?.length ? override.verbosityOptions : model.verbosityOptions,
		defaultVerbosity: override?.defaultVerbosity ?? model.defaultVerbosity,
	};
}

function userModelToEffectiveModel(model: UserModelConfig | undefined): EffectiveModelConfig | undefined {
	if (!model) {
		return undefined;
	}
	return {
		...model,
		capabilities: {
			toolCalling: model.toolCalling,
			nativeVision: model.nativeVision,
			thinking: model.thinking,
		},
	};
}

function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
	const configuredEffort =
		options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
	if (configuredEffort === undefined || configuredEffort === null) {
		return undefined;
	}

	// MiMo on/off
	if (configuredEffort === 'on') { return 'on'; }
	if (configuredEffort === 'off') { return 'none'; }

	if (configuredEffort === 'none') { return 'none'; }
	if (configuredEffort === 'low') { return 'low'; }
	if (configuredEffort === 'medium') { return 'medium'; }
	if (configuredEffort === 'high') { return 'high'; }
	if (configuredEffort === 'xhigh') { return 'xhigh'; }

	return configuredEffort === 'max' ? 'max' : undefined;
}

