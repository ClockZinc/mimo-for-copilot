import vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import { getApiModelId } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { updateStatusBarFromUsage } from '../statusBar';
import type {
	DeepSeekToolCall,
	ModelDefinition,
	ResponsesFunctionCallItem,
	ResponsesInputItem,
	ResponsesMessageContentPart,
	ResponsesRequest,
	ResponsesTool,
	StreamCallbacks,
	UserModelConfig,
} from '../types';

type ResponsesConfigurationSchema = { readonly properties: Record<string, unknown> };
type ResponsesVerbosity = 'low' | 'medium' | 'high';
type ResponsesReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

type ResponsesModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

type HandleResponsesChatRequestArgs = {
	baseUrl: string;
	apiKey: string;
	modelInfo: vscode.LanguageModelChatInformation;
	modelDef?: ModelDefinition;
	userModelDef?: UserModelConfig;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	maxTokens: number | undefined;
	thinkingEffort: string | undefined;
	unsupportedPreviousResponseIdBaseUrls: Set<string>;
	updateCharsPerToken: (observedRatio: number) => void;
};

type ResponsesStreamState = {
	pendingToolCalls: Map<number, DeepSeekToolCall>;
	emittedTextKeys: Set<string>;
	emittedReasoningKeys: Set<string>;
	emittedToolCallKeys: Set<string>;
	currentThinkingId: string | null;
	thinkingBuffer: string;
	thinkingFlushTimer: NodeJS.Timeout | null;
	hasEmittedThinking: boolean;
	hasEmittedAssistantText: boolean;
	emittedBeginToolCallsHint: boolean;
	reasoningEventCount: number;
	textEventCount: number;
	toolEventCount: number;
	unknownEventTypes: Set<string>;
	usedNonStreamFallback: boolean;
};

type ResponsesStatefulMarkerLocation = {
	marker: string;
	index: number;
};

const RESPONSES_STATEFUL_MARKER_MIME = 'application/vnd.mimo-copilot.responses-stateful-marker';

function previewText(text: string, maxLength = 100): string {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return '';
	}
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

class ResponsesHttpError extends Error {
	constructor(
		readonly status: number,
		readonly responseText: string,
	) {
		super(`OpenAI Responses API error (${status}): ${parseResponsesError(responseText)}`);
		this.name = 'ResponsesHttpError';
	}
}

export function buildResponsesConfigurationSchema(modelId: string): ResponsesConfigurationSchema {
	const isLitePreset = modelId === 'gpt-5.5';
	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: ['none', 'low', 'medium', 'high', 'xhigh'],
				enumItemLabels: [t('thinking.none'), t('thinking.low'), t('thinking.medium'), t('thinking.high'), t('thinking.xhigh')],
				enumDescriptions: [
					t('thinking.none.desc'),
					t('thinking.low.desc'),
					t('thinking.medium.desc'),
					t('thinking.high.desc'),
					t('thinking.xhigh.desc'),
				],
				default: isLitePreset ? 'medium' : 'none',
				group: 'navigation',
			},
			verbosity: {
				type: 'string',
				title: t('responses.verbosity.title'),
				enum: ['low', 'medium', 'high'],
				enumItemLabels: [t('responses.verbosity.low'), t('responses.verbosity.medium'), t('responses.verbosity.high')],
				default: isLitePreset ? 'medium' : 'high',
				group: 'navigation',
			},
		},
	} as const;
}

export function getConfiguredResponsesVerbosity(
	options: ResponsesModelConfigurationOptions,
	modelId: string,
): ResponsesVerbosity | undefined {
	const configuredVerbosity = options.modelConfiguration?.verbosity ?? options.configuration?.verbosity;
	if (configuredVerbosity === 'low' || configuredVerbosity === 'medium' || configuredVerbosity === 'high') {
		return configuredVerbosity;
	}
	return modelId === 'gpt-5.5' ? 'medium' : undefined;
}

export function normalizeResponsesEffort(
	modelId: string,
	effort: string | undefined,
): ResponsesReasoningEffort {
	if (effort === 'on' || effort === 'off') {
		return effort === 'off' ? 'none' : 'medium';
	}
	if (effort === 'max') {
		return 'high';
	}
	if (effort === 'none' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
		return effort;
	}
	return modelId === 'gpt-5.5' ? 'medium' : 'none';
}

function getResponsesReasoningSummary(
	effort: ResponsesReasoningEffort,
): 'auto' | 'concise' | 'detailed' {
	if (effort === 'none') {
		return 'auto';
	}
	return 'auto';
}

