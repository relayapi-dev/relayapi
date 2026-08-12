import {
	createDb,
	type Database,
	media,
	mediaUploadSessions,
} from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { decryptToken } from "../lib/crypto";
import { isR2NoSuchUploadError } from "../lib/r2-multipart";
import type { Env } from "../types";
import { retireRejectedMediaUpload } from "./media-reliability";
import { headStoredObject, storageLocatorForMedia } from "./storage-locator";

function uploadIdContext(sessionId: string) {
	return { recordId: sessionId, field: "multipart_upload_id" };
}

export const MEDIA_UPLOAD_SESSION_TERMINAL_GRACE_MS = 24 * 60 * 60 * 1_000;
export const MEDIA_UPLOAD_SESSION_CLEANUP_LEASE_MS = 5 * 60 * 1_000;

interface MediaUploadSessionCleanupOptions {
	db?: Database;
	now?: Date;
	expiryLimit?: number;
	deleteLimit?: number;
}

/** Abort expired multipart sessions so abandoned parts stop consuming storage. */
export async function cleanupExpiredMediaUploadSessions(
	env: Env,
	options: MediaUploadSessionCleanupOptions = {},
): Promise<number> {
	const db = options.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options.now ?? new Date();
	const expiryLimit = Math.min(Math.max(options.expiryLimit ?? 50, 1), 500);
	const deleteLimit = Math.min(Math.max(options.deleteLimit ?? 500, 1), 5_000);
	const rows = await db
		.select({ session: mediaUploadSessions, record: media })
		.from(mediaUploadSessions)
		.innerJoin(
			media,
			and(
				eq(media.id, mediaUploadSessions.mediaId),
				eq(media.organizationId, mediaUploadSessions.organizationId),
				eq(media.scopeKey, mediaUploadSessions.scopeKey),
			),
		)
		.where(
			and(
				inArray(mediaUploadSessions.status, [
					"created",
					"uploading",
					"completing",
					"aborting",
					"failed",
				]),
				lte(mediaUploadSessions.expiresAt, now),
				or(
					isNull(mediaUploadSessions.leaseExpiresAt),
					lte(mediaUploadSessions.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(asc(mediaUploadSessions.expiresAt), asc(mediaUploadSessions.id))
		.limit(expiryLimit);

	let expired = 0;
	for (const row of rows) {
		const needsProviderAbort =
			row.session.mode === "multipart" &&
			Boolean(row.session.multipartUploadIdCiphertext);
		const leaseExpiresAt = needsProviderAbort
			? new Date(now.getTime() + MEDIA_UPLOAD_SESSION_CLEANUP_LEASE_MS)
			: null;
		const [claimed] = await db
			.update(mediaUploadSessions)
			.set({
				status: needsProviderAbort ? "aborting" : "expired",
				leaseToken: sql`${mediaUploadSessions.leaseToken} + 1`,
				leaseExpiresAt,
				...(needsProviderAbort ? {} : { multipartUploadIdCiphertext: null }),
				updatedAt: now,
			})
			.where(
				and(
					eq(mediaUploadSessions.id, row.session.id),
					eq(mediaUploadSessions.status, row.session.status),
					eq(mediaUploadSessions.leaseToken, row.session.leaseToken),
					lte(mediaUploadSessions.expiresAt, now),
					or(
						isNull(mediaUploadSessions.leaseExpiresAt),
						lte(mediaUploadSessions.leaseExpiresAt, now),
					),
				),
			)
			.returning({
				id: mediaUploadSessions.id,
				leaseToken: mediaUploadSessions.leaseToken,
			});
		if (!claimed) continue;
		try {
			if (needsProviderAbort && row.session.multipartUploadIdCiphertext) {
				const locator = storageLocatorForMedia(row.record);
				let completedObject = await headStoredObject(db, env, locator);
				if (!completedObject) {
					const uploadId = await decryptToken(
						row.session.multipartUploadIdCiphertext,
						env.ENCRYPTION_KEY,
						uploadIdContext(row.session.id),
					);
					try {
						await env.MEDIA_BUCKET.resumeMultipartUpload(
							row.record.storageKey,
							uploadId,
						).abort();
					} catch (abortError) {
						// R2 may report NoSuchUpload after multipart completion won the
						// provider race or another fenced owner already aborted it. A
						// completed object is strongly visible to the exact re-head; when it
						// remains absent, only R2's documented NoSuchUpload (10024) proves
						// the multipart authority no longer exists.
						completedObject = await headStoredObject(db, env, locator);
						if (!completedObject && !isR2NoSuchUploadError(abortError)) {
							throw abortError;
						}
					}
				}
			}
			const [finalized] = await db
				.update(mediaUploadSessions)
				.set({
					status: "expired",
					multipartUploadIdCiphertext: null,
					leaseExpiresAt: null,
					lastErrorCode: "UPLOAD_SESSION_EXPIRED",
					lastError: "Upload session expired before completion",
					updatedAt: now,
				})
				.where(
					and(
						eq(mediaUploadSessions.id, row.session.id),
						eq(
							mediaUploadSessions.status,
							needsProviderAbort ? "aborting" : "expired",
						),
						eq(mediaUploadSessions.leaseToken, claimed.leaseToken),
					),
				)
				.returning({ id: mediaUploadSessions.id });
			if (!finalized) continue;
			await retireRejectedMediaUpload(
				db,
				env,
				row.record.id,
				now,
				"upload_session_expired",
			);
			expired++;
		} catch (error) {
			if (needsProviderAbort) {
				await db
					.update(mediaUploadSessions)
					.set({
						leaseExpiresAt: now,
						lastErrorCode: "UPLOAD_SESSION_ABORT_RETRY",
						lastError: "Provider abort must be retried",
						updatedAt: now,
					})
					.where(
						and(
							eq(mediaUploadSessions.id, row.session.id),
							eq(mediaUploadSessions.status, "aborting"),
							eq(mediaUploadSessions.leaseToken, claimed.leaseToken),
						),
					);
			}
			console.error("[media-upload] expired session cleanup failed", error);
		}
	}

	// Keep a short retry/polling grace, then remove terminal metadata in one
	// bounded ordered statement. Multipart authority must already be shredded.
	const terminalCutoff = new Date(
		now.getTime() - MEDIA_UPLOAD_SESSION_TERMINAL_GRACE_MS,
	);
	const deleted = await db.execute<{ id: string }>(sql`
		DELETE FROM media_upload_sessions
		WHERE id IN (
			SELECT id
			FROM media_upload_sessions
			WHERE status IN ('completed', 'aborted', 'failed', 'expired')
			  AND expires_at <= ${terminalCutoff}
			  AND updated_at <= ${terminalCutoff}
			  AND lease_expires_at IS NULL
			  AND multipart_upload_id_ciphertext IS NULL
			ORDER BY expires_at, id
			LIMIT ${deleteLimit}
		)
		RETURNING id
	`);
	return expired + deleted.length;
}
