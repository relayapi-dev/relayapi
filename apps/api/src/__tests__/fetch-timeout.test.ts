import { afterEach, describe, expect, it } from "bun:test";
import { fetchWithTimeout } from "../lib/fetch-timeout";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("fetchWithTimeout", () => {
	it("keeps an opt-in deadline active while the response body is consumed", async () => {
		let receivedSignal: AbortSignal | null | undefined;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			receivedSignal = init?.signal;
			return new Response("ok");
		}) as typeof fetch;

		await fetchWithTimeout("https://example.test", {
			timeout: 5,
			timeoutThroughBody: true,
		});
		await Bun.sleep(15);
		expect(receivedSignal?.aborted).toBe(true);
	});

	it("does not impose the response-header timeout on a streamed body", async () => {
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			const signal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						setTimeout(() => {
							if (signal?.aborted) {
								controller.error(signal.reason);
								return;
							}
							controller.enqueue(new TextEncoder().encode("ok"));
							controller.close();
						}, 15);
					},
				}),
			);
		}) as typeof fetch;

		const response = await fetchWithTimeout("https://example.test", {
			timeout: 5,
		});
		expect(await response.text()).toBe("ok");
	});

	it("preserves an earlier caller abort signal", async () => {
		let receivedSignal: AbortSignal | null | undefined;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => {
			receivedSignal = init?.signal;
			return new Response("ok");
		}) as typeof fetch;
		const caller = new AbortController();

		await fetchWithTimeout("https://example.test", {
			signal: caller.signal,
			timeout: 10_000,
		});
		caller.abort();

		expect(receivedSignal?.aborted).toBe(true);
	});
});
