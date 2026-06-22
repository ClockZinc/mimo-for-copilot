import { logger } from '../../logger';
import type { StreamCallbacks } from '../../types';

export interface ResponsesStreamLifecycle {
	finish: (reason: string) => void;
	fail: (error: Error, reason: string) => void;
	markReset: (attempt: number, maxAttempts: number, message: string) => void;
}

export function createResponsesStreamLifecycle(callbacks: StreamCallbacks): ResponsesStreamLifecycle {
	let finalized = false;
	return {
		finish: (reason: string) => {
			if (finalized) {
				logger.debug(`[Responses] stream.finish.skip reason=${reason}`);
				return;
			}
			finalized = true;
			logger.debug(`[Responses] stream.finish reason=${reason}`);
			callbacks.onConnectionStatus?.({ state: 'clear' });
			callbacks.onDone();
		},
		fail: (error: Error, reason: string) => {
			if (finalized) {
				logger.debug(`[Responses] stream.fail.skip reason=${reason}`);
				return;
			}
			finalized = true;
			logger.warn(`[Responses] stream.fail reason=${reason}`, error);
			callbacks.onError(error);
		},
		markReset: (attempt: number, maxAttempts: number, message: string) => {
			logger.warn(`[Responses] stream.reset attempt=${attempt}/${maxAttempts} message=${message}`);
			callbacks.onConnectionStatus?.({
				state: 'reset',
				attempt,
				maxAttempts,
				startedAt: Date.now(),
				message,
			});
		},
	};
}
