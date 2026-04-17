import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../types";

export const RELAY_MEDIA_HOST = "media.relayapi.dev";
export const RELAY_R2_BUCKET = "relayapi-media";

const r2ClientCache = new Map<string, S3Client>();

/**
 * KV cache for presigned URLs. AWS SDK v4 signing is HMAC-heavy; on list
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

export function getCachedR2Client(env: Env): S3Client | null {
	const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_ACCOUNT_ID } = env;
	if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !CF_ACCOUNT_ID) {
		return null;
	}

	const cacheKey = `${CF_ACCOUNT_ID}:${R2_ACCESS_KEY_ID}:${R2_SECRET_ACCESS_KEY}`;
	const cached = r2ClientCache.get(cacheKey);
	if (cached) return cached;

	const client = new S3Client({
		region: "auto",
		endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: R2_ACCESS_KEY_ID,
			secretAccessKey: R2_SECRET_ACCESS_KEY,
		},
	});
	r2ClientCache.set(cacheKey, client);
	return client;
}

async function presignWithCache(
	env: Env,
	client: S3Client,
	storageKey: string,
	expiresIn: number,
): Promise<string> {
	const kvKey = presignKvKey(storageKey, expiresIn);
	const cached = await env.KV.get(kvKey, "text");
	if (cached) return cached;

	const presignedUrl = await getSignedUrl(
		client,
		new GetObjectCommand({ Bucket: RELAY_R2_BUCKET, Key: storageKey }),
		{ expiresIn },
	);

	// Fire-and-forget cache write; don't block the response on KV put.
	env.KV.put(kvKey, presignedUrl, {
		expirationTtl: Math.min(PRESIGN_CACHE_TTL_SECONDS, expiresIn - 60),
	}).catch(() => {
		// Cache write failures are non-fatal.
	});

	return presignedUrl;
}

export async function presignRelayMediaUrls<T extends { url: string }>(
	env: Env,
	mediaArr: T[] | null,
	expiresIn: number = 3600,
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
				let presignedUrl = presignedByKey.get(storageKey);
				if (!presignedUrl) {
					presignedUrl = presignWithCache(env, client, storageKey, expiresIn);
					presignedByKey.set(storageKey, presignedUrl);
				}
				return { ...item, url: await presignedUrl } as T;
			} catch {
				return item;
			}
		}),
	);
}