export async function handleResponsesChatRequest(args: HandleResponsesChatRequestArgs): Promise<void> {
	const isThinkingModel = args.modelDef?.capabilities.thinking ?? args.userModelDef?.thinking ?? false;
	const needsThinkingParam = args.modelDef?.requiresThinkingParam ?? args.userModelDef?.requiresThinkingParam ?? true;
	const userTemp = args.userModelDef?.temperature ?? args.modelDef?.temperature;
	const userTopP = args.userModelDef?.topP ?? args.modelDef?.topP;
	const statefulModelId = getApiModelId(args.modelInfo.id);
	const normalizedBaseUrl = args.baseUrl.replace(/\/+$/, '');
	const fullMessages = convertResponsesMessages(args.messages);
	const marker = findLastResponsesStatefulMarker(statefulModelId, args.messages);
	let deltaMessages: { input: ResponsesInputItem[]; instructions?: string } | undefined;
	if (marker && marker.index >= 0 && marker.index < args.messages.length - 1) {
		deltaMessages = convertResponsesMessages(args.messages.slice(marker.index + 1));
	}
	const canUsePreviousResponseId =
		!!marker?.marker
		&& !args.unsupportedPreviousResponseIdBaseUrls.has(normalizedBaseUrl)
		&& !!deltaMessages
		&& deltaMessages.input.length > 0;
	const requestMessages = canUsePreviousResponseId && deltaMessages
		? {
			input: deltaMessages.input,
			instructions: deltaMessages.instructions ?? fullMessages.instructions,
		}
		: fullMessages;
	const responsesTools = convertResponsesTools(args.options.tools);
	const responsesVerbosity = getConfiguredResponsesVerbosity(
		args.options as ResponsesModelConfigurationOptions,
		args.modelInfo.id,
	);
	const normalizedEffort = normalizeResponsesEffort(args.modelInfo.id, args.thinkingEffort);
	const responseRequestChars = countResponsesRequestChars(requestMessages.input, requestMessages.instructions);
	const client = new ResponsesClient(args.baseUrl, args.apiKey);
	let currentThinkingId: string | null = null;

	const reportThinkingChunk = (text: string) => {
		if (!text) {
			if (!currentThinkingId) {
				return;
			}
			args.progress.report(
				new vscode.LanguageModelThinkingPart('', currentThinkingId) as unknown as vscode.LanguageModelResponsePart,
			);
			currentThinkingId = null;
			return;
		}

		if (!currentThinkingId) {
			currentThinkingId = generateThinkingId();
		}

		args.progress.report(
			new vscode.LanguageModelThinkingPart(text, currentThinkingId) as unknown as vscode.LanguageModelResponsePart,
		);
	};

	const buildRequest = (input: ResponsesInputItem[], instructions?: string, previousResponseId?: string): ResponsesRequest => ({
		model: getApiModelId(args.modelInfo.id),
		input,
		stream: true,
		...(instructions ? { instructions } : {}),
		...(typeof args.maxTokens === 'number' && args.maxTokens > 0 ? { max_output_tokens: args.maxTokens } : {}),
		...(userTemp !== undefined ? { temperature: userTemp } : {}),
		...(userTopP !== undefined ? { top_p: userTopP } : {}),
		...(responsesTools.tools
			? {
				tools: responsesTools.tools,
				tool_choice: responsesTools.toolChoice,
				parallel_tool_calls: true,
			}
			: {}),
		...(responsesVerbosity ? { text: { verbosity: responsesVerbosity } } : {}),
		...(isThinkingModel && needsThinkingParam
			? {
				reasoning: {
					effort: normalizedEffort,
					summary: getResponsesReasoningSummary(normalizedEffort),
				},
			}
			: {}),
		...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
	});

	let responseId: string | undefined;
	const streamWithCallbacks = async (request: ResponsesRequest, requestChars: number): Promise<void> => {
		return new Promise<void>((resolve, reject) => {
			client.stream(
				request,
				{
					onContent: (content: string) => {
						args.progress.report(new vscode.LanguageModelTextPart(content));
					},
					onThinking: (text: string) => {
						reportThinkingChunk(text);
					},
					onToolCall: (toolCall: DeepSeekToolCall) => {
						try {
							const parsedArgs = JSON.parse(toolCall.function.arguments);
							args.progress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, parsedArgs),
							);
						} catch {
							args.progress.report(
								new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}),
							);
						}
					},
					onResponseId: (nextResponseId: string) => {
						responseId = nextResponseId;
					},
					onError: reject,
					onDone: () => {
						reportThinkingChunk('');
						resolve();
					},
					onUsage: (usage) => {
						if (requestChars > 0 && usage.prompt_tokens > 0) {
							const observedRatio = requestChars / usage.prompt_tokens;
							if (Number.isFinite(observedRatio) && observedRatio > 0) {
								args.updateCharsPerToken(observedRatio);
							}
						}
						updateStatusBarFromUsage(usage, args.modelInfo.maxInputTokens);
					},
				},
				args.token,
			);
		});
	};

	let request = buildRequest(
		requestMessages.input,
		requestMessages.instructions,
		canUsePreviousResponseId ? marker?.marker : undefined,
	);

	try {
		await streamWithCallbacks(request, responseRequestChars);
	} catch (error) {
		const shouldRetryWithoutPreviousResponseId =
			canUsePreviousResponseId
			&& error instanceof ResponsesHttpError
			&& error.status >= 400
			&& error.status < 500
			&& error.status !== 429;

		if (!shouldRetryWithoutPreviousResponseId) {
			throw error;
		}

		args.unsupportedPreviousResponseIdBaseUrls.add(normalizedBaseUrl);
		responseId = undefined;
		request = buildRequest(fullMessages.input, fullMessages.instructions);
		await streamWithCallbacks(
			request,
			countResponsesRequestChars(fullMessages.input, fullMessages.instructions),
		);
	}

	if (responseId) {
		args.progress.report(
			createResponsesStatefulMarkerPart(statefulModelId, responseId) as unknown as vscode.LanguageModelResponsePart,
		);
	}
}

function convertResponsesMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): { input: ResponsesInputItem[]; instructions?: string } {
	const input: ResponsesInputItem[] = [];
	const instructionParts: string[] = [];

	for (const message of messages) {
		const textParts: string[] = [];
		const imageParts: vscode.LanguageModelDataPart[] = [];
		const toolCalls: DeepSeekToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];
		const thinkingParts: string[] = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
			} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
				imageParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: JSON.stringify(part.input ?? {}),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelTextPart) {
						toolContent += item.value;
					}
				}
				toolResults.push({
					callId: part.callId,
					content: toolContent || JSON.stringify(part.content),
				});
			} else if (part instanceof vscode.LanguageModelThinkingPart) {
				const value = Array.isArray(part.value) ? part.value.join('') : part.value;
				thinkingParts.push(value);
			}
		}

		const text = textParts.join('').trim();
		const thinking = thinkingParts.join('').trim();

		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			const content: ResponsesMessageContentPart[] = [];
			if (text) {
				content.push({ type: 'input_text', text });
			}
			for (const imagePart of imageParts) {
				const dataUrl = `data:${imagePart.mimeType};base64,${Buffer.from(imagePart.data).toString('base64')}`;
				content.push({ type: 'input_image', image_url: dataUrl });
			}
			if (content.length > 0) {
				input.push({
					type: 'message',
					role: 'user',
					content,
					status: 'completed',
				});
			}
			continue;
		}

		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			if (text) {
				input.push({
					type: 'message',
					role: 'assistant',
					phase: toolCalls.length > 0 ? 'commentary' : 'final_answer',
					content: [{ type: 'output_text', text }],
					status: 'completed',
				});
			}
			if (thinking) {
				input.push({
					type: 'reasoning',
					summary: [{ type: 'summary_text', text: thinking }],
					status: 'completed',
				});
			}
			for (const toolCall of toolCalls) {
				input.push({
					type: 'function_call',
					call_id: toolCall.id,
					name: toolCall.function.name,
					arguments: toolCall.function.arguments,
					status: 'completed',
				});
			}
			for (const toolResult of toolResults) {
				input.push({
					type: 'function_call_output',
					call_id: toolResult.callId,
					output: toolResult.content,
					status: 'completed',
				});
			}
			continue;
		}

		if (text) {
			instructionParts.push(text);
		}
	}

	return {
		input,
		instructions: instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined,
	};
}

function convertResponsesTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): { tools?: ResponsesTool[]; toolChoice?: 'auto' | { type: 'function'; name: string } } {
	if (!tools || tools.length === 0) {
		return {};
	}

	return {
		tools: tools.map((tool) => ({
			type: 'function',
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown> | undefined,
		})),
		toolChoice: 'auto',
	};
}

function countResponsesRequestChars(input: ResponsesInputItem[], instructions?: string): number {
	let total = instructions?.length ?? 0;

	for (const item of input) {
		if (item.type === 'message') {
			for (const part of item.content) {
				total += part.text?.length ?? 0;
			}
			continue;
		}

		if (item.type === 'reasoning') {
			for (const summary of item.summary) {
				total += summary.text?.length ?? 0;
			}
			continue;
		}

		if (item.type === 'function_call') {
			total += item.name.length + item.arguments.length;
			continue;
		}

		total += item.output.length;
	}

	return total;
}

class ResponsesClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
	) {}

	async stream(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		let emittedResponsePart = false;
		let streamConnected = false;
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});

		try {
			logger.debug(
				`[Responses] stream.start url=${this.baseUrl}/responses`
				+ ` model=${request.model} inputItems=${request.input.length}`
				+ ` previousResponseId=${request.previous_response_id ? 'yes' : 'no'}`
				+ ` reasoning=${request.reasoning ? JSON.stringify(request.reasoning) : 'none'}`,
			);

			const response = await this.fetchWithRetry(request, controller.signal, 'stream');

			if (!response.ok) {
				const errorText = await response.text();
				if (request.stream && shouldFallbackToNonStream(response.status, errorText)) {
					logger.warn(
						`[Responses] Streaming failed with ${response.status}; falling back to non-stream. ${errorText.slice(0, 200)}`,
					);
					await this.fetchWithoutStreaming({ ...request, stream: false }, callbacks, controller.signal);
					callbacks.onDone();
					return;
				}
				throw new ResponsesHttpError(response.status, errorText);
			}

			const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
			if (!contentType.includes('text/event-stream')) {
				logger.debug('[Responses] fallback.nonstream reason=content_type');
				logger.warn(
					`[Responses] Expected SSE but received ${contentType || 'unknown content type'}; using JSON fallback.`,
				);
				const responseJson = await response.json() as Record<string, unknown>;
				const state: ResponsesStreamState = {
					pendingToolCalls: new Map<number, DeepSeekToolCall>(),
					emittedTextKeys: new Set<string>(),
					emittedReasoningKeys: new Set<string>(),
					emittedToolCallKeys: new Set<string>(),
					currentThinkingId: null,
					thinkingBuffer: '',
					thinkingFlushTimer: null,
					hasEmittedThinking: false,
					hasEmittedAssistantText: false,
					emittedBeginToolCallsHint: false,
					reasoningEventCount: 0,
					textEventCount: 0,
					toolEventCount: 0,
					unknownEventTypes: new Set<string>(),
					usedNonStreamFallback: true,
				};
				this.emitJsonResponse(responseJson, callbacks);
				logResponsesSummary(state);
				callbacks.onDone();
				return;
			}

			if (!response.body) {
				throw new Error('No response body received');
			}
			streamConnected = true;
			logger.debug(
				`[Responses] stream.connected contentType=${contentType || 'unknown'}`,
			);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			const state: ResponsesStreamState = {
				pendingToolCalls: new Map<number, DeepSeekToolCall>(),
				emittedTextKeys: new Set<string>(),
				emittedReasoningKeys: new Set<string>(),
				emittedToolCallKeys: new Set<string>(),
				currentThinkingId: null,
				thinkingBuffer: '',
				thinkingFlushTimer: null,
				hasEmittedThinking: false,
				hasEmittedAssistantText: false,
				emittedBeginToolCallsHint: false,
				reasoningEventCount: 0,
				textEventCount: 0,
				toolEventCount: 0,
				unknownEventTypes: new Set<string>(),
				usedNonStreamFallback: false,
			};

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) {
						continue;
					}

					const data = trimmed.slice(5).trim();
					if (data === '[DONE]') {
						logger.debug('[Responses] stream.done');
						logResponsesSummary(state);
						flushPendingToolCalls(state, callbacks);
						callbacks.onDone();
						return;
					}

					try {
						const event = JSON.parse(data) as Record<string, unknown>;
						emittedResponsePart = true;
						this.handleEvent(event, callbacks, state);
					} catch (error) {
						logger.error('[Responses] Failed to parse SSE chunk:', data.slice(0, 200), error);
					}
				}
			}

			reportEndThinking(state, callbacks);
			logResponsesSummary(state);
			flushPendingToolCalls(state, callbacks);
			callbacks.onDone();
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				reportEndThinking(undefined, callbacks);
				callbacks.onDone();
				return;
			}

			if (request.stream && !emittedResponsePart && !streamConnected) {
				try {
					logger.debug('[Responses] fallback.nonstream reason=no_stream_events');
					logger.warn('[Responses] Streaming threw before content; retrying without streaming.', error);
					await this.fetchWithoutStreaming({ ...request, stream: false }, callbacks, controller.signal);
					callbacks.onDone();
					return;
				} catch (fallbackError) {
					callbacks.onError(fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)));
					return;
				}
			}

			callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancelListener?.dispose();
		}
	}

	private async fetchWithoutStreaming(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<void> {
		logger.debug(
			`[Responses] json.start url=${this.baseUrl}/responses`
			+ ` model=${request.model} inputItems=${request.input.length}`
				+ ` previousResponseId=${request.previous_response_id ? 'yes' : 'no'}`,
		);

		const response = await this.fetchWithRetry(request, signal, 'json');

		if (!response.ok) {
			const errorText = await response.text();
			throw new ResponsesHttpError(response.status, errorText);
		}

		const responseJson = await response.json() as Record<string, unknown>;
		this.emitJsonResponse(responseJson, callbacks);
	}

	private async fetchWithRetry(
		request: ResponsesRequest,
		signal: AbortSignal,
		mode: 'stream' | 'json',
	): Promise<Response> {
		const url = `${this.baseUrl}/responses`;
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await fetch(url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${this.apiKey}`,
					},
					body: JSON.stringify(request),
					signal,
				});
			} catch (error) {
				lastError = error;
				if (attempt === 0) {
					logger.warn(
						`[Responses] ${mode}.fetch.retry attempt=${attempt + 1} error=${error instanceof Error ? error.message : String(error)}`,
					);
					await new Promise((resolve) => setTimeout(resolve, 800));
				}
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`Responses ${mode} fetch failed`);
	}

	private emitJsonResponse(
		responseJson: Record<string, unknown>,
		callbacks: StreamCallbacks,
	): void {
		const responseId = typeof responseJson.id === 'string' ? responseJson.id : undefined;
		let hasOpenThinking = false;
		logger.debug(
			`[Responses] json.response id=${responseId ?? 'n/a'} status=${String(responseJson.status ?? 'unknown')}`,
		);
		if (responseId && callbacks.onResponseId) {
			callbacks.onResponseId(responseId);
		}

		const topLevelReasoning = responseJson.reasoning as Record<string, unknown> | undefined;
		if (topLevelReasoning) {
			const summaryItems = Array.isArray(topLevelReasoning.summary)
				? topLevelReasoning.summary as Array<Record<string, unknown>>
				: [];
			for (const summary of summaryItems) {
				const text = coerceText(summary.text ?? summary);
				if (text && !looksLikeReasoningConfigValue(text)) {
					logger.debug(
						`[Responses] json.reasoning type=top-level.summary len=${text.length} preview=${previewText(text)}`,
					);
					hasOpenThinking = true;
					callbacks.onThinking(text);
				}
			}
		}

		const outputItems = Array.isArray(responseJson.output)
			? responseJson.output as Array<Record<string, unknown>>
			: [];
		for (const item of outputItems) {
			const itemType = typeof item.type === 'string' ? item.type : '';
			if (itemType === 'message') {
				const contentParts = Array.isArray(item.content)
					? item.content as Array<Record<string, unknown>>
					: [];
				for (const part of contentParts) {
					const partType = typeof part.type === 'string' ? part.type : '';
					const text = coerceText(part.text ?? part.delta ?? part.content);
					if (!text) {
						continue;
					}
					if (partType === 'output_text' || partType === 'refusal') {
						if (hasOpenThinking) {
							callbacks.onThinking('');
							hasOpenThinking = false;
						}
						logger.debug(
							`[Responses] json.text type=${partType} len=${text.length} preview=${previewText(text)}`,
						);
						callbacks.onContent(text);
						continue;
					}
					if ((partType === 'reasoning_text' || partType === 'summary_text') && !looksLikeReasoningConfigValue(text)) {
						logger.debug(
							`[Responses] json.reasoning type=${partType} len=${text.length} preview=${previewText(text)}`,
						);
						hasOpenThinking = true;
						callbacks.onThinking(text);
					}
				}
				continue;
			}

			if (itemType === 'reasoning') {
				const summaries = Array.isArray(item.summary)
					? item.summary as Array<Record<string, unknown>>
					: [];
				for (const summary of summaries) {
					const text = coerceText(summary.text ?? summary);
					if (text && !looksLikeReasoningConfigValue(text)) {
						logger.debug(
							`[Responses] json.reasoning type=reasoning.summary len=${text.length} preview=${previewText(text)}`,
						);
						hasOpenThinking = true;
						callbacks.onThinking(text);
					}
				}
				continue;
			}

			if (itemType === 'function_call') {
				if (hasOpenThinking) {
					callbacks.onThinking('');
					hasOpenThinking = false;
				}
				const callId = typeof item.call_id === 'string'
					? item.call_id
					: typeof item.id === 'string'
						? item.id
						: 'call_0';
				const name = typeof item.name === 'string' ? item.name : '';
				const args = typeof item.arguments === 'string' ? item.arguments : '{}';
				logger.debug(`[Responses] json.tool name=${name || 'unknown'} callId=${callId}`);
				callbacks.onToolCall({
					id: callId,
					type: 'function',
					function: { name, arguments: args },
				});
			}
		}

		if (hasOpenThinking) {
			callbacks.onThinking('');
		}

		const usage = responseJson.usage as Record<string, unknown> | undefined;
		if (usage && callbacks.onUsage) {
			const inputTokens = Number(usage.input_tokens ?? 0);
			const outputTokens = Number(usage.output_tokens ?? 0);
			const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
			const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
			callbacks.onUsage({
				prompt_tokens: inputTokens,
				completion_tokens: outputTokens,
				total_tokens: totalTokens,
				prompt_cache_hit_tokens: Number(inputDetails?.cached_tokens ?? 0),
			});
		}

		const responseError = responseJson.error as Record<string, unknown> | null | undefined;
		if (responseError && typeof responseError.message === 'string') {
			throw new Error(responseError.message);
		}
	}

	private handleEvent(
		event: Record<string, unknown>,
		callbacks: StreamCallbacks,
		state: ResponsesStreamState,
	): void {
		const eventType = typeof event.type === 'string' ? event.type : '';
		captureResponseIdFromEvent(event, callbacks);

		switch (eventType) {
			case 'response.created':
			case 'response.in_progress': {
				logger.debug(`[Responses] event type=${eventType}`);
				return;
			}
			case 'response.output_text.delta':
			case 'response.refusal.delta': {
				const delta = coerceText(event.delta);
				if (!delta) {
					return;
				}
				logger.debug(
					`[Responses] text.delta type=${eventType} len=${delta.length} preview=${previewText(delta)}`,
				);
				state.textEventCount += 1;
				reportEndThinking(state, callbacks);
				const key = buildEventKey(event, 'item');
				state.emittedTextKeys.add(key);
				state.hasEmittedAssistantText = true;
				callbacks.onContent(delta);
				return;
			}
			case 'response.output_text.done':
			case 'response.refusal.done': {
				const key = buildEventKey(event, 'item');
				const text = coerceText(event.text);
				if (text && !state.emittedTextKeys.has(key)) {
					logger.debug(
						`[Responses] text.done type=${eventType} len=${text.length} preview=${previewText(text)}`,
					);
					state.textEventCount += 1;
					reportEndThinking(state, callbacks);
					state.emittedTextKeys.add(key);
					state.hasEmittedAssistantText = true;
					callbacks.onContent(text);
				}
				return;
			}
			case 'response.reasoning.delta':
			case 'response.reasoning_text.delta':
			case 'response.reasoning_summary.delta':
			case 'response.reasoning_summary_text.delta':
			case 'response.thinking.delta':
			case 'response.thinking_summary.delta':
			case 'response.thought.delta':
			case 'response.thought_summary.delta': {
				const delta = extractReasoningText(event);
				if (!delta || looksLikeReasoningConfigValue(delta)) {
					return;
				}
				logger.debug(
					`[Responses] reasoning.delta type=${eventType} len=${delta.length} preview=${previewText(delta)}`,
				);
				state.reasoningEventCount += 1;
				state.emittedReasoningKeys.add(buildEventKey(event, 'reasoning'));
				bufferThinkingContent(delta, state, callbacks);
				return;
			}
			case 'response.reasoning.done':
			case 'response.reasoning_text.done':
			case 'response.reasoning_summary.done':
			case 'response.reasoning_summary_text.done':
			case 'response.thinking.done':
			case 'response.thinking_summary.done':
			case 'response.thought.done':
			case 'response.thought_summary.done': {
				const key = buildEventKey(event, 'reasoning');
				const text = extractReasoningText(event);
				if (text && !looksLikeReasoningConfigValue(text) && !state.emittedReasoningKeys.has(key)) {
					logger.debug(
						`[Responses] reasoning.done type=${eventType} len=${text.length} preview=${previewText(text)}`,
					);
					state.reasoningEventCount += 1;
					state.emittedReasoningKeys.add(key);
					bufferThinkingContent(text, state, callbacks);
				}
				reportEndThinking(state, callbacks);
				return;
			}
			case 'response.function_call_arguments.delta':
			case 'response.function_call_arguments.done': {
				reportEndThinking(state, callbacks);
				if (!state.emittedBeginToolCallsHint && state.hasEmittedAssistantText) {
					callbacks.onContent(' ');
					state.emittedBeginToolCallsHint = true;
				}
				const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
				logger.debug(
					`[Responses] tool.delta type=${eventType} outputIndex=${outputIndex} name=${typeof event.name === 'string' ? event.name : ''}`,
				);
				state.toolEventCount += 1;
				const pending = state.pendingToolCalls.get(outputIndex) ?? {
					id: getCallIdFromEvent(event, outputIndex),
					type: 'function' as const,
					function: { name: '', arguments: '' },
				};
				const name = typeof event.name === 'string' ? event.name : '';
				if (name && !pending.function.name) {
					pending.function.name = name;
				}
				const argsChunk = eventType === 'response.function_call_arguments.delta'
					? coerceText(event.delta)
					: coerceText(event.arguments);
				if (eventType === 'response.function_call_arguments.delta') {
					pending.function.arguments += argsChunk;
				} else if (argsChunk) {
					pending.function.arguments = argsChunk;
				}
				state.pendingToolCalls.set(outputIndex, pending);
				if (eventType === 'response.function_call_arguments.done') {
					flushPendingToolCall(outputIndex, state, callbacks);
				}
				return;
			}
			case 'response.output_item.added':
			case 'response.output_item.done': {
				const item = event.item as ResponsesFunctionCallItem | undefined;
				if (!item || item.type !== 'function_call') {
					return;
				}
				logger.debug(`[Responses] tool.output_item name=${item.name} callId=${item.call_id}`);
				state.toolEventCount += 1;
				reportEndThinking(state, callbacks);
				if (!state.emittedBeginToolCallsHint && state.hasEmittedAssistantText) {
					callbacks.onContent(' ');
					state.emittedBeginToolCallsHint = true;
				}
				const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
				state.pendingToolCalls.set(outputIndex, {
					id: item.call_id,
					type: 'function',
					function: {
						name: item.name,
						arguments: item.arguments,
					},
				});
				if (eventType === 'response.output_item.done') {
					flushPendingToolCall(outputIndex, state, callbacks);
				}
				return;
			}
			case 'response.completed':
			case 'response.done': {
				logger.debug(`[Responses] event type=${eventType}`);
				reportEndThinking(state, callbacks);
				flushPendingToolCalls(state, callbacks);
				reportUsageFromEvent(event, callbacks);
				return;
			}
			case 'response.failed':
			case 'error': {
				const responseObject = event.response as Record<string, unknown> | undefined;
				const error = (responseObject?.error ?? event.error) as Record<string, unknown> | undefined;
				logger.debug(`[Responses] event type=${eventType} error=${String(error?.message ?? 'unknown')}`);
				throw new Error(
					typeof error?.message === 'string'
						? error.message
						: 'Responses API request failed',
				);
			}
			default: {
				if (eventType) {
					state.unknownEventTypes.add(eventType);
					logger.debug(
						`[Responses] event.unhandled type=${eventType} payload=${JSON.stringify(summarizeUnknownEvent(event))}`,
					);
				}
				return;
			}
		}
	}
}

function logResponsesSummary(state: ResponsesStreamState): void {
	logger.debug(
		`[Responses] summary reasoningEvents=${state.reasoningEventCount}`
		+ ` textEvents=${state.textEventCount}`
		+ ` toolEvents=${state.toolEventCount}`
		+ ` usedNonStreamFallback=${state.usedNonStreamFallback ? 'yes' : 'no'}`
		+ ` unknownEvents=${state.unknownEventTypes.size > 0 ? [...state.unknownEventTypes].join('|') : 'none'}`,
	);
}

function summarizeUnknownEvent(event: Record<string, unknown>): Record<string, unknown> {
	const summary: Record<string, unknown> = {};
	for (const key of ['type', 'item_id', 'output_index', 'content_index', 'part_index', 'summary_index']) {
		if (key in event) {
			summary[key] = event[key];
		}
	}

	const part = event.part;
	if (part && typeof part === 'object' && !Array.isArray(part)) {
		const record = part as Record<string, unknown>;
		summary.part = {
			type: record.type,
			text: typeof record.text === 'string' ? previewText(record.text, 160) : undefined,
			summary: typeof record.summary === 'string' ? previewText(record.summary, 160) : undefined,
			reasoning: typeof record.reasoning === 'string' ? previewText(record.reasoning, 160) : undefined,
		};
	}

	const item = event.item;
	if (item && typeof item === 'object' && !Array.isArray(item)) {
		const record = item as Record<string, unknown>;
		summary.item = {
			type: record.type,
			status: record.status,
			role: record.role,
		};
	}

	if (typeof event.delta === 'string') {
		summary.delta = previewText(event.delta, 160);
	}
	if (typeof event.text === 'string') {
		summary.text = previewText(event.text, 160);
	}

	return summary;
}

function captureResponseIdFromEvent(
	event: Record<string, unknown>,
	callbacks: StreamCallbacks,
): void {
	const responseObject = event.response as Record<string, unknown> | undefined;
	const responseId = typeof event.response_id === 'string'
		? event.response_id
		: typeof responseObject?.id === 'string'
			? responseObject.id
			: undefined;
	if (responseId && callbacks.onResponseId) {
		callbacks.onResponseId(responseId);
	}
}

function reportUsageFromEvent(event: Record<string, unknown>, callbacks: StreamCallbacks): void {
	const responseObject = event.response as Record<string, unknown> | undefined;
	const usage = responseObject?.usage as Record<string, unknown> | undefined;
	if (!usage || !callbacks.onUsage) {
		return;
	}
	const inputTokens = Number(usage.input_tokens ?? 0);
	const outputTokens = Number(usage.output_tokens ?? 0);
	const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens);
	const inputDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
	callbacks.onUsage({
		prompt_tokens: inputTokens,
		completion_tokens: outputTokens,
		total_tokens: totalTokens,
		prompt_cache_hit_tokens: Number(inputDetails?.cached_tokens ?? 0),
	});
}

function flushPendingToolCall(
	outputIndex: number,
	state: ResponsesStreamState,
	callbacks: StreamCallbacks,
): void {
	const pending = state.pendingToolCalls.get(outputIndex);
	if (!pending || state.emittedToolCallKeys.has(pending.id)) {
		state.pendingToolCalls.delete(outputIndex);
		return;
	}
	callbacks.onToolCall(pending);
	state.emittedToolCallKeys.add(pending.id);
	state.pendingToolCalls.delete(outputIndex);
}

function flushPendingToolCalls(state: ResponsesStreamState, callbacks: StreamCallbacks): void {
	for (const outputIndex of Array.from(state.pendingToolCalls.keys())) {
		flushPendingToolCall(outputIndex, state, callbacks);
	}
}

function generateThinkingId(): string {
	return `responses_thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function bufferThinkingContent(
	text: string,
	state: ResponsesStreamState | undefined,
	callbacks: StreamCallbacks,
): void {
	if (!state) {
		callbacks.onThinking(text);
		return;
	}
	state.hasEmittedThinking = true;
	if (!state.currentThinkingId) {
		state.currentThinkingId = generateThinkingId();
	}
	state.thinkingBuffer += text;
	if (!state.thinkingFlushTimer) {
		state.thinkingFlushTimer = setTimeout(() => {
			flushThinkingBuffer(state, callbacks);
		}, 100);
	}
}

function flushThinkingBuffer(
	state: ResponsesStreamState,
	callbacks: StreamCallbacks,
): void {
	if (state.thinkingFlushTimer) {
		clearTimeout(state.thinkingFlushTimer);
		state.thinkingFlushTimer = null;
	}
	if (state.thinkingBuffer && state.currentThinkingId) {
		const text = state.thinkingBuffer;
		state.thinkingBuffer = '';
		callbacks.onThinking(text);
	}
}

function reportEndThinking(
	state: ResponsesStreamState | undefined,
	callbacks: StreamCallbacks,
): void {
	if (!state?.currentThinkingId) {
		return;
	}
	flushThinkingBuffer(state, callbacks);
	callbacks.onThinking('');
	state.currentThinkingId = null;
	state.thinkingBuffer = '';
	state.hasEmittedThinking = false;
	if (state.thinkingFlushTimer) {
		clearTimeout(state.thinkingFlushTimer);
		state.thinkingFlushTimer = null;
	}
}

function buildEventKey(event: Record<string, unknown>, fallbackItemId: string): string {
	const itemId = typeof event.item_id === 'string' ? event.item_id : fallbackItemId;
	const contentIndex = typeof event.content_index === 'number'
		? event.content_index
		: typeof event.summary_index === 'number'
			? event.summary_index
			: 0;
	return `${itemId}:${contentIndex}`;
}

function extractReasoningText(event: Record<string, unknown>): string {
	const candidates = [
		coerceText(event.delta),
		coerceText(event.text),
		coerceText(event.reasoning),
		coerceText(event.summary),
	].filter(Boolean);
	return candidates[0] ?? '';
}

function getCallIdFromEvent(event: Record<string, unknown>, outputIndex: number): string {
	const raw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
	return typeof raw === 'string' && raw.trim() ? raw : `call_${outputIndex}`;
}

function coerceText(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => coerceText(item)).join('');
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.text === 'string') {
			return record.text;
		}
		if (typeof record.content === 'string') {
			return record.content;
		}
	}
	return '';
}

function looksLikeReasoningConfigValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === 'none'
		|| normalized === 'low'
		|| normalized === 'medium'
		|| normalized === 'high'
		|| normalized === 'xhigh'
		|| normalized === 'minimal'
		|| normalized === 'auto'
		|| normalized === 'concise'
		|| normalized === 'detailed';
}

function shouldFallbackToNonStream(status: number, errorText: string): boolean {
	if (status >= 500) {
		return true;
	}
	const normalized = errorText.toLowerCase();
	return normalized.includes('stream')
		&& (
			normalized.includes('unsupported')
			|| normalized.includes('not support')
			|| normalized.includes('not implemented')
		);
}

function createResponsesStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, RESPONSES_STATEFUL_MARKER_MIME);
}

function parseResponsesStatefulMarkerPart(part: unknown): { modelId: string; marker: string } | null {
	const maybe = part as { mimeType?: unknown; data?: unknown };
	if (!maybe || typeof maybe !== 'object') {
		return null;
	}
	if (typeof maybe.mimeType !== 'string') {
		return null;
	}
	if (!(maybe.data instanceof Uint8Array)) {
		return null;
	}
	if (maybe.mimeType !== RESPONSES_STATEFUL_MARKER_MIME) {
		return null;
	}

	try {
		const decoded = new TextDecoder().decode(maybe.data);
		const separator = decoded.indexOf('\\');
		if (separator <= 0) {
			return null;
		}
		const modelId = decoded.slice(0, separator).trim();
		const marker = decoded.slice(separator + 1).trim();
		if (!modelId || !marker) {
			return null;
		}
		return { modelId, marker };
	} catch {
		return null;
	}
}

function findLastResponsesStatefulMarker(
	modelId: string,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): ResponsesStatefulMarkerLocation | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role !== vscode.LanguageModelChatMessageRole.Assistant) {
			continue;
		}
		for (const part of messages[index].content ?? []) {
			const parsed = parseResponsesStatefulMarkerPart(part);
			if (parsed && parsed.modelId === modelId) {
				return { marker: parsed.marker, index };
			}
		}
	}
	return null;
}

function parseResponsesError(errorText: string): string {
	try {
		const errorJson = JSON.parse(errorText) as Record<string, unknown>;
		const error = errorJson.error as Record<string, unknown> | undefined;
		return typeof error?.message === 'string'
			? error.message
			: typeof errorJson.message === 'string'
				? errorJson.message
				: errorText;
	} catch {
		return errorText;
	}
}
