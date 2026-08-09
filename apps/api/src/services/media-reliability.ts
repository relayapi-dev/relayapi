import {
	createDb,
	type Database,
	ideaMedia,
	media,
	queueFailures,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { validateStoredMediaObject } from "../lib/media-storage-policy";
import { purgePresignedViewCache } from "../lib/r2-presign";
import {
	generateAndStoreThumbnailFromStoredObject,
	type ThumbnailGenerationResult,
	type ThumbnailStorageTarget,
	thumbnailKeyFor,
	thumbnailStorageTarget,
} from "../lib/thumbnails";
import type { Env } from "../types";
import { encryptQueueFailurePayload } from "../queues/failures";
import {
	deleteStoredObject,
	getStoredObject,
	headStoredObject,
	storageLocatorForMedia,
	storageLocatorForThumbnailObject,
} from "./storage-locator";

export interface MediaEventMessage {
	account: string;
	bucket: string;
	object: {
		key: string;
		size?: number;
		eTag?: string;
	};
	action: string;
	eventTime?: string;
}

const CREATE_ACTIONS = new Set([
	"PutObject",
	"CopyObject",
	"CompleteMultipartUpload",
]);
const DELETE_ACTIONS = new Set(["DeleteObject", "LifecycleDeletion"]);
const MEDIA_DELETION_BATCH_SIZE = 25;
const MEDIA_UPLOAD_RECONCILIATION_BATCH_SIZE = 25;
export const MEDIA_DIRECT_UPLOAD_STALE_MS = 10 * 60 * 1000;
// PUT presigns live for one hour. Allow an additional five minutes for a PUT
// that began just before expiry and its R2 notification to settle.
export const MEDIA_PRESIGNED_UPLOAD_STALE_MS = 65 * 60 * 1000;
const MEDIA_DELETION_ALERT_ATTEMPTS = 8;
const THUMBNAIL_CLAIM_MS = 5 * 60 * 1000;
// Upload URLs expire after one hour, but a request that started before expiry or
// its R2 event can finish later. Keep a hidden tombstone long enough to absorb
// those late writes, then perform one final unconditional object sweep.
export const MEDIA_DELETION_LATE_WRITE_GRACE_MS = 24 * 60 * 60 * 1000;

export class RetryableMediaError extends Error {
	readonly delaySeconds: number;

	constructor(message: string, delaySeconds: number) {
		super(message);
		this.name = "RetryableMediaError";
		this.delaySeconds = delaySeconds;
	}
}

export function thumbnailRetryDelaySeconds(attempts: number): number {
	const exponent = Math.max(0, Math.min(attempts - 1, 8));
	return Math.min(6 * 60 * 60, 60 * 2 ** exponent);
}

export function mediaDeletionRetryDelaySeconds(attempts: number): number {
	const exponent = Math.max(0, Math.min(attempts - 1, 8));
	return Math.min(6 * 60 * 60, 30 * 2 ** exponent);
}

/**
 * Retire an upload whose persisted R2 metadata violates the media policy. The
 * durable deletion tombstone absorbs a late/replayed presigned PUT instead of
 * deleting the row and creating an unowned object race.
 */
export async function retireRejectedMediaUpload(
	db: Database,
	env: Env,
	mediaId: string,
	now: Date = new Date(),
	reason: string = "stored_object_policy_rejected",
): Promise<void> {
	const claimed = await db.transaction(async (tx) => {
		await tx.delete(ideaMedia).where(eq(ideaMedia.mediaId, mediaId));
		return tx
			.update(media)
			.set({
				status: "deleting",
				url: null,
				thumbnailKey: sql<string>`COALESCE(${media.thumbnailKey}, ${media.storageKey} || '.avif')`,
				thumbnailStorageProvider: sql<"r2">`COALESCE(${media.thumbnailStorageProvider}, 'r2')`,
				thumbnailStorageBucketLocator: sql<string>`COALESCE(${media.thumbnailStorageBucketLocator}, ${env.R2_THUMBNAIL_BUCKET_NAME})`,
				thumbnailStorageRegion: sql<"default" | "eu">`COALESCE(${media.thumbnailStorageRegion}, ${env.R2_THUMBNAIL_BUCKET_JURISDICTION})`,
				deletionRequestedAt: sql<Date>`COALESCE(${media.deletionRequestedAt}, ${now})`,
				deletionNextRetryAt: now,
				deletionLastError: reason,
			})
			.where(
				and(
					eq(media.id, mediaId),
					inArray(media.status, [
						"pending",
						"uploading",
						"upload_failed",
						"ready",
					]),
					isNull(media.deletionRequestedAt),
				),
			)
			.returning({ id: media.id });
	});
	if (claimed.length > 0) {
		await processMediaDeletion(db, env, mediaId, now);
	}
}

export type MediaDeletionResult =
	| { status: "complete" }
	| {
			status: "pending";
			attempts: number;
			originalPending: boolean;
			thumbnailPending: boolean;
	  };

/**
 * Attempt the two idempotent R2 deletions represented by a durable media-row
 * tombstone. Successful phases are checkpointed; the row is removed only when
 * both providers have confirmed deletion.
 */
export async function processMediaDeletion(
	db: Database,
	env: Env,
	mediaId: string,
	now: Date = new Date(),
): Promise<MediaDeletionResult> {
	const [row] = await db
		.select({
			id: media.id,
			organizationId: media.organizationId,
			storageProvider: media.storageProvider,
			storageBucketLocator: media.storageBucketLocator,
			storageRegion: media.storageRegion,
			storageLocationId: media.storageLocationId,
			storageCredentialVersion: media.storageCredentialVersion,
			storageKey: media.storageKey,
			thumbnailKey: media.thumbnailKey,
			thumbnailStorageProvider: media.thumbnailStorageProvider,
			thumbnailStorageBucketLocator: media.thumbnailStorageBucketLocator,
			thumbnailStorageRegion: media.thumbnailStorageRegion,
			createdAt: media.createdAt,
			deletionRequestedAt: media.deletionRequestedAt,
			originalDeletionConfirmedAt: media.originalDeletionConfirmedAt,
			thumbnailDeletionConfirmedAt: media.thumbnailDeletionConfirmedAt,
			deletionAttempts: media.deletionAttempts,
		})
		.from(media)
		.where(eq(media.id, mediaId))
		.limit(1);
	if (!row) return { status: "complete" };
	if (!row.deletionRequestedAt) {
		throw new Error("media deletion tombstone is not initialized");
	}
	const retainUntil = new Date(
		row.createdAt.getTime() + MEDIA_DELETION_LATE_WRITE_GRACE_MS,
	);
	const finalSweep = now.getTime() >= retainUntil.getTime();

	const [originalResult, thumbnailResult] = await Promise.allSettled([
		row.originalDeletionConfirmedAt && !finalSweep
			? Promise.resolve()
			: deleteStoredObject(db, env, storageLocatorForMedia(row)),
		row.thumbnailDeletionConfirmedAt && !finalSweep
			? Promise.resolve()
			: deleteStoredObject(
					db,
					env,
					storageLocatorForThumbnailObject(row),
				),
	]);
	const originalComplete = originalResult.status === "fulfilled";
	const thumbnailComplete = thumbnailResult.status === "fulfilled";

	if (originalComplete) {
		await purgePresignedViewCache(
			env,
			row.storageKey,
			undefined,
			row.storageBucketLocator,
		);
	}

	if (originalComplete && thumbnailComplete) {
		// Resolve a previously surfaced operator alert once both providers accept
		// deletion. If this write fails, the tombstone remains and retries.
		if (row.deletionAttempts >= MEDIA_DELETION_ALERT_ATTEMPTS) {
			await db
				.update(queueFailures)
				.set({ status: "replayed", resolvedAt: now })
				.where(
					and(
						eq(queueFailures.queueName, "media-deletion-reconciler"),
						eq(queueFailures.messageId, row.id),
					),
				);
		}
		if (!finalSweep) {
			await db
				.update(media)
				.set({
					status: "deleting",
					deletionNextRetryAt: retainUntil,
					deletionLastError: null,
					originalDeletionConfirmedAt: row.originalDeletionConfirmedAt ?? now,
					thumbnailDeletionConfirmedAt: row.thumbnailDeletionConfirmedAt ?? now,
				})
				.where(and(eq(media.id, row.id), isNotNull(media.deletionRequestedAt)));
			return {
				status: "pending",
				attempts: row.deletionAttempts,
				originalPending: false,
				thumbnailPending: false,
			};
		}
		await db
			.delete(media)
			.where(and(eq(media.id, row.id), isNotNull(media.deletionRequestedAt)));
		return { status: "complete" };
	}

	const attempts = row.deletionAttempts + 1;
	const nextRetryAt = new Date(
		now.getTime() + mediaDeletionRetryDelaySeconds(attempts) * 1000,
	);
	const originalPending = !originalComplete;
	const thumbnailPending = !thumbnailComplete;
	await db
		.update(media)
		.set({
			status: sql<string>`CASE
				WHEN ${media.deletionAttempts} + 1 >= ${MEDIA_DELETION_ALERT_ATTEMPTS}
				THEN 'deletion_failed'
				ELSE 'deleting'
			END`,
			deletionAttempts: sql`${media.deletionAttempts} + 1`,
			deletionNextRetryAt: nextRetryAt,
			deletionLastError: [
				originalPending ? "original_delete_unconfirmed" : null,
				thumbnailPending ? "thumbnail_delete_unconfirmed" : null,
			]
				.filter(Boolean)
				.join(","),
			...(originalComplete && !row.originalDeletionConfirmedAt
				? { originalDeletionConfirmedAt: now }
				: {}),
			...(thumbnailComplete && !row.thumbnailDeletionConfirmedAt
				? { thumbnailDeletionConfirmedAt: now }
				: {}),
		})
		.where(and(eq(media.id, row.id), isNotNull(media.deletionRequestedAt)));

	if (attempts >= MEDIA_DELETION_ALERT_ATTEMPTS) {
		const error = [
			originalPending ? "original_delete_unconfirmed" : null,
			thumbnailPending ? "thumbnail_delete_unconfirmed" : null,
		]
			.filter(Boolean)
			.join(",");
		const encryptedPayload = await encryptQueueFailurePayload(
			env,
			"media-deletion-reconciler",
			row.id,
			{
				media_id: row.id,
				operation_id: row.id,
				organization_id: row.organizationId,
			},
		);
		await db
			.insert(queueFailures)
			.values({
				queueName: "media-deletion-reconciler",
				messageId: row.id,
				organizationIds: [row.organizationId],
				operationId: row.id,
				failureKind: "unknown_external_outcome",
				status: "unresolved",
				attempts,
				...encryptedPayload,
				error,
			})
			.onConflictDoUpdate({
				target: [queueFailures.queueName, queueFailures.messageId],
				set: {
					status: "unresolved",
					attempts,
					error,
					resolvedAt: null,
				},
			});
		console.error(
			"[media-deletion] durable cleanup requires operator attention",
			{
				attempts,
				originalPending,
				thumbnailPending,
			},
		);
	}
	return { status: "pending", attempts, originalPending, thumbnailPending };
}

/** Retry interrupted explicit deletions without adding work to request paths. */
export async function reconcileMediaDeletions(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const rows = await db
		.select({ id: media.id })
		.from(media)
		.where(
			and(
				isNotNull(media.deletionRequestedAt),
				inArray(media.status, ["deleting", "deletion_failed"]),
				or(
					sql`${media.deletionNextRetryAt} IS NULL`,
					lte(media.deletionNextRetryAt, now),
				),
			),
		)
		.orderBy(asc(media.deletionNextRetryAt), asc(media.deletionRequestedAt))
		.limit(MEDIA_DELETION_BATCH_SIZE);

	let processed = 0;
	for (const row of rows) {
		try {
			await processMediaDeletion(db, env, row.id, now);
			processed++;
		} catch {
			console.error("[media-deletion] reconciler attempt failed");
		}
	}
	return processed;
}

/**
 * Repair or retire durable upload intents that did not reach their final DB
 * update. R2 is authoritative for whether bytes were accepted: existing
 * objects become ready, while absent stale intents and their Idea attachment
 * rows are removed together. This closes both crash windows (after DB/before
 * PUT and after PUT/before DB completion) without URL-derived ownership.
 */
export async function reconcileMediaUploads(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = Date.now();
	const directStaleBefore = new Date(now - MEDIA_DIRECT_UPLOAD_STALE_MS);
	const presignedStaleBefore = new Date(now - MEDIA_PRESIGNED_UPLOAD_STALE_MS);
	const rows = await db
		.select({
			id: media.id,
			organizationId: media.organizationId,
			storageProvider: media.storageProvider,
			storageBucketLocator: media.storageBucketLocator,
			storageRegion: media.storageRegion,
			storageLocationId: media.storageLocationId,
			storageCredentialVersion: media.storageCredentialVersion,
			storageKey: media.storageKey,
			status: media.status,
			mimeType: media.mimeType,
			thumbnailKey: media.thumbnailKey,
			thumbnailStorageProvider: media.thumbnailStorageProvider,
			thumbnailStorageBucketLocator: media.thumbnailStorageBucketLocator,
			thumbnailStorageRegion: media.thumbnailStorageRegion,
			thumbnailUrl: media.thumbnailUrl,
			thumbnailStatus: media.thumbnailStatus,
			thumbnailAttempts: media.thumbnailAttempts,
			thumbnailNextRetryAt: media.thumbnailNextRetryAt,
			originalDeletedAt: media.originalDeletedAt,
		})
		.from(media)
		.where(
			and(
				or(
					and(
						eq(media.status, "pending"),
						lt(media.createdAt, presignedStaleBefore),
					),
					and(
						inArray(media.status, ["uploading", "upload_failed"]),
						lt(media.createdAt, directStaleBefore),
					),
				),
				isNull(media.deletionRequestedAt),
			),
		)
		.orderBy(asc(media.createdAt), asc(media.id))
		.limit(MEDIA_UPLOAD_RECONCILIATION_BATCH_SIZE);

	let processed = 0;
	for (const row of rows) {
		try {
			const object = await headStoredObject(
				db,
				env,
				storageLocatorForMedia(row),
			);
			if (object) {
				const validation = validateStoredMediaObject({
					size: object.size,
					httpMetadata: {
						contentType: object.contentType ?? undefined,
					},
				});
				if (!validation.ok) {
					await retireRejectedMediaUpload(db, env, row.id);
					processed++;
					continue;
				}
				const updated = await db
					.update(media)
					.set({
						status: "ready",
						size: validation.size,
						mimeType: validation.mimeType,
					})
					.where(
						and(
							eq(media.id, row.id),
							inArray(media.status, ["pending", "uploading", "upload_failed"]),
							isNull(media.deletionRequestedAt),
						),
					)
					.returning({ id: media.id });
				if (updated.length > 0) {
					await processThumbnailForMedia(db, env, {
						...row,
						mimeType: validation.mimeType,
					}).catch((error) => {
						if (!(error instanceof RetryableMediaError)) throw error;
					});
				}
			} else {
				if (row.status === "pending") {
					await retireRejectedMediaUpload(
						db,
						env,
						row.id,
						new Date(now),
						"presigned_upload_expired",
					);
				} else {
					await db.transaction(async (tx) => {
						await tx.delete(ideaMedia).where(eq(ideaMedia.mediaId, row.id));
						await tx
							.delete(media)
							.where(
								and(
									eq(media.id, row.id),
									inArray(media.status, ["uploading", "upload_failed"]),
									isNull(media.deletionRequestedAt),
								),
							);
					});
				}
			}
			processed++;
		} catch (error) {
			console.error("[media-upload] reconciler attempt failed", error);
		}
	}
	return processed;
}

export function isMediaEventMessage(
	value: unknown,
	expectedSource?: { account: string; bucket: string },
): value is MediaEventMessage {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	if (typeof event.account !== "string" || typeof event.bucket !== "string") {
		return false;
	}
	if (
		expectedSource &&
		(event.account !== expectedSource.account ||
			event.bucket !== expectedSource.bucket)
	) {
		return false;
	}
	if (
		typeof event.action !== "string" ||
		(!CREATE_ACTIONS.has(event.action) && !DELETE_ACTIONS.has(event.action))
	) {
		return false;
	}
	if (!event.object || typeof event.object !== "object") return false;
	return typeof (event.object as Record<string, unknown>).key === "string";
}

type ThumbnailRow = Pick<
	typeof media.$inferSelect,
	| "id"
	| "storageKey"
	| "storageBucketLocator"
	| "storageRegion"
	| "storageLocationId"
	| "storageCredentialVersion"
	| "mimeType"
	| "thumbnailUrl"
	| "thumbnailStatus"
	| "thumbnailAttempts"
	| "thumbnailNextRetryAt"
	| "originalDeletedAt"
> &
	Partial<
		Pick<
			typeof media.$inferSelect,
			| "organizationId"
			| "storageProvider"
			| "thumbnailKey"
			| "thumbnailStorageProvider"
			| "thumbnailStorageBucketLocator"
			| "thumbnailStorageRegion"
		>
	>;

function sourceStorageLocatorForThumbnail(row: ThumbnailRow) {
	if (!row.organizationId) {
		throw new Error("Thumbnail source is missing its organization locator");
	}
	return storageLocatorForMedia({
		organizationId: row.organizationId,
		storageProvider: row.storageProvider ?? "r2",
		storageBucketLocator: row.storageBucketLocator,
		storageRegion: row.storageRegion,
		storageLocationId: row.storageLocationId,
		storageCredentialVersion: row.storageCredentialVersion,
		storageKey: row.storageKey,
	});
}

/** Generate one thumbnail attempt and persist its typed terminal/retry state. */
export async function processThumbnailForMedia(
	db: Database,
	env: Env,
	row: ThumbnailRow,
	now: Date = new Date(),
): Promise<ThumbnailGenerationResult> {
	if (row.thumbnailUrl) {
		const target: ThumbnailStorageTarget =
			row.thumbnailStorageProvider === "r2" &&
			row.thumbnailStorageBucketLocator &&
			(row.thumbnailStorageRegion === "default" ||
				row.thumbnailStorageRegion === "eu")
				? {
						provider: "r2" as const,
						bucket: row.thumbnailStorageBucketLocator,
						region: row.thumbnailStorageRegion,
					}
				: thumbnailStorageTarget(env);
		await db
			.update(media)
			.set({
				thumbnailKey: row.thumbnailKey ?? thumbnailKeyFor(row.storageKey),
				thumbnailStorageProvider: target.provider,
				thumbnailStorageBucketLocator: target.bucket,
				thumbnailStorageRegion: target.region,
				thumbnailStatus: "generated",
				thumbnailNextRetryAt: null,
				thumbnailLastError: null,
			})
			.where(
				and(eq(media.id, row.id), eq(media.thumbnailUrl, row.thumbnailUrl)),
			);
		return {
			status: "generated",
			thumbnailKey: row.thumbnailKey ?? thumbnailKeyFor(row.storageKey),
			thumbnailUrl: row.thumbnailUrl,
			storage: target,
		};
	}

	if (row.originalDeletedAt) {
		const result: ThumbnailGenerationResult = {
			status: "source_missing",
			reason: "Original media object was lifecycle-deleted",
		};
		await db
			.update(media)
			.set({
				thumbnailStatus: result.status,
				thumbnailNextRetryAt: null,
				thumbnailLastError: result.reason,
			})
			.where(
				and(
					eq(media.id, row.id),
					isNull(media.thumbnailUrl),
					eq(media.originalDeletedAt, row.originalDeletedAt),
				),
			);
		return result;
	}

	if (
		row.thumbnailStatus === "transient_failure" &&
		row.thumbnailNextRetryAt &&
		row.thumbnailNextRetryAt.getTime() > now.getTime()
	) {
		throw new RetryableMediaError(
			"Thumbnail retry is not due yet",
			Math.max(
				1,
				Math.ceil((row.thumbnailNextRetryAt.getTime() - now.getTime()) / 1000),
			),
		);
	}

	const attempts = row.thumbnailAttempts + 1;
	const claimExpiresAt = new Date(now.getTime() + THUMBNAIL_CLAIM_MS);
	const [claimed] = await db
		.update(media)
		.set({
			thumbnailAttempts: attempts,
			thumbnailNextRetryAt: claimExpiresAt,
			thumbnailLastError: null,
		})
		.where(
			and(
				eq(media.id, row.id),
				eq(media.status, "ready"),
				isNull(media.deletionRequestedAt),
				isNull(media.originalDeletedAt),
				isNull(media.thumbnailUrl),
				inArray(media.thumbnailStatus, ["pending", "transient_failure"]),
				eq(media.thumbnailAttempts, row.thumbnailAttempts),
				or(
					isNull(media.thumbnailNextRetryAt),
					lte(media.thumbnailNextRetryAt, now),
				),
			),
		)
		.returning({ id: media.id });
	if (!claimed) {
		return {
			status: "transient_failure",
			error: "Thumbnail generation is already claimed or no longer needed",
		};
	}

	const result: ThumbnailGenerationResult = !env.IMAGES
		? {
				status: "transient_failure",
				error: "Cloudflare Images binding is unavailable",
			}
		: await (async () => {
				const source = await getStoredObject(
					db,
					env,
					sourceStorageLocatorForThumbnail(row),
				);
				return source
					? generateAndStoreThumbnailFromStoredObject(
							env,
							row.storageKey,
							row.mimeType,
							source.body,
							source.size,
						)
					: {
							status: "source_missing" as const,
							reason:
								"Original media object is missing from configured storage",
						};
			})();
	const claimFence = and(
		eq(media.id, row.id),
		eq(media.status, "ready"),
		eq(media.thumbnailAttempts, attempts),
	);

	if (result.status === "generated") {
		await db
			.update(media)
			.set({
				thumbnailKey: result.thumbnailKey,
				thumbnailStorageProvider: result.storage.provider,
				thumbnailStorageBucketLocator: result.storage.bucket,
				thumbnailStorageRegion: result.storage.region,
				thumbnailUrl: result.thumbnailUrl,
				thumbnailStatus: result.status,
				thumbnailAttempts: attempts,
				thumbnailNextRetryAt: null,
				thumbnailLastError: null,
			})
			.where(claimFence);
		return result;
	}

	if (result.status === "transient_failure") {
		const delaySeconds = thumbnailRetryDelaySeconds(attempts);
		const updated = await db
			.update(media)
			.set({
				thumbnailStatus: result.status,
				thumbnailAttempts: attempts,
				thumbnailNextRetryAt: new Date(now.getTime() + delaySeconds * 1000),
				thumbnailLastError: result.error,
			})
			.where(
				and(
					claimFence,
					isNull(media.originalDeletedAt),
					isNull(media.thumbnailUrl),
				),
			)
			.returning({ id: media.id });
		if (updated.length === 0) return result;
		throw new RetryableMediaError(result.error, delaySeconds);
	}

	const terminalReason = result.reason;
	const updated = await db
		.update(media)
		.set({
			thumbnailStatus: result.status,
			thumbnailAttempts: attempts,
			thumbnailNextRetryAt: null,
			thumbnailLastError: terminalReason,
			...(result.status === "source_missing"
				? {
						url: null,
						originalDeletedAt: sql<Date>`COALESCE(${media.originalDeletedAt}, ${now})`,
					}
				: {}),
		})
		.where(and(claimFence, isNull(media.thumbnailUrl)))
		.returning({ id: media.id });

	if (result.status === "source_missing" && updated.length > 0) {
		await purgePresignedViewCache(
			env,
			row.storageKey,
			undefined,
			row.storageBucketLocator,
		);
	}
	return result;
}

/** Idempotently apply one R2 object notification. */
export async function processMediaEvent(
	db: Database,
	env: Env,
	event: MediaEventMessage,
): Promise<void> {
	const key = event.object.key;
	if (CREATE_ACTIONS.has(event.action)) {
		await handleMediaCreated(db, env, key);
		return;
	}
	if (event.action === "LifecycleDeletion") {
		await handleLifecycleDeletion(db, env, key);
		return;
	}
	if (event.action === "DeleteObject") {
		await handleExplicitDeletion(db, env, key);
	}
}

async function handleMediaCreated(
	db: Database,
	env: Env,
	key: string,
): Promise<void> {
	const [row] = await db
		.select({
			id: media.id,
			organizationId: media.organizationId,
			storageProvider: media.storageProvider,
			storageBucketLocator: media.storageBucketLocator,
			storageRegion: media.storageRegion,
			storageLocationId: media.storageLocationId,
			storageCredentialVersion: media.storageCredentialVersion,
			storageKey: media.storageKey,
			mimeType: media.mimeType,
			status: media.status,
			thumbnailUrl: media.thumbnailUrl,
			thumbnailKey: media.thumbnailKey,
			thumbnailStorageProvider: media.thumbnailStorageProvider,
			thumbnailStorageBucketLocator: media.thumbnailStorageBucketLocator,
			thumbnailStorageRegion: media.thumbnailStorageRegion,
			thumbnailStatus: media.thumbnailStatus,
			thumbnailAttempts: media.thumbnailAttempts,
			thumbnailNextRetryAt: media.thumbnailNextRetryAt,
			originalDeletedAt: media.originalDeletedAt,
		})
		.from(media)
		.where(eq(media.storageKey, key))
		.limit(1);

	// Direct and presigned uploads create their row before R2 can receive bytes.
	// A namespaced object without a row is therefore a late or abandoned write;
	// delete it instead of leaving an unowned object until lifecycle expiry.
	if (!row) {
		if (isManagedMediaStorageKey(key)) {
			await env.MEDIA_BUCKET.delete(key);
			await purgePresignedViewCache(env, key);
		}
		return;
	}

	// A PUT may complete after the browser abandoned its intent. Reset the
	// original-object checkpoint and run the durable deletion state machine. If
	// a concurrent final sweep removed the row, issue the idempotent delete here.
	if (inArrayValue(row.status, ["deleting", "deletion_failed"])) {
		const now = new Date();
		const claimed = await db
			.update(media)
			.set({
				status: "deleting",
				originalDeletionConfirmedAt: null,
				deletionNextRetryAt: now,
				deletionLastError: "late_upload_arrived",
			})
			.where(
				and(
					eq(media.id, row.id),
					inArray(media.status, ["deleting", "deletion_failed"]),
				),
			)
			.returning({ id: media.id });
		if (claimed.length > 0) {
			await processMediaDeletion(db, env, row.id, now);
		} else {
			await env.MEDIA_BUCKET.delete(key);
			await purgePresignedViewCache(env, key);
		}
		return;
	}

	// A direct upload that crashed after R2 accepted the object is recoverable
	// from the create event. Presigned rows remain `pending` until the confirm
	// endpoint validates their actual MIME type and size.
	let storedObjectValidated = false;
	if (inArrayValue(row.status, ["uploading", "upload_failed"])) {
		const storedObject = await env.MEDIA_BUCKET.head(key);
		if (!storedObject) {
			throw new RetryableMediaError(
				`Stored media object ${key} was not visible during create-event validation`,
				30,
			);
		}
		const validation = validateStoredMediaObject(storedObject);
		if (!validation.ok) {
			await retireRejectedMediaUpload(db, env, row.id);
			return;
		}
		storedObjectValidated = true;
		row.mimeType = validation.mimeType;
		await db
			.update(media)
			.set({
				status: "ready",
				size: validation.size,
				mimeType: validation.mimeType,
			})
			.where(
				and(
					eq(media.id, row.id),
					inArray(media.status, ["uploading", "upload_failed"]),
				),
			);
		row.status = "ready";
	}

	if (row.status !== "ready") return;
	// A still-valid presigned PUT URL can overwrite an already-confirmed key. Re-
	// validate every ready-row create notification so a later active-content or
	// oversized overwrite is retired instead of remaining publishable.
	if (!storedObjectValidated) {
		const readyObject = await env.MEDIA_BUCKET.head(key);
		if (!readyObject) {
			throw new RetryableMediaError(
				`Stored media object ${key} was not visible during ready-event validation`,
				30,
			);
		}
		const readyValidation = validateStoredMediaObject(readyObject);
		if (!readyValidation.ok) {
			await retireRejectedMediaUpload(db, env, row.id);
			return;
		}
	}
	if (
		row.thumbnailStatus === "generated" ||
		row.thumbnailStatus === "unsupported" ||
		row.thumbnailStatus === "source_missing"
	) {
		return;
	}

	await processThumbnailForMedia(db, env, row);
}

function inArrayValue(value: string, allowed: readonly string[]): boolean {
	return allowed.includes(value);
}

export function isManagedMediaStorageKey(key: string): boolean {
	const parts = key.split("/");
	return (
		parts.length >= 4 &&
		parts[0] !== "" &&
		parts[1] === "media" &&
		parts[2]?.startsWith("file_") === true &&
		parts.slice(3).every((part) => part !== "")
	);
}

async function handleLifecycleDeletion(
	db: Database,
	env: Env,
	key: string,
): Promise<void> {
	const deletedAt = new Date();
	await db
		.update(media)
		.set({
			url: null,
			originalDeletedAt: deletedAt,
			// Evaluate thumbnail_url in this UPDATE, not in a stale preceding read:
			// generation may finish concurrently with the lifecycle event.
			thumbnailStatus: sql<"generated" | "source_missing">`CASE
				WHEN ${media.thumbnailUrl} IS NOT NULL THEN 'generated'
				ELSE 'source_missing'
			END`,
			thumbnailNextRetryAt: null,
			thumbnailLastError: sql<string | null>`CASE
				WHEN ${media.thumbnailUrl} IS NOT NULL THEN NULL
				ELSE 'Original lifecycle-deleted before a durable thumbnail was generated'
			END`,
		})
		.where(eq(media.storageKey, key));
	await purgePresignedViewCache(env, key);
}

async function handleExplicitDeletion(
	db: Database,
	env: Env,
	key: string,
): Promise<void> {
	const now = new Date();
	const rows = await db
		.update(media)
		.set({
			status: "deleting",
			url: null,
			thumbnailKey: sql<string>`COALESCE(${media.thumbnailKey}, ${thumbnailKeyFor(key)})`,
			thumbnailStorageProvider: sql<"r2">`COALESCE(${media.thumbnailStorageProvider}, 'r2')`,
			thumbnailStorageBucketLocator: sql<string>`COALESCE(${media.thumbnailStorageBucketLocator}, ${env.R2_THUMBNAIL_BUCKET_NAME})`,
			thumbnailStorageRegion: sql<"default" | "eu">`COALESCE(${media.thumbnailStorageRegion}, ${env.R2_THUMBNAIL_BUCKET_JURISDICTION})`,
			deletionRequestedAt: sql<Date>`COALESCE(${media.deletionRequestedAt}, ${now})`,
			originalDeletionConfirmedAt: now,
			deletionNextRetryAt: now,
			deletionLastError: null,
		})
		.where(eq(media.storageKey, key))
		.returning({ id: media.id });
	await purgePresignedViewCache(env, key);
	for (const row of rows) await processMediaDeletion(db, env, row.id, now);
}
