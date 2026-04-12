import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../types";

export const RELAY_MEDIA_HOST = "media.relayapi.dev";
export const RELAY_R2_BUCKET = "relayapi-media";

const r2ClientCache = new Map<string, S3Client>();

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

export async function presignRelayMediaUrls<T extends { url: string }>(
	env: Env,
	mediaArr: T[] | null,
	expiresIn: number = 3600,
): Promise<T[] | null> {
	if (!mediaArr || mediaArr.length === 0) return mediaArr;

	const client = getCachedR2Client(env);
	if (!client) return mediaArr;
	if (!mediaArr.some((item) => item.url.includes(RELAY_MEDIA_HOST))) return mediaArr;

	const presignedByKey = new Map<string, Promise<string>>();

	return Promise.all(
		mediaArr.map(async (item) => {
			if (!item.url.includes(RELAY_MEDIA_HOST)) return item;

			try {
				const urlObj = new URL(item.url);
				const storageKey = decodeURIComponent(urlObj.pathname.slice(1));
				let presignedUrl = presignedByKey.get(storageKey);
				if (!presignedUrl) {
					presignedUrl = getSignedUrl(
						client,
						new GetObjectCommand({ Bucket: RELAY_R2_BUCKET, Key: storageKey }),
						{ expiresIn },
					);
					presignedByKey.set(storageKey, presignedUrl);
				}
				return { ...item, url: await presignedUrl } as T;
			} catch {
				return item;
			}
		}),
	);
}
