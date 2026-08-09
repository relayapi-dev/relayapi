import { describe, expect, mock, test } from "bun:test";
import { fetchBounded } from "../src/http.js";

describe("bounded self-host HTTP", () => {
	test("installs an abort deadline and reports timeouts", async () => {
		const fetcher = Object.assign(
			mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				const error = new Error("deadline exceeded");
				error.name = "TimeoutError";
				throw error;
			}),
			{ preconnect: fetch.preconnect },
		);
		await expect(
			fetchBounded(
				"https://upstream.test/stalled",
				{},
				{
					label: "test request",
					maxBytes: 1_024,
					timeoutMs: 1,
					fetcher,
				},
			),
		).rejects.toThrow("test request timed out");
	});

	test("combines a caller cancellation signal with its own deadline", async () => {
		const caller = new AbortController();
		let combinedSignal: AbortSignal | null = null;
		const fetcher = Object.assign(
			mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
				combinedSignal = init?.signal ?? null;
				return new Response("ok");
			}),
			{ preconnect: fetch.preconnect },
		);

		await fetchBounded(
			"https://upstream.test/cancellable",
			{ signal: caller.signal },
			{
				label: "test request",
				maxBytes: 1_024,
				fetcher,
			},
		);
		expect(combinedSignal).not.toBe(caller.signal);
		caller.abort();
		expect((combinedSignal as AbortSignal | null)?.aborted).toBe(true);
	});
});
