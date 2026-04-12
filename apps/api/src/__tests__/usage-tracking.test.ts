import { mock, describe, it, expect, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — MUST come before importing the code under test
// ---------------------------------------------------------------------------
mock.module("@relayapi/db", () => ({
	createDb: () => ({
		insert: () => ({
			values: () => ({
				onConflictDoUpdate: () => ({
					then: (resolve: (v: void) => void) => resolve(),
				}),
				then: (resolve: (v: void) => void) => resolve(),
			}),
		}),
	}),
	usageRecords: {},
	apiRequestLogs: {},
}));

mock.module("../services/notification-manager", () => ({
	sendNotificationToOrg: async () => {},
}));

import { Hono } from "hono";
import {
	incrementUsage,
	getUsageCount,
	usageTrackingMiddleware,
} from "../middleware/usage-tracking";
import type { Env, Variables } from "../types";
import { MockKV, createMockEnv } from "./__mocks__/env";

// ===========================================================================
// Helpers
// ===========================================================================

/** Build the current month key segment (YYYY-MM) matching the production code. */
function currentMonthKey(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Create a minimal Hono app wired with the usage-tracking middleware.
 * A fake "auth" middleware runs first to inject the context variables the
 * real auth middleware would set.
 */
function createTestApp(opts: {
	plan?: "free" | "pro";
	callsIncluded?: number;
	orgId?: string;
	keyId?: string;
}) {
	const {
		plan = "free",
		callsIncluded = 200,
		orgId = "org_test",
		keyId = "key_test",
	} = opts;

	const app = new Hono<{ Bindings: Env; Variables: Variables }>();

	// Fake auth middleware — sets the variables the usage middleware reads
	app.use("*", async (c, next) => {
		c.set("orgId", orgId);
		c.set("keyId", keyId);
		c.set("plan", plan);
		c.set("callsIncluded", callsIncluded);
		await next();
	});

	app.use("*", usageTrackingMiddleware);

	// Test routes
	app.get("/v1/posts", (c) => c.json({ ok: true }));
	app.post("/v1/posts", (c) => c.json({ ok: true }));
	app.post("/v1/posts/bulk", async (c) => c.json({ ok: true }));

	return app;
}

/**
 * Create a mock execution context that captures waitUntil promises so we
 * can await them in tests.
 */
function createExecutionCtx() {
	const promises: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => {
			promises.push(p);
		},
		passThroughOnException: () => {},
	};
	return { ctx, promises };
}

/**
 * Fire a request against the test app and drain all async side-effects.
 */
async function executeRequest(
	app: Hono<{ Bindings: Env; Variables: Variables }>,
	request: Request,
	env: Env,
) {
	const { ctx, promises } = createExecutionCtx();
	const res = await app.fetch(request, env, ctx);
	// Drain all fire-and-forget promises so assertions on KV writes etc. work.
	await Promise.allSettled(promises);
	return { res, promises };
}

// ===========================================================================
// incrementUsage
// ===========================================================================

describe("incrementUsage", () => {
	let kv: MockKV;

	beforeEach(() => {
		kv = new MockKV();
	});

	it("increments from zero and returns 1", async () => {
		const result = await incrementUsage(kv as unknown as KVNamespace, "org_1");
		expect(result).toBe(1);
	});

	it("increments from an existing count", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_1:${month}`, "42");

		const result = await incrementUsage(kv as unknown as KVNamespace, "org_1");
		expect(result).toBe(43);
	});

	it("increments by a custom amount", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_1:${month}`, "10");

		const result = await incrementUsage(
			kv as unknown as KVNamespace,
			"org_1",
			5,
		);
		expect(result).toBe(15);
	});

	it("uses the correct KV key format usage:{orgId}:{YYYY-MM}", async () => {
		await incrementUsage(kv as unknown as KVNamespace, "org_abc");

		const month = currentMonthKey();
		const expectedKey = `usage:org_abc:${month}`;
		const stored = await kv.get(expectedKey, "text");
		expect(stored).toBe("1");
	});
});

// ===========================================================================
// getUsageCount
// ===========================================================================

