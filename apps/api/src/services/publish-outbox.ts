import { createDb, publishOutbox } from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";

const CLAIM_TTL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 100;
const RETENTION_BATCH_SIZE = 1_000;
const DISPATCHED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function postPublishOperationId(postId: string): string {
	return `publish:${postId}`;
}

export function threadPublishOperationId(threadGroupId: string): string {
	return `thread:${threadGroupId}`;
}

export interface NotificationOutboxInput {
	organizationId: string;
	userId?: string | null;
	type:
		| "post_failed"
		| "post_published"
		| "account_disconnected"
		| "payment_failed"
		| "usage_warning"
		| "weekly_digest"
		| "marketing"
		| "streak_warning";
	title: string;
	body: string;
	data?: Record<string, unknown>;
	occurrenceId: string;
}

export type PostCompletionStatus = "published" | "failed" | "partial";

/**
 * One compact post-completion job carries both optional user notification and
 * streak intent. This keeps both effects durable without extending the provider
 * publish transaction or adding a second Queue invocation for the common case.
 */
export function postCompletionOutboxRow(input: {
	postId: string;
	organizationId: string;
	userId: string | null;
	status: PostCompletionStatus;
	occurrenceId: string;
	platforms: string[];
	occurredAt: Date;
}): typeof publishOutbox.$inferInsert | null {
	const updatesStreak =
		input.status === "published" || input.status === "partial";
	if (!updatesStreak && !input.userId) return null;

	const platforms = [...new Set(input.platforms)].sort();
	const platformList = platforms.join(", ");
	const destination = platformList ? ` to ${platformList}` : "";
	const title =
		input.status === "published"
			? "Post published successfully"
			: input.status === "partial"
				? "Post partially published"
				: "Post failed to publish";
	const body =
		input.status === "published"
			? `Your post was published${destination}`
			: input.status === "partial"
				? `Your post was only partially published${destination}`
				: platformList
					? `Your post failed on ${platformList}`
					: "Your post failed to publish";

	return {
		operationId: `post-completion:${input.occurrenceId}`,
		organizationId: input.organizationId,
		kind: "post_completion",
		payload: {
			type: "post_completion_effects",
			post_id: input.postId,
			org_id: input.organizationId,
			status: input.status,
			occurred_at: input.occurredAt.toISOString(),
			occurrence_id: input.occurrenceId,
			update_streak: updatesStreak,
			notification: input.userId
				? {
						user_id: input.userId,
						notification_type:
							input.status === "published" ? "post_published" : "post_failed",
						title,
						body,
						data: {
							postId: input.postId,
							status: input.status,
							platforms,
						},
					}
				: null,
		},
	};
}

/** Durable notification job committed with its source business transition. */
export function notificationOutboxRow(
	input: NotificationOutboxInput,
): typeof publishOutbox.$inferInsert {
	return {
		operationId: `notification:${input.occurrenceId}:${input.userId ?? "organization"}`,
		organizationId: input.organizationId,
		kind: "notification",
		payload: {
			type: "send_notification",
			org_id: input.organizationId,
			user_id: input.userId ?? null,
			notification_type: input.type,
			title: input.title,
			body: input.body,
			data: input.data ?? {},
			occurrence_id: input.occurrenceId,
		},
	};
}

export function publishOutboxRow(input: {
	organizationId: string;
	postId?: string;
	threadGroupId?: string;
	threadPosition?: number;
	queueDelaySeconds?: number;
	operationId?: string;
}): typeof publishOutbox.$inferInsert {
	if (input.threadGroupId) {
		return {
			operationId:
				input.operationId ?? threadPublishOperationId(input.threadGroupId),
			organizationId: input.organizationId,
			kind: "publish_thread",
			payload: {
				type: "publish_thread",
				thread_group_id: input.threadGroupId,
				org_id: input.organizationId,
				position: input.threadPosition ?? 0,
				...(input.queueDelaySeconds
					? { _queue_delay_seconds: input.queueDelaySeconds }
					: {}),
			},
		};
	}
	if (!input.postId)
		throw new Error("Publish outbox requires postId or threadGroupId");
	return {
		operationId: input.operationId ?? postPublishOperationId(input.postId),
		organizationId: input.organizationId,
		postId: input.postId,
		kind: "publish",
		payload: {
			type: "publish",
			post_id: input.postId,
			org_id: input.organizationId,
		},
	};
}

