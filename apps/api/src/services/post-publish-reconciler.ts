import { createDb, posts, postTargets, publishOutbox } from "@relayapi/db";
import {
	and,
	asc,
	eq,
	gt,
	isNotNull,
	isNull,
	lte,
	notExists,
	sql,
} from "drizzle-orm";
import type { Env } from "../types";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";

const BATCH_SIZE = 25;

/** Recover standalone post executions without replaying ambiguous provider I/O. */
export async function reconcilePostPublishExecutions(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const activePreBoundaryTarget = db
		.select({ id: postTargets.id })
		.from(postTargets)
		.where(
			and(
				eq(postTargets.postId, posts.id),
				eq(postTargets.deliveryState, "in_flight"),
				isNull(postTargets.requestMayHaveBeenSentAt),
				gt(postTargets.leaseExpiresAt, now),
			),
		);
	const candidates = await db
		.select({
			id: posts.id,
			organizationId: posts.organizationId,
			leaseId: posts.publishLeaseId,
			leaseExpiresAt: posts.publishLeaseExpiresAt,
			publishAttempts: posts.publishAttempts,
		})
		.from(posts)
		.where(
			and(
				eq(posts.status, "publishing"),
				isNotNull(posts.publishLeaseId),
				isNotNull(posts.publishLeaseExpiresAt),
				lte(posts.publishLeaseExpiresAt, now),
				notExists(activePreBoundaryTarget),
			),
		)
		.orderBy(
			asc(posts.publishLeaseExpiresAt),
			asc(posts.updatedAt),
			asc(posts.id),
		)
		.limit(BATCH_SIZE);

	let recovered = 0;
	let requeued = 0;
	for (const candidate of candidates) {
		const targets = await db
			.select({
				deliveryState: postTargets.deliveryState,
				leaseExpiresAt: postTargets.leaseExpiresAt,
				requestMayHaveBeenSentAt: postTargets.requestMayHaveBeenSentAt,
			})
			.from(postTargets)
			.where(eq(postTargets.postId, candidate.id));

		if (!candidate.leaseId) continue;
		const leaseFence = eq(posts.publishLeaseId, candidate.leaseId);
		const hasUnknown = targets.some(
			(target) => target.deliveryState === "unknown",
		);
		const hasActivePreBoundary = targets.some(
			(target) =>
				target.deliveryState === "in_flight" &&
				target.requestMayHaveBeenSentAt == null &&
				(target.leaseExpiresAt?.getTime() ?? 0) > now.getTime(),
		);
		if (hasActivePreBoundary) continue;

		const didRecover = await db.transaction(async (tx) => {
			if (hasUnknown) {
				const [updated] = await tx
					.update(posts)
					.set({
						terminalReason: {
							code: "PUBLISH_OUTCOME_UNKNOWN",
							message:
								"At least one provider request has an unknown outcome and requires reconciliation.",
						},
						publishLeaseId: null,
						publishLeaseExpiresAt: null,
						revision: sql`${posts.revision} + 1`,
						updatedAt: now,
					})
					.where(
						and(
							eq(posts.id, candidate.id),
							eq(posts.organizationId, candidate.organizationId),
							eq(posts.status, "publishing"),
							leaseFence,
						),
					)
					.returning({ id: posts.id });
				return !!updated;
			}

			const [updated] = await tx
				.update(posts)
				.set({
					publishLeaseId: null,
					publishLeaseExpiresAt: null,
					revision: sql`${posts.revision} + 1`,
					updatedAt: now,
				})
				.where(
					and(
						eq(posts.id, candidate.id),
						eq(posts.organizationId, candidate.organizationId),
						eq(posts.status, "publishing"),
						leaseFence,
					),
				)
				.returning({ id: posts.id });
			if (!updated) return false;
			await tx
				.insert(publishOutbox)
				.values(
					publishOutboxRow({
						organizationId: candidate.organizationId,
						postId: candidate.id,
						operationId: `publish:${candidate.id}:lease-recovery:${candidate.publishAttempts}`,
					}),
				)
				.onConflictDoNothing();
			requeued++;
			return true;
		});
		if (didRecover) recovered++;
	}

	if (requeued > 0) {
		try {
			await dispatchPublishOutbox(env);
		} catch (error) {
			console.error(
				"[Publish] Durable lease recovery dispatch deferred",
				error,
			);
		}
	}
	return recovered;
}
