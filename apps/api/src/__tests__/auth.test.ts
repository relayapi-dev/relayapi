import { beforeEach, describe, expect, it, mock } from "bun:test";

let activeDb: ReturnType<typeof import("./__mocks__/db").createMockDb>;

mock.module("@relayapi/db", () => {
	const apikey = {
		id: { name: "id" },
		key: { name: "key" },
		organizationId: { name: "organizationId" },
		principalId: { name: "principalId" },
		enabled: { name: "enabled" },
		expiresAt: { name: "expiresAt" },
		permissions: { name: "permissions" },
		credentialVersion: { name: "credentialVersion" },
		metadata: { name: "metadata" },
		toString: () => "apikey",
	};
	const organizationSubscriptions = {
		organizationId: { name: "organizationId" },
		status: { name: "status" },
		source: { name: "source" },
		stripeSubscriptionId: { name: "stripeSubscriptionId" },
		trialEndsAt: { name: "trialEndsAt" },
		delinquentAt: { name: "delinquentAt" },
		graceEndsAt: { name: "graceEndsAt" },
		currentPeriodStart: { name: "currentPeriodStart" },
		currentPeriodEnd: { name: "currentPeriodEnd" },
		updatedAt: { name: "updatedAt" },
		aiEnabled: { name: "aiEnabled" },
		dailyToolLimitOverride: { name: "dailyToolLimitOverride" },
		toString: () => "organization_subscriptions",
	};
	// Use projection-specific names for period columns so the lightweight
	// flattened join mock cannot mistake billingPeriods.id for apikey.id when
	// no active billing-period row exists.
	const billingPeriods = {
		id: { name: "billingPeriodId" },
		organizationId: { name: "organizationId" },
		state: { name: "billingPeriodState" },
		source: { name: "billingPeriodSource" },
		billable: { name: "billingPeriodBillable" },
		quotaMode: { name: "billingPeriodQuotaMode" },
		includedUnits: { name: "billingPeriodIncludedUnits" },
		providerCycleAnchor: { name: "billingPeriodProviderCycleAnchor" },
		stripeSubscriptionId: { name: "billingPeriodStripeSubscriptionId" },
		periodStart: { name: "billingPeriodStart" },
		periodEnd: { name: "billingPeriodEnd" },
		toString: () => "billing_periods",
	};
	const usageBuckets = {
		id: { name: "usageBucketId" },
		organizationId: { name: "organizationId" },
		billingPeriodId: { name: "billingPeriodId" },
		metric: { name: "metric" },
		periodStart: { name: "usageBucketPeriodStart" },
		periodEnd: { name: "usageBucketPeriodEnd" },
		quotaMode: { name: "usageBucketQuotaMode" },
		includedUnits: { name: "usageBucketIncludedUnits" },
		toString: () => "usage_buckets",
	};
	const organization = {
		id: { name: "id" },
		lifecycleStatus: { name: "lifecycleStatus" },
		toString: () => "organization",
	};
	const organizationPrincipals = {
		id: { name: "id" },
		organizationId: { name: "organizationId" },
		memberId: { name: "memberId" },
		kind: { name: "kind" },
		scopeMode: { name: "scopeMode" },
		lifecycleStatus: { name: "principalLifecycleStatus" },
		toString: () => "organization_principals",
	};
	const principalWorkspaceGrants = {
		organizationId: { name: "organizationId" },
		principalId: { name: "principalId" },
		workspaceId: { name: "workspaceId" },
		toString: () => "principal_workspace_grants",
	};
	const member = {
		id: { name: "memberId" },
		organizationId: { name: "organizationId" },
		userId: { name: "userId" },
		role: { name: "role" },
		toString: () => "member",
	};
	const user = {
		id: { name: "userId" },
		banned: { name: "userBanned" },
		banExpires: { name: "userBanExpires" },
		credentialVersion: { name: "userCredentialVersion" },
		toString: () => "user",
	};

	return {
		createDb: () => activeDb,
		apikey,
		member,
		user,
		organization,
		organizationPrincipals,
		organizationSubscriptions,
		billingPeriods,
		usageBuckets,
		principalWorkspaceGrants,
	};
});

