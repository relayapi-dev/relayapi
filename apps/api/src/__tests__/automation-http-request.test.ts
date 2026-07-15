// apps/api/src/__tests__/automation-http-request.test.ts
//
// Unit tests for the http_request node handler. These use an in-memory DB read
// for the real encrypted, write-only request bundle and stub outbound fetches.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { encryptToken } from "../lib/crypto";
import type { HttpRequestSecretBundle } from "../services/automations/graph-secrets";
import { httpRequestHandler } from "../services/automations/nodes/http-request";
import type { RunContext } from "../services/automations/types";

// The http_request node stores its response under ctx.context as `unknown`.
// This narrows it for assertions.
type StoredHttpResponse = {
	status: number;
	body: { user?: string; id?: number } & Record<string, unknown>;
	headers: Record<string, string>;
	error: string;
};
function asStoredResponse(value: unknown): StoredHttpResponse {
	return value as StoredHttpResponse;
}

const originalFetch = globalThis.fetch;
const TEST_ENCRYPTION_KEY = `test=${"31".repeat(32)}`;
const TEST_SECRET_REF = "asec_http_request_test";
const REDACTED_URL = "https://redacted.invalid/";

type FetchStub = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Response | Promise<Response>;

function mockFetchWithPublicDns(fetchStub: FetchStub): typeof fetch {
	return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		if (
			url.hostname === "dns.google" ||
			url.hostname === "cloudflare-dns.com"
		) {
			return url.searchParams.get("type") === "AAAA"
				? Response.json({
						Status: 0,
						Answer: [{ type: 28, data: "2606:4700:4700::1111" }],
					})
				: Response.json({
						Status: 0,
						Answer: [{ type: 1, data: "93.184.216.34" }],
					});
		}
		return fetchStub(input, init);
	}) as unknown as typeof fetch;
}

function secretDb(bundle: HttpRequestSecretBundle): RunContext["db"] {
	// Focused test fixture: the runtime loader uses only this SELECT chain, while
	// RunContext deliberately retains the full production Database type.
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [
						{
							ciphertext: await encryptToken(
								JSON.stringify(bundle),
								TEST_ENCRYPTION_KEY,
								{ recordId: TEST_SECRET_REF, field: "credentials" },
							),
						},
					],
				}),
			}),
		}),
	} as unknown as RunContext["db"];
}

function makeCtx(
	bundle: HttpRequestSecretBundle,
	overrides: Partial<RunContext> = {},
): RunContext {
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
		db: secretDb(bundle),
		env: { ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
		...overrides,
	};
}

function makeFixture(
	config: Record<string, unknown>,
	contextOverrides: Partial<RunContext> = {},
) {
	const { url, headers, body, ...runtimeConfig } = config;
	if (typeof url !== "string") throw new Error("test fixture requires a URL");
	const bundle: HttpRequestSecretBundle = {
		url,
		...(headers ? { headers: headers as Record<string, string> } : {}),
		...(typeof body === "string" ? { body } : {}),
	};
	return {
		ctx: makeCtx(bundle, contextOverrides),
		node: {
			key: "hr",
			kind: "http_request",
			config: {
				...runtimeConfig,
				url: REDACTED_URL,
				headers: {},
				configured_headers: Object.keys(bundle.headers ?? {}).sort(),
				body_configured: Boolean(bundle.body),
				secret_ref: TEST_SECRET_REF,
				credentials_configured: true,
			} as never,
		},
	};
}

