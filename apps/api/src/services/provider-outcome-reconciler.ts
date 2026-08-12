import {
	createDb,
	type Database,
	posts,
	postTargets,
	publishAttempts,
	publishOutbox,
	socialAccounts,
	threadExecutions,
} from "@relayapi/db";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { mapConcurrently } from "../lib/concurrency";
import { getPublisher } from "../publishers";
import {
	isNonTerminalProviderOutcome,
	isTerminalProviderSuccess,
	type ProviderDisposition,
	type ProviderEffect,
	type PublishResult,
} from "../publishers/types";
import type { Platform } from "../schemas/common";
import type { Env } from "../types";
import {
	lockProviderReconciliationScope,
	type ProviderReconciliationTransaction,
} from "./provider-reconciliation-persistence";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";
import {
	normalizeProviderOutcome,
	providerReconcileAt,
} from "./publisher-runner";
import { refreshTokenIfNeeded } from "./token-refresh-coordinator";

const BATCH_SIZE = 25;
const CONCURRENCY = 4;
const CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_RECONCILE_ATTEMPTS = 40;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function retryAt(attempt: number, now: Date): Date {
	const exponent = Math.max(0, Math.min(attempt - 1, 10));
	return new Date(
		now.getTime() + Math.min(60_000 * 2 ** exponent, MAX_BACKOFF_MS),
	);
}

type ContinuationCandidate = {
	targetId: string;
	postId: string;
	organizationId: string;
	publishOperationId: string;
	threadGroupId: string | null;
	threadPosition: number | null;
};

type PersistedProviderFields = {
	providerDisposition: ProviderDisposition;
	providerOperationId: string | null;
	providerState: string | null;
	providerEffects: ProviderEffect[] | null;
};

interface TerminalProviderReconciliationInput {
	candidate: ContinuationCandidate & { attemptId: string | null };
	attemptNumber: number;
	observedAt: Date;
	platformPostId: string | null;
	platformUrl: string | null;
	providerFields: PersistedProviderFields;
	result: PublishResult;
}

/**
 * Commit the terminal target projection, immutable attempt audit, and the
 * continuation outbox as one unit. A crash can therefore leave all three
 * unapplied or all three durable, but can never strand a post between them.
 */
export async function persistTerminalProviderReconciliation(
	db: Database,
	input: TerminalProviderReconciliationInput,
): Promise<{ saved: boolean; continuationQueued: boolean }> {
	const succeeded = ["published", "sent", "delivered"].includes(
		input.providerFields.providerDisposition,
	);
	if (!succeeded && input.providerFields.providerDisposition !== "failed") {
		throw new Error("Provider reconciliation outcome is not terminal");
	}

	return db.transaction(async (tx) => {
		const scope = await lockProviderReconciliationScope(tx, {
			postId: input.candidate.postId,
			organizationId: input.candidate.organizationId,
			threadGroupId: input.candidate.threadGroupId,
		});
		if (!scope.locked) {
			throw new Error(
				`Provider reconciliation ${scope.conflict} scope was not found`,
			);
		}
		if (!input.candidate.attemptId) {
			throw new Error("Reconciled post target is missing its publish attempt");
		}

		const [savedTarget] = await tx
			.update(postTargets)
			.set(
				succeeded
					? {
							status: "published",
							deliveryState: "succeeded",
							platformPostId: input.platformPostId,
							platformUrl: input.platformUrl,
							...input.providerFields,
							nextReconcileAt: null,
							publishedAt: input.observedAt,
							error: null,
							errorCode: null,
							errorDetail: null,
							updatedAt: input.observedAt,
						}
					: {
							status: "failed",
							deliveryState: "failed",
							platformPostId: input.platformPostId,
							platformUrl: input.platformUrl,
							...input.providerFields,
							nextReconcileAt: null,
							publishedAt: null,
							error: input.result.error?.message ?? "Provider operation failed",
							errorCode: input.result.error?.code ?? "PUBLISH_FAILED",
							errorDetail: input.result.error?.detail ?? null,
							updatedAt: input.observedAt,
						},
			)
			.where(
				and(
					eq(postTargets.id, input.candidate.targetId),
					eq(postTargets.postId, input.candidate.postId),
					eq(postTargets.organizationId, input.candidate.organizationId),
					eq(
						postTargets.publishOperationId,
						input.candidate.publishOperationId,
					),
					eq(postTargets.attemptId, input.candidate.attemptId),
					eq(postTargets.deliveryState, "unknown"),
					eq(postTargets.reconcileAttempts, input.attemptNumber),
				),
			)
			.returning({ id: postTargets.id });
		if (!savedTarget) return { saved: false, continuationQueued: false };
		const [savedAttempt] = await tx
			.update(publishAttempts)
			.set({
				state: succeeded ? "succeeded" : "failed",
				providerPostId: input.platformPostId,
				...input.providerFields,
				error: succeeded
					? null
					: (input.result.error?.message ?? "Provider operation failed"),
			})
			.where(
				and(
					eq(publishAttempts.id, input.candidate.attemptId),
					eq(publishAttempts.postTargetId, input.candidate.targetId),
					eq(
						publishAttempts.publishOperationId,
						input.candidate.publishOperationId,
					),
					eq(publishAttempts.state, "unknown"),
				),
			)
			.returning({ id: publishAttempts.id });
		if (!savedAttempt) {
			throw new Error(
				"Reconciled publish attempt transition was not persisted",
			);
		}

		return {
			saved: true,
			continuationQueued: await enqueueTerminalContinuation(
				tx,
				input.candidate,
				input.attemptNumber,
			),
		};
	});
}

