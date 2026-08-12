import { createDb, media, queueFailures } from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { decryptQueueFailurePayload } from "../queues/failures";
import { deploymentQueueNames } from "../queues/queue-class";
import type { Env } from "../types";
import { backfillExternalPostPreviews } from "./external-post-sync/previews";
import {
	isMediaEventMessage,
	processMediaEvent,
	processThumbnailForMedia,
	RetryableMediaError,
} from "./media-reliability";
import { headStoredObject, storageLocatorForMedia } from "./storage-locator";

const RECONCILE_BATCH = 25;
const ABANDONED_DIRECT_UPLOAD_MS = 15 * 60 * 1000;
export const MEDIA_DEAD_LETTER_QUEUE_NAMES = deploymentQueueNames({
	capability: "media-cleanup",
	role: "dead-letter",
});

/**
 * Scheduled media reconciliation. In order, it replays durably recorded R2
 * events, repairs direct uploads interrupted between R2 and Postgres, then
 * retries only pending/transient thumbnail work that is due.
 */
export async function backfillMissingThumbnails(
	env: Env,
	limit: number = RECONCILE_BATCH,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	await replayMediaDeadLetters(db, env, limit);
	await reconcileDirectUploads(db, env, limit);
	await retryDueThumbnails(db, env, limit);
	await backfillExternalPostPreviews(env, limit);
}

async function replayMediaDeadLetters(
	db: ReturnType<typeof createDb>,
	env: Env,
	limit: number,
): Promise<void> {
	const failures = await db
		.select({
			id: queueFailures.id,
			queueName: queueFailures.queueName,
			messageId: queueFailures.messageId,
			payloadCiphertext: queueFailures.payloadCiphertext,
			attempts: queueFailures.attempts,
		})
		.from(queueFailures)
		.where(
			and(
				inArray(queueFailures.queueName, [...MEDIA_DEAD_LETTER_QUEUE_NAMES]),
				eq(queueFailures.status, "unresolved"),
			),
		)
		.orderBy(asc(queueFailures.createdAt))
		.limit(limit);

	for (const failure of failures) {
		const payload = await decryptQueueFailurePayload(env, failure).catch(
			() => null,
		);
		if (!isMediaEventMessage(payload)) {
			await db
				.update(queueFailures)
				.set({
					status: "dismissed",
					error: "Invalid media event payload in durable DLQ record",
					resolvedAt: new Date(),
				})
				.where(eq(queueFailures.id, failure.id));
			continue;
		}

		try {
			await processMediaEvent(db, env, payload);
			await db
				.update(queueFailures)
				.set({ status: "replayed", error: null, resolvedAt: new Date() })
				.where(eq(queueFailures.id, failure.id));
		} catch (error) {
			await db
				.update(queueFailures)
				.set({
					attempts: sql`${queueFailures.attempts} + 1`,
					error: error instanceof Error ? error.message : String(error),
				})
				.where(eq(queueFailures.id, failure.id));
		}
	}
}

async function reconcileDirectUploads(
	db: ReturnType<typeof createDb>,
	env: Env,
	limit: number,
): Promise<void> {
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
			createdAt: media.createdAt,
		})
		.from(media)
		.where(inArray(media.status, ["uploading", "upload_failed"]))
		.orderBy(asc(media.createdAt))
		.limit(limit);

	const now = new Date();
	for (const row of rows) {
		try {
			const object = await headStoredObject(
				db,
				env,
				storageLocatorForMedia(row),
			);
			if (object) {
				await db
					.update(media)
					.set({ status: "ready", size: object.size })
					.where(
						and(
							eq(media.id, row.id),
							inArray(media.status, ["uploading", "upload_failed"]),
						),
					);
				continue;
			}

			if (
				row.status === "uploading" &&
				now.getTime() - row.createdAt.getTime() >= ABANDONED_DIRECT_UPLOAD_MS
			) {
				await db
					.update(media)
					.set({ status: "upload_failed" })
					.where(and(eq(media.id, row.id), eq(media.status, "uploading")));
			}
		} catch (error) {
			console.error(
				`[Media Reconcile] Failed to inspect direct upload ${row.id}:`,
				error,
			);
		}
	}
}

async function retryDueThumbnails(
	db: ReturnType<typeof createDb>,
	env: Env,
	limit: number,
): Promise<void> {
	const now = new Date();
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
				eq(media.status, "ready"),
				isNull(media.originalDeletedAt),
				isNull(media.thumbnailUrl),
				inArray(media.thumbnailStatus, ["pending", "transient_failure"]),
				or(
					isNull(media.thumbnailNextRetryAt),
					lte(media.thumbnailNextRetryAt, now),
				),
			),
		)
		.orderBy(asc(media.thumbnailNextRetryAt), asc(media.createdAt))
		.limit(limit);

	for (const row of rows) {
		try {
			await processThumbnailForMedia(db, env, row, now);
		} catch (error) {
			if (!(error instanceof RetryableMediaError)) {
				console.error(
					`[Media Reconcile] Thumbnail retry failed for ${row.id}:`,
					error,
				);
			}
		}
	}
}
