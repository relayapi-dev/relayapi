import {
	API_KEY_CACHE_TTL_SECONDS,
	API_KEY_NEGATIVE_CACHE_TTL_SECONDS,
	apiKeyCacheTtl,
	getBillingPolicy,
	PRICING,
} from "@relayapi/config";
import {
	apikey,
	member,
	organization,
	organizationSubscriptions,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { parseApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope";
import { getRequestDb } from "../lib/request-db";
import type { Env, KVKeyData, Variables } from "../types";

const API_KEY_PREFIXES = ["rlay_live_", "rlay_test_"];

/**
 * KV cache lifetime for an API key record. Acts as a passive backstop:
 * if a key is mutated in the DB without going through an explicit
 * invalidation path (DELETE endpoint, Stripe webhook, invoice generator),
 * the change still takes effect within this window. Active invalidation
 * paths bypass this entirely.
 *
 * Kept short (10 min) so an out-of-band revoke/disable (direct DB/admin
 * update, or a Better Auth apiKey() route) stops authenticating within
 * minutes rather than a full day. The miss path is a single LEFT JOIN
 * (~100ms) with the KV write-back deferred via waitUntil, so once-per-
 * window rehydration per key per colo is cheap.
 */
export const API_KEY_KV_TTL_SECONDS = API_KEY_CACHE_TTL_SECONDS;

/**
 * KV TTL for the negative (tombstone) cache entry written when a
 * well-formed-but-invalid key is looked up. Bounds how long a revoked/
 * unknown key keeps short-circuiting at the edge without a DB round trip.
 * KV enforces a 60s minimum TTL.
 */
export const API_KEY_NEGATIVE_KV_TTL_SECONDS =
	API_KEY_NEGATIVE_CACHE_TTL_SECONDS;

/** Sentinel stored in KV to mark a well-formed key as known-invalid. */
const NEGATIVE_CACHE_VALUE = '{"invalid":true}';

/**
 * Compute the actual TTL to use when writing a key to KV — clamps the
 * backstop window (API_KEY_KV_TTL_SECONDS) against the key's own expiry
 * so we never cache past it. KV requires a minimum TTL of 60s.
 */
export function kvTtlForKey(expiresAt: Date | string | null): number {
	return apiKeyCacheTtl(expiresAt);
}

export async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Rebuild the KV cache for an API key from the database. Returns null if
 * the key doesn't exist, is disabled, has no org, or is expired. On
 * success, writes the rebuilt record to KV with the standard TTL.
 *
 * Pass `waitUntil` (from the request's ExecutionContext) to defer the KV
 * write off the response path; without it the write is awaited.
 */
export async function hydrateApiKey(
	env: Env,
	hashedKey: string,
	waitUntil?: (p: Promise<unknown>) => void,
): Promise<KVKeyData | null> {
	const db = getRequestDb(env);

	// Single round trip: key row + its org's subscription via LEFT JOIN.
	// These were two serialized queries (~2x origin RTT) before.
	const [joined] = await db
		.select({
			id: apikey.id,
			organizationId: apikey.organizationId,
			enabled: apikey.enabled,
			expiresAt: apikey.expiresAt,
			permissions: apikey.permissions,
			metadata: apikey.metadata,
			organizationLifecycleStatus: organization.lifecycleStatus,
			subStatus: organizationSubscriptions.status,
			subAiEnabled: organizationSubscriptions.aiEnabled,
			subDailyToolLimit: organizationSubscriptions.dailyToolLimit,
			subStripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			subTrialEndsAt: organizationSubscriptions.trialEndsAt,
			subPeriodStart: organizationSubscriptions.currentPeriodStart,
			subPeriodEnd: organizationSubscriptions.currentPeriodEnd,
		})
		.from(apikey)
		.innerJoin(organization, eq(organization.id, apikey.organizationId))
		.leftJoin(
			organizationSubscriptions,
			eq(organizationSubscriptions.organizationId, apikey.organizationId),
		)
		.where(eq(apikey.key, hashedKey))
		.limit(1);

	if (
		!joined ||
		joined.enabled === false ||
		!joined.organizationId ||
		joined.organizationLifecycleStatus !== "active" ||
		(joined.expiresAt && joined.expiresAt < new Date())
	) {
		// Negative cache: write a short-lived tombstone so a misconfigured
		// client or an attacker replaying one revoked/unknown key doesn't
		// turn every request into a blocking origin DB round trip. Key
		// creation/re-enable overwrites `apikey:<hash>` with the real record,
		// so a newly valid key is never blocked by a stale tombstone.
		const tombstone = env.KV.put(`apikey:${hashedKey}`, NEGATIVE_CACHE_VALUE, {
			expirationTtl: API_KEY_NEGATIVE_KV_TTL_SECONDS,
		});
		if (waitUntil) waitUntil(tombstone);
		else await tombstone;
		return null;
	}

	const row = joined;
	const sub = {
		status: joined.subStatus,
		aiEnabled: joined.subAiEnabled,
		dailyToolLimit: joined.subDailyToolLimit,
	};

	const billing = getBillingPolicy({
		status: sub.status,
		stripeSubscriptionId: joined.subStripeSubscriptionId,
		trialEndsAt: joined.subTrialEndsAt,
		currentPeriodStart: joined.subPeriodStart,
		currentPeriodEnd: joined.subPeriodEnd,
	});
	const plan = billing.entitlement;
	const callsIncluded =
		plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;

	const permissionsArray = (row.permissions ?? "read,write")
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
	const workspaceScope = parseApiKeyWorkspaceScope(metadata);
	if (workspaceScope === null) {
		const tombstone = env.KV.put(`apikey:${hashedKey}`, NEGATIVE_CACHE_VALUE, {
			expirationTtl: API_KEY_NEGATIVE_KV_TTL_SECONDS,
		});
		if (waitUntil) waitUntil(tombstone);
		else await tombstone;
		return null;
	}

	// Carry the Stripe billing period only for active (pro) subs that have it —
	// usage records key on it so the included-allowance window matches the
	// charged window. Free orgs fall back to calendar month downstream.
	const data: KVKeyData = {
		org_id: joined.organizationId,
		key_id: row.id,
		permissions: permissionsArray,
		workspace_scope: workspaceScope,
		principal_type:
			metadata?.principal_type === "dashboard_user"
				? "dashboard_user"
				: "service",
		principal_id:
			metadata?.principal_type === "dashboard_user" &&
			typeof metadata.principal_id === "string"
				? metadata.principal_id
				: null,
		expires_at: row.expiresAt?.toISOString() ?? null,
		plan,
		calls_included: callsIncluded,
		ai_enabled: sub?.aiEnabled ?? false,
		daily_tool_limit: sub?.dailyToolLimit ?? (plan === "pro" ? 10 : 2),
		period_start: billing.usagePeriod?.start.toISOString() ?? null,
		period_end: billing.usagePeriod?.end.toISOString() ?? null,
	};

	const kvWrite = env.KV.put(`apikey:${hashedKey}`, JSON.stringify(data), {
		expirationTtl: kvTtlForKey(row.expiresAt),
	});
	if (waitUntil) waitUntil(kvWrite);
	else await kvWrite;

	return data;
}

/**
 * Dashboard credentials are intentionally user-bound. They receive a live DB
 * membership check even on KV hits, so deleting a user/member cannot leave a
 * stale edge-cache credential authenticating until TTL expiry. Organization-
 * owned service keys retain the normal KV fast path.
 */
async function isLiveDashboardPrincipal(
	env: Env,
	data: KVKeyData,
): Promise<boolean> {
	if (data.principal_type !== "dashboard_user") return true;
	if (!data.principal_id) return false;

	const db = getRequestDb(env);
	const [row] = await db
		.select({ id: apikey.id })
		.from(apikey)
		.innerJoin(
			organization,
			and(
				eq(organization.id, apikey.organizationId),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.innerJoin(
			member,
			and(
				eq(member.userId, apikey.referenceId),
				eq(member.organizationId, apikey.organizationId),
			),
		)
		.where(
			and(
				eq(apikey.id, data.key_id),
				eq(apikey.organizationId, data.org_id),
				eq(apikey.referenceId, data.principal_id),
				eq(apikey.enabled, true),
				sql`${apikey.metadata}->>'principal_type' = 'dashboard_user'`,
			),
		)
		.limit(1);
	return Boolean(row);
}

export const authMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Missing API key" } },
			401,
		);
	}

	const token = authHeader.slice(7);
	const hasValidPrefix = API_KEY_PREFIXES.some((prefix) =>
		token.startsWith(prefix),
	);
	if (!hasValidPrefix) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key format" } },
			401,
		);
	}

	const hashedKey = await hashKey(token);
	const cached = await c.env.KV.get<KVKeyData & { invalid?: boolean }>(
		`apikey:${hashedKey}`,
		"json",
	);

	// Negative cache hit: a prior lookup proved this well-formed key invalid.
	// Reject at the edge without a DB round trip.
	if (cached?.invalid) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}

	let data: KVKeyData | null = cached ?? null;

	if (!data) {
		// Cache miss — rehydrate from DB. This is the path that lets us run
		// with a short KV TTL: passive backstop for permission/enabled changes
		// that bypass the explicit invalidation paths. hydrateApiKey writes a
		// short-lived negative tombstone when the key is invalid.
		data = await hydrateApiKey(c.env, hashedKey, (p) =>
			c.executionCtx.waitUntil(p),
		);
	}

	if (!data) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}

	if (data.expires_at && new Date(data.expires_at) < new Date()) {
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "API key expired" } },
			401,
		);
	}
	const liveWorkspaceScope = parseApiKeyWorkspaceScope({
		workspace_scope: data.workspace_scope,
	});
	if (liveWorkspaceScope === null) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${hashedKey}`));
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key scope" } },
			401,
		);
	}

	if (!(await isLiveDashboardPrincipal(c.env, data))) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${hashedKey}`));
		return c.json(
			{ error: { code: "UNAUTHORIZED", message: "Invalid API key" } },
			401,
		);
	}

	// SECURITY: default to "free" — never grant Pro without explicit proof
	const plan = data.plan ?? "free";
	const callsIncluded = data.calls_included ?? PRICING.freeCallsIncluded;

	c.set("orgId", data.org_id);
	c.set("keyId", data.key_id);
	c.set("permissions", data.permissions);
	c.set("workspaceScope", liveWorkspaceScope);
	c.set("principalType", data.principal_type ?? "service");
	c.set("principalId", data.principal_id ?? null);
	c.set("plan", plan);
	c.set("callsIncluded", callsIncluded);
	c.set("aiEnabled", data.ai_enabled ?? false);
	c.set("dailyToolLimit", data.daily_tool_limit ?? (plan === "pro" ? 10 : 2));
	c.set("periodStart", data.period_start ?? null);
	c.set("periodEnd", data.period_end ?? null);
	return next();
});
