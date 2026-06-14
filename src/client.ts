import type { CancellationToken } from 'vscode';
import { logger } from './logger';
import type {
    DeepSeekRequest,
    DeepSeekStreamChunk,
    DeepSeekToolCall,
    ResponsesFunctionCallItem,
    ResponsesRequest,
    StreamCallbacks,
} from './types';

function previewText(text: string, maxLength = 100): string {
	const normalized = text.replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return '';
	}
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function parseToolArguments(raw: string): Record<string, unknown> | undefined {
	const trimmed = raw.trim();
	if (!trimmed) {
		return {};
	}
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch {
		return undefined;
	}
}

function isCompleteToolCall(toolCall: DeepSeekToolCall): boolean {
	return !!toolCall.id?.trim()
		&& !!toolCall.function.name?.trim()
		&& parseToolArguments(toolCall.function.arguments) !== undefined;
}

function flushToolCalls(
	pendingToolCalls: Map<number, DeepSeekToolCall>,
	callbacks: StreamCallbacks,
	providerLabel: string,
	reason: string,
): void {
	for (const [index, toolCall] of pendingToolCalls) {
		if (isCompleteToolCall(toolCall)) {
			callbacks.onToolCall(toolCall);
			continue;
		}
		logger.warn(
			`[Client] drop incomplete tool call provider=${providerLabel}`
			+ ` reason=${reason} index=${index} id=${toolCall.id || '(empty)'}`
			+ ` name=${toolCall.function.name || '(empty)'}`,
		);
	}
	pendingToolCalls.clear();
}

/**
 * Lightweight SSE-streaming DeepSeek API client.
 * No external dependencies — uses Node's built-in fetch.
 */
