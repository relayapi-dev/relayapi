import { type Database, media } from "@relayapi/db";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
	isAllowedMediaMimeType,
	MAX_MEDIA_UPLOAD_BYTES,
	normalizeMediaMimeType,
} from "./media-storage-policy";

export const RELAY_MEDIA_HOST = "media.relayapi.dev";

export type RelayMediaReference = {
	url: string;
	storageKey: string | null;
	reason?: "invalid_relay_url";
};

/**
 * Classify only the exact Relay media origin. Other HTTP(S) origins remain
 * ordinary external media and are intentionally outside this ownership check.
 */
export function relayMediaReferenceFromUrl(
	value: string,
	relayMediaHost = RELAY_MEDIA_HOST,
): RelayMediaReference | null {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	const hostnameWithoutTrailingDot = parsed.hostname.endsWith(".")
		? parsed.hostname.slice(0, -1)
		: parsed.hostname;
	if (hostnameWithoutTrailingDot !== relayMediaHost) return null;
	if (
		parsed.hostname !== relayMediaHost ||
		parsed.protocol !== "https:" ||
		parsed.port !== "" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		return { url: value, storageKey: null, reason: "invalid_relay_url" };
	}
	try {
		const storageKey = decodeURIComponent(parsed.pathname.slice(1));
		if (
			!storageKey ||
			storageKey.startsWith("/") ||
			storageKey.includes("\0")
		) {
			return { url: value, storageKey: null, reason: "invalid_relay_url" };
		}
		return { url: value, storageKey };
	} catch {
		return { url: value, storageKey: null, reason: "invalid_relay_url" };
	}
}

export function collectRelayMediaReferences(
	value: unknown,
	relayMediaHost = RELAY_MEDIA_HOST,
): RelayMediaReference[] {
	const references: RelayMediaReference[] = [];
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown): void => {
		if (typeof candidate === "string") {
			const reference = relayMediaReferenceFromUrl(candidate, relayMediaHost);
			if (reference) references.push(reference);
			return;
		}
		if (!candidate || typeof candidate !== "object") return;
		if (seen.has(candidate)) return;
		seen.add(candidate);
		if (Array.isArray(candidate)) {
			for (const item of candidate) visit(item);
			return;
		}
		for (const item of Object.values(candidate as Record<string, unknown>)) {
			visit(item);
		}
	};
	visit(value);
	return references;
}

export type RelayMediaViolation = Omit<RelayMediaReference, "reason"> & {
	reason:
		| "invalid_relay_url"
		| "not_ready_or_not_owned"
		| "stored_object_invalid"
		| "stored_object_drift";
};

export type ReadyRelayMedia = {
	id: string;
	storageKey: string;
	storageProvider: "r2" | "byos";
	storageBucketLocator: string;
	storageRegion: string;
	storageLocationId: string | null;
	storageCredentialVersion: number | null;
	mimeType: string;
	size: number;
};

export class RelayMediaPolicy {
	readonly references: readonly RelayMediaReference[];
	readonly readyStorageKeys: ReadonlySet<string>;
	readonly readyMediaByStorageKey: ReadonlyMap<string, ReadyRelayMedia>;
	readonly relayMediaHost: string;

	constructor(
		references: readonly RelayMediaReference[],
		readyMediaByStorageKey: ReadonlyMap<string, ReadyRelayMedia>,
		relayMediaHost = RELAY_MEDIA_HOST,
	) {
		this.references = references;
		this.readyMediaByStorageKey = readyMediaByStorageKey;
		this.readyStorageKeys = new Set(readyMediaByStorageKey.keys());
		this.relayMediaHost = relayMediaHost;
	}

	violationFor(value: unknown): RelayMediaViolation | null {
		for (const reference of collectRelayMediaReferences(value, this.relayMediaHost)) {
			if (!reference.storageKey) {
				return {
					url: reference.url,
					storageKey: null,
					reason: "invalid_relay_url",
				};
			}
			if (!this.readyStorageKeys.has(reference.storageKey)) {
				return {
					url: reference.url,
					storageKey: reference.storageKey,
					reason: "not_ready_or_not_owned",
				};
			}
		}
		return null;
	}

