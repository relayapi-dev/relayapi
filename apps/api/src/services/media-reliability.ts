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
import { purgePresignedViewCache } from "../lib/r2-presign";
import {
	generateAndStoreThumbnail,
	type ThumbnailGenerationResult,
	thumbnailKeyFor,
} from "../lib/thumbnails";
import type { Env } from "../types";

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
const MEDIA_UPLOAD_STALE_MS = 10 * 60 * 1000;
const MEDIA_DELETION_ALERT_ATTEMPTS = 8;
const THUMBNAIL_CLAIM_MS = 5 * 60 * 1000;

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
			storageKey: media.storageKey,
			thumbnailKey: media.thumbnailKey,
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

	const deleteObject = async (bucket: R2Bucket, key: string): Promise<void> => {
		await bucket.delete(key);
	};
	const [originalResult, thumbnailResult] = await Promise.allSettled([
		row.originalDeletionConfirmedAt
			? Promise.resolve()
			: deleteObject(env.MEDIA_BUCKET, row.storageKey),
		row.thumbnailDeletionConfirmedAt
			? Promise.resolve()
			: deleteObject(
					env.THUMBNAIL_BUCKET,
					row.thumbnailKey ?? thumbnailKeyFor(row.storageKey),
				),
	]);
	const originalComplete = originalResult.status === "fulfilled";
	const thumbnailComplete = thumbnailResult.status === "fulfilled";

	if (originalComplete) {
		await purgePresignedViewCache(env, row.storageKey);
	}

	if (originalComplete && thumbnailComplete) {
		// Resolve a previously surfaced operator alert before removing the only
		// retry source. If this write fails, the tombstone remains and retries.
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
				payload: {
					media_id: row.id,
					operation_id: row.id,
					organization_id: row.organizationId,
				},
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
	const staleBefore = new Date(Date.now() - MEDIA_UPLOAD_STALE_MS);
	const rows = await db
		.select({
			id: media.id,
			storageKey: media.storageKey,
			mimeType: media.mimeType,
			thumbnailUrl: media.thumbnailUrl,
			thumbnailStatus: media.thumbnailStatus,
			thumbnailAttempts: media.thumbnailAttempts,
			thumbnailNextRetryAt: media.thumbnailNextRetryAt,
			originalDeletedAt: media.originalDeletedAt,
		})
		.from(media)
		.where(
			and(
				inArray(media.status, ["uploading", "upload_failed"]),
				lt(media.createdAt, staleBefore),
				isNull(media.deletionRequestedAt),
			),
		)
		.orderBy(asc(media.createdAt), asc(media.id))
		.limit(MEDIA_UPLOAD_RECONCILIATION_BATCH_SIZE);

	let processed = 0;
	for (const row of rows) {
		try {
			const object = await env.MEDIA_BUCKET.head(row.storageKey);
			if (object) {
				const updated = await db
					.update(media)
					.set({ status: "ready", size: object.size })
					.where(
						and(
							eq(media.id, row.id),
							inArray(media.status, ["uploading", "upload_failed"]),
							isNull(media.deletionRequestedAt),
						),
					)
					.returning({ id: media.id });
				if (updated.length > 0) {
					await processThumbnailForMedia(db, env, row).catch((error) => {
						if (!(error instanceof RetryableMediaError)) throw error;
					});
				}
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
	| "mimeType"
	| "thumbnailUrl"
	| "thumbnailStatus"
	| "thumbnailAttempts"
	| "thumbnailNextRetryAt"
	| "originalDeletedAt"
>;

/** Generate one thumbnail attempt and persist its typed terminal/retry state. */
export async function processThumbnailForMedia(
	db: Database,
	env: Env,
	row: ThumbnailRow,
	now: Date = new Date(),
): Promise<ThumbnailGenerationResult> {
	if (row.thumbnailUrl) {
		await db
			.update(media)
			.set({
				thumbnailStatus: "generated",
				thumbnailNextRetryAt: null,
				thumbnailLastError: null,
			})
			.where(
				and(eq(media.id, row.id), eq(media.thumbnailUrl, row.thumbnailUrl)),
			);
		return {
			status: "generated",
			thumbnailKey: thumbnailKeyFor(row.storageKey),
			thumbnailUrl: row.thumbnailUrl,
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

	const result = await generateAndStoreThumbnail(
		env,
		row.storageKey,
		row.mimeType,
	);
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
		await purgePresignedViewCache(env, row.storageKey);
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
		await handleMediaCreated(db, env, key, event.object.size);
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
	objectSize?: number,
): Promise<void> {
	const [row] = await db
		.select({
			id: media.id,
			storageKey: media.storageKey,
			mimeType: media.mimeType,
			status: media.status,
			thumbnailUrl: media.thumbnailUrl,
			thumbnailStatus: media.thumbnailStatus,
			thumbnailAttempts: media.thumbnailAttempts,
			thumbnailNextRetryAt: media.thumbnailNextRetryAt,
			originalDeletedAt: media.originalDeletedAt,
		})
		.from(media)
		.where(eq(media.storageKey, key))
		.limit(1);

	// Other features share this bucket. A missing media-library row is not an
	// error, and direct uploads now create their row before the R2 PUT begins.
	if (!row) return;

	// A direct upload that crashed after R2 accepted the object is recoverable
	// from the create event. Presigned rows remain `pending` until the confirm
	// endpoint validates their actual MIME type and size.
	if (inArrayValue(row.status, ["uploading", "upload_failed"])) {
		await db
			.update(media)
			.set({
				status: "ready",
				...(typeof objectSize === "number" ? { size: objectSize } : {}),
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
