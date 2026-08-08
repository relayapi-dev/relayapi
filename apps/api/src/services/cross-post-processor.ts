import {
	createDb,
	crossPostActions,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getPublisher } from "../publishers";
import type {
	EngagementAccount,
	EngagementActionResult,
} from "../publishers/types";
import type { Platform } from "../schemas/common";
import type { Env } from "../types";
import { refreshTokenIfNeeded } from "./token-refresh-coordinator";
import {
	enqueuePersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "./webhook-delivery";

const CROSS_POST_LEASE_MS = 5 * 60 * 1000;
const MAX_CROSS_POST_ATTEMPTS = 5;
const MAX_CROSS_POST_READINESS_CHECKS = 240;

type ClaimedAction = typeof crossPostActions.$inferSelect;
type ActionState = ClaimedAction["status"];

function retryDelayMs(attempt: number): number {
	return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1));
}

export function crossPostReadinessDelayMs(readinessCheck: number): number {
	return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, readinessCheck - 1));
}

export function chooseCrossPostSourceTarget<
	T extends { id: string; platform: string },
>(targets: readonly T[], targetPlatform: string): T | undefined {
	return [...targets]
		.filter((target) => target.platform === targetPlatform)
		.sort((left, right) => left.id.localeCompare(right.id))[0];
}

export function classifyCrossPostResult(
	result: EngagementActionResult,
):
	| { state: "executed"; resultPostId: string | null }
	| { state: "retry" | "failed" | "unknown"; error: string } {
	if (result.success) {
		return { state: "executed", resultPostId: result.platform_post_id ?? null };
	}
	const code = result.error?.code ?? "PUBLISH_FAILED";
	const error =
		result.error?.message ?? "Cross-post provider rejected the action";
	if (code === "RATE_LIMITED" || code === "TOKEN_EXPIRED") {
		return { state: "retry", error };
	}
	if (code === "CONTENT_ERROR") return { state: "failed", error };
	return { state: "unknown", error };
}

export async function processCrossPostActions(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	// Once the request boundary was crossed, an expired lease is ambiguous and
	// must never be replayed automatically.
	await db
		.update(crossPostActions)
		.set({
			status: "unknown",
			leaseExpiresAt: null,
			completedAt: now,
			error: "Worker lease expired after provider request may have been sent",
		})
		.where(
			and(
				eq(crossPostActions.status, "executing"),
				lte(crossPostActions.leaseExpiresAt, now),
			),
		);

	const candidates = await db
		.select()
		.from(crossPostActions)
		.where(
			and(
				inArray(crossPostActions.status, ["pending", "retry", "processing"]),
				lte(crossPostActions.nextAttemptAt, now),
				or(
					isNull(crossPostActions.leaseExpiresAt),
					lte(crossPostActions.leaseExpiresAt, now),
				),
			),
		)
		.limit(10);

	const claimed: ClaimedAction[] = [];
	for (const candidate of candidates) {
		if (candidate.attempts >= MAX_CROSS_POST_ATTEMPTS) {
			await db
				.update(crossPostActions)
				.set({
					status: "failed",
					completedAt: now,
					error: "Maximum cross-post attempts exceeded",
				})
				.where(
					and(
						eq(crossPostActions.id, candidate.id),
						eq(crossPostActions.leaseToken, candidate.leaseToken),
					),
				);
			continue;
		}
		const [row] = await db
			.update(crossPostActions)
			.set({
				status: "processing",
				leaseToken: sql`${crossPostActions.leaseToken} + 1`,
				leaseExpiresAt: new Date(now.getTime() + CROSS_POST_LEASE_MS),
				error: null,
			})
			.where(
				and(
					eq(crossPostActions.id, candidate.id),
					eq(crossPostActions.leaseToken, candidate.leaseToken),
					inArray(crossPostActions.status, ["pending", "retry", "processing"]),
					or(
						isNull(crossPostActions.leaseExpiresAt),
						lte(crossPostActions.leaseExpiresAt, now),
					),
				),
			)
			.returning();
		if (row) claimed.push(row);
	}

	for (const action of claimed) await processClaimedAction(env, db, action);
}

async function updateFenced(
	db: ReturnType<typeof createDb>,
	action: ClaimedAction,
	state: ActionState,
	values: Partial<typeof crossPostActions.$inferInsert>,
): Promise<boolean> {
	const [updated] = await db
		.update(crossPostActions)
		.set({ ...values, status: state })
		.where(
			and(
				eq(crossPostActions.id, action.id),
				eq(crossPostActions.leaseToken, action.leaseToken),
				inArray(crossPostActions.status, ["processing", "executing"]),
			),
		)
		.returning({ id: crossPostActions.id });
	return Boolean(updated);
}

