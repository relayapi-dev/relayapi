import { createDb, inboxEventEffects, queueFailures } from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NormalizedInboxQueueMessage } from "../routes/platform-webhooks";
import type { Env } from "../types";

const MAX_RECONCILE_BATCH = 100;
const REPLAY_RESERVATION_MS = 5 * 60_000;
const REPLAY_FAILURE_DELAY_MS = 30_000;
const INBOX_QUEUE_NAME = "relayapi-inbox";
const MAX_QUEUE_MESSAGE_BYTES = 120 * 1024;
const MAX_QUEUE_BATCH_BYTES = 240 * 1024;

export function chunkInboxReplayEntries<T extends { bytes: number }>(
	entries: T[],
): { chunks: T[][]; oversized: T[] } {
	const chunks: T[][] = [];
	const oversized: T[] = [];
	let chunk: T[] = [];
	let chunkBytes = 0;
	for (const entry of entries) {
		if (entry.bytes > MAX_QUEUE_MESSAGE_BYTES) {
			oversized.push(entry);
			continue;
		}
		if (
			chunk.length >= 100 ||
			(chunk.length > 0 && chunkBytes + entry.bytes > MAX_QUEUE_BATCH_BYTES)
		) {
			chunks.push(chunk);
			chunk = [];
			chunkBytes = 0;
		}
		chunk.push(entry);
		chunkBytes += entry.bytes;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return { chunks, oversized };
}

async function recordUnknownInboxEffects(
	db: ReturnType<typeof createDb>,
	limit: number,
): Promise<number> {
	return db.transaction(async (tx) => {
		const unknown = (await tx.execute(sql`
			SELECT effect.id,
			       effect.organization_id,
			       effect.effect,
			       effect.attempts,
			       effect.replay_payload,
			       effect.error
			  FROM inbox_event_effects AS effect
			 WHERE effect.status = 'unknown'
			   AND NOT EXISTS (
			         SELECT 1
			           FROM queue_failures AS failure
			          WHERE failure.queue_name = ${INBOX_QUEUE_NAME}
			            AND failure.message_id = 'effect:' || effect.id
			            AND failure.organization_ids @> ARRAY[effect.organization_id]::text[]
			       )
			 ORDER BY effect.updated_at ASC, effect.id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		`)) as unknown as Array<{
			id: string;
			organization_id: string;
			effect: string;
			attempts: number;
			replay_payload: Record<string, unknown> | null;
			error: string | null;
		}>;
		if (unknown.length === 0) return 0;

		await tx
			.insert(queueFailures)
			.values(
				unknown.map((effect) => ({
					queueName: INBOX_QUEUE_NAME,
					messageId: `effect:${effect.id}`,
					organizationIds: [effect.organization_id],
					operationId: effect.id,
					failureKind: "unknown_external_outcome" as const,
					attempts: effect.attempts,
					payload: {
						type: "inbox_effect_reconciliation",
						effect_id: effect.id,
						effect: effect.effect,
						replay_payload: effect.replay_payload,
					},
					error:
						effect.error ?? "Inbound effect outcome requires reconciliation",
				})),
			)
			.onConflictDoUpdate({
				target: [queueFailures.queueName, queueFailures.messageId],
				set: {
					attempts: sql`GREATEST(${queueFailures.attempts}, excluded.attempts)`,
					error: sql`excluded.error`,
					organizationIds: sql`(
						SELECT COALESCE(array_agg(DISTINCT merged.value), ARRAY[]::text[])
						  FROM unnest(${queueFailures.organizationIds} || excluded.organization_ids) AS merged(value)
					)`,
				},
			});
		return unknown.length;
	});
}

/**
 * Recover inbox effects that died before their side-effect boundary and enqueue
 * their persisted source message. Effects whose boundary marker was written are
 * moved to `unknown`; replaying those automatically could duplicate a message,
 * automation action, or realtime notification.
 */
export async function reconcileInboxEventEffects(
	env: Env,
	limit = MAX_RECONCILE_BATCH,
): Promise<{
	recoveredPending: number;
	markedUnknown: number;
	unknownRecorded: number;
	replayedMessages: number;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const batchSize = Math.min(
		Math.max(Math.trunc(limit), 1),
		MAX_RECONCILE_BATCH,
	);
	const recovered = (await db.execute(sql`
		WITH expired AS (
			SELECT id
			  FROM inbox_event_effects
			 WHERE status = 'in_flight'
			   AND lease_expires_at < NOW()
			 ORDER BY lease_expires_at ASC, id ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE inbox_event_effects AS effect
		   SET status = CASE
		                  WHEN effect_started_at IS NULL THEN 'pending'
		                  ELSE 'unknown'
		                END,
		       lease_token = lease_token + 1,
		       lease_expires_at = NULL,
		       next_attempt_at = CASE
		                           WHEN effect_started_at IS NULL THEN NOW()
		                           ELSE next_attempt_at
		                         END,
		       error = CASE
		                 WHEN effect_started_at IS NULL
		                   THEN 'effect lease expired before the side-effect boundary'
		                 ELSE 'effect lease expired after the side-effect boundary'
		               END,
		       updated_at = NOW()
		  FROM expired
		 WHERE effect.id = expired.id
		RETURNING effect.status
	`)) as unknown as Array<{ status: "pending" | "unknown" }>;

	const reservedAt = new Date();
	const due = (await db.execute(sql`
		WITH pending AS (
			SELECT id
			  FROM inbox_event_effects
			 WHERE status = 'pending'
			   AND replay_payload IS NOT NULL
			   AND next_attempt_at <= NOW()
			 ORDER BY next_attempt_at ASC, id ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE inbox_event_effects AS effect
		   SET next_attempt_at = NOW() + make_interval(secs => ${REPLAY_RESERVATION_MS / 1_000}),
		       last_enqueued_at = ${reservedAt},
		       updated_at = NOW()
		  FROM pending
		 WHERE effect.id = pending.id
		RETURNING effect.id, effect.replay_payload
	`)) as unknown as Array<{
		id: string;
		replay_payload: NormalizedInboxQueueMessage;
	}>;

	// One source Queue message can own several effect rows. De-duplicate the
	// persisted payloads before handoff so reconciliation does not amplify load.
	const uniqueMessages = new Map<
		string,
		{ body: NormalizedInboxQueueMessage; effectIds: string[]; bytes: number }
	>();
	for (const row of due) {
		const key = JSON.stringify(row.replay_payload);
		const existing = uniqueMessages.get(key);
		if (existing) {
			existing.effectIds.push(row.id);
		} else {
			uniqueMessages.set(key, {
				body: row.replay_payload,
				effectIds: [row.id],
				bytes: new TextEncoder().encode(key).byteLength,
			});
		}
	}

	let replayedMessages = 0;
	if (uniqueMessages.size > 0) {
		const entries = [...uniqueMessages.values()];
		const { chunks, oversized } = chunkInboxReplayEntries(entries);
		if (oversized.length > 0) {
			await db
				.update(inboxEventEffects)
				.set({
					status: "unknown",
					error: "Persisted inbox replay payload exceeds Queue size limit",
					updatedAt: new Date(),
				})
				.where(
					and(
						inArray(
							inboxEventEffects.id,
							oversized.flatMap(({ effectIds }) => effectIds),
						),
						eq(inboxEventEffects.status, "pending"),
						eq(inboxEventEffects.lastEnqueuedAt, reservedAt),
					),
				);
		}

		for (let index = 0; index < chunks.length; index++) {
			const current = chunks[index] ?? [];
			try {
				await env.INBOX_QUEUE.sendBatch(current.map(({ body }) => ({ body })));
				replayedMessages += current.length;
			} catch (error) {
				const unsentIds = chunks
					.slice(index)
					.flatMap((batch) => batch.flatMap(({ effectIds }) => effectIds));
				if (unsentIds.length > 0) {
					await db
						.update(inboxEventEffects)
						.set({
							nextAttemptAt: new Date(Date.now() + REPLAY_FAILURE_DELAY_MS),
							error: (error instanceof Error
								? error.message
								: String(error)
							).slice(0, 1_000),
							updatedAt: new Date(),
						})
						.where(
							and(
								inArray(inboxEventEffects.id, unsentIds),
								eq(inboxEventEffects.status, "pending"),
								eq(inboxEventEffects.lastEnqueuedAt, reservedAt),
							),
						);
				}
				throw error;
			}
		}
	}

	const markedUnknown = recovered.filter(
		({ status }) => status === "unknown",
	).length;
	if (markedUnknown > 0) {
		console.error(
			JSON.stringify({
				event: "inbox_effect_reconciliation_required",
				count: markedUnknown,
			}),
		);
	}
	const unknownRecorded = await recordUnknownInboxEffects(db, batchSize);
	return {
		recoveredPending: recovered.length - markedUnknown,
		markedUnknown,
		unknownRecorded,
		replayedMessages,
	};
}