export class DeepSeekClient {
	private readonly skipStreamOptions: boolean;
	private readonly providerLabel: string;

	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		options?: { skipStreamOptions?: boolean; providerLabel?: string },
	) {
		this.skipStreamOptions = options?.skipStreamOptions ?? false;
		this.providerLabel = options?.providerLabel ?? 'API';
	}

	/**
	 * Stream a chat completion from the configured API endpoint.
	 * Parses SSE chunks and dispatches callbacks for content, thinking, and tool calls.
	 */
	async streamChatCompletion(
		request: DeepSeekRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();

		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});

		try {
			const requestBody = this.skipStreamOptions
				? { ...request }
				: { ...request, stream_options: { include_usage: true } };

			const url = `${this.baseUrl}/chat/completions`;
			logger.debug(
				`[Client] chat.stream.start provider=${this.providerLabel} url=${url}`
				+ ` model=${requestBody.model} messages=${requestBody.messages.length}`
				+ ` tools=${requestBody.tools?.length ?? 0}`
				+ ` thinking=${requestBody.thinking?.type ?? 'n/a'}`,
			);

			let response: Response;
			let lastError: unknown;
			// Retry up to 2 times on fetch-level errors with 1s delay
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					response = await fetch(url, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${this.apiKey}`,
						},
						body: JSON.stringify(requestBody),
						signal: controller.signal,
					});
					break;
				} catch (err) {
					lastError = err;
					if (attempt === 0) {
						logger.warn(`[Client] fetch attempt ${attempt + 1} failed for ${this.providerLabel} ${url}, retrying...`);
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
				}
			}

			if (!response!) {
				const err = lastError instanceof Error ? lastError : new Error(String(lastError));
				logger.error(`[Client] All fetch attempts failed for ${this.providerLabel} ${url}: ${err.message}`);
				throw new Error(
					`Failed to connect to ${this.baseUrl}. ` +
					`Check your network connection and that the endpoint is reachable. ` +
					`Error: ${err.message}`,
				);
			}

			if (!response.ok) {
				const errorText = await response.text();
				let errorMessage: string;
				try {
					const errorJson = JSON.parse(errorText);
					errorMessage = errorJson.error?.message || errorJson.message || errorText;
				} catch {
					errorMessage = errorText;
				}
				throw new Error(`${this.providerLabel} API error (${response.status}): ${errorMessage}`);
			}

			if (!response.body) {
				throw new Error('No response body received');
			}
			logger.debug(`[Client] chat.stream.connected provider=${this.providerLabel} url=${url}`);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let activeDeltaLog: 'reasoning' | 'text' | 'tool' | null = null;

			const appendDeltaLog = (kind: 'reasoning' | 'text' | 'tool', delta: string) => {
				if (activeDeltaLog !== kind) {
					if (activeDeltaLog) {
						logger.endLine();
					}
					logger.debugAppendStart(`[Client] chat.${kind}.stream provider=${this.providerLabel} `);
					activeDeltaLog = kind;
				}
				logger.append(delta);
			};

			const endDeltaLog = () => {
				if (activeDeltaLog) {
					logger.endLine();
					activeDeltaLog = null;
				}
			};

			// Accumulate tool call deltas by index, then emit complete calls on finish.
			const pendingToolCalls = new Map<number, DeepSeekToolCall>();

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

					if (!trimmed || trimmed.startsWith(':')) {
						continue;
					}

					if (trimmed === 'data: [DONE]') {
						endDeltaLog();
						logger.debug(`[Client] chat.stream.done provider=${this.providerLabel}`);
						flushToolCalls(pendingToolCalls, callbacks, this.providerLabel, 'done');
						callbacks.onDone();
						return;
					}

					if (!trimmed.startsWith('data: ')) {
						continue;
					}

					const jsonStr = trimmed.slice(6);
					try {
						const chunk: DeepSeekStreamChunk = JSON.parse(jsonStr);
						const choice = chunk.choices?.[0];

						// Capture usage stats from the API for token-count calibration.
						if (chunk.usage && callbacks.onUsage) {
							callbacks.onUsage(chunk.usage);
						}

						if (!choice) {
							continue;
						}

						// Thinking content → report with correct field name so VS Code renders collapsible blocks
						const reasoning = choice.delta.reasoning_content;
						if (reasoning) {
							appendDeltaLog('reasoning', reasoning);
							callbacks.onThinking(reasoning);
						}

						// Regular content
						if (choice.delta.content) {
							appendDeltaLog('text', choice.delta.content);
							callbacks.onContent(choice.delta.content);
						}

						// Tool calls — accumulate deltas by index
						if (choice.delta.tool_calls) {
							for (const tc of choice.delta.tool_calls) {
								let pending = pendingToolCalls.get(tc.index);
								if (!pending && tc.id) {
									pending = {
										id: tc.id,
										type: 'function',
										function: { name: '', arguments: '' },
									};
									pendingToolCalls.set(tc.index, pending);
								}
								if (pending) {
									if (tc.function?.name) {
										pending.function.name += tc.function.name;
										appendDeltaLog('tool', tc.function.name);
										callbacks.onToolDelta?.(tc.function.name);
									}
									if (tc.function?.arguments) {
										pending.function.arguments += tc.function.arguments;
										appendDeltaLog('tool', tc.function.arguments);
										callbacks.onToolDelta?.(tc.function.arguments);
									}
								}
							}
						}

						// Flush pending tool calls on finish
						if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
							endDeltaLog();
							logger.debug(
								`[Client] chat.finish provider=${this.providerLabel} reason=${choice.finish_reason}`,
							);
							flushToolCalls(
								pendingToolCalls,
								callbacks,
								this.providerLabel,
								choice.finish_reason,
							);
						}
					} catch (e) {
						logger.error('Failed to parse SSE chunk:', jsonStr.slice(0, 200), e);
					}
				}
			}

			endDeltaLog();
			callbacks.onDone();
		} catch (error) {
			// If an error occurs mid-stream, finish any open inline delta log before writing the error.
			if (error instanceof Error && error.name === 'AbortError') {
				callbacks.onDone();
				return;
			}
			callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancelListener?.dispose();
		}
	}

	async streamResponses(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		let emittedResponsePart = false;

		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});

		try {
			logger.debug(
				`[Client] responses.stream.start provider=${this.providerLabel} url=${this.baseUrl}/responses`
				+ ` model=${request.model} inputItems=${request.input.length}`
				+ ` previousResponseId=${request.previous_response_id ? 'yes' : 'no'}`
				+ ` reasoning=${request.reasoning ? JSON.stringify(request.reasoning) : 'none'}`,
			);

			const response = await fetch(`${this.baseUrl}/responses`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify(request),
				signal: controller.signal,
			});

			if (request.stream && !response.ok && response.status >= 500) {
				const errorText = await response.text();
				logger.warn(
					`[Client] Responses streaming failed with ${response.status}; retrying without streaming. `
					+ `${errorText.slice(0, 200)}`,
				);
				await this.fetchResponsesWithoutStreaming({ ...request, stream: false }, callbacks, controller.signal);
				callbacks.onDone();
				return;
			}

			if (!response.ok) {
				const errorText = await response.text();
				const errorMessage = this.parseResponsesError(errorText);
				throw new Error(`${this.providerLabel} Responses API error (${response.status}): ${errorMessage}`);
			}

			const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
			if (!contentType.includes('text/event-stream')) {
				logger.warn(
					`[Client] Responses stream requested but received ${contentType || 'unknown content type'}; `
					+ 'falling back to non-stream JSON handling.',
				);
				const responseJson = await response.json() as Record<string, unknown>;
				this.emitResponsesJson(responseJson, callbacks);
				callbacks.onDone();
				return;
			}

			if (!response.body) {
				throw new Error('No response body received');
			}
			logger.debug(
				`[Client] responses.stream.connected provider=${this.providerLabel} contentType=${contentType || 'unknown'}`,
			);

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			const pendingToolCalls = new Map<number, DeepSeekToolCall>();
			const emittedTextKeys = new Set<string>();
			const emittedReasoningKeys = new Set<string>();
			const emittedToolCallKeys = new Set<string>();

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
						logger.debug(`[Client] responses.stream.done provider=${this.providerLabel}`);
						for (const toolCall of pendingToolCalls.values()) {
							callbacks.onToolCall(toolCall);
						}
						pendingToolCalls.clear();
						callbacks.onDone();
						return;
					}

					try {
						const event = JSON.parse(data) as Record<string, unknown>;
						emittedResponsePart = true;
						this.handleResponsesEvent(event, callbacks, pendingToolCalls, emittedTextKeys, emittedReasoningKeys, emittedToolCallKeys);
					} catch (error) {
						logger.error('Failed to parse Responses SSE chunk:', data.slice(0, 200), error);
					}
				}
			}

			callbacks.onDone();
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				callbacks.onDone();
				return;
			}
			if (request.stream && !emittedResponsePart) {
				try {
					logger.warn('[Client] Responses streaming threw before any content; retrying without streaming.', error);
					await this.fetchResponsesWithoutStreaming({ ...request, stream: false }, callbacks, controller.signal);
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

	private async fetchResponsesWithoutStreaming(
		request: ResponsesRequest,
		callbacks: StreamCallbacks,
		signal: AbortSignal,
	): Promise<void> {
		const response = await fetch(`${this.baseUrl}/responses`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(request),
			signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`${this.providerLabel} Responses API error (${response.status}): ${this.parseResponsesError(errorText)}`,
			);
		}

		const responseJson = await response.json() as Record<string, unknown>;
		this.emitResponsesJson(responseJson, callbacks);
	}

	private emitResponsesJson(
		responseJson: Record<string, unknown>,
		callbacks: StreamCallbacks,
	): void {
		const responseId = typeof responseJson.id === 'string' ? responseJson.id : undefined;
		logger.debug(
			`[Client] responses.json.response id=${responseId ?? 'n/a'} status=${String(responseJson.status ?? 'unknown')}`,
		);
		if (responseId && callbacks.onResponseId) {
			callbacks.onResponseId(responseId);
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
					if ((partType === 'output_text' || partType === 'refusal') && typeof part.text === 'string') {
						logger.debug(
							`[Client] responses.json.event type=${partType} len=${part.text.length} preview=${previewText(part.text)}`,
						);
						callbacks.onContent(part.text);
					}
					if ((partType === 'reasoning_text' || partType === 'summary_text') && typeof part.text === 'string') {
						logger.debug(
							`[Client] responses.json.reasoning type=${partType} len=${part.text.length} preview=${previewText(part.text)}`,
						);
						callbacks.onThinking(part.text);
					}
				}
				continue;
			}

			if (itemType === 'reasoning') {
				const summaries = Array.isArray(item.summary)
					? item.summary as Array<Record<string, unknown>>
					: [];
				for (const summary of summaries) {
					if (typeof summary.text === 'string') {
						logger.debug(
							`[Client] responses.json.reasoning type=reasoning.summary len=${summary.text.length} preview=${previewText(summary.text)}`,
						);
						callbacks.onThinking(summary.text);
					}
				}
				continue;
			}

			if (itemType === 'function_call') {
				const callId = typeof item.call_id === 'string'
					? item.call_id
					: typeof item.id === 'string'
						? item.id
						: 'call_0';
				const name = typeof item.name === 'string' ? item.name : '';
				const args = typeof item.arguments === 'string' ? item.arguments : '{}';
				logger.debug(`[Client] responses.json.tool name=${name || 'unknown'} callId=${callId}`);
				callbacks.onToolCall({
					id: callId,
					type: 'function',
					function: { name, arguments: args },
				});
			}
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

	private parseResponsesError(errorText: string): string {
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

	private handleResponsesEvent(
		event: Record<string, unknown>,
		callbacks: StreamCallbacks,
		pendingToolCalls: Map<number, DeepSeekToolCall>,
		emittedTextKeys: Set<string>,
		emittedReasoningKeys: Set<string>,
		emittedToolCallKeys: Set<string>,
	): void {
		const type = typeof event.type === 'string' ? event.type : '';
		const responseObject = event.response as Record<string, unknown> | undefined;
		const responseId = typeof event.response_id === 'string'
			? event.response_id
			: typeof responseObject?.id === 'string'
				? responseObject.id
				: undefined;

		if (responseId && callbacks.onResponseId) {
			callbacks.onResponseId(responseId);
		}

		switch (type) {
			case 'response.created':
			case 'response.in_progress': {
				logger.debug(`[Client] responses.event type=${type}`);
				return;
			}
			case 'response.output_text.delta':
			case 'response.refusal.delta': {
				const delta = typeof event.delta === 'string' ? event.delta : '';
				if (delta) {
					const itemId = typeof event.item_id === 'string' ? event.item_id : 'item';
					const contentIndex = typeof event.content_index === 'number' ? event.content_index : 0;
					emittedTextKeys.add(`${itemId}:${contentIndex}`);
					callbacks.onContent(delta);
				}
				return;
			}
			case 'response.output_text.done': {
				const text = typeof event.text === 'string' ? event.text : '';
				const itemId = typeof event.item_id === 'string' ? event.item_id : 'item';
				const contentIndex = typeof event.content_index === 'number' ? event.content_index : 0;
				const textKey = `${itemId}:${contentIndex}`;
				if (text && !emittedTextKeys.has(textKey)) {
					logger.debug(
						`[Client] responses.text.done len=${text.length} preview=${previewText(text)}`,
					);
					callbacks.onContent(text);
				}
				return;
			}
			case 'response.reasoning_text.delta':
			case 'response.reasoning_summary_text.delta': {
				const delta = typeof event.delta === 'string' ? event.delta : '';
				if (delta) {
					const itemId = typeof event.item_id === 'string' ? event.item_id : 'reasoning';
					const contentIndex = typeof event.content_index === 'number'
						? event.content_index
						: typeof event.summary_index === 'number'
							? event.summary_index
							: 0;
					emittedReasoningKeys.add(`${itemId}:${contentIndex}`);
					callbacks.onThinking(delta);
				}
				return;
			}
			case 'response.reasoning_text.done':
			case 'response.reasoning_summary_text.done': {
				const text = typeof event.text === 'string' ? event.text : '';
				const itemId = typeof event.item_id === 'string' ? event.item_id : 'reasoning';
				const contentIndex = typeof event.content_index === 'number'
					? event.content_index
					: typeof event.summary_index === 'number'
						? event.summary_index
						: 0;
				const reasoningKey = `${itemId}:${contentIndex}`;
				if (text && !emittedReasoningKeys.has(reasoningKey)) {
					logger.debug(
						`[Client] responses.reasoning.done type=${type} len=${text.length} preview=${previewText(text)}`,
					);
					callbacks.onThinking(text);
				}
				return;
			}
			case 'response.function_call_arguments.delta':
			case 'response.function_call_arguments.done': {
				const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
				const pending = pendingToolCalls.get(outputIndex) ?? {
					id: typeof event.item_id === 'string' ? event.item_id : `call_${outputIndex}`,
					type: 'function' as const,
					function: { name: '', arguments: '' },
				};
				if (typeof event.name === 'string' && !pending.function.name) {
					pending.function.name = event.name;
				}
				if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
					pending.function.arguments += event.delta;
				}
				if (type === 'response.function_call_arguments.done' && typeof event.arguments === 'string') {
					logger.debug(
						`[Client] responses.tool.done outputIndex=${outputIndex} name=${pending.function.name || ''}`,
					);
					pending.function.arguments = event.arguments;
				}
				pendingToolCalls.set(outputIndex, pending);
				if (type === 'response.function_call_arguments.done' && !emittedToolCallKeys.has(pending.id)) {
					callbacks.onToolCall(pending);
					emittedToolCallKeys.add(pending.id);
					pendingToolCalls.delete(outputIndex);
				}
				return;
			}
			case 'response.output_item.done': {
				const item = event.item as ResponsesFunctionCallItem | undefined;
				if (item?.type === 'function_call' && !emittedToolCallKeys.has(item.call_id)) {
					logger.debug(`[Client] responses.tool.output_item name=${item.name} callId=${item.call_id}`);
					callbacks.onToolCall({
						id: item.call_id,
						type: 'function',
						function: { name: item.name, arguments: item.arguments },
					});
					emittedToolCallKeys.add(item.call_id);
				}
				return;
			}
			case 'response.completed': {
				const usage = responseObject?.usage as Record<string, unknown> | undefined;
				logger.debug(`[Client] responses.event type=response.completed`);
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
				return;
			}
			case 'response.failed': {
				const error = responseObject?.error as Record<string, unknown> | undefined;
				logger.debug(`[Client] responses.event type=response.failed error=${String(error?.message ?? 'unknown')}`);
				throw new Error(typeof error?.message === 'string' ? error.message : 'Responses API request failed');
			}
		}
	}
}
