import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Env } from "../types";

const AVATAR_KEY_PREFIX = "avatars/";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_API_BASE = "https://api.relayapi.dev";

/** R2 object key for an account's re-hosted avatar. */
function avatarKey(accountId: string): string {
	return `${AVATAR_KEY_PREFIX}${accountId}`;
}

/** Stable, never-expiring RelayAPI URL for an account's re-hosted avatar. */
export function avatarPublicUrl(env: Env, accountId: string): string {
	const base = (env.API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
	return `${base}/avatars/${accountId}`;
}

/**
 * Download a platform CDN avatar and re-host it in R2 (MEDIA_BUCKET) under a
 * stable key, returning a permanent RelayAPI URL. Platform CDN URLs (Facebook,
 * Instagram, Threads, …) are signed and expire over time; re-hosting makes the
 * avatar durable and stops the dashboard from hitting third-party CDNs directly.
 *
 * Best-effort: returns null on any failure so callers can fall back to storing
 * the raw CDN URL (never worse than before).
 */
export async function rehostAvatar(
	env: Env,
	accountId: string,
	sourceUrl: string | null | undefined,
): Promise<string | null> {
	if (!sourceUrl) return null;
	try {
		const res = await fetchWithTimeout(sourceUrl, { timeout: FETCH_TIMEOUT_MS });
		if (!res.ok) return null;

		const contentType =
			res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
		if (!contentType.startsWith("image/")) return null;

		const bytes = await res.arrayBuffer();
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) return null;

		await env.MEDIA_BUCKET.put(avatarKey(accountId), bytes, {
			httpMetadata: { contentType },
		});

		return avatarPublicUrl(env, accountId);
	} catch (err) {
		console.warn(`[Avatar] Re-host failed for account ${accountId}:`, err);
		return null;
	}
}

/** Best-effort delete of an account's re-hosted avatar object (on disconnect). */
export async function deleteStoredAvatar(
	env: Env,
	accountId: string,
): Promise<void> {
	try {
		await env.MEDIA_BUCKET.delete(avatarKey(accountId));
	} catch (err) {
		console.warn(`[Avatar] Delete failed for account ${accountId}:`, err);
	}
}
