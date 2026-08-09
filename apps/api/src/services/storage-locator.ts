import {
	type Database,
	storageCredentials,
	storageLocations,
} from "@relayapi/db";
import { AwsClient } from "aws4fetch";
import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import { decryptToken } from "../lib/crypto";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import type { Env } from "../types";

export type StorageLocator =
	| {
			provider: "r2";
			bucket: string;
			region: "default" | "eu";
			key: string;
	  }
	| {
			provider: "byos";
			organizationId: string;
			locationId: string;
			credentialVersion: number;
			bucket: string;
			region: string;
			key: string;
	  };

export type StorageTarget =
	| {
			provider: "r2";
			bucket: string;
			region: "default" | "eu";
	  }
	| {
			provider: "byos";
			organizationId: string;
			locationId: string;
			credentialVersion: number;
			bucket: string;
			region: string;
	  };

export interface StoredObjectHead {
	size: number;
	contentType: string | null;
	etag: string | null;
}

export interface StoredObject extends StoredObjectHead {
	body: ReadableStream;
}

export class StorageConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageConfigurationError";
	}
}

export class StorageProviderError extends Error {
	readonly status: number;

	constructor(operation: string, status: number) {
		super(`Storage provider ${operation} failed with status ${status}`);
		this.name = "StorageProviderError";
		this.status = status;
	}
}

type StorageLocationRow = typeof storageLocations.$inferSelect;
type StorageCredentialRow = typeof storageCredentials.$inferSelect;
type LoadedByosAuthority = {
	location: StorageLocationRow;
	credential: StorageCredentialRow;
	client: AwsClient;
};

const DEFAULT_BYOS_RETRIES = 2;

export const PINNED_BYOS_CREDENTIAL_STATES = ["active", "retired"] as const;
const CLEANUP_BYOS_CREDENTIAL_STATES = [
	"staged",
	"active",
	"retired",
	"failed",
] as const;

export function buildByosObjectUrl(
	config: Pick<
		StorageLocationRow,
		"endpoint" | "bucket" | "forcePathStyle" | "keyPrefix"
	>,
	key: string,
): URL {
	const url = new URL(config.endpoint);
	const normalizedBasePath = url.pathname.replace(/\/+$/, "");
	const objectPath = [config.keyPrefix, key]
		.flatMap((part) => part.split("/"))
		.filter(Boolean)
		.map((part) => encodeURIComponent(part))
		.join("/");
	if (config.forcePathStyle) {
		url.pathname = `${normalizedBasePath}/${encodeURIComponent(config.bucket)}/${objectPath}`;
	} else {
		url.hostname = `${config.bucket}.${url.hostname}`;
		url.pathname = `${normalizedBasePath}/${objectPath}`;
	}
	return url;
}

export function buildByosBucketUrl(
	config: Pick<StorageLocationRow, "endpoint" | "bucket" | "forcePathStyle">,
): URL {
	const url = new URL(config.endpoint);
	const normalizedBasePath = url.pathname.replace(/\/+$/, "");
	if (config.forcePathStyle) {
		url.pathname = `${normalizedBasePath}/${encodeURIComponent(config.bucket)}`;
	} else {
		url.hostname = `${config.bucket}.${url.hostname}`;
		url.pathname = normalizedBasePath || "/";
	}
	return url;
}

async function assertPublicByosUrl(url: URL): Promise<void> {
	if (await isBlockedUrlWithDns(url.toString())) {
		throw new StorageConfigurationError(
			"BYOS object endpoint does not resolve exclusively to public addresses",
		);
	}
}

async function loadByosAuthority(
	db: Database,
	env: Env,
	authority: {
		organizationId: string;
		locationId: string;
		credentialVersion: number;
	},
	allowedStates: readonly ("staged" | "active" | "retired" | "failed")[],
	retries = DEFAULT_BYOS_RETRIES,
): Promise<LoadedByosAuthority> {
	const [loaded] = await db
		.select({
			location: storageLocations,
			credential: storageCredentials,
		})
		.from(storageCredentials)
		.innerJoin(
			storageLocations,
			and(
				eq(storageLocations.id, storageCredentials.locationId),
				eq(storageLocations.organizationId, storageCredentials.organizationId),
			),
		)
		.where(
			and(
				eq(storageCredentials.organizationId, authority.organizationId),
				eq(storageCredentials.locationId, authority.locationId),
				eq(storageCredentials.version, authority.credentialVersion),
				inArray(storageCredentials.state, [...allowedStates]),
			),
		)
		.limit(1);
	if (!loaded) {
		throw new StorageConfigurationError(
			"Pinned BYOS location or credential version is unavailable",
		);
	}
	if (await isBlockedUrlWithDns(loaded.location.endpoint)) {
		throw new StorageConfigurationError(
			"BYOS endpoint no longer resolves exclusively to public addresses",
		);
	}
	const [accessKeyId, secretAccessKey] = await Promise.all([
		decryptToken(loaded.credential.accessKeyId, env.ENCRYPTION_KEY),
		decryptToken(loaded.credential.secretAccessKey, env.ENCRYPTION_KEY),
	]);
	return {
		...loaded,
		client: new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: "s3",
			region: loaded.location.region,
			retries,
		}),
	};
}