mock.module("drizzle-orm", () => {
	const { mockEq } = require("./__mocks__/db");
	return {
		and: (...conditions: Array<Record<string, unknown> | undefined>) => ({
			_filter: (row: Record<string, unknown>) =>
				conditions.every((condition) => {
					const filter = condition?._filter;
					return typeof filter !== "function" || filter(row);
				}),
			_joinCols: conditions.find((condition) => condition?._joinCols)
				?._joinCols,
		}),
		eq: (col: unknown, val: unknown) => mockEq(col, val),
	};
});

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import type { Env, KVKeyData, Variables } from "../types";
import { createMockDb } from "./__mocks__/db";
import {
	createMockEnv,
	hashKey,
	type MockKV,
	seedApiKeyInKV,
} from "./__mocks__/env";

const TEST_KEY = "rlay_live_testauthkey0000000000000000000000000000000";
type AuthErrorResponse = { error: { code: string; message: string } };
type AuthSuccessResponse = {
	orgId: string;
	keyId: string;
	keyHash: string;
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
		principalId: string;
		enabled: boolean;
		expiresAt: Date | null;
		referenceId: string | null;
		credentialVersion: string | null;
		permissions: string;
		metadata: Record<string, unknown> | null;
		scopeMode: "all" | "selected";
		workspaceIds: string[];
		status: string;
		source: "stripe" | "complimentary";
		stripeSubscriptionId: string | null;
		aiEnabled: boolean;
		dailyToolLimitOverride: number | null;
	}> = {},
) {
	const principalId = overrides.principalId ?? "prn_db_1";
	activeDb._seed("apikey", [
		{
			id: overrides.id ?? "key_db_1",
			key: hashedKey,
			organizationId: overrides.organizationId ?? "org_db_1",
			enabled: overrides.enabled ?? true,
			expiresAt: overrides.expiresAt ?? null,
			permissions: overrides.permissions ?? "posts:write,analytics:read",
			metadata: overrides.metadata ?? null,
			principalId,
			referenceId: overrides.referenceId ?? null,
			credentialVersion: overrides.credentialVersion ?? null,
		},
	]);
	activeDb._seed("organizationPrincipals", [
		{
			id: principalId,
			organizationId: overrides.organizationId ?? "org_db_1",
			kind: "service",
			scopeMode: overrides.scopeMode ?? "all",
			principalLifecycleStatus: "active",
		},
	]);
	activeDb._seed(
		"principalWorkspaceGrants",
		(overrides.workspaceIds ?? []).map((workspaceId) => ({
			organizationId: overrides.organizationId ?? "org_db_1",
			principalId,
			workspaceId,
		})),
	);

	activeDb._seed("organizationSubscriptions", [
		{
			organizationId: overrides.organizationId ?? "org_db_1",
			status: overrides.status ?? "active",
			source: overrides.source ?? "complimentary",
			stripeSubscriptionId: overrides.stripeSubscriptionId ?? null,
			aiEnabled: overrides.aiEnabled ?? true,
			dailyToolLimitOverride: overrides.dailyToolLimitOverride ?? null,
		},
	]);
	activeDb._seed("organization", [
		{
			id: overrides.organizationId ?? "org_db_1",
			lifecycleStatus: "active",
		},
	]);
}