beforeEach(() => {
	// Reset ctx.context between tests by letting each test build its own ctx.
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("http_request handler", () => {
	it("stores response body as JSON and routes via success on 200", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async () => {
			return new Response(JSON.stringify({ ok: true, user: "alice" }), {
				status: 200,
				headers: { "content-type": "application/json", "x-req-id": "abc" },
			});
		});

		const { ctx, node } = makeFixture({
			url: "https://example.com/hook",
			method: "POST",
			headers: { "x-custom": "v" },
			body: JSON.stringify({ a: 1 }),
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("success");
		const stored = asStoredResponse(ctx.context.last_http_response);
		expect(stored.status).toBe(200);
		expect(stored.body.user).toBe("alice");
		expect(stored.headers["x-req-id"]).toBe("abc");
	});

	it("preserves platform-accepted response headers without truncation", async () => {
		const responseHeaders = new Headers();
		for (let index = 0; index < 70; index++) {
			responseHeaders.set(`x-meta-${index}`, `value-${index}`);
		}
		responseHeaders.set("x-long-value", "x".repeat(5_000));
		responseHeaders.set("authorization", "Bearer do-not-store");
		globalThis.fetch = mockFetchWithPublicDns(
			async () => new Response("ok", { headers: responseHeaders }),
		);

		const { ctx, node } = makeFixture({
			url: "https://example.com/headers",
			method: "GET",
		});
		await httpRequestHandler.handle(node, ctx);

		const stored = asStoredResponse(ctx.context.last_http_response);
		expect(stored.headers["x-meta-69"]).toBe("value-69");
		expect(stored.headers["x-long-value"]).toHaveLength(5_000);
		expect(stored.headers.authorization).toBeUndefined();
	});

	it("accepts request headers within the Worker platform ceiling", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async () => new Response("ok"));
		const { ctx, node } = makeFixture({
			url: "https://example.com/headers",
			method: "GET",
			headers: {
				"x-large-a": "a".repeat(6_000),
				"x-large-b": "b".repeat(6_000),
				"x-large-c": "c".repeat(6_000),
			},
		});

		const result = await httpRequestHandler.handle(node, ctx);
		expect(result).toEqual(
			expect.objectContaining({ result: "advance", via_port: "success" }),
		);
	});

	it("routes via error on 500 and still stores the response", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async () => {
			return new Response("boom", { status: 500 });
		});

		const { ctx, node } = makeFixture({
			url: "https://example.com/fail",
			method: "GET",
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		const stored = asStoredResponse(ctx.context.last_http_response);
		expect(stored.status).toBe(500);
		expect(stored.body as unknown).toBe("boom");
	});

	it("writes response to a custom response_key", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async () => {
			return new Response(JSON.stringify({ id: 42 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const { ctx, node } = makeFixture({
			url: "https://example.com/x",
			method: "GET",
			response_key: "my_custom_key",
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		expect(ctx.context.my_custom_key).toBeTruthy();
		expect(ctx.context.last_http_response).toBeUndefined();
		expect(asStoredResponse(ctx.context.my_custom_key).body.id).toBe(42);
	});

	it("classifies the runtime timeout reason and routes via error", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async (_url, init) => {
			return new Promise<Response>((_resolve, reject) => {
				// Keep Bun's event loop active so AbortSignal.timeout dispatches in
				// this synthetic never-settling fetch fixture, as a real fetch would.
				const keepAlive = setTimeout(() => {}, 100);
				init?.signal?.addEventListener("abort", () => {
					clearTimeout(keepAlive);
					reject(init.signal?.reason);
				});
			});
		});

		const { ctx, node } = makeFixture({
			url: "https://example.com/slow",
			method: "POST",
			timeout_ms: 10,
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		const stored = asStoredResponse(ctx.context.last_http_response);
		expect(stored.error).toBe("timeout");
	});

	it("classifies a network error and routes via error", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async () => {
			throw new Error("ECONNREFUSED");
		});

		const { ctx, node } = makeFixture({
			url: "https://example.com/x",
			method: "POST",
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		const stored = asStoredResponse(ctx.context.last_http_response);
		expect(stored.error).toBe("ECONNREFUSED");
	});

	it("blocks loopback destinations before issuing the request", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls += 1;
			return new Response("unexpected");
		}) as unknown as typeof fetch;

		const { ctx, node } = makeFixture({
			url: "http://127.0.0.1/internal",
			method: "GET",
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		expect(calls).toBe(0);
		expect(asStoredResponse(ctx.context.last_http_response).error).toContain(
			"Blocked public URL",
		);
	});

	it("rejects an oversized response without retaining it in run context", async () => {
		globalThis.fetch = mockFetchWithPublicDns(async () => {
			return new Response(new Uint8Array(512 * 1024 + 1));
		});

		const { ctx, node } = makeFixture({
			url: "https://bounded-response.example/hook",
		});
		const result = await httpRequestHandler.handle(node, ctx);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		expect(asStoredResponse(ctx.context.last_http_response).error).toContain(
			"exceeded",
		);
	});

	it("rejects an oversized interpolated request before fetch", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls += 1;
			return new Response("unexpected");
		}) as unknown as typeof fetch;

		const { ctx, node } = makeFixture({
			url: "https://example.com/hook",
			body: "x".repeat(256 * 1024 + 1),
		});
		await expect(httpRequestHandler.handle(node, ctx)).rejects.toThrow(
			"request body exceeds",
		);
		expect(calls).toBe(0);
	});

	it("resolves merge tags in url / headers / body before fetching", async () => {
		let captured: { url?: string; init?: RequestInit } = {};
		globalThis.fetch = mockFetchWithPublicDns(async (url, init) => {
			captured = { url: String(url), init };
			return new Response("ok", { status: 200 });
		});

		const { ctx, node } = makeFixture(
			{
				url: "https://example.com/hook?name={{contact.name}}",
				method: "POST",
				headers: { "x-email": "{{contact.email}}" },
				body: '{"greet":"hi {{contact.name}}"}',
			},
			{
				context: { contact: { name: "bob", email: "bob@example.com" } },
			},
		);
		await httpRequestHandler.handle(node, ctx);

		expect(captured.url).toBe("https://example.com/hook?name=bob");
		const headerVal = (
			captured.init?.headers as Record<string, string> | undefined
		)?.["x-email"];
		expect(headerVal).toBe("bob@example.com");
		expect(captured.init?.body).toBe('{"greet":"hi bob"}');
	});
});
