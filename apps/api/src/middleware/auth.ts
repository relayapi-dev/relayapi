import { createMiddleware } from "hono/factory";
import { apikey, organizationSubscriptions } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { getRequestDb } from "../lib/request-db";
import type { Env, KVKeyData, Variables } from "../types";
import { PRICING } from "../types";

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
export const API_KEY_KV_TTL_SECONDS = 600; // 10m

/**
 * KV TTL for the negative (tombstone) cache entry written when a
 * well-formed-but-invalid key is looked up. Bounds how long a revoked/
 * unknown key keeps short-circuiting at the edge without a DB round trip.
 * KV enforces a 60s minimum TTL.
 */
export const API_KEY_NEGATIVE_KV_TTL_SECONDS = 300; // 5m

/** Sentinel stored in KV to mark a well-formed key as known-invalid. */
const NEGATIVE_CACHE_VALUE = '{"invalid":true}';

/**
 * Compute the actual TTL to use when writing a key to KV — clamps the
 * backstop window (API_KEY_KV_TTL_SECONDS) against the key's own expiry
 * so we never cache past it. KV requires a minimum TTL of 60s.
 */
export function kvTtlForKey(expiresAt: Date | string | null): number {
	if (!expiresAt) return API_KEY_KV_TTL_SECONDS;
	const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
	const secondsUntilExpiry = Math.floor((expiry.getTime() - Date.now()) / 1000);
	return Math.max(60, Math.min(API_KEY_KV_TTL_SECONDS, secondsUntilExpiry));
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
			subStatus: organizationSubscriptions.status,
			subAiEnabled: organizationSubscriptions.aiEnabled,
			subDailyToolLimit: organizationSubscriptions.dailyToolLimit,
			subPeriodStart: organizationSubscriptions.currentPeriodStart,
			subPeriodEnd: organizationSubscriptions.currentPeriodEnd,
		})
		.from(apikey)
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
		(joined.expiresAt && joined.expiresAt < new Date())
	) {
		// Negative cache: write a short-lived tombstone so a misconfigured
		// client or an attacker replaying one revoked/unknown key doesn't
		// turn every request into a blocking origin DB round trip. Key
		// creation/re-enable overwrites `apikey:<hash>` with the real record,
		// so a newly valid key is never blocked by a stale tombstone.
		const tombstone = env.KV.put(
			`apikey:${hashedKey}`,
			NEGATIVE_CACHE_VALUE,
			{ expirationTtl: API_KEY_NEGATIVE_KV_TTL_SECONDS },
		);
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

	const plan: "free" | "pro" = sub?.status === "active" ? "pro" : "free";
	const callsIncluded =
		plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;

	const permissionsArray = (row.permissions ?? "read,write")
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
	const workspaceScope =
		(metadata?.workspace_scope as "all" | string[] | undefined) ?? "all";

	// Carry the Stripe billing period only for active (pro) subs that have it —
	// usage records key on it so the included-allowance window matches the
	// charged window. Free orgs fall back to calendar month downstream.
	const hasStripePeriod =
		plan === "pro" && joined.subPeriodStart && joined.subPeriodEnd;

	const data: KVKeyData = {
		org_id: joined.organizationId,
		key_id: row.id,
		permissions: permissionsArray,
		workspace_scope: workspaceScope,
		expires_at: row.expiresAt?.toISOString() ?? null,
		plan,
		calls_included: callsIncluded,
		ai_enabled: sub?.aiEnabled ?? false,
		daily_tool_limit: sub?.dailyToolLimit ?? (plan === "pro" ? 10 : 2),
		period_start: hasStripePeriod ? joined.subPeriodStart!.toISOString() : null,
		period_end: hasStripePeriod ? joined.subPeriodEnd!.toISOString() : null,
	};

	const kvWrite = env.KV.put(`apikey:${hashedKey}`, JSON.stringify(data), {
		expirationTtl: kvTtlForKey(row.expiresAt),
	});
	if (waitUntil) waitUntil(kvWrite);
	else await kvWrite;

	return data;
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

	// SECURITY: default to "free" — never grant Pro without explicit proof
	const plan = data.plan ?? "free";
	const callsIncluded = data.calls_included ?? PRICING.freeCallsIncluded;

	c.set("orgId", data.org_id);
	c.set("keyId", data.key_id);
	c.set("permissions", data.permissions);
	c.set("workspaceScope", data.workspace_scope ?? "all");
	c.set("plan", plan);
	c.set("callsIncluded", callsIncluded);
	c.set("aiEnabled", data.ai_enabled ?? false);
	c.set("dailyToolLimit", data.daily_tool_limit ?? (plan === "pro" ? 10 : 2));
	c.set("periodStart", data.period_start ?? null);
	c.set("periodEnd", data.period_end ?? null);
	return next();
});