async function updateFencedWithWebhook(
	env: Env,
	db: ReturnType<typeof createDb>,
	action: ClaimedAction,
	state: Exclude<ActionState, "pending" | "processing" | "executing" | "retry">,
	values: Partial<typeof crossPostActions.$inferInsert>,
	post: { organizationId: string; workspaceId: string | null },
	data: Record<string, unknown>,
): Promise<boolean> {
	const persisted = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(crossPostActions)
			.set({ ...values, status: state })
			.where(
				and(
					eq(crossPostActions.id, action.id),
					eq(crossPostActions.leaseToken, action.leaseToken),
					inArray(crossPostActions.status, ["processing", "executing"]),
				),
			)
			.returning({ id: crossPostActions.id });
		if (!updated) return null;
		return persistWebhookEventInTransaction(
			tx,
			post.organizationId,
			state === "executed"
				? "cross_post_action.executed"
				: "cross_post_action.failed",
			data,
			{
				workspaceId: post.workspaceId,
				occurrenceId: `cross-post:${action.operationId}:${state}`,
			},
		);
	});
	if (!persisted) return false;
	await enqueuePersistedWebhookEvent(env, db, persisted);
	return true;
}

async function processClaimedAction(
	env: Env,
	db: ReturnType<typeof createDb>,
	action: ClaimedAction,
): Promise<void> {
	let post: { organizationId: string; workspaceId: string | null } | undefined;
	let requestBoundaryCrossed = false;
	let providerAttemptNumber: number | null = null;
	try {
		const [source] = await db
			.select({
				platform: postTargets.platform,
				platformPostId: postTargets.platformPostId,
				targetStatus: postTargets.status,
				organizationId: posts.organizationId,
				workspaceId: posts.workspaceId,
				postStatus: posts.status,
				scheduledAt: posts.scheduledAt,
			})
			.from(postTargets)
			.innerJoin(
				posts,
				and(
					eq(posts.id, postTargets.postId),
					eq(posts.organizationId, postTargets.organizationId),
					eq(posts.scopeKey, postTargets.scopeKey),
				),
			)
			.where(
				and(
					eq(postTargets.id, action.sourceTargetId),
					eq(postTargets.postId, action.postId),
					eq(postTargets.organizationId, action.organizationId),
					eq(postTargets.scopeKey, action.scopeKey),
					eq(postTargets.platform, action.sourcePlatform),
				),
			)
			.limit(1);
		post = source;
		if (!source) {
			await updateFenced(db, action, "failed", {
				leaseExpiresAt: null,
				completedAt: new Date(),
				error: "Selected source post target not found",
			});
			return;
		}

		if (!source.platformPostId || source.targetStatus !== "published") {
			const sourceCanStillPublish =
				["scheduled", "draft", "publishing"].includes(source.postStatus) &&
				!["failed", "cancelled"].includes(source.targetStatus);
			if (sourceCanStillPublish) {
				if (action.readinessChecks >= MAX_CROSS_POST_READINESS_CHECKS) {
					await updateFenced(db, action, "failed", {
						leaseExpiresAt: null,
						completedAt: new Date(),
						error:
							"Selected source target did not publish before the readiness deadline",
					});
					return;
				}
				const nextReadinessCheck = action.readinessChecks + 1;
				await updateFenced(db, action, "retry", {
					leaseExpiresAt: null,
					readinessChecks: nextReadinessCheck,
					nextAttemptAt: new Date(
						Date.now() + crossPostReadinessDelayMs(nextReadinessCheck),
					),
					error: "Selected source post target is not published yet",
				});
				return;
			}
			await updateFenced(db, action, "failed", {
				leaseExpiresAt: null,
				completedAt: new Date(),
				error: "Selected source post target was not published",
			});
			return;
		}

		const [account] = await db
			.select()
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, action.targetAccountId),
					eq(socialAccounts.organizationId, action.organizationId),
					eq(socialAccounts.scopeKey, action.scopeKey),
					eq(socialAccounts.platform, action.targetPlatform),
					eq(socialAccounts.lifecycleStatus, "active"),
				),
			)
			.limit(1);
		if (!account) {
			await updateFenced(db, action, "failed", {
				leaseExpiresAt: null,
				completedAt: new Date(),
				error: "Target account not found",
			});
			return;
		}

		const publisher = getPublisher(source.platform as Platform);
		if (!publisher) {
			await updateFenced(db, action, "failed", {
				leaseExpiresAt: null,
				completedAt: new Date(),
				error: `No publisher for platform ${source.platform}`,
			});
			return;
		}

		const [providerAttempt] = await db
			.update(crossPostActions)
			.set({ attempts: sql`${crossPostActions.attempts} + 1` })
			.where(
				and(
					eq(crossPostActions.id, action.id),
					eq(crossPostActions.leaseToken, action.leaseToken),
					eq(crossPostActions.status, "processing"),
					lt(crossPostActions.attempts, MAX_CROSS_POST_ATTEMPTS),
				),
			)
			.returning({ attempts: crossPostActions.attempts });
		if (!providerAttempt) return;
		providerAttemptNumber = providerAttempt.attempts;

		let accessToken: string;
		try {
			accessToken = await refreshTokenIfNeeded(env, account);
		} catch (error) {
			await updateFenced(db, action, "retry", {
				leaseExpiresAt: null,
				nextAttemptAt: new Date(
					Date.now() + retryDelayMs(providerAttemptNumber),
				),
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}

		const engagementAccount: EngagementAccount = {
			access_token: accessToken,
			refresh_token: null,
			platform_account_id: account.platformAccountId,
			username: account.username,
		};
		const requestStartedAt = new Date();
		const armed = await updateFenced(db, action, "executing", {
			requestMayHaveBeenSentAt: requestStartedAt,
			leaseExpiresAt: new Date(
				requestStartedAt.getTime() + CROSS_POST_LEASE_MS,
			),
		});
		if (!armed) return;
		requestBoundaryCrossed = true;

		let result: EngagementActionResult;
		switch (action.actionType) {
			case "repost":
				if (!publisher.repost) {
					result = {
						success: false,
						error: { code: "CONTENT_ERROR", message: "Repost is unsupported" },
					};
				} else {
					result = await publisher.repost(
						engagementAccount,
						source.platformPostId,
					);
				}
				break;
			case "comment":
				if (!publisher.comment) {
					result = {
						success: false,
						error: {
							code: "CONTENT_ERROR",
							message: "Comments are unsupported",
						},
					};
				} else {
					result = await publisher.comment(
						engagementAccount,
						source.platformPostId,
						action.content ?? "",
					);
				}
				break;
			case "quote":
				if (!publisher.quote) {
					result = {
						success: false,
						error: { code: "CONTENT_ERROR", message: "Quotes are unsupported" },
					};
				} else {
					result = await publisher.quote(
						engagementAccount,
						source.platformPostId,
						action.content ?? "",
					);
				}
				break;
		}

		const outcome = classifyCrossPostResult(result);
		if (outcome.state === "retry") {
			await updateFenced(db, action, "retry", {
				leaseExpiresAt: null,
				requestMayHaveBeenSentAt: null,
				nextAttemptAt: new Date(
					Date.now() + retryDelayMs(providerAttemptNumber),
				),
				error: outcome.error,
			});
			return;
		}
		const terminalValues =
			outcome.state === "executed"
				? {
						leaseExpiresAt: null,
						executedAt: new Date(),
						completedAt: new Date(),
						resultPostId: outcome.resultPostId,
						error: null,
					}
				: {
						leaseExpiresAt: null,
						completedAt: new Date(),
						error: outcome.error,
					};
		await updateFencedWithWebhook(
			env,
			db,
			action,
			outcome.state,
			terminalValues,
			source,
			{
				action_id: action.id,
				operation_id: action.operationId,
				post_id: action.postId,
				action_type: action.actionType,
				target_account_id: action.targetAccountId,
				state: outcome.state,
				result_post_id:
					outcome.state === "executed" ? outcome.resultPostId : undefined,
				error: outcome.state === "executed" ? undefined : outcome.error,
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const state = requestBoundaryCrossed ? "unknown" : "retry";
		const values = {
			leaseExpiresAt: null,
			completedAt: requestBoundaryCrossed ? new Date() : null,
			...(requestBoundaryCrossed
				? {}
				: {
						nextAttemptAt: new Date(
							Date.now() +
								retryDelayMs(
									providerAttemptNumber ?? Math.max(1, action.attempts),
								),
						),
					}),
			error: message,
		};
		if (!requestBoundaryCrossed) {
			await updateFenced(db, action, "retry", values);
		} else if (post) {
			await updateFencedWithWebhook(env, db, action, "unknown", values, post, {
				action_id: action.id,
				operation_id: action.operationId,
				post_id: action.postId,
				state,
				error: message,
			});
		} else {
			await updateFenced(db, action, "unknown", values);
		}
	}
}
