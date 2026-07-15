import {
	createDb,
	posts,
	postTargets,
	publishOutbox,
	threadExecutions,
} from "@relayapi/db";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { Env } from "../types";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";

const BATCH_SIZE = 25;

/**
 * Recover thread workers that disappeared while holding an execution lease.
 *
 * The provider boundary lives on each target. An expired execution containing
 * an unknown target is terminalized for manual reconciliation; a purely
 * pre-boundary execution is safely re-enqueued. Both transitions compare the
 * same lease ID, so a late worker cannot overwrite the recovery decision.
 */
export async function reconcileThreadExecutions(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select({
			threadGroupId: threadExecutions.threadGroupId,
			organizationId: threadExecutions.organizationId,
			currentPosition: threadExecutions.currentPosition,
			attempts: threadExecutions.attempts,
			leaseId: threadExecutions.leaseId,
			leaseExpiresAt: threadExecutions.leaseExpiresAt,
		})
		.from(threadExecutions)
		.where(
			and(
				eq(threadExecutions.status, "in_flight"),
				or(
					isNull(threadExecutions.leaseExpiresAt),
					lte(threadExecutions.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(asc(threadExecutions.leaseExpiresAt))
		.limit(BATCH_SIZE);

	let recovered = 0;
	let requeued = 0;
	for (const candidate of candidates) {
		const [unknownTarget] = await db
			.select({ position: posts.threadPosition })
			.from(postTargets)
			.innerJoin(posts, eq(postTargets.postId, posts.id))
			.where(
				and(
					eq(posts.threadGroupId, candidate.threadGroupId),
					eq(posts.organizationId, candidate.organizationId),
					eq(postTargets.deliveryState, "unknown"),
				),
			)
			.limit(1);

		const leaseFence = candidate.leaseId
			? eq(threadExecutions.leaseId, candidate.leaseId)
			: isNull(threadExecutions.leaseId);
		const didRecover = await db.transaction(async (tx) => {
			if (unknownTarget) {
				const [updated] = await tx
					.update(threadExecutions)
					.set({
						status: "unknown",
						failedPosition: unknownTarget.position ?? candidate.currentPosition,
						failure: {
							code: "THREAD_OUTCOME_UNKNOWN",
							message:
								"Thread worker expired after a provider request may have been sent",
						},
						leaseId: null,
						leaseExpiresAt: null,
						updatedAt: now,
					})
					.where(
						and(
							eq(threadExecutions.threadGroupId, candidate.threadGroupId),
							eq(threadExecutions.organizationId, candidate.organizationId),
							eq(threadExecutions.status, "in_flight"),
							leaseFence,
						),
					)
					.returning({ threadGroupId: threadExecutions.threadGroupId });
				return !!updated;
			}

			const [updated] = await tx
				.update(threadExecutions)
				.set({
					status: "queued",
					leaseId: null,
					leaseExpiresAt: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(threadExecutions.threadGroupId, candidate.threadGroupId),
						eq(threadExecutions.organizationId, candidate.organizationId),
						eq(threadExecutions.status, "in_flight"),
						leaseFence,
					),
				)
				.returning({ threadGroupId: threadExecutions.threadGroupId });
			if (!updated) return false;

			await tx
				.insert(publishOutbox)
				.values(
					publishOutboxRow({
						organizationId: candidate.organizationId,
						threadGroupId: candidate.threadGroupId,
						threadPosition: candidate.currentPosition,
						operationId: `thread:${candidate.threadGroupId}:lease-recovery:${candidate.attempts}:${candidate.currentPosition}`,
					}),
				)
				.onConflictDoNothing();
			requeued++;
			return true;
		});
		if (didRecover) recovered++;
	}

	if (requeued > 0) await dispatchPublishOutbox(env);
	return recovered;
}
