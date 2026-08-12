import {
	type Database,
	posts,
	postTargets,
	publishAttempts,
	threadExecutions,
} from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";

export type ProviderReconciliationTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

export interface ProviderReconciliationScopeInput {
	postId: string;
	organizationId: string;
	threadGroupId: string | null;
}

export type ProviderReconciliationScopeLock =
	| { locked: true; post: typeof posts.$inferSelect }
	| { locked: false; conflict: "thread" | "post" };

/**
 * Acquire every durable reconciliation fence in one canonical order.
 *
 * Both manual and provider-driven terminalization must call this before
 * touching a target: thread execution (when present), parent post, then the
 * target/attempt pair. The parent post lock serializes different targets of a
 * standalone post; the thread lock extends that serialization across posts in
 * the same thread and prevents inverse-order deadlocks with continuation work.
 */
export async function lockProviderReconciliationScope(
	tx: ProviderReconciliationTransaction,
	input: ProviderReconciliationScopeInput,
): Promise<ProviderReconciliationScopeLock> {
	if (input.threadGroupId) {
		const [thread] = await tx
			.select({ threadGroupId: threadExecutions.threadGroupId })
			.from(threadExecutions)
			.where(
				and(
					eq(threadExecutions.threadGroupId, input.threadGroupId),
					eq(threadExecutions.organizationId, input.organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!thread) return { locked: false, conflict: "thread" };
	}

	const [post] = await tx
		.select()
		.from(posts)
		.where(
			and(
				eq(posts.id, input.postId),
				eq(posts.organizationId, input.organizationId),
				input.threadGroupId
					? eq(posts.threadGroupId, input.threadGroupId)
					: isNull(posts.threadGroupId),
			),
		)
		.for("update")
		.limit(1);
	if (!post) return { locked: false, conflict: "post" };
	return { locked: true, post };
}

export interface ManualProviderReconciliationInput {
	targetId: string;
	postId: string;
	organizationId: string;
	publishOperationId: string;
	succeeded: boolean;
	providerPostId: string | null;
	providerUrl: string | null;
	errorCode: string | null;
	errorMessage: string | null;
	observedAt: Date;
}

/**
 * Persist a manual unknown-to-terminal projection under target and attempt
 * fences. The caller must already hold `lockProviderReconciliationScope` in
 * the surrounding transaction.
 */
export async function persistManualProviderReconciliation(
	tx: ProviderReconciliationTransaction,
	input: ManualProviderReconciliationInput,
): Promise<boolean> {
	const [candidate] = await tx
		.select({
			id: postTargets.id,
			attemptId: postTargets.attemptId,
			providerOperationId: postTargets.providerOperationId,
			providerState: postTargets.providerState,
			providerEffects: postTargets.providerEffects,
		})
		.from(postTargets)
		.where(
			and(
				eq(postTargets.id, input.targetId),
				eq(postTargets.postId, input.postId),
				eq(postTargets.organizationId, input.organizationId),
				eq(postTargets.publishOperationId, input.publishOperationId),
				eq(postTargets.deliveryState, "unknown"),
			),
		)
		.for("update")
		.limit(1);
	if (!candidate) return false;
	if (!candidate.attemptId) {
		throw new Error("Unknown post target is missing its publish attempt");
	}

	const providerDisposition: "published" | "failed" = input.succeeded
		? "published"
		: "failed";
	const providerState = input.succeeded
		? "manually_confirmed_succeeded"
		: "manually_confirmed_failed";
	const providerProjection = {
		providerDisposition,
		providerOperationId: candidate.providerOperationId,
		providerState,
		// Effects are immutable provider evidence. Manual adjudication changes the
		// aggregate disposition/state but must not erase known partial side effects.
		providerEffects: candidate.providerEffects,
	};
	const [savedTarget] = await tx
		.update(postTargets)
		.set({
			status: input.succeeded ? "published" : "failed",
			deliveryState: input.succeeded ? "succeeded" : "failed",
			platformPostId: input.providerPostId,
			platformUrl: input.providerUrl,
			...providerProjection,
			nextReconcileAt: null,
			publishedAt: input.succeeded ? input.observedAt : null,
			error: input.errorMessage,
			errorCode: input.errorCode,
			errorDetail: null,
			leaseExpiresAt: null,
			updatedAt: input.observedAt,
		})
		.where(
			and(
				eq(postTargets.id, candidate.id),
				eq(postTargets.postId, input.postId),
				eq(postTargets.organizationId, input.organizationId),
				eq(postTargets.publishOperationId, input.publishOperationId),
				eq(postTargets.attemptId, candidate.attemptId),
				eq(postTargets.deliveryState, "unknown"),
			),
		)
		.returning({ id: postTargets.id });
	if (!savedTarget) {
		throw new Error("Manual post target transition was not persisted");
	}

	const [savedAttempt] = await tx
		.update(publishAttempts)
		.set({
			state: input.succeeded ? "succeeded" : "failed",
			providerPostId: input.providerPostId,
			...providerProjection,
			completedAt: input.observedAt,
			leaseExpiresAt: input.observedAt,
			error: input.errorMessage,
		})
		.where(
			and(
				eq(publishAttempts.id, candidate.attemptId),
				eq(publishAttempts.postTargetId, candidate.id),
				eq(publishAttempts.publishOperationId, input.publishOperationId),
				eq(publishAttempts.state, "unknown"),
			),
		)
		.returning({ id: publishAttempts.id });
	if (!savedAttempt) {
		throw new Error("Manual publish attempt transition was not persisted");
	}
	return true;
}