	isReadyUrl(value: string): boolean {
		const reference = relayMediaReferenceFromUrl(value, this.relayMediaHost);
		return (
			!!reference?.storageKey && this.readyStorageKeys.has(reference.storageKey)
		);
	}
}

export class RelayMediaPolicyError extends Error {
	readonly violation: RelayMediaViolation;

	constructor(violation: RelayMediaViolation) {
		super(
			violation.reason === "invalid_relay_url"
				? "Relay-hosted media URLs must use the canonical HTTPS URL without credentials, a port, query, or fragment"
				: violation.reason === "stored_object_invalid"
					? "Relay-hosted media failed the stored-object MIME or size policy"
					: violation.reason === "stored_object_drift"
						? "Relay-hosted media changed after it was confirmed"
						: "Relay-hosted media must belong to the organization and be ready before it can be used",
		);
		this.name = "RelayMediaPolicyError";
		this.violation = violation;
	}
}

/**
 * Load a request-scoped readiness snapshot in one query. A row must be owned by
 * the tenant, ready, not in deletion, retain its original, and carry metadata
 * inside the same MIME/size policy enforced against R2 at confirmation time.
 */
export async function loadRelayMediaPolicy(
	db: Database,
	organizationId: string,
	value: unknown,
	relayMediaHost = RELAY_MEDIA_HOST,
): Promise<RelayMediaPolicy> {
	const references = collectRelayMediaReferences(value, relayMediaHost);
	const storageKeys = [
		...new Set(
			references.flatMap((reference) =>
				reference.storageKey ? [reference.storageKey] : [],
			),
		),
	];
	if (storageKeys.length === 0) {
		return new RelayMediaPolicy(references, new Map(), relayMediaHost);
	}

	const rows = await db
		.select({
			id: media.id,
			storageKey: media.storageKey,
			storageProvider: media.storageProvider,
			storageBucketLocator: media.storageBucketLocator,
			storageRegion: media.storageRegion,
			storageLocationId: media.storageLocationId,
			storageCredentialVersion: media.storageCredentialVersion,
			mimeType: media.mimeType,
			size: media.size,
		})
		.from(media)
		.where(
			and(
				eq(media.organizationId, organizationId),
				eq(media.status, "ready"),
				inArray(media.storageKey, storageKeys),
				isNull(media.deletionRequestedAt),
				isNull(media.originalDeletedAt),
				isNotNull(media.url),
			),
		);
	const readyMediaByStorageKey = new Map<string, ReadyRelayMedia>();
	for (const row of rows) {
		if (
			row.size > MAX_MEDIA_UPLOAD_BYTES ||
			!isAllowedMediaMimeType(row.mimeType)
		) {
			continue;
		}
		readyMediaByStorageKey.set(row.storageKey, {
			id: row.id,
			storageKey: row.storageKey,
			storageProvider: row.storageProvider,
			storageBucketLocator: row.storageBucketLocator,
			storageRegion: row.storageRegion,
			storageLocationId: row.storageLocationId,
			storageCredentialVersion: row.storageCredentialVersion,
			mimeType: normalizeMediaMimeType(row.mimeType),
			size: row.size,
		});
	}
	return new RelayMediaPolicy(references, readyMediaByStorageKey, relayMediaHost);
}

export async function assertRelayMediaReady(
	db: Database,
	organizationId: string,
	value: unknown,
	relayMediaHost = RELAY_MEDIA_HOST,
): Promise<RelayMediaPolicy> {
	const policy = await loadRelayMediaPolicy(
		db,
		organizationId,
		value,
		relayMediaHost,
	);
	const violation = policy.violationFor(value);
	if (violation) throw new RelayMediaPolicyError(violation);
	return policy;
}
