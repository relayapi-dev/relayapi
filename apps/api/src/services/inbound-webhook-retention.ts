import { createDb, inboundWebhookEvents } from "@relayapi/db";
import { and, asc, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "../types";

const DEFAULT_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 500;
const REDACTED_VALUE = "[REDACTED]";

/**
 * Redact expired raw provider payloads without deleting their durable delivery
 * keys. Manual review may extend retention, but the schema caps that extension
 * at 90 days from receipt.
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

	if (candidates.length === 0) return 0;
	const ids = candidates.map(({ id }) => id);
	const redacted = await db
		.update(inboundWebhookEvents)
		.set({
			payloadCiphertext: REDACTED_VALUE,
			payloadKeyId: REDACTED_VALUE,
			contentType: null,
			signatureMetadata: null,
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

	return redacted.length;
}