function seedDashboardDbApiKey(
	hashedKey: string,
	overrides: Partial<{
		keyCredentialVersion: string | null;
		userCredentialVersion: string;
		banned: boolean | null;
		banExpires: Date | null;
		role: string;
		permissions: string;
	}> = {},
) {
	activeDb._seed("apikey", [
		{
			id: "key_dashboard",
			key: hashedKey,
			organizationId: "org_dashboard",
			principalId: "prn_dashboard",
			memberId: "mem_dashboard",
			userId: "usr_dashboard",
			referenceId: "usr_dashboard",
			credentialVersion:
				overrides.keyCredentialVersion === undefined
					? "generation-2"
					: overrides.keyCredentialVersion,
			enabled: true,
			expiresAt: new Date(Date.now() + 60_000),
			permissions: overrides.permissions ?? "read,write",
		},
	]);
	activeDb._seed("organizationPrincipals", [
		{
			id: "prn_dashboard",
			organizationId: "org_dashboard",
			memberId: "mem_dashboard",
			kind: "member",
			scopeMode: "all",
			principalLifecycleStatus: "active",
		},
	]);
	activeDb._seed("member", [
		{
			id: "mem_dashboard",
			organizationId: "org_dashboard",
			userId: "usr_dashboard",
			role: overrides.role ?? "member",
		},
	]);
	activeDb._seed("user", [
		{
			userId: "usr_dashboard",
			userBanned: overrides.banned ?? false,
			userBanExpires: overrides.banExpires ?? null,
			userCredentialVersion: overrides.userCredentialVersion ?? "generation-2",
		},
	]);
	activeDb._seed("organizationSubscriptions", [
		{
			organizationId: "org_dashboard",
			status: "active",
			source: "complimentary",
			aiEnabled: true,
		},
	]);
	activeDb._seed("organization", [
		{ id: "org_dashboard", lifecycleStatus: "active" },
	]);
}

async function seedDashboardKeyInKv(
	hashedKey: string,
	permissions: string[] = ["read", "write"],
): Promise<void> {
	await seedApiKeyInKV(kv, hashedKey, {
		org_id: "org_dashboard",
		key_id: "key_dashboard",
		permissions,
		workspace_scope: "all",
		principal_type: "dashboard_user",
		principal_id: "prn_dashboard",
		principal_user_id: "usr_dashboard",
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		plan: "free",
		calls_included: 200,
		entitlement_recheck_at: null,
	});
}