async function loadPinnedByosAuthority(
	db: Database,
	env: Env,
	locator: Extract<StorageLocator, { provider: "byos" }>,
	retries = DEFAULT_BYOS_RETRIES,
): Promise<LoadedByosAuthority> {
	const loaded = await loadByosAuthority(
		db,
		env,
		locator,
		PINNED_BYOS_CREDENTIAL_STATES,
		retries,
	);
	if (
		loaded.location.bucket !== locator.bucket ||
		loaded.location.region !== locator.region
	) {
		throw new StorageConfigurationError(
			"Stored object locator does not match its immutable BYOS location",
		);
	}
	return loaded;
}

/**
 * aws4fetch retries by signing a fresh Request around the original body. A
 * ReadableStream is one-shot, so replaying it after a 429/5xx sends a disturbed
 * body. Disable transport retries for streams and let the durable upload intent
 * plus the media reconciler resolve an ambiguous outcome instead.
 */
export function byosPutRetries(
	body: ReadableStream | ArrayBuffer | Uint8Array | string,
): number {
	return typeof body === "object" && body !== null && "getReader" in body
		? 0
		: DEFAULT_BYOS_RETRIES;
}

function currentR2Bucket(
	env: Env,
	locator: Extract<StorageLocator, { provider: "r2" }>,
): R2Bucket {
	if (
		locator.bucket === env.R2_MEDIA_BUCKET_NAME &&
		locator.region === env.R2_MEDIA_BUCKET_JURISDICTION
	) {
		return env.MEDIA_BUCKET;
	}
	if (
		locator.bucket === env.R2_THUMBNAIL_BUCKET_NAME &&
		locator.region === env.R2_THUMBNAIL_BUCKET_JURISDICTION
	) {
		return env.THUMBNAIL_BUCKET;
	}
	throw new StorageConfigurationError(
		`No R2 binding routes bucket ${locator.bucket} in jurisdiction ${locator.region}`,
	);
}

export async function preferredMediaStorageTarget(
	db: Database,
	env: Env,
	organizationId: string,
): Promise<StorageTarget> {
	const [active] = await db
		.select({
			locationId: storageLocations.id,
			bucket: storageLocations.bucket,
			region: storageLocations.region,
			credentialVersion: storageCredentials.version,
		})
		.from(storageCredentials)
		.innerJoin(
			storageLocations,
			and(
				eq(storageLocations.id, storageCredentials.locationId),
				eq(storageLocations.organizationId, storageCredentials.organizationId),
			),
		)
		.where(
			and(
				eq(storageCredentials.organizationId, organizationId),
				eq(storageCredentials.state, "active"),
			),
		)
		.orderBy(desc(storageCredentials.activatedAt))
		.limit(1);
	if (active) {
		return {
			provider: "byos",
			organizationId,
			locationId: active.locationId,
			credentialVersion: active.credentialVersion,
			bucket: active.bucket,
			region: active.region,
		};
	}
	return {
		provider: "r2",
		bucket: env.R2_MEDIA_BUCKET_NAME,
		region: env.R2_MEDIA_BUCKET_JURISDICTION,
	};
}

export async function preferredMediaStorageProvider(
	db: Database,
	organizationId: string,
): Promise<"r2" | "byos"> {
	const [row] = await db
		.select({ id: storageCredentials.id })
		.from(storageCredentials)
		.where(
			and(
				eq(storageCredentials.organizationId, organizationId),
				eq(storageCredentials.state, "active"),
			),
		)
		.limit(1);
	return row ? "byos" : "r2";
}

export function storageLocatorForTarget(
	target: Extract<StorageTarget, { provider: "r2" }>,
	key: string,
): Extract<StorageLocator, { provider: "r2" }>;
export function storageLocatorForTarget(
	target: Extract<StorageTarget, { provider: "byos" }>,
	key: string,
): Extract<StorageLocator, { provider: "byos" }>;
export function storageLocatorForTarget(
	target: StorageTarget,
	key: string,
): StorageLocator;
export function storageLocatorForTarget(
	target: StorageTarget,
	key: string,
): StorageLocator {
	return { ...target, key };
}

