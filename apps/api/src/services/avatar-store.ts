import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Env } from "../types";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_API_BASE = "https://api.relayapi.dev";

/** Durable, independently purgeable R2 object key for a social account. */
export function accountAvatarKey(accountId: string): string {
	return `account/${encodeURIComponent(accountId)}/avatar`;
}

export function conversationAvatarKey(
	organizationId: string,
	workspaceId: string | null | undefined,
	conversationId: string,
): string {
	const scope = workspaceId
		? `workspaces/${encodeURIComponent(workspaceId)}`
		: "organization";
	return `${encodeURIComponent(organizationId)}/${scope}/conversations/${encodeURIComponent(conversationId)}/avatar`;
}

/** Stable, never-expiring RelayAPI URL for an account's re-hosted avatar. */
export function avatarPublicUrl(env: Env, accountId: string): string {
	const base = (env.API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
	return `${base}/avatars/${accountId}`;
}

export function conversationAvatarPublicUrl(
	env: Env,
	organizationId: string,
	workspaceId: string | null | undefined,
	conversationId: string,
): string {
	const base = (env.API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");
	const scope = workspaceId
		? `workspace-${encodeURIComponent(workspaceId)}`
		: "organization";
	return `${base}/avatars/conversations/${encodeURIComponent(organizationId)}/${scope}/${encodeURIComponent(conversationId)}`;
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
	objectKey: string,
	publicUrl: string,
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

		await bucket.put(objectKey, bytes, {
			httpMetadata: { contentType },
		});

		return publicUrl;
	} catch {
		console.warn("[Avatar] Re-host failed");
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
	return rehostAvatarInBucket(
		env,
		env.AVATAR_BUCKET,
		accountAvatarKey(accountId),
		avatarPublicUrl(env, accountId),
		sourceUrl,
	);
}

/**
 * Re-host a transient inbox participant avatar in MEDIA_BUCKET. These objects
 * intentionally retain the media bucket's finite lifecycle.
 */
export async function rehostTransientAvatar(
	env: Env,
	organizationId: string,
	workspaceId: string | null | undefined,
	conversationId: string,
	sourceUrl: string | null | undefined,
): Promise<string | null> {
	return rehostAvatarInBucket(
		env,
		env.MEDIA_BUCKET,
		conversationAvatarKey(organizationId, workspaceId, conversationId),
		conversationAvatarPublicUrl(
			env,
			organizationId,
			workspaceId,
			conversationId,
		),
		sourceUrl,
	);
}

/** True only when the durable account-avatar object currently exists. */
export async function hasStoredAvatar(
	env: Env,
	accountId: string,
): Promise<boolean> {
	try {
		return (await env.AVATAR_BUCKET.head(accountAvatarKey(accountId))) !== null;
	} catch (err) {
		console.warn(`[Avatar] Head failed for account ${accountId}:`, err);
		return false;
	}
}

/** Best-effort delete of the durable account-avatar object. */
export async function deleteStoredAvatar(
	env: Env,
	accountId: string,
): Promise<void> {
	try {
		await env.AVATAR_BUCKET.delete(accountAvatarKey(accountId));
	} catch (err) {
		console.warn(`[Avatar] Delete failed for account ${accountId}:`, err);
	}
}