export function publishQueueMessage(row: {
	payload: unknown;
	operationId: string;
}): MessageSendRequest<Record<string, unknown>> {
	const { _queue_delay_seconds: rawDelaySeconds, ...payload } =
		row.payload as Record<string, unknown>;
	const delaySeconds =
		typeof rawDelaySeconds === "number" && Number.isFinite(rawDelaySeconds)
			? Math.max(0, Math.min(86_400, Math.ceil(rawDelaySeconds)))
			: undefined;
	return {
		body: { ...payload, operation_id: row.operationId },
		...(delaySeconds ? { delaySeconds } : {}),
	};
}

/**
 * Drain the transactional publish outbox. A crash after Queue acceptance and
 * before the dispatched update can send the same operation again; consumers use
 * the stable operation_id and per-target state to suppress it safely.
 */
export async function dispatchPublishOutbox(
	env: Env,
	maxBatches = 1,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const batchBudget = Math.min(Math.max(Math.trunc(maxBatches), 1), 10);
	let dispatched = 0;
	for (let batchIndex = 0; batchIndex < batchBudget; batchIndex++) {
		const now = new Date();
		const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
		const claimed = (await db.execute(sql`
			WITH due AS (
				SELECT id
				  FROM publish_outbox
				 WHERE available_at < ${now}
				   AND (
					status = 'pending'
					OR (status = 'dispatching' AND claimed_at < ${staleBefore})
				   )
				 ORDER BY available_at ASC, id ASC
				 LIMIT ${BATCH_SIZE}
				 FOR UPDATE SKIP LOCKED
			)
			UPDATE publish_outbox AS outbox
			   SET status = 'dispatching',
			       claimed_at = ${now},
			       attempts = outbox.attempts + 1,
			       last_error = NULL
			  FROM due
			 WHERE outbox.id = due.id
			RETURNING outbox.id, outbox.operation_id, outbox.payload
		`)) as unknown as Array<{
			id: string;
			operation_id: string;
			payload: unknown;
		}>;

		if (claimed.length === 0) break;
		const ids = claimed.map((row) => row.id);
		try {
			await env.PUBLISH_QUEUE.sendBatch(
				claimed.map((row) =>
					publishQueueMessage({
						operationId: row.operation_id,
						payload: row.payload,
					}),
				),
			);
			const completedAt = new Date();
			const completed = await db
				.update(publishOutbox)
				.set({
					status: "dispatched",
					dispatchedAt: completedAt,
					claimedAt: null,
				})
				.where(
					and(
						inArray(publishOutbox.id, ids),
						eq(publishOutbox.status, "dispatching"),
						eq(publishOutbox.claimedAt, now),
					),
				)
				.returning({ id: publishOutbox.id });
			dispatched += completed.length;
			if (claimed.length < BATCH_SIZE) break;
		} catch (error) {
			await db
				.update(publishOutbox)
				.set({
					status: "pending",
					availableAt: new Date(Date.now() + 30_000),
					claimedAt: null,
					lastError: error instanceof Error ? error.message : String(error),
				})
				.where(
					and(
						inArray(publishOutbox.id, ids),
						eq(publishOutbox.status, "dispatching"),
						eq(publishOutbox.claimedAt, now),
					),
				);
			throw error;
		}
	}
	if (batchBudget > 1) {
		const retentionCutoff = new Date(Date.now() - DISPATCHED_RETENTION_MS);
		await db.execute(sql`
			WITH expired AS (
				SELECT id
				  FROM publish_outbox
				 WHERE status = 'dispatched'
				   AND dispatched_at < ${retentionCutoff}
				 ORDER BY dispatched_at ASC, id ASC
				 LIMIT ${RETENTION_BATCH_SIZE}
				 FOR UPDATE SKIP LOCKED
			)
			DELETE FROM publish_outbox AS outbox
			 USING expired
			 WHERE outbox.id = expired.id
		`);
	}
	return dispatched;
}
