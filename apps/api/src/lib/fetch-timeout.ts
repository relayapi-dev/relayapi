/**
 * Wrapper around `fetch()` with a response-header timeout. Callers consuming
 * small provider bodies can opt into an end-to-end deadline; streamed media
 * keeps its established header-only timeout so large uploads are not aborted
 * after an arbitrary wall-clock limit. Defaults to 10 seconds.
 */
export async function fetchWithTimeout(
	url: string | URL,
	init: RequestInit & {
		timeout?: number;
		timeoutThroughBody?: boolean;
	} = {},
): Promise<Response> {
	const {
		timeout = 10_000,
		timeoutThroughBody = false,
		signal: callerSignal,
		...fetchInit
	} = init;
	const headerController = timeoutThroughBody ? null : new AbortController();
	const deadline = timeoutThroughBody
		? AbortSignal.timeout(timeout)
		: headerController?.signal;
	if (!deadline) throw new Error("Request deadline was not initialized");
	const signal = callerSignal
		? AbortSignal.any([callerSignal, deadline])
		: deadline;
	const timer = headerController
		? setTimeout(
				() =>
					headerController.abort(
						new DOMException(
							`Request timed out after ${timeout}ms`,
							"TimeoutError",
						),
					),
				timeout,
			)
		: undefined;
	try {
		return await fetch(url instanceof URL ? url.toString() : url, {
			...fetchInit,
			signal,
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
