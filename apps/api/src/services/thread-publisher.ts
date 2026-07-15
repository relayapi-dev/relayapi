import {
	createDb,
	generateId,
	posts,
	postTargets,
	publishAttempts,
	publishOutbox,
	socialAccounts,
	threadExecutions,
} from "@relayapi/db";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getPublisher } from "../publishers";
import type { MediaAttachment, PublishResult } from "../publishers/types";
import type { Platform } from "../schemas/common";
import type { Env } from "../types";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";
import { refreshTokenIfNeeded } from "./token-refresh-coordinator";
import {
	enqueuePersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "./webhook-delivery";

/**
 * Platforms that support threading via reply chains.
 */
const THREADABLE_PLATFORMS = new Set<string>([
	"twitter",
	"threads",
	"bluesky",
	"mastodon",
	"linkedin",
	"facebook",
	"telegram",
	"discord",
]);
const THREAD_EXECUTION_LEASE_MS = 30 * 60 * 1000;

class ThreadExecutionLeaseLostError extends Error {
	constructor() {
		super("Thread execution lease was lost");
		this.name = "ThreadExecutionLeaseLostError";
	}
}

export function isThreadable(platform: string): boolean {
	return THREADABLE_PLATFORMS.has(platform);
}

/**
 * Publish all thread items for a given position (and subsequent zero-delay items).
 * Returns the next position that needs a delayed publish, or null if done.
 */
export async function publishThreadPosition(
	env: Env,
	threadGroupId: string,
	orgId: string,
	startPosition: number,
): Promise<{
	nextPosition: number | null;
	nextDelayMs: number;
	positionFailed?: boolean;
}> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const claimedAt = new Date();
	const executionLeaseId = crypto.randomUUID();
	const executionLeaseExpiresAt = new Date(
		claimedAt.getTime() + THREAD_EXECUTION_LEASE_MS,
	);
	const [claimedExecution] = await db
		.update(threadExecutions)
		.set({
			status: "in_flight",
			leaseId: executionLeaseId,
			leaseExpiresAt: executionLeaseExpiresAt,
			currentPosition: startPosition,
			attempts: sql`${threadExecutions.attempts} + 1`,
			updatedAt: claimedAt,
		})
		.where(
			and(
				eq(threadExecutions.threadGroupId, threadGroupId),
				eq(threadExecutions.organizationId, orgId),
				eq(threadExecutions.currentPosition, startPosition),
				or(
					eq(threadExecutions.status, "queued"),
					and(
						eq(threadExecutions.status, "in_flight"),
						or(
							isNull(threadExecutions.leaseExpiresAt),
							lt(threadExecutions.leaseExpiresAt, claimedAt),
						),
					),
				),
			),
		)
		.returning({
			threadGroupId: threadExecutions.threadGroupId,
			attempts: threadExecutions.attempts,
		});
	if (!claimedExecution) return { nextPosition: null, nextDelayMs: 0 };

	const executionWhere = and(
		eq(threadExecutions.threadGroupId, threadGroupId),
		eq(threadExecutions.organizationId, orgId),
		eq(threadExecutions.status, "in_flight"),
		eq(threadExecutions.leaseId, executionLeaseId),
	);
	const executionFence = sql`EXISTS (
		SELECT 1 FROM thread_executions
		WHERE thread_group_id = ${threadGroupId}
			AND organization_id = ${orgId}
			AND status = 'in_flight'
			AND lease_id = ${executionLeaseId}
	)`;
	const renewExecutionLease = async (): Promise<void> => {
		const renewedAt = new Date();
		const [renewed] = await db
			.update(threadExecutions)
			.set({
				leaseExpiresAt: new Date(
					renewedAt.getTime() + THREAD_EXECUTION_LEASE_MS,
				),
				updatedAt: renewedAt,
			})
			.where(executionWhere)
			.returning({ threadGroupId: threadExecutions.threadGroupId });
		if (!renewed) throw new ThreadExecutionLeaseLostError();
	};

	// Fetch all thread posts ordered by position
	const threadPosts = await db
		.select({
			id: posts.id,
			content: posts.content,
			threadPosition: posts.threadPosition,
			threadDelayMs: posts.threadDelayMs,
			platformOverrides: posts.platformOverrides,
			status: posts.status,
			publishedAt: posts.publishedAt,
			revision: posts.revision,
			updatedAt: posts.updatedAt,
			organizationId: posts.organizationId,
			workspaceId: posts.workspaceId,
		})
		.from(posts)
		.where(
			and(
				eq(posts.threadGroupId, threadGroupId),
				eq(posts.organizationId, orgId),
			),
		)
		.orderBy(asc(posts.threadPosition));

	if (threadPosts.length === 0) {
		await db
			.update(threadExecutions)
			.set({
				status: "failed",
				failure: {
					code: "THREAD_POSTS_MISSING",
					message: "Thread execution has no persisted posts",
				},
				leaseId: null,
				leaseExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(executionWhere);
		return { nextPosition: null, nextDelayMs: 0, positionFailed: true };
	}

	// Fetch all targets for all thread posts
	const postIds = threadPosts.map((p) => p.id);
	const targets = await db
		.select({
			id: postTargets.id,
			postId: postTargets.postId,
			socialAccountId: postTargets.socialAccountId,
			platform: postTargets.platform,
			status: postTargets.status,
			platformPostId: postTargets.platformPostId,
			publishOperationId: postTargets.publishOperationId,
			deliveryState: postTargets.deliveryState,
			attemptId: postTargets.attemptId,
			leaseExpiresAt: postTargets.leaseExpiresAt,
			requestMayHaveBeenSentAt: postTargets.requestMayHaveBeenSentAt,
		})
		.from(postTargets)
		.where(inArray(postTargets.postId, postIds));

	// Group targets by post ID
	const targetsByPost = new Map<string, typeof targets>();
	for (const t of targets) {
		const list = targetsByPost.get(t.postId) ?? [];
		list.push(t);
		targetsByPost.set(t.postId, list);
	}

	// Get unique account IDs and fetch account details
	const accountIds = [...new Set(targets.map((t) => t.socialAccountId))];
	if (accountIds.length === 0) {
		const failure = {
			code: "THREAD_TARGETS_MISSING",
			message: "Thread has no persisted publish targets",
		};
		await db.transaction(async (tx) => {
			await tx
				.update(posts)
				.set({
					status: "failed",
					terminalReason: failure,
					revision: sql`${posts.revision} + 1`,
					updatedAt: new Date(),
				})
				.where(and(inArray(posts.id, postIds), executionFence));
			await tx
				.update(threadExecutions)
				.set({
					status: "failed",
					failure,
					leaseId: null,
					leaseExpiresAt: null,
					updatedAt: new Date(),
				})
				.where(executionWhere);
		});
		return { nextPosition: null, nextDelayMs: 0, positionFailed: true };
	}
	const accountRows = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			metadata: socialAccounts.metadata,
		})
		.from(socialAccounts)
		.where(
			and(
				inArray(socialAccounts.id, accountIds),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		);

	const accountMap = new Map(accountRows.map((a) => [a.id, a]));

	// Determine which positions to publish in this invocation
	// Start at startPosition, continue until we hit a position with delay > 0
	const positionsToPublish: number[] = [];

	for (const post of threadPosts) {
		if ((post.threadPosition ?? 0) < startPosition) continue;
		if ((post.threadPosition ?? 0) === startPosition) {
			positionsToPublish.push(post.threadPosition ?? 0);
			continue;
		}
		// For subsequent positions, only include if delay is 0
		if ((post.threadDelayMs ?? 0) === 0) {
			positionsToPublish.push(post.threadPosition ?? 0);
		} else {
			// This position has a delay - stop here
			break;
		}
	}

	// For native-thread platforms (twitter, threads, bluesky), try publishing all items at once
	// For others, publish one at a time with reply chains
	const postsToPublish = threadPosts.filter((p) =>
		positionsToPublish.includes(p.threadPosition ?? 0),
	);

	// Collect previous positions' platform post IDs for reply chaining.
	// The platformPostId is already loaded in the targets query above, so read it
	// from memory instead of issuing one SELECT per previous-position target (N+1).
	const previousPlatformPostIds = new Map<string, string>(); // accountId -> platformPostId
	if (startPosition > 0) {
		const prevPost = threadPosts.find(
			(p) => (p.threadPosition ?? 0) === startPosition - 1,
		);
		if (prevPost) {
			const prevTargets = targetsByPost.get(prevPost.id) ?? [];
			for (const pt of prevTargets) {
				if (pt.platformPostId) {
					previousPlatformPostIds.set(pt.socialAccountId, pt.platformPostId);
				}
			}
		}
	}

	// Publish each item for each account
	for (const post of postsToPublish) {
		await renewExecutionLease();
		const postTargetList = targetsByPost.get(post.id) ?? [];
		const overrides = (post.platformOverrides ?? {}) as Record<string, unknown>;
		const mediaItems = (overrides._media as MediaAttachment[]) ?? [];

		// Atomically claim this thread item before any platform calls. Cloudflare Queues
		// are at-least-once and handleThreadPublish retries the whole position on any
		// escaped error, so without a claim a redelivery/retry re-publishes already-live
		// items (duplicate tweets/posts). Compare-and-swap on (status, revision): the CAS
		// only succeeds when the post is still "scheduled"/"publishing" AND its revision
		// matches what we read, so two concurrent deliveries cannot both claim the same
		// item. If another worker advanced it (terminal status, or bumped revision), skip
		// its platform calls entirely.
		const claimed = await db
			.update(posts)
			.set({
				status: "publishing",
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(posts.id, post.id),
					inArray(posts.status, ["scheduled", "publishing"]),
					eq(posts.revision, post.revision),
					executionFence,
				),
			)
			.returning({ id: posts.id });
		if (claimed.length === 0) {
			// Already finalized by another delivery. Still surface its published targets'
			// platformPostId into the reply chain so subsequent positions can chain.
			for (const t of postTargetList) {
				if (t.status === "published" && t.platformPostId) {
					previousPlatformPostIds.set(t.socialAccountId, t.platformPostId);
				}
			}
			continue;
		}

		let successCount = 0;
		// A persisted thread item without targets is a definitive chain failure;
		// represent it in the aggregate even though there is no target row to count.
		let failCount = postTargetList.length === 0 ? 1 : 0;
		let unknownCount = 0;
		let skippedCount = 0;

		for (const target of postTargetList) {
			// Idempotency: a target already marked "published" was published on a prior
			// (possibly retried/redelivered) run. Do not re-publish it — that would create
			// a duplicate post on the platform. Reuse its stored platformPostId for the
			// reply chain and count it as a success.
			if (target.status === "published") {
				if (target.platformPostId) {
					previousPlatformPostIds.set(
						target.socialAccountId,
						target.platformPostId,
					);
				}
				successCount++;
				continue;
			}

			const attemptId = generateId("pat_");
			const claimedAt = new Date();
			const leaseExpiresAt = new Date(claimedAt.getTime() + 5 * 60 * 1000);
			const claimedTarget = await db.transaction(async (tx) => {
				const rows = await tx
					.update(postTargets)
					.set({
						status: "publishing",
						deliveryState: "in_flight",
						attemptId,
						claimedAt,
						leaseExpiresAt,
						updatedAt: claimedAt,
					})
					.where(
						and(
							eq(postTargets.id, target.id),
							or(
								eq(postTargets.deliveryState, "queued"),
								and(
									eq(postTargets.deliveryState, "in_flight"),
									isNull(postTargets.requestMayHaveBeenSentAt),
									or(
										isNull(postTargets.leaseExpiresAt),
										lt(postTargets.leaseExpiresAt, claimedAt),
									),
								),
							),
							executionFence,
						),
					)
					.returning({ id: postTargets.id });
				if (!rows[0]) return false;
				await tx.insert(publishAttempts).values({
					id: attemptId,
					publishOperationId: target.publishOperationId,
					postTargetId: target.id,
					state: "in_flight",
					claimedAt,
					leaseExpiresAt,
				});
				return true;
			});
			if (!claimedTarget) {
				// The initial target snapshot predates this claim. Re-read only on a
				// contested/terminal target so a provider-boundary transition cannot be
				// mistaken for a definitive failure.
				const [currentTarget] = await db
					.select({
						status: postTargets.status,
						deliveryState: postTargets.deliveryState,
						platformPostId: postTargets.platformPostId,
					})
					.from(postTargets)
					.where(eq(postTargets.id, target.id))
					.limit(1);
				if (
					currentTarget?.status === "published" ||
					currentTarget?.deliveryState === "succeeded"
				) {
					if (currentTarget.platformPostId) {
						previousPlatformPostIds.set(
							target.socialAccountId,
							currentTarget.platformPostId,
						);
					}
					successCount++;
				} else if (currentTarget?.deliveryState === "unknown") {
					unknownCount++;
					failCount++;
				} else if (currentTarget?.deliveryState === "failed") {
					failCount++;
				} else {
					throw new ThreadExecutionLeaseLostError();
				}
				continue;
			}

			const account = accountMap.get(target.socialAccountId);
			if (!account) {
				await db.transaction(async (tx) => {
					const [saved] = await tx
						.update(postTargets)
						.set({
							status: "failed",
							deliveryState: "failed",
							error: "Account not found",
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(postTargets.id, target.id),
								eq(postTargets.attemptId, attemptId),
								executionFence,
							),
						)
						.returning({ id: postTargets.id });
					if (!saved) throw new ThreadExecutionLeaseLostError();
					await tx
						.update(publishAttempts)
						.set({
							state: "failed",
							completedAt: new Date(),
							error: "Account not found",
						})
						.where(eq(publishAttempts.id, attemptId));
				});
				failCount++;
				continue;
			}

			// Skip non-threadable platforms for non-root items
			if ((post.threadPosition ?? 0) > 0 && !isThreadable(target.platform)) {
				await db.transaction(async (tx) => {
					const [saved] = await tx
						.update(postTargets)
						.set({
							status: "failed",
							deliveryState: "failed",
							error: "Platform does not support threading",
							errorCode: "THREAD_PLATFORM_UNSUPPORTED",
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(postTargets.id, target.id),
								eq(postTargets.attemptId, attemptId),
								executionFence,
							),
						)
						.returning({ id: postTargets.id });
					if (!saved) throw new ThreadExecutionLeaseLostError();
					await tx
						.update(publishAttempts)
						.set({
							state: "failed",
							completedAt: new Date(),
							error: "Platform does not support threading",
						})
						.where(eq(publishAttempts.id, attemptId));
				});
				skippedCount++;
				continue;
			}

			let requestMayHaveBeenSent = false;
			try {
				const publisher = getPublisher(target.platform as Platform);
				if (!publisher) {
					await db.transaction(async (tx) => {
						const [saved] = await tx
							.update(postTargets)
							.set({
								status: "failed",
								deliveryState: "failed",
								error: `No publisher for ${target.platform}`,
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(postTargets.id, target.id),
									eq(postTargets.attemptId, attemptId),
									executionFence,
								),
							)
							.returning({ id: postTargets.id });
						if (!saved) throw new ThreadExecutionLeaseLostError();
						await tx
							.update(publishAttempts)
							.set({
								state: "failed",
								completedAt: new Date(),
								error: `No publisher for ${target.platform}`,
							})
							.where(eq(publishAttempts.id, attemptId));
					});
					failCount++;
					continue;
				}

				const accessToken = await refreshTokenIfNeeded(env, account);

				// Build target_options with reply_to for non-root items
				const targetOpts: Record<string, unknown> = {
					...((overrides[target.platform] as Record<string, unknown>) ?? {}),
				};

				if ((post.threadPosition ?? 0) > 0) {
					const prevPostId = previousPlatformPostIds.get(
						target.socialAccountId,
					);
					if (!prevPostId) {
						const message =
							"Previous thread item has no confirmed platform post ID";
						await db.transaction(async (tx) => {
							const [saved] = await tx
								.update(postTargets)
								.set({
									status: "failed",
									deliveryState: "failed",
									error: message,
									errorCode: "THREAD_PARENT_MISSING",
									updatedAt: new Date(),
								})
								.where(
									and(
										eq(postTargets.id, target.id),
										eq(postTargets.attemptId, attemptId),
										executionFence,
									),
								)
								.returning({ id: postTargets.id });
							if (!saved) throw new ThreadExecutionLeaseLostError();
							await tx
								.update(publishAttempts)
								.set({
									state: "failed",
									completedAt: new Date(),
									error: message,
								})
								.where(eq(publishAttempts.id, attemptId));
						});
						skippedCount++;
						continue;
					}
					targetOpts.reply_to = prevPostId;
				}

				// Cross the durable transmission boundary before provider I/O. A crash
				// from this point leaves an explicit unknown outcome, never a retryable claim.
				await renewExecutionLease();
				const requestBoundary = new Date();
				await db.transaction(async (tx) => {
					const [boundary] = await tx
						.update(postTargets)
						.set({
							deliveryState: "unknown",
							requestMayHaveBeenSentAt: requestBoundary,
							updatedAt: requestBoundary,
						})
						.where(
							and(
								eq(postTargets.id, target.id),
								eq(postTargets.attemptId, attemptId),
								executionFence,
							),
						)
						.returning({ id: postTargets.id });
					if (!boundary) throw new ThreadExecutionLeaseLostError();
					await tx
						.update(publishAttempts)
						.set({
							state: "unknown",
							requestMayHaveBeenSentAt: requestBoundary,
						})
						.where(eq(publishAttempts.id, attemptId));
				});
				requestMayHaveBeenSent = true;

				// Publish
				const result: PublishResult = await publisher.publish({
					operation_id: target.publishOperationId,
					content: post.content ?? "",
					media: mediaItems,
					target_options: targetOpts,
					account: {
						id: account.id,
						platform: account.platform,
						access_token: accessToken,
						refresh_token: null,
						platform_account_id: account.platformAccountId,
						username: account.username,
						metadata: account.metadata as Record<string, unknown> | null,
					},
				});

				if (result.success) {
					await db.transaction(async (tx) => {
						const [saved] = await tx
							.update(postTargets)
							.set({
								status: "published",
								deliveryState: "succeeded",
								platformPostId: result.platform_post_id ?? null,
								platformUrl: result.platform_url ?? null,
								publishedAt: new Date(),
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(postTargets.id, target.id),
									eq(postTargets.attemptId, attemptId),
									executionFence,
								),
							)
							.returning({ id: postTargets.id });
						if (!saved) throw new ThreadExecutionLeaseLostError();
						await tx
							.update(publishAttempts)
							.set({
								state: "succeeded",
								providerPostId: result.platform_post_id ?? null,
								completedAt: new Date(),
							})
							.where(eq(publishAttempts.id, attemptId));
					});

					// Store this post's platform ID for the next item's reply chain
					if (result.platform_post_id) {
						previousPlatformPostIds.set(
							target.socialAccountId,
							result.platform_post_id,
						);
					}
					successCount++;
				} else if (
					["PLATFORM_ERROR", "RATE_LIMITED", "PUBLISH_FAILED"].includes(
						result.error?.code ?? "PUBLISH_FAILED",
					)
				) {
					await db.transaction(async (tx) => {
						const [saved] = await tx
							.update(postTargets)
							.set({
								status: "publishing",
								deliveryState: "unknown",
								error: result.error?.message ?? "Provider outcome unknown",
								errorCode: "PUBLISH_OUTCOME_UNKNOWN",
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(postTargets.id, target.id),
									eq(postTargets.attemptId, attemptId),
									executionFence,
								),
							)
							.returning({ id: postTargets.id });
						if (!saved) throw new ThreadExecutionLeaseLostError();
						await tx
							.update(publishAttempts)
							.set({
								state: "unknown",
								error: result.error?.message ?? "Provider outcome unknown",
							})
							.where(eq(publishAttempts.id, attemptId));
					});
					unknownCount++;
					failCount++;
				} else {
					await db.transaction(async (tx) => {
						const [saved] = await tx
							.update(postTargets)
							.set({
								status: "failed",
								deliveryState: "failed",
								error: result.error?.message ?? "Unknown error",
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(postTargets.id, target.id),
									eq(postTargets.attemptId, attemptId),
									executionFence,
								),
							)
							.returning({ id: postTargets.id });
						if (!saved) throw new ThreadExecutionLeaseLostError();
						await tx
							.update(publishAttempts)
							.set({
								state: "failed",
								completedAt: new Date(),
								error: result.error?.message ?? "Publish rejected",
							})
							.where(eq(publishAttempts.id, attemptId));
					});
					failCount++;
				}
			} catch (err) {
				if (err instanceof ThreadExecutionLeaseLostError) throw err;
				const message = err instanceof Error ? err.message : "Unknown error";
				await db.transaction(async (tx) => {
					const [saved] = await tx
						.update(postTargets)
						.set(
							requestMayHaveBeenSent
								? {
										status: "publishing",
										deliveryState: "unknown",
										error: message,
										errorCode: "PUBLISH_OUTCOME_UNKNOWN",
										updatedAt: new Date(),
									}
								: {
										status: "failed",
										deliveryState: "failed",
										error: message,
										errorCode: "PUBLISH_PREBOUNDARY_ERROR",
										updatedAt: new Date(),
									},
						)
						.where(
							and(
								eq(postTargets.id, target.id),
								eq(postTargets.attemptId, attemptId),
								executionFence,
							),
						)
						.returning({ id: postTargets.id });
					if (!saved) throw new ThreadExecutionLeaseLostError();
					await tx
						.update(publishAttempts)
						.set(
							requestMayHaveBeenSent
								? { state: "unknown", error: message }
								: { state: "failed", error: message, completedAt: new Date() },
						)
						.where(eq(publishAttempts.id, attemptId));
				});
				if (requestMayHaveBeenSent) unknownCount++;
				failCount++;
			}
		}

		// Keep the aggregate status consistent with every persisted target. Unsupported
		// non-root platforms are definitive target failures but do not abort the reply
		// chain for accounts that do support threads.
		const totalCount = successCount + failCount + skippedCount;
		const finalStatus =
			unknownCount > 0
				? "publishing"
				: totalCount === 0
					? "failed"
					: successCount === totalCount
						? "published"
						: successCount === 0
							? "failed"
							: "partial";
		await db
			.update(posts)
			.set({
				status: finalStatus,
				publishedAt:
					finalStatus === "published" ||
					(finalStatus === "partial" && successCount > 0)
						? (post.publishedAt ?? new Date())
						: finalStatus === "failed"
							? null
							: post.publishedAt,
				revision: sql`${posts.revision} + 1`,
				updatedAt: new Date(),
			})
			.where(and(eq(posts.id, post.id), executionFence));

		// Abort the chain only on real publish failures (not pure skips).
		// If all targets were skipped or some succeeded, continue the chain.
		if (unknownCount > 0 || (successCount === 0 && failCount > 0)) {
			const failedPosition = post.threadPosition ?? startPosition;
			const reason = {
				code:
					unknownCount > 0
						? "THREAD_OUTCOME_UNKNOWN"
						: "THREAD_ANCESTOR_FAILED",
				message:
					unknownCount > 0
						? `Thread position ${failedPosition} has an unknown provider outcome; downstream items were not attempted`
						: `Thread position ${failedPosition} failed; downstream items were not attempted`,
				failed_position: failedPosition,
			};
			const downstreamIds = threadPosts
				.filter((item) => (item.threadPosition ?? 0) > failedPosition)
				.map((item) => item.id);
			await db.transaction(async (tx) => {
				// Unknown means the current provider may have succeeded. Keep downstream
				// items untouched until the stable publish operation is reconciled;
				// only a definitive failure may terminalize the remainder of the chain.
				if (unknownCount === 0 && downstreamIds.length > 0) {
					await tx
						.update(posts)
						.set({
							status: "failed",
							terminalReason: reason,
							revision: sql`${posts.revision} + 1`,
							updatedAt: new Date(),
						})
						.where(and(inArray(posts.id, downstreamIds), executionFence));
					await tx
						.update(postTargets)
						.set({
							status: "failed",
							deliveryState: "failed",
							error: reason.message,
							errorCode: reason.code,
							errorDetail: JSON.stringify(reason),
							updatedAt: new Date(),
						})
						.where(
							and(inArray(postTargets.postId, downstreamIds), executionFence),
						);
				}
				await tx
					.update(threadExecutions)
					.set({
						status: unknownCount > 0 ? "unknown" : "failed",
						failedPosition,
						failure: { code: reason.code, message: reason.message },
						leaseId: null,
						leaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(executionWhere);
			});
			return { nextPosition: null, nextDelayMs: 0, positionFailed: true };
		}
	}

	// Determine next position that needs publishing
	const lastPublished =
		positionsToPublish[positionsToPublish.length - 1] ?? startPosition;
	const nextPost = threadPosts.find(
		(p) => (p.threadPosition ?? 0) > lastPublished,
	);

	if (!nextPost) {
		// Thread is complete. Only dispatch thread.published if at least one target
		// across the whole thread actually went live — otherwise a thread whose items
		// were all skipped/failed would emit a success event. Re-read the persisted
		// target statuses (the in-memory `targets` snapshot predates this run's writes).
		const finalTargets = await db
			.select({ status: postTargets.status })
			.from(postTargets)
			.where(inArray(postTargets.postId, postIds));
		const hasRealSuccess = finalTargets.some((t) => t.status === "published");
		const rootPost = threadPosts[0];
		const completion = await db.transaction(async (tx) => {
			const [completed] = await tx
				.update(threadExecutions)
				.set({
					status: hasRealSuccess ? "completed" : "failed",
					...(!hasRealSuccess
						? {
								failure: {
									code: "THREAD_NO_PUBLISHED_TARGETS",
									message: "Thread completed without a published target",
								},
							}
						: {}),
					leaseId: null,
					leaseExpiresAt: null,
					updatedAt: new Date(),
				})
				.where(executionWhere)
				.returning({ threadGroupId: threadExecutions.threadGroupId });
			if (!completed) return null;
			const persisted =
				rootPost && hasRealSuccess
					? await persistWebhookEventInTransaction(
							tx,
							orgId,
							"thread.published",
							{
								thread_group_id: threadGroupId,
								item_count: threadPosts.length,
							},
							{
								workspaceId: rootPost.workspaceId,
								occurrenceId: `thread:${threadGroupId}:published`,
							},
						)
					: null;
			return { completed, persisted };
		});
		if (!completion) return { nextPosition: null, nextDelayMs: 0 };
		if (completion.persisted) {
			await enqueuePersistedWebhookEvent(env, db, completion.persisted);
		}
		return {
			nextPosition: null,
			nextDelayMs: 0,
			...(!hasRealSuccess && completion.completed
				? { positionFailed: true as const }
				: {}),
		};
	}

	const nextPosition = nextPost.threadPosition ?? 0;
	const nextDelayMs = nextPost.threadDelayMs ?? 0;
	const [released] = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(threadExecutions)
			.set({
				status: "queued",
				currentPosition: nextPosition,
				leaseId: null,
				leaseExpiresAt: null,
				updatedAt: new Date(),
			})
			.where(executionWhere)
			.returning({ threadGroupId: threadExecutions.threadGroupId });
		if (!updated) return [];
		await tx
			.insert(publishOutbox)
			.values(
				publishOutboxRow({
					organizationId: orgId,
					threadGroupId,
					threadPosition: nextPosition,
					queueDelaySeconds: Math.ceil(nextDelayMs / 1000),
					operationId: `thread:${threadGroupId}:position:${nextPosition}:attempt:${claimedExecution.attempts}`,
				}),
			)
			.onConflictDoNothing();
		return [updated];
	});
	if (!released) return { nextPosition: null, nextDelayMs: 0 };
	// The transaction above is the crash-safe handoff. Dispatch immediately for
	// latency; if Queue acceptance fails, the every-minute outbox drain retries it.
	try {
		await dispatchPublishOutbox(env);
	} catch (error) {
		console.error("[Thread] Durable next-position dispatch deferred", error);
	}
	return {
		nextPosition,
		nextDelayMs,
	};
}