/**
 * Reconcile provider operations that were durably accepted but not yet terminal.
 * Claims are represented by moving `next_reconcile_at` into the future before
 * provider I/O, so overlapping cron invocations cannot poll the same operation.
 * Adapter reconciliation is read-only by contract and never recreates content.
 */
export async function reconcileProviderOutcomes(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select({
			targetId: postTargets.id,
			postId: postTargets.postId,
			organizationId: postTargets.organizationId,
			attemptId: postTargets.attemptId,
			publishOperationId: postTargets.publishOperationId,
			platform: postTargets.platform,
			providerDisposition: postTargets.providerDisposition,
			providerOperationId: postTargets.providerOperationId,
			providerState: postTargets.providerState,
			providerEffects: postTargets.providerEffects,
			platformPostId: postTargets.platformPostId,
			platformUrl: postTargets.platformUrl,
			reconcileAttempts: postTargets.reconcileAttempts,
			threadGroupId: posts.threadGroupId,
			threadPosition: posts.threadPosition,
			accountId: socialAccounts.id,
			accountPlatformId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			metadata: socialAccounts.metadata,
		})
		.from(postTargets)
		.innerJoin(posts, eq(postTargets.postId, posts.id))
		.innerJoin(
			socialAccounts,
			and(
				eq(postTargets.socialAccountId, socialAccounts.id),
				eq(postTargets.organizationId, socialAccounts.organizationId),
			),
		)
		.where(
			and(
				eq(postTargets.deliveryState, "unknown"),
				isNotNull(postTargets.providerDisposition),
				isNotNull(postTargets.nextReconcileAt),
				lte(postTargets.nextReconcileAt, now),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.orderBy(asc(postTargets.nextReconcileAt), asc(postTargets.id))
		.limit(BATCH_SIZE);

	let changed = 0;
	let needsDispatch = false;
	await mapConcurrently(candidates, CONCURRENCY, async (candidate) => {
		if (!candidate.providerDisposition) return;
		const claimedAt = new Date();
		const attemptNumber = candidate.reconcileAttempts + 1;
		const [claimed] = await db
			.update(postTargets)
			.set({
				nextReconcileAt: new Date(claimedAt.getTime() + CLAIM_TTL_MS),
				reconcileAttempts: sql`${postTargets.reconcileAttempts} + 1`,
				updatedAt: claimedAt,
			})
			.where(
				and(
					eq(postTargets.id, candidate.targetId),
					eq(postTargets.deliveryState, "unknown"),
					eq(postTargets.providerDisposition, candidate.providerDisposition),
					isNotNull(postTargets.nextReconcileAt),
					lte(postTargets.nextReconcileAt, claimedAt),
				),
			)
			.returning({ id: postTargets.id });
		if (!claimed) return;

		const publisher = getPublisher(candidate.platform as Platform);
		if (!publisher?.reconcile) {
			await db
				.update(postTargets)
				.set({
					nextReconcileAt: null,
					error:
						"The provider accepted this operation but has no read-only status reconciler.",
					errorCode: "PROVIDER_RECONCILIATION_UNAVAILABLE",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(postTargets.id, candidate.targetId),
						eq(postTargets.deliveryState, "unknown"),
					),
				);
			changed++;
			return;
		}

		try {
			const accessToken = await refreshTokenIfNeeded(env, {
				id: candidate.accountId,
				platform: candidate.platform as Platform,
				accessToken: candidate.accessToken,
				refreshToken: candidate.refreshToken,
				tokenExpiresAt: candidate.tokenExpiresAt,
			});
			const result = await publisher.reconcile({
				account: {
					id: candidate.accountId,
					platform: candidate.platform as Platform,
					access_token: accessToken,
					refresh_token: null,
					platform_account_id: candidate.accountPlatformId,
					username: candidate.username,
					metadata: candidate.metadata as Record<string, unknown> | null,
				},
				provider_operation_id: candidate.providerOperationId,
				platform_post_id: candidate.platformPostId,
				provider_state: candidate.providerState,
				effects: candidate.providerEffects ?? [],
			});
			const outcome = normalizeProviderOutcome(result);
			const observedAt = new Date();
			const platformPostId =
				outcome.platform_post_id ?? candidate.platformPostId;
			const platformUrl = outcome.platform_url ?? candidate.platformUrl;
			const providerFields: PersistedProviderFields = {
				providerDisposition: outcome.disposition,
				providerOperationId:
					outcome.provider_operation_id ?? candidate.providerOperationId,
				providerState: outcome.provider_state ?? candidate.providerState,
				providerEffects: outcome.effects ?? candidate.providerEffects,
			};
			const reconciliationUnavailable =
				result.error?.code === "PROVIDER_RECONCILIATION_UNAVAILABLE" ||
				result.error?.code.endsWith("_RECONCILIATION_UNAVAILABLE");

			if (reconciliationUnavailable) {
				await db.transaction(async (tx) => {
					const [saved] = await tx
						.update(postTargets)
						.set({
							platformPostId,
							platformUrl,
							...providerFields,
							nextReconcileAt: null,
							error:
								result.error?.message ??
								"Provider reconciliation is unavailable",
							errorCode:
								result.error?.code ?? "PROVIDER_RECONCILIATION_UNAVAILABLE",
							errorDetail: result.error?.detail ?? null,
							updatedAt: observedAt,
						})
						.where(
							and(
								eq(postTargets.id, candidate.targetId),
								eq(postTargets.deliveryState, "unknown"),
								eq(postTargets.reconcileAttempts, attemptNumber),
							),
						)
						.returning({ id: postTargets.id });
					if (!saved || !candidate.attemptId) return;
					await tx
						.update(publishAttempts)
						.set({
							providerPostId: platformPostId,
							...providerFields,
							error:
								result.error?.message ??
								"Provider reconciliation is unavailable",
						})
						.where(eq(publishAttempts.id, candidate.attemptId));
				});
				changed++;
				return;
			}

			if (
				isTerminalProviderSuccess(outcome) ||
				outcome.disposition === "failed"
			) {
				const terminal = await persistTerminalProviderReconciliation(db, {
					candidate,
					attemptNumber,
					observedAt,
					platformPostId,
					platformUrl,
					providerFields,
					result,
				});
				if (terminal.saved) changed++;
				needsDispatch = terminal.continuationQueued || needsDispatch;
				return;
			}

			if (isNonTerminalProviderOutcome(outcome)) {
				await db
					.update(postTargets)
					.set({
						platformPostId,
						platformUrl,
						...providerFields,
						nextReconcileAt:
							providerReconcileAt(outcome, observedAt) ??
							retryAt(attemptNumber, observedAt),
						error: null,
						errorCode: null,
						errorDetail: null,
						updatedAt: observedAt,
					})
					.where(
						and(
							eq(postTargets.id, candidate.targetId),
							eq(postTargets.deliveryState, "unknown"),
							eq(postTargets.reconcileAttempts, attemptNumber),
						),
					);
				changed++;
				return;
			}

			await deferUnknownOutcome(
				db,
				candidate.targetId,
				attemptNumber,
				observedAt,
				result.error?.message ?? "Provider status could not be reconciled",
			);
			changed++;
		} catch (error) {
			await deferUnknownOutcome(
				db,
				candidate.targetId,
				attemptNumber,
				new Date(),
				error instanceof Error
					? error.message
					: "Provider reconciliation failed",
			);
			changed++;
		}
	});

	if (needsDispatch) {
		try {
			await dispatchPublishOutbox(env);
		} catch (error) {
			console.error(
				"[provider-reconciler] continuation dispatch deferred",
				error,
			);
		}
	}
	return changed;
}

async function deferUnknownOutcome(
	db: ReturnType<typeof createDb>,
	targetId: string,
	attemptNumber: number,
	now: Date,
	message: string,
): Promise<void> {
	const exhausted = attemptNumber >= MAX_RECONCILE_ATTEMPTS;
	await db
		.update(postTargets)
		.set({
			...(exhausted ? { providerDisposition: "outcome_unknown" as const } : {}),
			nextReconcileAt: exhausted ? null : retryAt(attemptNumber, now),
			error: message,
			errorCode: exhausted
				? "PUBLISH_OUTCOME_UNKNOWN"
				: "PROVIDER_RECONCILIATION_RETRY",
			updatedAt: now,
		})
		.where(
			and(
				eq(postTargets.id, targetId),
				eq(postTargets.deliveryState, "unknown"),
				eq(postTargets.reconcileAttempts, attemptNumber),
			),
		);
}

async function enqueueTerminalContinuation(
	db: ProviderReconciliationTransaction,
	candidate: ContinuationCandidate,
	attemptNumber: number,
): Promise<boolean> {
	const remaining = await db
		.select({ id: postTargets.id })
		.from(postTargets)
		.where(
			and(
				eq(postTargets.postId, candidate.postId),
				inArray(postTargets.deliveryState, ["queued", "in_flight", "unknown"]),
			),
		)
		.limit(1);
	if (remaining.length > 0) return false;

	if (candidate.threadGroupId) {
		const resumedAt = new Date();
		const [resumed] = await db
			.update(threadExecutions)
			.set({
				status: "queued",
				currentPosition: candidate.threadPosition ?? 0,
				failedPosition: null,
				failure: null,
				leaseId: null,
				leaseExpiresAt: null,
				updatedAt: resumedAt,
			})
			.where(
				and(
					eq(threadExecutions.threadGroupId, candidate.threadGroupId),
					eq(threadExecutions.organizationId, candidate.organizationId),
					eq(threadExecutions.status, "unknown"),
				),
			)
			.returning({ id: threadExecutions.threadGroupId });
		if (!resumed) return false;
		await db
			.insert(publishOutbox)
			.values(
				publishOutboxRow({
					organizationId: candidate.organizationId,
					threadGroupId: candidate.threadGroupId,
					threadPosition: candidate.threadPosition ?? 0,
					operationId: `thread:${candidate.threadGroupId}:provider-reconcile:${candidate.targetId}:${attemptNumber}`,
				}),
			)
			.onConflictDoNothing();
		return true;
	}

	await db
		.insert(publishOutbox)
		.values(
			publishOutboxRow({
				organizationId: candidate.organizationId,
				postId: candidate.postId,
				operationId: `publish:${candidate.postId}:provider-reconcile:${candidate.targetId}:${attemptNumber}`,
			}),
		)
		.onConflictDoNothing();
	return true;
}
