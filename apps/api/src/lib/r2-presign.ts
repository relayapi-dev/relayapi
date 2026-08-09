import type { Database } from "@relayapi/db";
import { AwsClient } from "aws4fetch";
import {
	headStoredObject,
	presignStoredObject,
	storageLocatorForMedia,
} from "../services/storage-locator";
import type { Env } from "../types";
import { mediaPublicHost } from "./deployment-mode";
import { validateStoredMediaObject } from "./media-storage-policy";
import {
	loadRelayMediaPolicy,
	type RelayMediaPolicy,
	RelayMediaPolicyError,
	relayMediaReferenceFromUrl,
} from "./relay-media-policy";

export { RELAY_MEDIA_HOST } from "./relay-media-policy";
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

function presignKvKey(
	storageKey: string,
	expiresIn: number,
	bucket = "",
): string {
	// The bucket is part of the signed URL, so it has to be part of the key —
	// otherwise an entry signed for one bucket could be served for another.
	return `r2-presign:${expiresIn}:${bucket}:${storageKey}`;
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
	/**
	 * The bucket the row was persisted to. Entries are keyed by the bucket that
	 * was signed, so passing the row's own `storageBucketLocator` is required for
	 * the delete to hit — the deployment default is only correct for a row that
	 * lives in the current default bucket.
	 */
	bucket: string = mediaBucketLocation(env).bucket,
): Promise<void> {
	if (!env.KV) return;
	await env.KV.delete(presignKvKey(storageKey, expiresIn, bucket)).catch(() => {
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

/**
 * Where an R2 object actually lives. Defaults to this deployment's configured
 * media bucket rather than a hardcoded name — a self-hosted instance provisions
 * its own bucket, and signing against the managed one would 404 every URL.
 */
export interface R2ObjectLocation {
	bucket: string;
	region: "default" | "eu";
}

function mediaBucketLocation(env: Env): R2ObjectLocation {
	return {
		bucket: env.R2_MEDIA_BUCKET_NAME || RELAY_R2_BUCKET,
		region: env.R2_MEDIA_BUCKET_JURISDICTION || "default",
	};
}

function r2ObjectUrl(
	env: Env,
	location: R2ObjectLocation,
	storageKey: string,
): string {
	// Storage keys may contain "/", spaces, etc. Encode each path segment so the
	// URL is well-formed; aws4fetch signs the canonical request from this URL.
	const encodedKey = storageKey
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	// EU-jurisdiction buckets are only reachable on the eu S3 endpoint.
	const host =
		location.region === "eu"
			? `${env.CF_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`
			: `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	return `https://${host}/${location.bucket}/${encodedKey}`;
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
	location: R2ObjectLocation = mediaBucketLocation(env),
): Promise<string> {
	const url = new URL(r2ObjectUrl(env, location, storageKey));
	url.searchParams.set("X-Amz-Expires", String(expiresIn));

	const headers: Record<string, string> = {};
	const pinContentType = method === "PUT" && !!contentType;
	if (pinContentType && contentType) {
		headers["content-type"] = contentType;
		// A presigned PUT URL remains reusable until expiry. Require object
		// creation so it cannot overwrite bytes after confirmation.
		headers["if-none-match"] = "*";
	}

	const signed = await client.sign(url.toString(), {
		method,
		headers,
		// content-type is in aws4fetch's UNSIGNABLE_HEADERS, so allHeaders is
		// required to pin it together with the create-only precondition. The
		// client must send both headers exactly as returned by the API.
		aws: { signQuery: true, allHeaders: pinContentType },
	});
	return signed.url;
}

/**
 * Generate a presigned GET (view) URL, served from the KV cache when warm.
 * Use this for any read path that signs the same storage key repeatedly.
 */
async function presignViewUrlWithCache(
	env: Env,
	client: AwsClient,
	storageKey: string,
	expiresIn: number,
	location: R2ObjectLocation = mediaBucketLocation(env),
): Promise<string> {
	const kvKey = presignKvKey(storageKey, expiresIn, location.bucket);

	// KV is optional: when the binding is absent (e.g. unit tests, misconfig),
	// fall back to signing directly so view URLs still resolve.
	const kv = env.KV;
	if (kv) {
		const cached = await kv.get(kvKey, "text").catch(() => null);
		if (cached) return cached;
	}

	const presignedUrl = await presignR2Url(
		env,
		client,
		storageKey,
		"GET",
		expiresIn,
		undefined,
		location,
	);

	if (kv) {
		// Fire-and-forget cache write; don't block the response on KV put.
		void kv
			.put(kvKey, presignedUrl, {
				expirationTtl: Math.min(PRESIGN_CACHE_TTL_SECONDS, expiresIn - 60),
			})
			.catch(() => {
				// Cache write failures are non-fatal.
			});
	}

	return presignedUrl;
}

export class RelayMediaSigningUnavailableError extends Error {
	constructor() {
		super("Relay media GET signing is not configured");
		this.name = "RelayMediaSigningUnavailableError";
	}
}

async function presignRelayMediaValue<T>(
	db: Database,
	env: Env,
	value: T,
	expiresIn: number,
	organizationId: string,
	rejectInvalid: boolean,
	preloadedPolicy?: RelayMediaPolicy,
): Promise<T> {
	const policy =
		preloadedPolicy ??
		(await loadRelayMediaPolicy(
			db,
			organizationId,
			value,
			mediaPublicHost(env),
		));
	const violation = policy.violationFor(value);
	if (violation && rejectInvalid) throw new RelayMediaPolicyError(violation);
	if (policy.references.length === 0) return value;
	if (rejectInvalid) {
		const referencesByKey = new Map(
			policy.references.flatMap((reference) =>
				reference.storageKey
					? [[reference.storageKey, reference] as const]
					: [],
			),
		);
		const references = [...referencesByKey.entries()];
		// Keep R2 metadata checks bounded while avoiding one serial network roundtrip
		// per attachment. Every key is checked immediately before GET signing.
		for (let offset = 0; offset < references.length; offset += 6) {
			await Promise.all(
				references
					.slice(offset, offset + 6)
					.map(async ([storageKey, reference]) => {
						const expected = policy.readyMediaByStorageKey.get(storageKey);
						if (!expected) return;
						const locator = storageLocatorForMedia({
							organizationId,
							storageProvider: expected.storageProvider,
							storageBucketLocator: expected.storageBucketLocator,
							storageRegion: expected.storageRegion,
							storageLocationId: expected.storageLocationId,
							storageCredentialVersion:
								expected.storageCredentialVersion,
							storageKey,
						});
						const object = await headStoredObject(db, env, locator);
						if (!object) {
							throw new RelayMediaPolicyError({
								url: reference.url,
								storageKey,
								reason: "not_ready_or_not_owned",
							});
						}
						const actual = validateStoredMediaObject({
							size: object.size,
							httpMetadata: {
								contentType: object.contentType ?? undefined,
							},
						});
						if (!actual.ok) {
							throw new RelayMediaPolicyError({
								url: reference.url,
								storageKey,
								reason: "stored_object_invalid",
							});
						}
						if (
							actual.size !== expected.size ||
							actual.mimeType !== expected.mimeType
						) {
							throw new RelayMediaPolicyError({
								url: reference.url,
								storageKey,
								reason: "stored_object_drift",
							});
						}
					}),
			);
		}
	}

	const client = getCachedR2Client(env);
	const hasReadyR2Reference = policy.references.some((reference) => {
		if (!reference.storageKey) return false;
		return (
			policy.readyMediaByStorageKey.get(reference.storageKey)
				?.storageProvider === "r2"
		);
	});
	if (!client && rejectInvalid && hasReadyR2Reference) {
		throw new RelayMediaSigningUnavailableError();
	}

	const presignedByKey = new Map<string, Promise<string>>();
	const presignKey = (storageKey: string): Promise<string> => {
		let result = presignedByKey.get(storageKey);
		if (!result) {
			const row = policy.readyMediaByStorageKey.get(storageKey);
			if (!row) return Promise.resolve(storageKey);
			const locator = storageLocatorForMedia({
				organizationId,
				storageProvider: row.storageProvider,
				storageBucketLocator: row.storageBucketLocator,
				storageRegion: row.storageRegion,
				storageLocationId: row.storageLocationId,
				storageCredentialVersion: row.storageCredentialVersion,
				storageKey,
			});
			result =
				locator.provider === "byos"
					? presignStoredObject(
							db,
							env,
							locator,
							"GET",
							expiresIn,
						)
					: client
						? // Sign against the bucket the row was actually written to,
							// not this deployment's default — they differ on self-host.
							presignViewUrlWithCache(env, client, storageKey, expiresIn, {
								bucket: locator.bucket,
								region: locator.region,
							})
						: Promise.resolve(
								`https://${mediaPublicHost(env)}/${storageKey}`,
							);
			presignedByKey.set(storageKey, result);
		}
		return result;
	};

	const transform = async (candidate: unknown): Promise<unknown> => {
		if (typeof candidate === "string") {
			const reference = relayMediaReferenceFromUrl(
				candidate,
				mediaPublicHost(env),
			);
			if (
				reference?.storageKey &&
				policy.readyStorageKeys.has(reference.storageKey)
			) {
				return presignKey(reference.storageKey);
			}
			return candidate;
		}
		if (Array.isArray(candidate)) {
			return Promise.all(candidate.map((item) => transform(item)));
		}
		if (!candidate || typeof candidate !== "object") return candidate;
		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) return candidate;
		const entries = await Promise.all(
			Object.entries(candidate as Record<string, unknown>).map(
				async ([key, item]) => [key, await transform(item)] as const,
			),
		);
		return Object.fromEntries(entries);
	};

	return (await transform(value)) as T;
}

export async function presignRelayMediaUrls<T extends { url: string | null }>(
	db: Database,
	env: Env,
	mediaArr: T[] | null,
	expiresIn: number,
	organizationId: string,
	preloadedPolicy?: RelayMediaPolicy,
): Promise<T[] | null> {
	if (!mediaArr || mediaArr.length === 0) return mediaArr;
	return presignRelayMediaValue(
		db,
		env,
		mediaArr,
		expiresIn,
		organizationId,
		false,
		preloadedPolicy,
	);
}

/**
 * Final provider-boundary fence. It rejects any Relay URL that is malformed,
 * cross-tenant, pending, deleted, oversized, or tied to a disallowed MIME row,
 * then replaces every accepted Relay URL (including nested target options) with
 * a short-lived R2 GET URL. External HTTP(S) URLs are preserved unchanged.
 */
export async function resolveRelayMediaForPublish<T>(
	db: Database,
	env: Env,
	value: T,
	organizationId: string,
	expiresIn: number = 3600,
): Promise<T> {
	return presignRelayMediaValue(
		db,
		env,
		value,
		expiresIn,
		organizationId,
		true,
	);
}
