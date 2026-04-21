// apps/api/src/__tests__/automation-http-request.test.ts
//
// Unit tests for the http_request node handler. These don't hit the DB — we
// build a minimal `ctx` directly and stub `fetch` via bun's `mock()`.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { httpRequestHandler } from "../services/automations/nodes/http-request";
import type { RunContext } from "../services/automations/types";

const originalFetch = globalThis.fetch;

function makeCtx(overrides: Partial<RunContext> = {}): RunContext {
	return {
		runId: "arun_test",
		automationId: "auto_test",
		organizationId: "org_test",
		contactId: "ct_test",
		conversationId: null,
		channel: "telegram",
		graph: {
			schema_version: 1,
			root_node_key: null,
			nodes: [],
			edges: [],
		},
		context: {},
		now: new Date(),
		env: {},
		...overrides,
	};
}

function makeNode(config: Record<string, unknown>) {
	return { key: "hr", kind: "http_request", config: config as never };
}

beforeEach(() => {
	// Reset ctx.context between tests by letting each test build its own ctx.
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("http_request handler", () => {
	it("stores response body as JSON and routes via success on 200", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ ok: true, user: "alice" }), {
				status: 200,
				headers: { "content-type": "application/json", "x-req-id": "abc" },
			});
		}) as unknown as typeof fetch;

		const ctx = makeCtx();
		const result = await httpRequestHandler.handle(
			makeNode({
				url: "https://example.com/hook",
				method: "POST",
				headers: { "x-custom": "v" },
				body: JSON.stringify({ a: 1 }),
			}),
			ctx,
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("success");
		const stored = ctx.context.last_http_response as any;
		expect(stored.status).toBe(200);
		expect(stored.body.user).toBe("alice");
		expect(stored.headers["x-req-id"]).toBe("abc");
	});

	it("routes via error on 500 and still stores the response", async () => {
		globalThis.fetch = mock(async () => {
			return new Response("boom", { status: 500 });
		}) as unknown as typeof fetch;

		const ctx = makeCtx();
		const result = await httpRequestHandler.handle(
			makeNode({ url: "https://example.com/fail", method: "GET" }),
			ctx,
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		const stored = ctx.context.last_http_response as any;
		expect(stored.status).toBe(500);
		expect(stored.body).toBe("boom");
	});

	it("writes response to a custom response_key", async () => {
		globalThis.fetch = mock(async () => {
			return new Response(JSON.stringify({ id: 42 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const ctx = makeCtx();
		const result = await httpRequestHandler.handle(
			makeNode({
				url: "https://example.com/x",
				method: "GET",
				response_key: "my_custom_key",
			}),
			ctx,
		);

		expect(result.result).toBe("advance");
		expect(ctx.context.my_custom_key).toBeTruthy();
		expect(ctx.context.last_http_response).toBeUndefined();
		expect((ctx.context.my_custom_key as any).body.id).toBe(42);
	});

	it("classifies an aborted fetch as timeout and routes via error", async () => {
		// Simulate a fetch that rejects with an AbortError.
		globalThis.fetch = mock(async (_url: unknown, init?: { signal?: AbortSignal }) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted.");
					err.name = "AbortError";
					reject(err);
				});
			});
		}) as unknown as typeof fetch;

		const ctx = makeCtx();
		const result = await httpRequestHandler.handle(
			makeNode({
				url: "https://example.com/slow",
				method: "POST",
				timeout_ms: 10,
			}),
			ctx,
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		const stored = ctx.context.last_http_response as any;
		expect(stored.error).toBe("timeout");
	});

	it("classifies a network error and routes via error", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;

		const ctx = makeCtx();
		const result = await httpRequestHandler.handle(
			makeNode({ url: "https://example.com/x", method: "POST" }),
			ctx,
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		const stored = ctx.context.last_http_response as any;
		expect(stored.error).toBe("ECONNREFUSED");
	});

	it("resolves merge tags in url / headers / body before fetching", async () => {
		let captured: { url?: string; init?: RequestInit } = {};
		globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
			captured = { url: String(url), init };
			return new Response("ok", { status: 200 });
		}) as unknown as typeof fetch;

		const ctx = makeCtx({
			context: { contact: { name: "bob", email: "bob@example.com" } },
		});
		await httpRequestHandler.handle(
			makeNode({
				url: "https://example.com/hook?name={{contact.name}}",
				method: "POST",
				headers: { "x-email": "{{contact.email}}" },
				body: '{"greet":"hi {{contact.name}}"}',
			}),
			ctx,
		);

		expect(captured.url).toBe("https://example.com/hook?name=bob");
		const headerVal = (captured.init?.headers as Record<string, string>)["x-email"];
		expect(headerVal).toBe("bob@example.com");
		expect(captured.init?.body).toBe('{"greet":"hi bob"}');
	});
});