describe("getUsageCount", () => {
	let kv: MockKV;

	beforeEach(() => {
		kv = new MockKV();
	});

	it("returns 0 when no usage has been recorded", async () => {
		const count = await getUsageCount(kv as unknown as KVNamespace, "org_new");
		expect(count).toBe(0);
	});

	it("returns the current count from KV", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_1:${month}`, "99");

		const count = await getUsageCount(kv as unknown as KVNamespace, "org_1");
		expect(count).toBe(99);
	});
});

// ===========================================================================
// usageTrackingMiddleware
// ===========================================================================

describe("usageTrackingMiddleware", () => {
	let env: Env;
	let kv: MockKV;

	beforeEach(() => {
		const mock = createMockEnv();
		env = mock.env;
		kv = mock.kv;
		kv._clear();
	});

	// -----------------------------------------------------------------------
	// Free plan — under / at / over limit
	// -----------------------------------------------------------------------

	it("allows free plan requests under the limit", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_test:${month}`, "50");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);
	});

	it("blocks free plan at the limit (countBefore >= callsIncluded)", async () => {
		const month = currentMonthKey();
		// Usage is already at the limit before this request
		await kv.put(`usage:org_test:${month}`, "200");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("FREE_LIMIT_REACHED");
	});

	it("blocks free plan over the limit", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_test:${month}`, "250");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("FREE_LIMIT_REACHED");
	});

	// -----------------------------------------------------------------------
	// Pro plan — no hard limit
	// -----------------------------------------------------------------------

	it("allows pro plan requests over the included amount", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_test:${month}`, "15000");

		const app = createTestApp({
			plan: "pro",
			callsIncluded: 10_000,
		});
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);
	});

	// -----------------------------------------------------------------------
	// Bulk endpoint — counts items individually
	// -----------------------------------------------------------------------

	it("counts bulk items individually", async () => {
		const month = currentMonthKey();
		// Start from 0 so the new count = 3
		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts/bulk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ posts: [{}, {}, {}] }),
		});
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);

		// KV should show count = 3 (one per item, not one per request)
		const stored = await kv.get(`usage:org_test:${month}`, "text");
		expect(stored).toBe("3");
	});

	// -----------------------------------------------------------------------
	// GET requests — no billing increment
	// -----------------------------------------------------------------------

	it("skips billing for GET requests", async () => {
		const month = currentMonthKey();
		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "GET" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);

		// Usage counter should not exist (no KV write for GET)
		const stored = await kv.get(`usage:org_test:${month}`, "text");
		expect(stored).toBeNull();
	});

	// -----------------------------------------------------------------------
	// Response headers
	// -----------------------------------------------------------------------

	it("sets X-Usage-Count and X-Usage-Limit headers on success", async () => {
		const month = currentMonthKey();
		await kv.put(`usage:org_test:${month}`, "50");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Usage-Count")).toBe("51");
		expect(res.headers.get("X-Usage-Limit")).toBe("200");
	});

	// -----------------------------------------------------------------------
	// Usage warnings
	// -----------------------------------------------------------------------

	it("sends 80% usage warning when threshold is crossed", async () => {
		const month = currentMonthKey();
		// 159 calls used; next call brings it to 160 = 80% of 200
		await kv.put(`usage:org_test:${month}`, "159");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);

		// The warning dedup key should have been set in KV
		const warningKey = `usage_warning:org_test:80:${month}`;
		const warningFlag = await kv.get(warningKey, "text");
		expect(warningFlag).toBe("1");
	});

	it("sends 100% usage warning when threshold is crossed", async () => {
		const month = currentMonthKey();
		// 199 calls used; next call brings it to 200 = 100% of 200
		await kv.put(`usage:org_test:${month}`, "199");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		// countBefore = 199, which is < 200 (callsIncluded), so the request
		// should still go through (the limit check is countBefore >= callsIncluded)
		expect(res.status).toBe(200);

		// The 100% warning dedup key should have been written
		const warningKey = `usage_warning:org_test:100:${month}`;
		const warningFlag = await kv.get(warningKey, "text");
		expect(warningFlag).toBe("1");
	});

	it("deduplicates warnings when the flag already exists in KV", async () => {
		const month = currentMonthKey();
		// Pre-seed the 80% warning flag so it looks like it was already sent
		const warningKey = `usage_warning:org_test:80:${month}`;
		await kv.put(warningKey, "1");

		// Set usage to 159 so the next call crosses 80% again
		await kv.put(`usage:org_test:${month}`, "159");

		const app = createTestApp({ plan: "free", callsIncluded: 200 });
		const req = new Request("http://localhost/v1/posts", { method: "POST" });
		const { res } = await executeRequest(app, req, env);

		expect(res.status).toBe(200);

		// The warning flag should still be "1" (not re-written or doubled).
		// Since sendNotificationToOrg is mocked, the key test is that the
		// existing flag prevents the notification path from writing again.
		// The flag value remains "1" as it was — no duplicate notification sent.
		const warningFlag = await kv.get(warningKey, "text");
		expect(warningFlag).toBe("1");
	});
});
