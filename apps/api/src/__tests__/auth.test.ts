import { describe, it, expect, beforeEach, mock } from "bun:test";

let activeDb: ReturnType<typeof import("./__mocks__/db").createMockDb>;

mock.module("@relayapi/db", () => {
	const apikey = {
		id: { name: "id" },
		key: { name: "key" },
		organizationId: { name: "organizationId" },
		enabled: { name: "enabled" },
		expiresAt: { name: "expiresAt" },
		permissions: { name: "permissions" },
		metadata: { name: "metadata" },
		toString: () => "apikey",
	};
	const organizationSubscriptions = {
		organizationId: { name: "organizationId" },
		status: { name: "status" },
		aiEnabled: { name: "aiEnabled" },
		dailyToolLimit: { name: "dailyToolLimit" },
		toString: () => "organization_subscriptions",
	};

	return {
		createDb: () => activeDb,
		apikey,
		organizationSubscriptions,
	};
});

mock.module("drizzle-orm", () => {
	const { mockEq } = require("./__mocks__/db");
	return {
		eq: (col: unknown, val: unknown) => mockEq(col, val),
	};
});

import { Hono } from "hono";
import type { Env, Variables, KVKeyData } from "../types";
import { authMiddleware } from "../middleware/auth";
import { MockKV, createMockEnv, seedApiKeyInKV, hashKey } from "./__mocks__/env";
import { createMockDb } from "./__mocks__/db";

const TEST_KEY = "rlay_live_testauthkey0000000000000000000000000000000";
type AuthErrorResponse = { error: { code: string; message: string } };
type AuthSuccessResponse = {
	orgId: string;
	keyId: string;
	plan: "free" | "pro";
	callsIncluded: number;
};

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

async function readJson<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

function seedDbApiKey(
	hashedKey: string,
	overrides: Partial<{
		id: string;
		organizationId: string;
		enabled: boolean;
		expiresAt: Date | null;
		permissions: string;
		metadata: Record<string, unknown> | null;
		status: string;
		aiEnabled: boolean;
		dailyToolLimit: number;
	}> = {},
) {
	activeDb._seed("apikey", [
		{
			id: overrides.id ?? "key_db_1",
			key: hashedKey,
			organizationId: overrides.organizationId ?? "org_db_1",
			enabled: overrides.enabled ?? true,
			expiresAt: overrides.expiresAt ?? null,
			permissions: overrides.permissions ?? "posts:write,analytics:read",
			metadata: overrides.metadata ?? null,
		},
	]);

	activeDb._seed("organizationSubscriptions", [
		{
			organizationId: overrides.organizationId ?? "org_db_1",
			status: overrides.status ?? "active",
			aiEnabled: overrides.aiEnabled ?? true,
			dailyToolLimit: overrides.dailyToolLimit ?? 10,
		},
	]);
}

beforeEach(async () => {
	activeDb = createMockDb();
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
		const body = await readJson<AuthErrorResponse>(res);
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
		const body = await readJson<AuthErrorResponse>(res);
		expect(body.error.message).toBe("Missing API key");
	});

	it("rejects invalid API key prefix with 401", async () => {
		const res = await app.fetch(
			makeRequest({ Authorization: "Bearer invalid_prefix_key" }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(401);
		const body = await readJson<AuthErrorResponse>(res);
		expect(body.error.message).toBe("Invalid API key format");
	});

	it("returns 401 on KV miss when the API key is also missing from the DB", async () => {
		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(res.status).toBe(401);
		const body = await readJson<AuthErrorResponse>(res);
		expect(body.error.message).toBe("Invalid API key");
	});

	it("rehydrates a KV miss from the DB and caches the API key record", async () => {
		const hashedKey = await hashKey(TEST_KEY);
		seedDbApiKey(hashedKey, {
			id: "key_db_hydrated",
			organizationId: "org_db_hydrated",
			metadata: { workspace_scope: ["ws_123"] },
		});

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(res.status).toBe(200);
		const body = await readJson<AuthSuccessResponse>(res);
		expect(body.orgId).toBe("org_db_hydrated");
		expect(body.keyId).toBe("key_db_hydrated");
		expect(body.plan).toBe("pro");
		expect(body.callsIncluded).toBe(10_000);

		const cached = await kv.get(`apikey:${hashedKey}`, "json");
		expect(cached).toEqual({
			org_id: "org_db_hydrated",
			key_id: "key_db_hydrated",
			permissions: ["posts:write", "analytics:read"],
			workspace_scope: ["ws_123"],
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
			ai_enabled: true,
			daily_tool_limit: 10,
		});
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
		const body = await readJson<AuthErrorResponse>(res);
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
		const body = await readJson<AuthSuccessResponse>(res);
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
		const body = await readJson<AuthSuccessResponse>(res);
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
		const body = await readJson<AuthSuccessResponse>(res);
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
		const firstBody = await readJson<AuthSuccessResponse>(first);
		expect(firstBody.plan).toBe("pro");

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
		const body = await readJson<AuthSuccessResponse>(second);
		expect(body.plan).toBe("free");
		expect(body.callsIncluded).toBe(200);
	});
});
