import { AwsClient } from "aws4fetch";
import type { Env } from "../types";

export const RELAY_MEDIA_HOST = "media.relayapi.dev";
export const RELAY_R2_BUCKET = "relayapi-media";

/**
 * R2 presigning uses SigV4 query-string signatures. We use aws4fetch — a tiny
 * (~5KB) Workers-native signer built on crypto.subtle — instead of the AWS SDK
 * v3 S3 client + s3-request-presigner, which statically bundled ~hundreds of KB
 * into the worker entry and inflated cold-start parse time for every route.
 */
const r2ClientCache = new Map<string, AwsClient>();

/**
 * KV cache for presigned URLs. SigV4 signing is HMAC-heavy; on list
 * endpoints with ~100 posts × multiple media items, we'd run hundreds of
 * HMACs per request. Caching by storage key for less than the presign
 * lifetime lets most list requests skip signing entirely.
 *
 * TTL is 50 min so the cached URL always has at least 10 min of validity
 * when handed to a client (presign lifetime is 3600s).
 */
const PRESIGN_CACHE_TTL_SECONDS = 50 * 60;

function presignKvKey(storageKey: string, expiresIn: number): string {
	return `r2-presign:${expiresIn}:${storageKey}`;
}

/**
 * Purge any cached presigned GET URL for a storage key so callers stop receiving
 * a URL that now 404s (e.g. after the object is deleted). Best-effort; failures
 * are non-fatal. `expiresIn` must match the value used when the URL was cached.
 */
export async function purgePresignedViewCache(
	env: Env,
	storageKey: string,
	expiresIn: number = 3600,
): Promise<void> {
	if (!env.KV) return;
	await env.KV.delete(presignKvKey(storageKey, expiresIn)).catch(() => {
		// Non-fatal: the cached URL expires within the TTL regardless.
	});
}

export function getCachedR2Client(env: Env): AwsClient | null {
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID } = env;
	if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !CF_ACCOUNT_ID) {
		return null;
	}

	const cacheKey = `${CF_ACCOUNT_ID}:${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}`;
	const cached = r2ClientCache.get(cacheKey);
	if (cached) return cached;

	const client = new AwsClient({
		accessKeyId: R2_ACCESS_KEY_ID,
		secretAccessKey: R2_SECRET_ACCESS_KEY,
		service: "s3",
		region: "auto",
	});
	r2ClientCache.set(cacheKey, client);
	return client;
}

function r2ObjectUrl(env: Env, storageKey: string): string {
	// Storage keys may contain "/", spaces, etc. Encode each path segment so the
	// URL is well-formed; aws4fetch signs the canonical request from this URL.
	const encodedKey = storageKey
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${RELAY_R2_BUCKET}/${encodedKey}`;
}

/**
 * Generate a SigV4 query-presigned URL for an R2 object using the given method.
 * GET → view URL; PUT → upload URL. For PUT presigns the Content-Type can be
 * pinned into the signature by passing it (the client must then send the same
 * Content-Type header on upload).
 */
export async function presignR2Url(
	env: Env,
	client: AwsClient,
	storageKey: string,
	method: "GET" | "PUT",
	expiresIn: number,
	contentType?: string,
): Promise<string> {
	const url = new URL(r2ObjectUrl(env, storageKey));
	url.searchParams.set("X-Amz-Expires", String(expiresIn));

	const headers: Record<string, string> = {};
	const pinContentType = method === "PUT" && !!contentType;
	if (pinContentType && contentType) {
		headers["content-type"] = contentType;
	}

	const signed = await client.sign(url.toString(), {
		method,
		headers,
		// content-type is in aws4fetch's UNSIGNABLE_HEADERS, so allHeaders is
		// required to pin it into the PUT signature — matching the prior AWS SDK
		// PutObjectCommand({ ContentType }) behavior. The client must then send
		// the same Content-Type header when uploading to the presigned URL.
		aws: { signQuery: true, allHeaders: pinContentType },
	});
	return signed.url;
}

/**
 * Generate a presigned GET (view) URL, served from the KV cache when warm.
 * Use this for any read path that signs the same storage key repeatedly.
 */
export async function presignViewUrlWithCache(
	env: Env,
	client: AwsClient,
	storageKey: string,
	expiresIn: number,
): Promise<string> {
	const kvKey = presignKvKey(storageKey, expiresIn);

	// KV is optional: when the binding is absent (e.g. unit tests, misconfig),
	// fall back to signing directly so view URLs still resolve.
	const kv = env.KV;
	if (kv) {
		const cached = await kv.get(kvKey, "text").catch(() => null);
		if (cached) return cached;
	}

	const presignedUrl = await presignR2Url(env, client, storageKey, "GET", expiresIn);

	if (kv) {
		// Fire-and-forget cache write; don't block the response on KV put.
		kv.put(kvKey, presignedUrl, {
			expirationTtl: Math.min(PRESIGN_CACHE_TTL_SECONDS, expiresIn - 60),
		}).catch(() => {
			// Cache write failures are non-fatal.
		});
	}

	return presignedUrl;
}

export async function presignRelayMediaUrls<T extends { url: string }>(
	env: Env,
	mediaArr: T[] | null,
	expiresIn: number = 3600,
	orgId: string | null = null,
): Promise<T[] | null> {
	if (!mediaArr || mediaArr.length === 0) return mediaArr;

	const client = getCachedR2Client(env);
	if (!client) return mediaArr;
	if (!mediaArr.some((item) => item.url.includes(RELAY_MEDIA_HOST))) return mediaArr;

	// Dedup presign work within this call — the same storage key appearing on
	// multiple items only gets signed once even if the KV cache misses.
	const presignedByKey = new Map<string, Promise<string>>();

	return Promise.all(
		mediaArr.map(async (item) => {
			if (!item.url.includes(RELAY_MEDIA_HOST)) return item;

			try {
				const urlObj = new URL(item.url);
				const storageKey = decodeURIComponent(urlObj.pathname.slice(1));

				// SECURITY: When an orgId is supplied, only sign storage keys that
				// belong to that org. Post media URLs are arbitrary client input;
				// without this guard, presignRelayMediaUrls would sign a GET for any
				// key learned from another org (cross-org R2 read oracle), mirroring
				// the guard in confirmMedia. Internal callers that pass no orgId keep
				// the previous unguarded behavior.
				if (orgId !== null && !storageKey.startsWith(`${orgId}/`)) {
					return item;
				}

				let presignedUrl = presignedByKey.get(storageKey);
				if (!presignedUrl) {
					presignedUrl = presignViewUrlWithCache(env, client, storageKey, expiresIn);
					presignedByKey.set(storageKey, presignedUrl);
				}
				return { ...item, url: await presignedUrl } as T;
			} catch {
				return item;
			}
		}),
	);
}
