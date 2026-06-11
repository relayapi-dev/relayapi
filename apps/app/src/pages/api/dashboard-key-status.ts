import type { APIRoute } from "astro";
import { apikey } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { clearClientCache } from "@/lib/relay";

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	const org = context.locals.organization as { id?: string } | null;
	const kv = context.locals.kv;
	const db = context.locals.db;

	if (!user || !org?.id || !kv) {
		return Response.json(
			{ error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
			{ status: 401 },
		);
	}

	const rawKey = await kv.get(`dashboard-key:${org.id}`);
	if (!rawKey) {
		return Response.json({ has_api_key: false });
	}

	// Validate against the DB apikey row (exists + enabled), NOT the apikey:* KV
	// auth cache: that cache has a short TTL (10 min) and the API re-hydrates it
	// from the DB on first use, so its absence does not mean the key was revoked.
	// Equating KV-absence with revocation would spuriously delete a valid
	// dashboard key (and show the bootstrap banner) every time the cache lapses.
	const hashedKey = await hashKey(rawKey);
	const [row] = await db
		.select({ enabled: apikey.enabled })
		.from(apikey)
		.where(eq(apikey.key, hashedKey))
		.limit(1);

	if (!row?.enabled) {
		// Genuinely revoked/disabled (or deleted) — clear the stale dashboard key.
		await kv.delete(`dashboard-key:${org.id}`);
		clearClientCache(org.id);
		return Response.json({ has_api_key: false });
	}

	return Response.json({ has_api_key: true });
};
