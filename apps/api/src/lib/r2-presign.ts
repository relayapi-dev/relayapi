import {
	type Database,
	media,
	mediaDerivatives,
	mediaProcessingJobs,
} from "@relayapi/db";
import { AwsClient } from "aws4fetch";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
	headStoredObject,
	presignStoredObject,
	storageLocatorForMedia,
} from "../services/storage-locator";
import type { Env } from "../types";
import { mediaPublicHost } from "./deployment-mode";
import {
	AUTOMATIC_MEDIA_PROFILE,
	validateStoredMediaObject,
} from "./media-storage-policy";
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

export function mediaBucketLocation(env: Env): R2ObjectLocation {
	return {
		bucket: env.R2_MEDIA_BUCKET_NAME || RELAY_R2_BUCKET,
		region: env.R2_MEDIA_BUCKET_JURISDICTION || "default",
	};
}

export function r2ObjectUrl(
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
 * Sign one UploadPart request for a multipart upload created through the R2
 * binding. The upload id and part number are part of the SigV4 canonical query;
 * callers may renew an expired URL without creating a second upload.
 */
export async function presignR2MultipartPartUrl(
	env: Env,
	client: AwsClient,
	storageKey: string,
	uploadId: string,
	partNumber: number,
	expiresIn: number,
	location: R2ObjectLocation = mediaBucketLocation(env),
): Promise<string> {
	if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
		throw new RangeError("Multipart part number must be between 1 and 10000");
	}
	if (!uploadId) throw new Error("Multipart upload id is required");

	const url = new URL(r2ObjectUrl(env, location, storageKey));
	url.searchParams.set("partNumber", String(partNumber));
	url.searchParams.set("uploadId", uploadId);
	url.searchParams.set("X-Amz-Expires", String(expiresIn));
	const signed = await client.sign(url.toString(), {
		method: "PUT",
		aws: { signQuery: true },
	});
	return signed.url;
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

function relayObjectUrl(env: Env, storageKey: string): string {
	const encodedKey = storageKey
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `https://${mediaPublicHost(env)}/${encodedKey}`;
}

function coverSelectorPolicyError(selector: string): RelayMediaPolicyError {
	return new RelayMediaPolicyError({
		url: selector,
		storageKey: null,
		reason: "not_ready_or_not_owned",
	});
}

/**
 * Resolve Relay-owned Instagram cover selectors at the last provider boundary.
 * The fresh URL exists only in this in-memory payload; persisted target options
 * retain the stable med_/mder_ selector and never a bearer-style presign.
 */
async function resolveInstagramCoverSelectors<T>(
	db: Database,
	env: Env,
	value: T,
	organizationId: string,
	expiresIn: number,
	rootWorkspaceId?: string | null,
): Promise<T> {
	const now = new Date();
	const resolve = async (candidate: unknown): Promise<unknown> => {
		if (Array.isArray(candidate)) {
			return Promise.all(candidate.map((item) => resolve(item)));
		}
		if (!candidate || typeof candidate !== "object") return candidate;
		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) return candidate;

		const record = { ...(candidate as Record<string, unknown>) };
		const coverMediaId =
			typeof record.cover_media_id === "string" ? record.cover_media_id : null;
		const coverVariantId =
			typeof record.cover_variant_id === "string"
				? record.cover_variant_id
				: null;
		if (coverMediaId || coverVariantId) {
			const selectedCount = [
				coverMediaId,
				coverVariantId,
				typeof record.cover_url === "string" ? record.cover_url : null,
				record.thumb_offset !== undefined ? "thumb_offset" : null,
			].filter(Boolean).length;
			if (selectedCount !== 1) {
				throw coverSelectorPolicyError(
					coverMediaId ?? coverVariantId ?? "cover",
				);
			}

			if (coverMediaId) {
				const workspaceCondition =
					rootWorkspaceId === undefined
						? undefined
						: rootWorkspaceId === null
							? isNull(media.workspaceId)
							: or(
									isNull(media.workspaceId),
									eq(media.workspaceId, rootWorkspaceId),
								);
				const [source] = await db
					.select({ storageKey: media.storageKey, mimeType: media.mimeType })
					.from(media)
					.where(
						and(
							eq(media.id, coverMediaId),
							eq(media.organizationId, organizationId),
							workspaceCondition,
							eq(media.status, "ready"),
							isNull(media.deletionRequestedAt),
							isNull(media.originalDeletedAt),
							isNotNull(media.url),
						),
					)
					.limit(1);
				if (!source?.mimeType.startsWith("image/")) {
					throw coverSelectorPolicyError(coverMediaId);
				}
				record.cover_url = relayObjectUrl(env, source.storageKey);
				delete record.cover_media_id;
			}

			if (coverVariantId) {
				const workspaceCondition =
					rootWorkspaceId === undefined
						? undefined
						: rootWorkspaceId === null
							? isNull(media.workspaceId)
							: or(
									isNull(media.workspaceId),
									eq(media.workspaceId, rootWorkspaceId),
								);
				const [variant] = await db
					.select({
						storageKey: mediaDerivatives.storageKey,
						mimeType: mediaDerivatives.mimeType,
						size: mediaDerivatives.size,
					})
					.from(mediaDerivatives)
					.innerJoin(
						media,
						and(
							eq(media.id, mediaDerivatives.mediaId),
							eq(media.organizationId, mediaDerivatives.organizationId),
						),
					)
					.where(
						and(
							eq(mediaDerivatives.id, coverVariantId),
							eq(mediaDerivatives.organizationId, organizationId),
							workspaceCondition,
							eq(mediaDerivatives.kind, "cover"),
							eq(mediaDerivatives.status, "ready"),
							gt(mediaDerivatives.deleteAfter, now),
							eq(media.status, "ready"),
							isNull(media.deletionRequestedAt),
						),
					)
					.limit(1);
				if (!variant?.mimeType.startsWith("image/")) {
					throw coverSelectorPolicyError(coverVariantId);
				}
				const object = await env.MEDIA_BUCKET.head(variant.storageKey);
				const validated = object
					? validateStoredMediaObject({
							size: object.size,
							httpMetadata: object.httpMetadata,
						})
					: null;
				if (
					!validated?.ok ||
					validated.size !== variant.size ||
					validated.mimeType !== variant.mimeType
				) {
					throw coverSelectorPolicyError(coverVariantId);
				}
				const client = getCachedR2Client(env);
				if (!client) throw new RelayMediaSigningUnavailableError();
				record.cover_url = await presignViewUrlWithCache(
					env,
					client,
					variant.storageKey,
					expiresIn,
					mediaBucketLocation(env),
				);
				delete record.cover_variant_id;
			}
		}

		const entries = await Promise.all(
			Object.entries(record).map(
				async ([key, item]) => [key, await resolve(item)] as const,
			),
		);
		return Object.fromEntries(entries);
	};

	return (await resolve(value)) as T;
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
	const sourceEtags = new Map<string, string>();
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
							storageCredentialVersion: expected.storageCredentialVersion,
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
						if (object.etag) sourceEtags.set(storageKey, object.etag);
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

	const preferredDerivativeByStorageKey = new Map<
		string,
		{ storageKey: string; mimeType: string; size: number }
	>();
	if (rejectInvalid && policy.readyMediaByStorageKey.size > 0) {
		const sourceById = new Map(
			[...policy.readyMediaByStorageKey.values()].map((row) => [row.id, row]),
		);
		const derivatives = await db
			.select({
				mediaId: mediaDerivatives.mediaId,
				storageKey: mediaDerivatives.storageKey,
				mimeType: mediaDerivatives.mimeType,
				size: mediaDerivatives.size,
				sourceEtag: mediaProcessingJobs.sourceEtag,
			})
			.from(mediaDerivatives)
			.innerJoin(
				mediaProcessingJobs,
				eq(mediaProcessingJobs.id, mediaDerivatives.processingJobId),
			)
			.where(
				and(
					eq(mediaDerivatives.organizationId, organizationId),
					inArray(mediaDerivatives.mediaId, [...sourceById.keys()]),
					eq(mediaDerivatives.kind, "normalized"),
					eq(mediaDerivatives.profile, AUTOMATIC_MEDIA_PROFILE),
					eq(mediaDerivatives.status, "ready"),
					gt(mediaDerivatives.deleteAfter, new Date()),
					eq(mediaProcessingJobs.status, "completed"),
				),
			)
			.orderBy(desc(mediaDerivatives.readyAt));

		for (const derivative of derivatives) {
			const source = sourceById.get(derivative.mediaId);
			if (!source || preferredDerivativeByStorageKey.has(source.storageKey)) {
				continue;
			}
			const sourceCategory = source.mimeType.split("/", 1)[0];
			const derivativeCategory = derivative.mimeType.split("/", 1)[0];
			if (
				source.mimeType === "image/gif" ||
				sourceCategory !== derivativeCategory ||
				!sourceEtags.get(source.storageKey) ||
				sourceEtags.get(source.storageKey) !== derivative.sourceEtag ||
				derivative.size >= source.size
			) {
				continue;
			}
			const object = await env.MEDIA_BUCKET.head(derivative.storageKey);
			const actual = object
				? validateStoredMediaObject({
						size: object.size,
						httpMetadata: object.httpMetadata,
					})
				: null;
			if (
				!actual?.ok ||
				actual.size !== derivative.size ||
				actual.mimeType !== derivative.mimeType
			) {
				continue;
			}
			preferredDerivativeByStorageKey.set(source.storageKey, derivative);
		}
	}

	const client = getCachedR2Client(env);
	const hasReadyR2Reference =
		preferredDerivativeByStorageKey.size > 0 ||
		policy.references.some((reference) => {
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
			const derivative = preferredDerivativeByStorageKey.get(storageKey);
			if (derivative) {
				result = client
					? presignViewUrlWithCache(
							env,
							client,
							derivative.storageKey,
							expiresIn,
							mediaBucketLocation(env),
						)
					: Promise.resolve(relayObjectUrl(env, derivative.storageKey));
				presignedByKey.set(storageKey, result);
				return result;
			}
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
					? presignStoredObject(db, env, locator, "GET", expiresIn)
					: client
						? // Sign against the bucket the row was actually written to,
							// not this deployment's default — they differ on self-host.
							presignViewUrlWithCache(env, client, storageKey, expiresIn, {
								bucket: locator.bucket,
								region: locator.region,
							})
						: Promise.resolve(`https://${mediaPublicHost(env)}/${storageKey}`);
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
	rootWorkspaceId?: string | null,
): Promise<T> {
	const withResolvedCovers = await resolveInstagramCoverSelectors(
		db,
		env,
		value,
		organizationId,
		expiresIn,
		rootWorkspaceId,
	);
	return presignRelayMediaValue(
		db,
		env,
		withResolvedCovers,
		expiresIn,
		organizationId,
		true,
	);
}
