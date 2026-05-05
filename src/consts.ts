import type { ModelDefinition, ProviderDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'mimo-copilot';

/** Command ID for opening the provider config webview. */
export const OPEN_CONFIG_COMMAND = 'mimo-copilot.openConfigView';

// ---- Secret keys ----

/** SecretStorage key for the DeepSeek API key. */
export const API_KEY_SECRET = 'mimo-copilot.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'mimo-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'clockzincbit.mimo-for-copilot#mimoGettingStarted';

// ---- Vision proxy ----

/** Default model ID used for the vision proxy when auto-detection is enabled. */
export const DEFAULT_VISION_MODEL_ID = 'oswe-vscode-prime';

/**
 * Prompt sent to the vision proxy model when describing image attachments
 * before forwarding them to text-only DeepSeek models.
 */
export const IMAGE_DESCRIPTION_PROMPT =
	'Describe the visual contents of this image in detail, including any text, objects, people, or context that would be relevant for understanding it. Focus on factual visual elements.';

/**
 * Stable fallback marker inserted into the chat prompt when the vision proxy
 * fails to describe an image. Keep this in English and out of i18n so prompt
 * shape and cache behaviour do not vary by VS Code display language.
 */
export const IMAGE_DESCRIPTION_UNAVAILABLE = '[Image Description unavailable]';

// ---- Cache ----

/** Max entries in the reasoning-content cache before eviction kicks in. */
export const MAX_CACHE_SIZE = 200;

// ---- Model registry ----

/** Available DeepSeek models exposed through the language model provider. */
export const MODELS: ModelDefinition[] = [
	{
		id: 'deepseek-v4-flash',
		name: 'DeepSeek V4 Flash',
		family: 'deepseek',
		version: 'v4',
		detail: 'Fast, general-purpose model',
		maxInputTokens: 1048576,
		maxOutputTokens: 393216,
		capabilities: {
			toolCalling: true,
			nativeVision: false,
			thinking: true,
		},
		// NOTE: 默认关闭 enhancedVision 以加快首字响应速度。启用后每条含图消息会多一次 Copilot 代理请求。
		enhancedVision: false,
		requiresThinkingParam: true,
		providerId: 'deepseek',
		temperature: 0,
	},
	{
		id: 'deepseek-v4-pro',
		name: 'DeepSeek V4 Pro',
		family: 'deepseek',
		version: 'v4',
		detail: 'Most capable reasoning model',
		maxInputTokens: 1048576,
		maxOutputTokens: 393216,
		capabilities: {
			toolCalling: true,
			nativeVision: false,
			thinking: true,
		},
		// NOTE: 默认关闭 enhancedVision 以加快首字响应速度。启用后每条含图消息会多一次 Copilot 代理请求。
		enhancedVision: false,
		requiresThinkingParam: true,
		providerId: 'deepseek',
		temperature: 0,
	},
	{
		id: 'mimo-v2.5-pro',
		name: 'MiMo V2.5 Pro',
		family: 'mimo',
		version: 'v2.5',
		detail: 'Xiaomi advanced reasoning model',
		maxInputTokens: 1048576,
		maxOutputTokens: 131072,
		capabilities: {
			toolCalling: true,
			nativeVision: false,
			thinking: true,
		},
		// NOTE: 默认关闭 enhancedVision 以加快首字响应速度。启用后每条含图消息会多一次 Copilot 代理请求。
		enhancedVision: false,
		requiresThinkingParam: true,
		thinkingParamStyle: 'mimo',
		providerId: 'mimo',
		temperature: 1,
		topP: 0.95,
	},
	{
		id: 'mimo-v2.5',
		name: 'MiMo V2.5',
		family: 'mimo',
		version: 'v2.5',
		detail: 'Xiaomi model with native vision',
		maxInputTokens: 1048576,
		maxOutputTokens: 131072,
		capabilities: {
			toolCalling: true,
			nativeVision: true,
			thinking: true,
		},
		enhancedVision: false,
		requiresThinkingParam: true,
		thinkingParamStyle: 'mimo',
		providerId: 'mimo',
		temperature: 1,
		topP: 0.95,
	},
];

/** Default provider definitions. Users can add more via the config view. */
export const DEFAULT_PROVIDERS: ProviderDefinition[] = [
	{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
	{ id: 'mimo', name: 'MiMo (Xiaomi)', baseUrl: 'https://api.xiaomimimo.com/v1' },
	{ id: 'mimo-tp', name: 'MiMo Token Plan', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1' },
];
