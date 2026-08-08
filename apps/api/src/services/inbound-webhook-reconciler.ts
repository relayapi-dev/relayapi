import { createDb, inboundWebhookEvents } from "@relayapi/db";
import {
	and,
	asc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { recordQueueFailureRecord } from "../queues/failures";
import type { Env } from "../types";

const STALE_RECEIPT_MS = 5 * 60 * 1000;
const MAX_RECEIPT_ATTEMPTS = 10;
const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;

function retryableReceipt(cutoff: Date, now: Date) {
	return and(
		isNull(inboundWebhookEvents.redactedAt),
		gt(inboundWebhookEvents.expiresAt, now),
		or(
			and(
				eq(inboundWebhookEvents.status, "received"),
				lt(inboundWebhookEvents.receivedAt, cutoff),
			),
			and(
				eq(inboundWebhookEvents.status, "queued"),
				lt(inboundWebhookEvents.receivedAt, cutoff),
				or(
					isNull(inboundWebhookEvents.claimedAt),
					lt(inboundWebhookEvents.claimedAt, cutoff),
				),
			),
			and(
				inArray(inboundWebhookEvents.status, ["processing", "failed"]),
				or(
					isNull(inboundWebhookEvents.claimedAt),
					lt(inboundWebhookEvents.claimedAt, cutoff),
				),
			),
		),
	);
}

/**
 * Re-dispatch receipts whose Queue handoff or consumer lease was interrupted.
 * Claims are fenced by status/time and the query is bounded; duplicate sends
 * are harmless because the inbox consumer atomically claims the receipt row.
 */
export async function reconcileInboundWebhookReceipts(
	env: Env,
	requestedLimit = DEFAULT_BATCH_SIZE,
): Promise<{ requeued: number; exhausted: number; failed: number }> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.max(1, Math.min(requestedLimit, MAX_BATCH_SIZE));
	const cutoff = new Date(Date.now() - STALE_RECEIPT_MS);
	const now = new Date();
	let requeued = 0;
	let failed = 0;

	const candidates = await db
		.select({ id: inboundWebhookEvents.id })
		.from(inboundWebhookEvents)
		.where(
			and(
				lt(inboundWebhookEvents.attempts, MAX_RECEIPT_ATTEMPTS),
				retryableReceipt(cutoff, now),
			),
		)
		.orderBy(asc(inboundWebhookEvents.receivedAt))
		.limit(limit);

	const claimedReceipts: Array<{ id: string; receivedAt: Date }> = [];
	for (const candidate of candidates) {
		const claimedAt = new Date();
		const [receipt] = await db
			.update(inboundWebhookEvents)
			.set({
				status: "queued",
				claimedAt,
				lastError: null,
				attempts: sql`${inboundWebhookEvents.attempts} + 1`,
			})
			.where(
				and(
					eq(inboundWebhookEvents.id, candidate.id),
					lt(inboundWebhookEvents.attempts, MAX_RECEIPT_ATTEMPTS),
					retryableReceipt(cutoff, now),
				),
			)
			.returning({
				id: inboundWebhookEvents.id,
				receivedAt: inboundWebhookEvents.receivedAt,
			});
		if (!receipt) continue;
		claimedReceipts.push(receipt);
	}

	if (claimedReceipts.length > 0) {
		try {
			await env.INBOX_QUEUE.sendBatch(
				claimedReceipts.map((receipt) => ({
					body: {
						type: "raw_platform_webhook",
						receipt_id: receipt.id,
					},
				})),
			);
			requeued += claimedReceipts.length;
		} catch (error) {
			const updated = await db
				.update(inboundWebhookEvents)
				.set({
					status: "failed",
					lastError: error instanceof Error ? error.message : String(error),
				})
				.where(
					and(
						inArray(
							inboundWebhookEvents.id,
							claimedReceipts.map((receipt) => receipt.id),
						),
						eq(inboundWebhookEvents.status, "queued"),
					),
				)
				.returning({ id: inboundWebhookEvents.id });
			failed += updated.length;
		}
	}

	let exhausted = 0;
	const terminal = await db
		.select({
			id: inboundWebhookEvents.id,
			attempts: inboundWebhookEvents.attempts,
			provider: inboundWebhookEvents.provider,
			receivedAt: inboundWebhookEvents.receivedAt,
			organizationIds: inboundWebhookEvents.organizationIds,
			lastError: inboundWebhookEvents.lastError,
		})
		.from(inboundWebhookEvents)
		.where(
			and(
				gte(inboundWebhookEvents.attempts, MAX_RECEIPT_ATTEMPTS),
				retryableReceipt(cutoff, now),
			),
		)
		.orderBy(asc(inboundWebhookEvents.receivedAt))
		.limit(limit);

	for (const receipt of terminal) {
		await recordQueueFailureRecord(env, {
			queueName: "relayapi-inbox-raw",
			messageId: receipt.id,
			attempts: receipt.attempts,
			payload: {
				type: "raw_platform_webhook",
				receipt_id: receipt.id,
				organization_ids: receipt.organizationIds,
			},
			kind: "dead_letter",
			error:
				receipt.lastError ??
				`Raw ${receipt.provider} receipt exhausted retries`,
			organizationIds: receipt.organizationIds,
			operationId: receipt.id,
		});
		const updated = await db
			.update(inboundWebhookEvents)
			.set({ status: "exhausted" })
			.where(
				and(
					eq(inboundWebhookEvents.id, receipt.id),
					gte(inboundWebhookEvents.attempts, MAX_RECEIPT_ATTEMPTS),
					retryableReceipt(cutoff, now),
				),
			)
			.returning({ id: inboundWebhookEvents.id });
		if (updated.length > 0) exhausted += 1;
	}

	if (requeued > 0 || exhausted > 0 || failed > 0) {
		console.log("[Inbound receipt reconciler] batch complete", {
			requeued,
			exhausted,
			failed,
		});
	}
	return { requeued, exhausted, failed };
}
