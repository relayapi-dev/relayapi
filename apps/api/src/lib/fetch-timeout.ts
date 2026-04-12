/**
 * Wrapper around `fetch()` that adds an AbortController-based timeout.
 * Defaults to 10 seconds. Throws an AbortError if the timeout is exceeded.
 */
export async function fetchWithTimeout(
	url: string | URL,
	init: RequestInit & { timeout?: number } = {},
): Promise<Response> {
	const { timeout = 10_000, ...fetchInit } = init;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new DOMException(`Request timed out after ${timeout}ms`, "TimeoutError")),
		timeout,
	);
	try {
		return await fetch(url instanceof URL ? url.toString() : url, {
			...fetchInit,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}
