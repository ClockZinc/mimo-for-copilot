export class ResponsesNoFeedbackTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Responses stream had no feedback for ${timeoutMs}ms`);
		this.name = 'ResponsesNoFeedbackTimeoutError';
	}
}

export function withNoFeedbackTimeout<T>(
	promise: Promise<T>,
	controller: AbortController,
	timeoutMs: number,
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}
	let timeout: NodeJS.Timeout | undefined;
	let timedOut = false;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
			reject(new ResponsesNoFeedbackTimeoutError(timeoutMs));
		}, timeoutMs);
	});
	return Promise.race([promise.catch((error) => {
		if (timedOut && error instanceof Error && error.name === 'AbortError') {
			throw new ResponsesNoFeedbackTimeoutError(timeoutMs);
		}
		throw error;
	}), timeoutPromise]).finally(() => {
		if (timeout) {
			clearTimeout(timeout);
		}
	});
}

export function readSseChunkWithNoFeedbackTimeout(
	reader: { read: () => Promise<{ done?: boolean; value?: Uint8Array }> },
	controller: AbortController,
	timeoutMs: number,
): Promise<{ done?: boolean; value?: Uint8Array }> {
	return withNoFeedbackTimeout(reader.read(), controller, timeoutMs);
}
