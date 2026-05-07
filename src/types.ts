/**
 * Shared types for the DeepSeek Copilot extension.
 */

// ---- API request/response types ----

export interface DeepSeekMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | DeepSeekContentPart[];
	tool_call_id?: string;
	tool_calls?: DeepSeekToolCall[];
	reasoning_content?: string;
}

export interface DeepSeekContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface DeepSeekToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface DeepSeekTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface DeepSeekRequest {
	model: string;
	messages: DeepSeekMessage[];
	stream: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	tools?: DeepSeekTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	thinking?: { type: 'enabled' | 'disabled' };
	reasoning_effort?: 'high' | 'max';
	stream_options?: {
		include_usage: boolean;
	};
}

export interface DeepSeekStreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
	};
}

// ---- Stream callbacks ----

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string) => void;
	onToolCall: (toolCall: DeepSeekToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
	}) => void;
}

// ---- Model definitions ----

export interface ModelDefinition {
	id: string;
	name: string;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean;
		/** Model natively supports image input (base64 images in request). */
		nativeVision: boolean;
		thinking: boolean;
	};
	/** Use Copilot's vision proxy for image descriptions (default true). */
	enhancedVision: boolean;
	requiresThinkingParam: boolean;
	/**
	 * Thinking parameter style:
	 * - 'deepseek' → sends `thinking` + `reasoning_effort`
	 * - 'mimo' → sends `reasoning` (boolean only)
	 * Defaults to 'deepseek' if omitted.
	 */
	thinkingParamStyle?: 'deepseek' | 'mimo';
	/** Link this model to a specific provider. Defaults to 'default' if omitted. */
	providerId?: string;
	/** Default temperature (0-2). */
	temperature?: number;
	/** Default top_p (0-1). */
	topP?: number;
	/** Whether this model appears in the chat model picker. Defaults to true. */
	isUserSelectable?: boolean;
}

/** A configured API provider (DeepSeek, MiMo, or any OpenAI-compatible endpoint). */
export interface ProviderDefinition {
	/** Unique provider identifier (e.g. 'deepseek', 'mimo'). */
	id: string;
	/** Human-readable display name. */
	name: string;
	/** API base URL (e.g. 'https://api.deepseek.com'). */
	baseUrl: string;
}

/** A user-configured model entry (extends the built-in ModelDefinition with user overrides). */
export interface UserModelConfig {
	/** Model ID sent to the API (e.g. 'deepseek-v4-pro'). */
	id: string;
	/** Display name in the model picker. */
	name: string;
	/** Link to a provider. */
	providerId: string;
	/** Max input context tokens. */
	maxInputTokens: number;
	/** Max output tokens. */
	maxOutputTokens: number;
	/** Supports tool calling. */
	toolCalling: boolean;
	/** Supports image input natively (base64 images). */
	nativeVision: boolean;
	/** Use Copilot's vision proxy for image descriptions. */
	enhancedVision: boolean;
	/** Supports thinking/reasoning. */
	thinking: boolean;
	/** Requires explicit thinking parameter in request. */
	requiresThinkingParam?: boolean;
	/** Temperature override (0-2). */
	temperature?: number;
	/** Top-P override (0-1). */
	topP?: number;
}
