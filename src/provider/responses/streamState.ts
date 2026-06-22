import { logger } from '../../logger';
import type { DeepSeekToolCall, StreamCallbacks } from '../../types';

const INVISIBLE_COMPLETION_SENTINEL = '\u2060';

export type ResponsesDeltaLogKind = 'reasoning' | 'text' | 'tool';

export type ResponsesStreamState = {
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
	receivedCompletedEvent: boolean;
	unknownEventTypes: Set<string>;
	usedNonStreamFallback: boolean;
	activeDeltaLog: ResponsesDeltaLogKind | null;
	emittedInvisibleCompletionSentinel: boolean;
};

export function createEmptyResponsesStreamState(usedNonStreamFallback: boolean): ResponsesStreamState {
	return {
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
		receivedCompletedEvent: false,
		unknownEventTypes: new Set<string>(),
		usedNonStreamFallback,
		activeDeltaLog: null,
		emittedInvisibleCompletionSentinel: false,
	};
}

export function logResponsesSummary(state: ResponsesStreamState): void {
	logger.debug(
		`[Responses] summary reasoningEvents=${state.reasoningEventCount}`
		+ ` textEvents=${state.textEventCount}`
		+ ` toolEvents=${state.toolEventCount}`
		+ ` completedEvent=${state.receivedCompletedEvent ? 'yes' : 'no'}`
		+ ` usedNonStreamFallback=${state.usedNonStreamFallback ? 'yes' : 'no'}`
		+ ` unknownEvents=${state.unknownEventTypes.size > 0 ? [...state.unknownEventTypes].join('|') : 'none'}`,
	);
}

export function appendResponsesDeltaLog(
	state: ResponsesStreamState,
	kind: ResponsesDeltaLogKind,
	delta: string,
): void {
	if (!delta) {
		return;
	}
	if (state.activeDeltaLog !== kind) {
		endResponsesDeltaLog(state);
		logger.debugAppendStart(`[Responses] ${kind}.stream `);
		state.activeDeltaLog = kind;
	}
	logger.append(delta);
}

export function emitInvisibleCompletionSentinelIfNeeded(
	state: ResponsesStreamState,
	callbacks: StreamCallbacks,
	reason: string,
): void {
	const hasVisibleOutput = state.textEventCount > 0
		|| state.reasoningEventCount > 0
		|| state.toolEventCount > 0;
	if (hasVisibleOutput || state.emittedInvisibleCompletionSentinel) {
		return;
	}
	state.emittedInvisibleCompletionSentinel = true;
	logger.debug(`[Responses] sentinel.invisible reason=${reason}`);
	callbacks.onContent(INVISIBLE_COMPLETION_SENTINEL);
}

export function endResponsesDeltaLog(state: ResponsesStreamState): void {
	if (!state.activeDeltaLog) {
		return;
	}
	logger.endLine();
	state.activeDeltaLog = null;
}

export function endResponsesDeltaLogUnless(
	state: ResponsesStreamState,
	keepKind: ResponsesDeltaLogKind,
): void {
	if (state.activeDeltaLog && state.activeDeltaLog !== keepKind) {
		endResponsesDeltaLog(state);
	}
}

export function hasResponsesStreamProgress(state: ResponsesStreamState): boolean {
	return state.textEventCount > 0
		|| state.reasoningEventCount > 0
		|| state.toolEventCount > 0
		|| state.pendingToolCalls.size > 0
		|| state.hasEmittedAssistantText
		|| state.hasEmittedThinking;
}
