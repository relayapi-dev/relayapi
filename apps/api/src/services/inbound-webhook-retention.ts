import { createDb, inboundWebhookEvents } from "@relayapi/db";
import { and, asc, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "../types";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const REDACTED_VALUE = "[REDACTED]";
export const INBOUND_WEBHOOK_RECEIPT_RETENTION_DAYS = 365;

/**
 * Redact expired raw provider payloads, then drain minimized delivery receipts
 * after one year. Manual review may extend payload retention, but the schema
 * caps that extension at 90 days from receipt. Active organization holds pause
 * only deletion of the already-redacted shared receipt.
 */
export async function redactExpiredInboundWebhookPayloads(
	env: Env,
	requestedLimit = DEFAULT_BATCH_SIZE,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const staleProcessingBefore = new Date(now.getTime() - 5 * 60 * 1000);
	const limit = Math.max(1, Math.min(requestedLimit, MAX_BATCH_SIZE));
	const safeToRedact = or(
		sql`${inboundWebhookEvents.status} <> 'processing'`,
		isNull(inboundWebhookEvents.claimedAt),
		lte(inboundWebhookEvents.claimedAt, staleProcessingBefore),
	);
	const candidates = await db
		.select({ id: inboundWebhookEvents.id })
		.from(inboundWebhookEvents)
		.where(
			and(
				isNull(inboundWebhookEvents.redactedAt),
				lte(inboundWebhookEvents.expiresAt, now),
				or(
					isNull(inboundWebhookEvents.manualReviewUntil),
					lte(inboundWebhookEvents.manualReviewUntil, now),
				),
				safeToRedact,
			),
		)
		.orderBy(asc(inboundWebhookEvents.expiresAt), asc(inboundWebhookEvents.id))
		.limit(limit);

	let redactedCount = 0;
	if (candidates.length > 0) {
		const ids = candidates.map(({ id }) => id);
		const redacted = await db
			.update(inboundWebhookEvents)
			.set({
				payloadCiphertext: REDACTED_VALUE,
				payloadKeyId: REDACTED_VALUE,
				contentType: null,
				signatureMetadata: null,
				lastError: sql`CASE
					WHEN ${inboundWebhookEvents.lastError} IS NULL THEN NULL
					ELSE 'retained_failure'
				END`,
				redactedAt: now,
				// An expired unfinished receipt can no longer be replayed after its
				// source payload is removed. Completed receipts retain their outcome.
				status: sql`CASE WHEN ${inboundWebhookEvents.status} = 'completed' THEN 'completed' ELSE 'exhausted' END`,
			})
			.where(
				and(
					inArray(inboundWebhookEvents.id, ids),
					isNull(inboundWebhookEvents.redactedAt),
					lte(inboundWebhookEvents.expiresAt, now),
					or(
						isNull(inboundWebhookEvents.manualReviewUntil),
						lte(inboundWebhookEvents.manualReviewUntil, now),
					),
					safeToRedact,
				),
			)
			.returning({ id: inboundWebhookEvents.id });
		redactedCount = redacted.length;
	}

	const receiptCutoff = new Date(
		now.getTime() -
			INBOUND_WEBHOOK_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	);
	const deleted = (await db.execute(sql`
		WITH due AS (
			SELECT receipt.id
			  FROM ${inboundWebhookEvents} AS receipt
			 WHERE receipt.redacted_at IS NOT NULL
			   AND receipt.received_at <= ${receiptCutoff}
			   AND NOT EXISTS (
					SELECT 1
					  FROM erasure_holds AS hold
					 WHERE hold.released_at IS NULL
					   AND hold.subject_kind = 'organization'
					   AND hold.subject_id = ANY(receipt.organization_ids)
					   AND hold.organization_tombstone_id = hold.subject_id
			   )
			 ORDER BY receipt.received_at, receipt.id
			 LIMIT ${limit}
			 FOR UPDATE OF receipt SKIP LOCKED
		)
		DELETE FROM ${inboundWebhookEvents} AS receipt
		 USING due
		 WHERE receipt.id = due.id
		RETURNING receipt.id
	`)) as unknown as Array<{ id: string }>;

	return redactedCount + deleted.length;
}
