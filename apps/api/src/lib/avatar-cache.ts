import type { Env } from "../types";
import { getCachedR2Client, RELAY_MEDIA_HOST } from "./r2-presign";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB — profile pictures are small
const AVATAR_FETCH_TIMEOUT_MS = 5_000;

function sanitizeKeySegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/**
 * Download a remote profile picture and store it in the private media bucket so
 * it survives the platform's short-lived signed-CDN expiry (Instagram/Facebook
 * `profile_pic` URLs expire within days). Returns a stable `media.relayapi.dev`
 * URL — which the inbox feed presigns on read — or `null` when caching isn't
 * possible, in which case the caller keeps the raw remote URL as a best effort.
 *
 * Uses a stable key (`avatars/{orgId}/{participantId}`) so a refresh overwrites
 * in place rather than accumulating orphaned objects.
 */
export async function cacheRemoteAvatar(
	env: Env,
	orgId: string,
	participantId: string,
	remoteUrl: string,
): Promise<string | null> {
	// Only cache when we'll be able to presign it back out later (production has
	// the R2 S3 credentials). Otherwise the stored object would be unreachable,
	// so we're better off leaving the caller with the raw URL.
	if (!getCachedR2Client(env)) return null;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AVATAR_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(remoteUrl, { signal: controller.signal });
		if (!res.ok) return null;

		const contentType = res.headers.get("content-type") ?? "image/jpeg";
		if (!contentType.startsWith("image/")) return null;

		const bytes = await res.arrayBuffer();
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) return null;

		const key = `avatars/${sanitizeKeySegment(orgId)}/${sanitizeKeySegment(participantId)}`;
		await env.MEDIA_BUCKET.put(key, bytes, {
			httpMetadata: { contentType },
		});

		return `https://${RELAY_MEDIA_HOST}/${key}`;
	} catch {
		// Network error / abort / R2 failure — keep the raw URL upstream.
		return null;
	} finally {
		clearTimeout(timer);
	}
}
