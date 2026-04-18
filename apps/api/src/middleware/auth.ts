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
 */
export const API_KEY_KV_TTL_SECONDS = 86400; // 24h

/**
 * Compute the actual TTL to use when writing a key to KV — clamps the
 * 24h backstop against the key's own expiry so we never cache past it.
 * KV requires a minimum TTL of 60s.
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
 */
export async function hydrateApiKey(
	env: Env,
	hashedKey: string,
): Promise<KVKeyData | null> {
	const db = getRequestDb(env);

	const [row] = await db
		.select({
			id: apikey.id,
			organizationId: apikey.organizationId,
			enabled: apikey.enabled,
			expiresAt: apikey.expiresAt,
			permissions: apikey.permissions,
			metadata: apikey.metadata,
		})
		.from(apikey)
		.where(eq(apikey.key, hashedKey))
		.limit(1);

	if (!row || row.enabled === false || !row.organizationId) return null;
	if (row.expiresAt && row.expiresAt < new Date()) return null;

	const [sub] = await db
		.select({
			status: organizationSubscriptions.status,
			aiEnabled: organizationSubscriptions.aiEnabled,
			dailyToolLimit: organizationSubscriptions.dailyToolLimit,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, row.organizationId))
		.limit(1);

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

	const data: KVKeyData = {
		org_id: row.organizationId,
		key_id: row.id,
		permissions: permissionsArray,
		workspace_scope: workspaceScope,
		expires_at: row.expiresAt?.toISOString() ?? null,
		plan,
		calls_included: callsIncluded,
		ai_enabled: sub?.aiEnabled ?? false,
		daily_tool_limit: sub?.dailyToolLimit ?? (plan === "pro" ? 10 : 2),
	};

	await env.KV.put(`apikey:${hashedKey}`, JSON.stringify(data), {
		expirationTtl: kvTtlForKey(row.expiresAt),
	});

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
	let data = await c.env.KV.get<KVKeyData>(`apikey:${hashedKey}`, "json");

	if (!data) {
		// Cache miss — rehydrate from DB. This is the path that lets us run
		// with a short KV TTL: passive backstop for permission/enabled changes
		// that bypass the explicit invalidation paths.
		data = await hydrateApiKey(c.env, hashedKey);
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
	return next();
});
