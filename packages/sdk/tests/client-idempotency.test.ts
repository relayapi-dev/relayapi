import { describe, expect, it } from "bun:test";
import Relay from "../src";

const TEST_API_KEY = ["rlay", "test", "sdk"].join("_");
const MUTATION_KEY = ["mutation", "key", "123"].join("-");

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"retry-after-ms": "0",
		},
	});
}

describe("Relay mutation retries", () => {
	it("generates one key and reuses it when retrying a mutation", async () => {
		const headers: Headers[] = [];
		const client = new Relay({
			apiKey: TEST_API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 2,
			fetch: async (_url, init) => {
				headers.push(new Headers(init?.headers));
				return headers.length < 3
					? jsonResponse(500, { error: { message: "temporary" } })
					: jsonResponse(200, { ok: true });
			},
		});

		const result = await client.post<{ ok: boolean }>("/v1/mutations", {
			body: { value: 1 },
		});

		expect(result).toEqual({ ok: true });
		expect(headers).toHaveLength(3);
		const keys = headers.map((value) => value.get("idempotency-key"));
		expect(keys[0]).toMatch(/^stainless-node-retry-/);
		expect(new Set(keys).size).toBe(1);
	});

	it("retries a mutation when the caller supplies an idempotency key", async () => {
		const headers: Headers[] = [];
		const client = new Relay({
			apiKey: TEST_API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 1,
			fetch: async (_url, init) => {
				headers.push(new Headers(init?.headers));
				return headers.length === 1
					? jsonResponse(500, { error: { message: "temporary" } })
					: jsonResponse(200, { ok: true });
			},
		});

		const result = await client.post<{ ok: boolean }>("/v1/mutations", {
			body: { value: 1 },
			idempotencyKey: MUTATION_KEY,
		});

		expect(result).toEqual({ ok: true });
		expect(headers).toHaveLength(2);
		expect(headers.map((value) => value.get("idempotency-key"))).toEqual([
			MUTATION_KEY,
			MUTATION_KEY,
		]);
	});

	it("does not retry a one-shot stream even with an idempotency key", async () => {
		let calls = 0;
		const client = new Relay({
			apiKey: TEST_API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 1,
			fetch: async (_url, init) => {
				calls += 1;
				if (init?.body instanceof ReadableStream) {
					await new Response(init.body).arrayBuffer();
				}
				return jsonResponse(500, { error: { message: "temporary" } });
			},
		});

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.close();
			},
		});

		let rejected = false;
		try {
			await client.media.upload(
				body,
				{ filename: "image.png", content_type: "image/png" },
				{ idempotencyKey: MUTATION_KEY },
			);
		} catch {
			rejected = true;
		}

		expect(rejected).toBe(true);
		expect(calls).toBe(1);
	});

	it("does not retry an async iterable body", async () => {
		let calls = 0;
		const client = new Relay({
			apiKey: TEST_API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 1,
			fetch: async (_url, init) => {
				calls += 1;
				if (init?.body instanceof ReadableStream) {
					await new Response(init.body).arrayBuffer();
				}
				return jsonResponse(500, { error: { message: "temporary" } });
			},
		});

		async function* body() {
			yield new Uint8Array([1, 2, 3]);
		}

		let rejected = false;
		try {
			await client.post("/v1/mutations", {
				body: body(),
				idempotencyKey: MUTATION_KEY,
			});
		} catch {
			rejected = true;
		}

		expect(rejected).toBe(true);
		expect(calls).toBe(1);
	});

	it("keeps retries enabled for reads without an idempotency key", async () => {
		let calls = 0;
		const client = new Relay({
			apiKey: TEST_API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 1,
			fetch: async () => {
				calls += 1;
				return calls === 1
					? jsonResponse(500, { error: { message: "temporary" } })
					: jsonResponse(200, { ok: true });
			},
		});

		const result = await client.get<{ ok: boolean }>("/v1/resources");

		expect(result).toEqual({ ok: true });
		expect(calls).toBe(2);
	});
});