beforeEach(async () => {
	activeDb = createMockDb();
	const mock = createMockEnv();
	kv = mock.kv;
	env = mock.env;

	app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("db", activeDb as unknown as Variables["db"]);
		await next();
	});
	app.use("*", authMiddleware);
	app.all("*", (c) =>
		c.json({
			orgId: c.get("orgId"),
			keyId: c.get("keyId"),
			keyHash: c.get("keyHash"),
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
			scopeMode: "selected",
			workspaceIds: ["ws_123"],
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
		expect(body.keyHash).toBe(hashedKey);
		expect(body.plan).toBe("pro");
		// Pro feature entitlement is preserved, but mutation authority fails
		// closed until an exact immutable period/bucket pair exists.
		expect(body.callsIncluded).toBe(0);

		const cached = await kv.get(`apikey:${hashedKey}`, "json");
		expect(cached).toEqual({
			org_id: "org_db_hydrated",
			key_id: "key_db_hydrated",
			permissions: ["posts:write", "analytics:read"],
			workspace_scope: ["ws_123"],
			expires_at: null,
			plan: "pro",
			calls_included: 0,
			quota_mode: "hard",
			billing_source: "complimentary",
			billable: false,
			billing_period_id: null,
			billing_authority_state: "pending",
			principal_type: "service",
			principal_id: "prn_db_1",
			principal_user_id: null,
			ai_enabled: true,
			daily_tool_limit: 10,
			// Stripe billing-period bounds — null here because the mock subscription
			// has no current_period_start/end, so usage falls back to calendar month.
			period_start: null,
			period_end: null,
			entitlement_recheck_at: null,
			billing_transition_at: null,
		});
	});

	it("fails closed when a cached workspace grant has a malformed shape", async () => {
		const hashedKey = await hashKey(TEST_KEY);
		await kv.put(
			`apikey:${hashedKey}`,
			JSON.stringify({
				org_id: "org_cached",
				key_id: "key_cached",
				permissions: ["write"],
				workspace_scope: "ws_123",
				principal_type: "service",
				principal_id: "prn_cached",
				principal_user_id: null,
				expires_at: null,
				plan: "pro",
				calls_included: 10_000,
			}),
		);

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(res.status).toBe(401);
		const body = await readJson<AuthErrorResponse>(res);
		expect(body.error.message).toBe("Invalid API key scope");
		expect(await kv.get(`apikey:${hashedKey}`)).toBeNull();
	});

	it("authorizes a selected principal with zero grants but exposes no workspace", async () => {
		const hashedKey = await hashKey(TEST_KEY);
		seedDbApiKey(hashedKey, {
			scopeMode: "selected",
			workspaceIds: [],
		});

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(res.status).toBe(200);
		const cached = (await kv.get(`apikey:${hashedKey}`, "json")) as KVKeyData;
		expect(cached.workspace_scope).toEqual([]);
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
			billing_authority_state: "ready",
			billing_period_id: "bp_cached",
			period_start: "2026-08-01T00:00:00.000Z",
			period_end: "2026-09-01T00:00:00.000Z",
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
		seedDbApiKey(hash, {
			id: "key_456",
			organizationId: "org_123",
			principalId: "prn_456",
			permissions: "posts:write",
		});
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_123",
			key_id: "key_456",
			permissions: ["posts:write"],
			principal_type: "service",
			principal_id: "prn_456",
			principal_user_id: null,
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
			billing_authority_state: "ready",
			billing_period_id: "bp_pro",
			period_start: "2026-08-01T00:00:00.000Z",
			period_end: "2026-09-01T00:00:00.000Z",
			entitlement_recheck_at: null,
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
		seedDbApiKey(hash, {
			id: "key_456",
			organizationId: "org_123",
			principalId: "prn_456",
			permissions: "",
		});
		// Seed without plan field
		const data = {
			org_id: "org_123",
			key_id: "key_456",
			permissions: [],
			principal_type: "service",
			principal_id: "prn_456",
			principal_user_id: null,
			expires_at: null,
			entitlement_recheck_at: null,
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
		seedDbApiKey(hash, {
			id: "key_pro",
			organizationId: "org_pro",
			principalId: "prn_pro",
		});
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_pro",
			key_id: "key_pro",
			permissions: ["posts:write", "analytics:read"],
			principal_type: "service",
			principal_id: "prn_pro",
			principal_user_id: null,
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
			billing_authority_state: "ready",
			billing_period_id: "bp_cached",
			period_start: "2026-08-01T00:00:00.000Z",
			period_end: "2026-09-01T00:00:00.000Z",
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

	it("rejects cached service authority immediately after PostgreSQL revokes a scope", async () => {
		const hash = await hashKey(TEST_KEY);
		seedDbApiKey(hash, {
			id: "key_cached",
			organizationId: "org_cached",
			principalId: "prn_cached",
			permissions: "read,write,manage_api_keys",
		});
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_cached",
			key_id: "key_cached",
			permissions: ["read", "write", "manage_api_keys"],
			workspace_scope: "all",
			principal_type: "service",
			principal_id: "prn_cached",
			principal_user_id: null,
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
			billing_authority_state: "ready",
			billing_period_id: "bp_deleted",
			period_start: "2026-08-01T00:00:00.000Z",
			period_end: "2026-09-01T00:00:00.000Z",
			entitlement_recheck_at: null,
		});

		const first = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(first.status).toBe(200);
		const firstBody = await readJson<AuthSuccessResponse>(first);
		expect(firstBody.plan).toBe("pro");

		seedDbApiKey(hash, {
			id: "key_cached",
			organizationId: "org_cached",
			principalId: "prn_cached",
			permissions: "read",
		});

		const second = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(second.status).toBe(401);
		expect(await kv.get(`apikey:${hash}`)).toBeNull();
	});

	it("accepts a dashboard key only when its credential generation is current", async () => {
		const hash = await hashKey(TEST_KEY);
		seedDashboardDbApiKey(hash);
		await seedDashboardKeyInKv(hash);

		const response = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(response.status).toBe(200);
	});

	it("rejects a cached dashboard key immediately after its user generation changes", async () => {
		const hash = await hashKey(TEST_KEY);
		seedDashboardDbApiKey(hash, { userCredentialVersion: "generation-3" });
		await seedDashboardKeyInKv(hash);

		const response = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(response.status).toBe(401);
		expect(await kv.get(`apikey:${hash}`)).toBeNull();
	});

	it("rejects a cached admin dashboard key immediately after membership demotion", async () => {
		const hash = await hashKey(TEST_KEY);
		const adminPermissions = [
			"read",
			"write",
			"manage_api_keys",
			"manage_spend",
		];
		seedDashboardDbApiKey(hash, {
			role: "member",
			permissions: adminPermissions.join(","),
		});
		await seedDashboardKeyInKv(hash, adminPermissions);

		const response = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(response.status).toBe(401);
		expect(await kv.get(`apikey:${hash}`)).toBeNull();
	});

	it("rejects an actively banned dashboard user but honors an elapsed temporary ban", async () => {
		const hash = await hashKey(TEST_KEY);
		seedDashboardDbApiKey(hash, { banned: true, banExpires: null });
		await seedDashboardKeyInKv(hash);
		const banned = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(banned.status).toBe(401);

		seedDashboardDbApiKey(hash, {
			banned: true,
			banExpires: new Date(Date.now() - 1_000),
		});
		await seedDashboardKeyInKv(hash);
		const elapsed = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(elapsed.status).toBe(200);
	});

	it("keeps a service key valid when its recorded creator is banned", async () => {
		const hash = await hashKey(TEST_KEY);
		seedDbApiKey(hash, {
			id: "key_service_owned",
			organizationId: "org_service_owned",
			principalId: "prn_service_owned",
			referenceId: "usr_banned_creator",
			permissions: "read",
		});
		activeDb._seed("user", [
			{
				userId: "usr_banned_creator",
				userBanned: true,
				userBanExpires: null,
				userCredentialVersion: "generation-9",
			},
		]);
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_service_owned",
			key_id: "key_service_owned",
			permissions: ["read"],
			workspace_scope: "all",
			principal_type: "service",
			principal_id: "prn_service_owned",
			principal_user_id: null,
			expires_at: null,
			plan: "free",
			calls_included: 200,
			entitlement_recheck_at: null,
		});

		const response = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);
		expect(response.status).toBe(200);
	});

	it("rejects and purges a stale cached service key after authoritative deletion", async () => {
		const hash = await hashKey(TEST_KEY);
		await seedApiKeyInKV(kv, hash, {
			org_id: "org_deleted",
			key_id: "key_deleted",
			permissions: ["posts:write"],
			workspace_scope: "all",
			principal_type: "service",
			principal_id: "prn_deleted",
			principal_user_id: null,
			expires_at: null,
			plan: "pro",
			calls_included: 10_000,
			billing_authority_state: "ready",
			billing_period_id: "bp_deleted",
			period_start: "2026-08-01T00:00:00.000Z",
			period_end: "2026-09-01T00:00:00.000Z",
		});

		const res = await app.fetch(
			makeRequest({ Authorization: `Bearer ${TEST_KEY}` }),
			env,
			mockCtx,
		);

		expect(res.status).toBe(401);
		const body = await readJson<AuthErrorResponse>(res);
		expect(body.error.message).toBe("Invalid API key");
		expect(await kv.get(`apikey:${hash}`)).toBeNull();
	});
});