function responseHead(response: Response): StoredObjectHead {
	const length = Number(response.headers.get("content-length"));
	return {
		size: Number.isSafeInteger(length) && length >= 0 ? length : 0,
		contentType: response.headers.get("content-type"),
		etag: response.headers.get("etag"),
	};
}

export async function headStoredObject(
	db: Database,
	env: Env,
	locator: StorageLocator,
): Promise<StoredObjectHead | null> {
	if (locator.provider === "r2") {
		const object = await currentR2Bucket(env, locator).head(locator.key);
		if (!object) return null;
		return {
			size: object.size,
			contentType: object.httpMetadata?.contentType ?? null,
			etag: object.httpEtag ?? null,
		};
	}
	const { location, client } = await loadPinnedByosAuthority(db, env, locator);
	const url = buildByosObjectUrl(location, locator.key);
	await assertPublicByosUrl(url);
	const response = await client.fetch(url, {
		method: "HEAD",
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new StorageProviderError("HEAD", response.status);
	return responseHead(response);
}

export async function getStoredObject(
	db: Database,
	env: Env,
	locator: StorageLocator,
): Promise<StoredObject | null> {
	if (locator.provider === "r2") {
		const object = await currentR2Bucket(env, locator).get(locator.key);
		if (!object) return null;
		return {
			body: object.body,
			size: object.size,
			contentType: object.httpMetadata?.contentType ?? null,
			etag: object.httpEtag ?? null,
		};
	}
	const { location, client } = await loadPinnedByosAuthority(db, env, locator);
	const url = buildByosObjectUrl(location, locator.key);
	await assertPublicByosUrl(url);
	const response = await client.fetch(url, {
		method: "GET",
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new StorageProviderError("GET", response.status);
	if (!response.body) throw new StorageProviderError("GET body", 502);
	return { body: response.body, ...responseHead(response) };
}

export async function putStoredObject(
	db: Database,
	env: Env,
	locator: StorageLocator,
	body: ReadableStream | ArrayBuffer | Uint8Array | string,
	options: {
		contentType: string;
		metadata?: Record<string, string>;
		ifNoneMatch?: boolean;
	},
): Promise<void> {
	if (locator.provider === "r2") {
		await currentR2Bucket(env, locator).put(locator.key, body, {
			httpMetadata: { contentType: options.contentType },
			customMetadata: options.metadata,
			onlyIf: options.ifNoneMatch ? { etagDoesNotMatch: "*" } : undefined,
		});
		return;
	}
	const { location, client } = await loadPinnedByosAuthority(
		db,
		env,
		locator,
		byosPutRetries(body),
	);
	const headers = new Headers({ "content-type": options.contentType });
	if (options.ifNoneMatch) headers.set("if-none-match", "*");
	for (const [key, value] of Object.entries(options.metadata ?? {})) {
		headers.set(
			`x-amz-meta-${key.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
			value,
		);
	}
	const url = buildByosObjectUrl(location, locator.key);
	await assertPublicByosUrl(url);
	const response = await client.fetch(url, {
		method: "PUT",
		headers,
		body:
			body instanceof Uint8Array
				? (body.buffer.slice(
						body.byteOffset,
						body.byteOffset + body.byteLength,
					) as ArrayBuffer)
				: body,
	});
	if (!response.ok) throw new StorageProviderError("PUT", response.status);
}

export async function deleteStoredObject(
	db: Database,
	env: Env,
	locator: StorageLocator,
): Promise<void> {
	if (locator.provider === "r2") {
		await currentR2Bucket(env, locator).delete(locator.key);
		return;
	}
	const { location, client } = await loadPinnedByosAuthority(db, env, locator);
	const url = buildByosObjectUrl(location, locator.key);
	await assertPublicByosUrl(url);
	const response = await client.fetch(url, {
		method: "DELETE",
	});
	if (!response.ok && response.status !== 404) {
		throw new StorageProviderError("DELETE", response.status);
	}
}

export async function presignStoredObject(
	db: Database,
	env: Env,
	locator: Extract<StorageLocator, { provider: "byos" }>,
	method: "GET" | "PUT",
	expiresInSeconds: number,
	contentType?: string,
): Promise<string> {
	const { location, client } = await loadPinnedByosAuthority(db, env, locator);
	const url = buildByosObjectUrl(location, locator.key);
	await assertPublicByosUrl(url);
	url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
	const headers: Record<string, string> = {};
	if (method === "PUT" && contentType) {
		headers["content-type"] = contentType;
		headers["if-none-match"] = "*";
	}
	const request = await client.sign(url, {
		method,
		headers,
		aws: {
			signQuery: true,
			allHeaders: method === "PUT" && !!contentType,
		},
	});
	return request.url;
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

/**
 * Prove that the saved credentials can complete the exact object lifecycle the
 * product needs. The probe is namespaced, never overwrites, and is deleted even
 * when the read verification fails.
 */
export async function probeByosCredential(
	db: Database,
	env: Env,
	authority: {
		organizationId: string;
		locationId: string;
		credentialVersion: number;
	},
): Promise<void> {
	const { location, client } = await loadByosAuthority(db, env, authority, [
		"staged",
	]);
	const key = byosProbeKey(authority.organizationId);
	const url = buildByosObjectUrl(location, key);
	await assertPublicByosUrl(url);
	const expected = `relayapi-byos-probe:${crypto.randomUUID()}`;
	let putCompleted = false;
	let probeError: unknown;
	try {
		const put = await client.fetch(url, {
			method: "PUT",
			headers: {
				"content-type": "text/plain; charset=utf-8",
				"if-none-match": "*",
			},
			body: expected,
		});
		if (!put.ok) throw new StorageProviderError("probe PUT", put.status);
		putCompleted = true;
		const head = await client.fetch(url, { method: "HEAD" });
		if (!head.ok) throw new StorageProviderError("probe HEAD", head.status);
		const get = await client.fetch(url, { method: "GET" });
		if (!get.ok) throw new StorageProviderError("probe GET", get.status);
		if ((await get.text()) !== expected) {
			throw new StorageConfigurationError(
				"BYOS probe read did not match the bytes that were written",
			);
		}
	} catch (error) {
		probeError = error;
	}

	let cleanupError: unknown;
	if (putCompleted) {
		try {
			const deleted = await client.fetch(url, { method: "DELETE" });
			if (!deleted.ok && deleted.status !== 404) {
				throw new StorageProviderError("probe DELETE", deleted.status);
			}
		} catch (error) {
			cleanupError = error;
		}
	}
	if (probeError && cleanupError) {
		throw new AggregateError(
			[probeError, cleanupError],
			"BYOS probe failed and its cleanup also failed",
		);
	}
	if (probeError) throw probeError;
	if (cleanupError) throw cleanupError;
}

/**
 * Delete one bounded page of tenant-owned BYOS objects. Returns true only when
 * the provider reported that no later page remains.
 */
export async function deleteByosPrefixPage(
	db: Database,
	env: Env,
	locator: Omit<Extract<StorageLocator, { provider: "byos" }>, "key">,
	prefix: string,
	maxKeys: number = 100,
): Promise<boolean> {
	const { location, client } = await loadByosAuthority(
		db,
		env,
		locator,
		CLEANUP_BYOS_CREDENTIAL_STATES,
	);
	if (
		location.bucket !== locator.bucket ||
		location.region !== locator.region
	) {
		throw new StorageConfigurationError(
			"Cleanup locator does not match its immutable BYOS location",
		);
	}
	const listUrl = buildByosBucketUrl(location);
	await assertPublicByosUrl(listUrl);
	const storagePrefix = [location.keyPrefix, prefix]
		.flatMap((part) => part.split("/"))
		.filter(Boolean)
		.join("/");
	listUrl.searchParams.set("list-type", "2");
	listUrl.searchParams.set("prefix", `${storagePrefix.replace(/\/+$/, "")}/`);
	listUrl.searchParams.set(
		"max-keys",
		String(Math.max(1, Math.min(maxKeys, 1000))),
	);
	const response = await client.fetch(listUrl, { method: "GET" });
	if (!response.ok) {
		throw new StorageProviderError("LIST", response.status);
	}
	const xml = await response.text();
	const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
		decodeXml(match[1] ?? ""),
	);
	const logicalPrefix = `${location.keyPrefix.replace(/\/+$/, "")}/`;
	const logicalKeys = keys.map((key) => {
		if (!key.startsWith(logicalPrefix)) {
			throw new StorageConfigurationError(
				"BYOS provider returned an object outside the configured prefix",
			);
		}
		return key.slice(logicalPrefix.length);
	});
	for (let offset = 0; offset < logicalKeys.length; offset += 10) {
		await Promise.all(
			logicalKeys.slice(offset, offset + 10).map(async (key) => {
				const url = buildByosObjectUrl(location, key);
				await assertPublicByosUrl(url);
				const deleted = await client.fetch(url, { method: "DELETE" });
				if (!deleted.ok && deleted.status !== 404) {
					throw new StorageProviderError("DELETE", deleted.status);
				}
			}),
		);
	}
	return !/<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
}

export type ByosCleanupLocator = Omit<
	Extract<StorageLocator, { provider: "byos" }>,
	"key"
>;

/**
 * Return the next exact historical BYOS authority for tenant cleanup. The
 * cursor is a stable (location id, credential version) tuple, so retries keep
 * using the same credential until its prefix is empty and then advance.
 *
 * Failed and staged credentials are included because a probe can write an
 * object and then lose its cleanup response. They are never accepted by the
 * ordinary media read/write path.
 */
export async function nextByosCleanupLocator(
	db: Database,
	organizationId: string,
	after?: { locationId: string; credentialVersion: number },
): Promise<ByosCleanupLocator | null> {
	const afterCursor = after
		? or(
				gt(storageCredentials.locationId, after.locationId),
				and(
					eq(storageCredentials.locationId, after.locationId),
					gt(storageCredentials.version, after.credentialVersion),
				),
			)
		: undefined;
	const [row] = await db
		.select({
			locationId: storageCredentials.locationId,
			credentialVersion: storageCredentials.version,
			bucket: storageLocations.bucket,
			region: storageLocations.region,
		})
		.from(storageCredentials)
		.innerJoin(
			storageLocations,
			and(
				eq(storageLocations.id, storageCredentials.locationId),
				eq(storageLocations.organizationId, storageCredentials.organizationId),
			),
		)
		.where(
			and(
				eq(storageCredentials.organizationId, organizationId),
				inArray(storageCredentials.state, [...CLEANUP_BYOS_CREDENTIAL_STATES]),
				afterCursor,
			),
		)
		.orderBy(
			asc(storageCredentials.locationId),
			asc(storageCredentials.version),
		)
		.limit(1);
	return row
		? {
				provider: "byos",
				organizationId,
				locationId: row.locationId,
				credentialVersion: row.credentialVersion,
				bucket: row.bucket,
				region: row.region,
			}
		: null;
}

export function storageLocatorForMedia(row: {
	organizationId: string;
	storageProvider: "r2" | "byos";
	storageBucketLocator: string;
	storageRegion: string;
	storageLocationId: string | null;
	storageCredentialVersion: number | null;
	storageKey: string;
}): StorageLocator {
	if (row.storageProvider === "byos") {
		if (!row.storageLocationId || !row.storageCredentialVersion) {
			throw new StorageConfigurationError(
				"Persisted BYOS object is missing its location or credential version",
			);
		}
		return {
			provider: "byos",
			organizationId: row.organizationId,
			locationId: row.storageLocationId,
			credentialVersion: row.storageCredentialVersion,
			bucket: row.storageBucketLocator,
			region: row.storageRegion,
			key: row.storageKey,
		};
	}
	if (row.storageRegion !== "default" && row.storageRegion !== "eu") {
		throw new StorageConfigurationError(
			`Unsupported persisted R2 jurisdiction ${row.storageRegion}`,
		);
	}
	return {
		provider: "r2",
		bucket: row.storageBucketLocator,
		region: row.storageRegion,
		key: row.storageKey,
	};
}

export function storageLocatorForThumbnailObject(row: {
	organizationId: string;
	thumbnailStorageProvider: "r2" | "byos" | null;
	thumbnailStorageBucketLocator: string | null;
	thumbnailStorageRegion: string | null;
	thumbnailKey: string | null;
}): StorageLocator {
	if (
		!row.thumbnailStorageProvider ||
		!row.thumbnailStorageBucketLocator ||
		!row.thumbnailStorageRegion ||
		!row.thumbnailKey
	) {
		throw new StorageConfigurationError(
			"Persisted thumbnail object is missing its storage locator",
		);
	}
	if (row.thumbnailStorageProvider !== "r2") {
		throw new StorageConfigurationError(
			`Unsupported persisted thumbnail provider ${row.thumbnailStorageProvider}`,
		);
	}
	if (
		row.thumbnailStorageRegion !== "default" &&
		row.thumbnailStorageRegion !== "eu"
	) {
		throw new StorageConfigurationError(
			`Unsupported persisted R2 jurisdiction ${row.thumbnailStorageRegion}`,
		);
	}
	return {
		provider: "r2",
		bucket: row.thumbnailStorageBucketLocator,
		region: row.thumbnailStorageRegion,
		key: row.thumbnailKey,
	};
}

export function byosProbeKey(organizationId: string): string {
	return `${organizationId}/probes/${crypto.randomUUID()}`;
}
