import { describe, it, expect, beforeEach, mock } from "bun:test";

// Mock @relayapi/db to prevent import errors when running alongside other test files
mock.module("@relayapi/db", () => ({
	createDb: () => ({}),
	usageRecords: {},
	apiRequestLogs: {},
}));

import { Hono } from "hono";
import type { Env, Variables, KVKeyData } from "../types";
import { authMiddleware } from "../middleware/auth";
import { MockKV, createMockEnv, seedApiKeyInKV, hashKey } from "./__mocks__/env";

const TEST_KEY = "rlay_live_testauthkey0000000000000000000000000000000";
let kv: MockKV;
let env: Env;
let app: Hono<{ Bindings: Env; Variables: Variables }>;

function makeRequest(headers?: Record<string, string>) {
	return new Request("http://localhost/v1/posts", {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({}),
	});
}

const mockCtx = {
	waitUntil: () => {},
	passThroughOnException: () => {},
} as unknown as ExecutionContext;

beforeEach(async () => {
	const mock = createMockEnv();
	kv = mock.kv;
	env = mock.env;

	app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", authMiddleware);
	app.all("*", (c) =>
		c.json({
			orgId: c.get("orgId"),
			keyId: c.get("keyId"),
			plan: c.get("plan"),
			callsIncluded: c.get("callsIncluded"),
		}),
	);
});

describe("authMiddleware", () => {
	it("rejects missing Authorization header with 401", async () => {
		const res = await app.fetch(makeRequest(), env, mockCtx);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.code).toBe("UNAUTHORIZED");
		expect(body.error.message).toBe("Missing API key");
	});

	it("rejects non-Bearer authorization with 401", async () => {
		const res = await app.fetch(
			makeRequest({ Authorization: "Basic abc123" }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toBe("Missing API key");
	});

	it("rejects invalid API key prefix with 401", async () => {
		const res = await app.fetch(
			makeRequest({ Authorization: "Bearer invalid_prefix_key" }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toBe("Invalid API key format");
	});

	it("rejects API key not found in KV with 401", async () => {
		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toBe("Invalid API key");
	});

	it("rejects expired API key with 401", async () => {
		const hash = await hashKey(TEST_KEY);
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_test",
			key_id: "key_test",
			permissions: [],
			expires_at: "2020-01-01T00:00:00Z", // expired
			plan: "pro",
			calls_included: 10_000,
		});

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error.message).toBe("API key expired");
	});

	it("authenticates valid API key and sets context variables", async () => {
		const hash = await hashKey(TEST_KEY);
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_123",
			key_id: "key_456",
			permissions: ["posts:write"],
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
		});

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.orgId).toBe("org_123");
		expect(body.keyId).toBe("key_456");
		expect(body.plan).toBe("pro");
		expect(body.callsIncluded).toBe(10_000);
	});

	it("defaults to free plan when plan field missing in KV data", async () => {
		const hash = await hashKey(TEST_KEY);
		// Seed without plan field
		const data = {
			org_id: "org_123",
			key_id: "key_456",
			permissions: [],
			expires_at: null,
		} as unknown as KVKeyData;
		await seedApiKeyInKV(kv, hash, data);

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.plan).toBe("free");
		expect(body.callsIncluded).toBe(200);
	});

	it("propagates pro plan from KV data", async () => {
		const hash = await hashKey(TEST_KEY);
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_pro",
			key_id: "key_pro",
			permissions: ["posts:write", "analytics:read"],
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
		});

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.plan).toBe("pro");
		expect(body.callsIncluded).toBe(10_000);
	});

	it("applies updated KV auth data immediately for the same API key", async () => {
		const hash = await hashKey(TEST_KEY);
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_cached",
			key_id: "key_cached",
			permissions: ["write"],
			workspace_scope: "all",
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
		});

		const first = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(first.status).toBe(200);
		expect((await first.json()).plan).toBe("pro");

		await seedApiKeyInKV(kv, hash, {
			org_id: "org_cached",
			key_id: "key_cached",
			permissions: ["read"],
			workspace_scope: ["ws_123"],
			expires_at: null,
			plan: "free",
			calls_included: 200,
		});

		const second = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(second.status).toBe(200);
		const body = await second.json();
		expect(body.plan).toBe("free");
		expect(body.callsIncluded).toBe(200);
	});
});
