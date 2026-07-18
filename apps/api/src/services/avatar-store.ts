import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Env } from "../types";

const AVATAR_KEY_PREFIX = "avatars/";
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_API_BASE = "https://api.relayapi.dev";

/** R2 object key for a re-hosted avatar. */
function avatarKey(accountId: string): string {
	return `${AVATAR_KEY_PREFIX}${accountId}`;
}

/** Stable, never-expiring RelayAPI URL for an account's re-hosted avatar. */
export function avatarPublicUrl(env: Env, accountId: string): string {
	const base = (env.API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
	return `${base}/avatars/${accountId}`;
}

/**
 * Download an avatar and re-host it in the provided R2 bucket under a stable
 * key, returning a RelayAPI URL. The caller chooses the storage lifecycle.
 *
 * Best-effort: returns null on any failure so callers can fall back to storing
 * the raw CDN URL (never worse than before).
 */
async function rehostAvatarInBucket(
	env: Env,
	bucket: R2Bucket,
	accountId: string,
	sourceUrl: string | null | undefined,
): Promise<string | null> {
	if (!sourceUrl) return null;
	try {
		const res = await fetchWithTimeout(sourceUrl, {
			timeout: FETCH_TIMEOUT_MS,
		});
		if (!res.ok) return null;

		const contentType =
			res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
		if (!contentType.startsWith("image/")) return null;

		const bytes = await res.arrayBuffer();
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES)
			return null;

		await bucket.put(avatarKey(accountId), bytes, {
			httpMetadata: { contentType },
		});

		return avatarPublicUrl(env, accountId);
	} catch (err) {
		console.warn(`[Avatar] Re-host failed for account ${accountId}:`, err);
		return null;
	}
}

/**
 * Re-host a social-account avatar in the durable, non-expiring avatar bucket.
 * Platform CDN URLs are commonly signed and short-lived, so the database stores
 * the stable RelayAPI URL returned here instead.
 */
export async function rehostAvatar(
	env: Env,
	accountId: string,
	sourceUrl: string | null | undefined,
): Promise<string | null> {
	return rehostAvatarInBucket(env, env.AVATAR_BUCKET, accountId, sourceUrl);
}

/**
 * Re-host a transient inbox participant avatar in MEDIA_BUCKET. These objects
 * intentionally retain the media bucket's finite lifecycle.
 */
export async function rehostTransientAvatar(
	env: Env,
	avatarId: string,
	sourceUrl: string | null | undefined,
): Promise<string | null> {
	return rehostAvatarInBucket(env, env.MEDIA_BUCKET, avatarId, sourceUrl);
}

/** True only when the durable account-avatar object currently exists. */
export async function hasStoredAvatar(
	env: Env,
	accountId: string,
): Promise<boolean> {
	try {
		return (await env.AVATAR_BUCKET.head(avatarKey(accountId))) !== null;
	} catch (err) {
		console.warn(`[Avatar] Head failed for account ${accountId}:`, err);
		return false;
	}
}

/** Best-effort delete of durable and legacy account-avatar objects. */
export async function deleteStoredAvatar(
	env: Env,
	accountId: string,
): Promise<void> {
	try {
		const key = avatarKey(accountId);
		await Promise.all([
			env.AVATAR_BUCKET.delete(key),
			env.MEDIA_BUCKET.delete(key),
		]);
	} catch (err) {
		console.warn(`[Avatar] Delete failed for account ${accountId}:`, err);
	}
}
