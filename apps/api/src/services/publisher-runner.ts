import {
	createDb,
	engagementRules,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import type { PublishRequest, PublishResult } from "../publishers";
import { getPublisher } from "../publishers";
import type { Platform } from "../schemas/common";
import { maybeDecrypt, maybeEncrypt } from "../lib/crypto";
import { refreshTokenIfNeeded, refreshTokenDirect } from "./token-refresh";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { notifyRealtime } from "../lib/notify-post-update";
import { sendNotification } from "./notification-manager";
import { updateStreak } from "./streak";
import type { Env } from "../types";
import { presignRelayMediaUrls } from "../lib/r2-presign";

/**
 * Convert media.relayapi.dev URLs to presigned R2 GET URLs so external
 * platforms (Instagram, Facebook, etc.) can fetch the media.
 * Docs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
 */
async function resolveMediaUrls(
	env: Env,
	mediaItems: PublishRequest["media"],
): Promise<PublishRequest["media"]> {
	return (await presignRelayMediaUrls(env, mediaItems, 3600)) ?? mediaItems;
}

export interface PublishTargetInput {
	key: string;
	platform: Platform;
	accounts: Array<{
		id: string;
		username: string | null;
	}>;
}

export interface PublishTargetResult {
	status: string;
	platform: string;
	accounts: Array<{
		id: string;
		username: string | null;
		url: string | null;
	}>;
	error?: { code: string; message: string };
}

/**
 * Publishes a post to all resolved targets. Updates post_targets and post status in DB.
 * Returns a map of target key -> result for building the response.
 */
export async function publishToTargets(
	env: Env,
	postId: string,
	orgId: string,
	content: string | null,
	mediaItems: PublishRequest["media"],
	targetOptions: Record<string, Record<string, unknown>> | null,
	targets: PublishTargetInput[],
): Promise<Record<string, PublishTargetResult>> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const responseTargets: Record<string, PublishTargetResult> = {};
	const successCounts: Record<string, number> = {};
	const failureCounts: Record<string, number> = {};

	// Resolve media.relayapi.dev URLs to presigned R2 GET URLs
	const resolvedMedia = await resolveMediaUrls(env, mediaItems);

	// Batch-fetch all account details upfront in one query
	const allAccountIds = [...new Set(targets.flatMap((t) => t.accounts.map((a) => a.id)))];
	const fullAccounts = allAccountIds.length > 0
		? await db.select().from(socialAccounts).where(inArray(socialAccounts.id, allAccountIds))
		: [];
	const accountMap = new Map(fullAccounts.map((a) => [a.id, a]));

	// Collect DB update promises to batch at the end
	const dbUpdatePromises: Promise<unknown>[] = [];

	// Initialize response targets and collect publish tasks for parallel execution
	type PublishTask = {
		targetKey: string;
		platform: string;
		accountId: string;
		username: string | null;
		task: () => Promise<{ success: boolean; platform_url?: string | null; platform_post_id?: string | null; error?: { code: string; message: string } }>;
	};
	const publishTasks: PublishTask[] = [];

	for (const target of targets) {
		const publisher = getPublisher(target.platform);

		if (!responseTargets[target.key]) {
			responseTargets[target.key] = {
				status: "published",
				platform: target.platform,
				accounts: [],
			};
		}

		for (const account of target.accounts) {
			if (!publisher) {
				const entry = responseTargets[target.key]!;
				entry.accounts.push({ id: account.id, username: account.username, url: null });
				failureCounts[target.key] = (failureCounts[target.key] ?? 0) + 1;
				entry.status = "failed";
				entry.error = {
					code: "PLATFORM_NOT_SUPPORTED",
					message: `Publishing to ${target.platform} is not yet supported.`,
				};
				dbUpdatePromises.push(
					db.update(postTargets).set({
						status: "failed",
						error: `Platform ${target.platform} not supported`,
					}).where(and(eq(postTargets.postId, postId), eq(postTargets.socialAccountId, account.id))),
				);
				continue;
			}

			const fullAccount = accountMap.get(account.id);
			if (!fullAccount) continue;

			const targetOpts =
				(targetOptions?.[target.key] as Record<string, unknown>) ?? {};

			// Queue publish task for parallel execution (with inline token refresh retry)
			publishTasks.push({
				targetKey: target.key,
				platform: target.platform,
				accountId: account.id,
				username: account.username,
				task: async () => {
					let accessToken =
						target.platform === "telegram"
							? env.TELEGRAM_BOT_TOKEN ?? (await maybeDecrypt(fullAccount.accessToken, env.ENCRYPTION_KEY)) ?? ""
							: await refreshTokenIfNeeded(env, {
									id: fullAccount.id,
									platform: target.platform,
									accessToken: fullAccount.accessToken,
									refreshToken: fullAccount.refreshToken,
									tokenExpiresAt: fullAccount.tokenExpiresAt,
								});

					const maxRetries = 1; // retry once on TOKEN_EXPIRED
					for (let attempt = 0; attempt <= maxRetries; attempt++) {
						const publishStart = Date.now();
						console.log(`[publisher-runner] Publishing to ${target.platform} for account ${account.id}${attempt > 0 ? ` (retry ${attempt})` : ""}...`);
						const result = await publisher.publish({
							content,
							media: resolvedMedia,
							target_options: targetOpts,
							account: {
								id: fullAccount.id,
								platform: target.platform,
								access_token: accessToken,
								refresh_token: (await maybeDecrypt(fullAccount.refreshToken, env.ENCRYPTION_KEY)) ?? null,
								platform_account_id: fullAccount.platformAccountId,
								username: fullAccount.username,
								metadata: fullAccount.metadata as Record<string, unknown> | null,
							},
						});
						console.log(`[publisher-runner] ${target.platform} publish completed in ${Date.now() - publishStart}ms: ${result.success ? "success" : "failed"} ${result.error?.message ?? ""}`);

						// If TOKEN_EXPIRED and we haven't exhausted retries, refresh and retry
						if (!result.success && result.error?.code === "TOKEN_EXPIRED" && attempt < maxRetries) {
							console.log(`[publisher-runner] Token expired for ${target.platform} account ${account.id}, refreshing and retrying...`);
							try {
								const decryptedRefresh = await maybeDecrypt(fullAccount.refreshToken, env.ENCRYPTION_KEY);
								const refreshed = await refreshTokenDirect(env, target.platform, {
									accessToken: accessToken,
									refreshToken: decryptedRefresh,
								});
								if (refreshed) {
									accessToken = refreshed.access_token;
									// Persist new token to DB
									const updateData: Record<string, unknown> = {
										accessToken: await maybeEncrypt(refreshed.access_token, env.ENCRYPTION_KEY),
										updatedAt: new Date(),
									};
									if (refreshed.refresh_token) {
										updateData.refreshToken = await maybeEncrypt(refreshed.refresh_token, env.ENCRYPTION_KEY);
									}
									if (refreshed.expires_in) {
										updateData.tokenExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
									}
									await db.update(socialAccounts).set(updateData).where(eq(socialAccounts.id, fullAccount.id));
									continue; // retry with new token
								}
							} catch (refreshErr) {
								console.error(`[publisher-runner] Token refresh failed for ${target.platform} account ${account.id}:`, refreshErr);
							}
						}

						return result;
					}

					// Should not reach here, but just in case
					return { success: false, error: { code: "PUBLISH_FAILED", message: "Max retries exceeded" } } as PublishResult;
				},
			});
		}
	}

	// Execute all publish tasks in parallel
	const publishResults = await Promise.allSettled(publishTasks.map((t) => t.task()));

	// Process results
	for (let i = 0; i < publishTasks.length; i++) {
		const { targetKey, accountId, username } = publishTasks[i]!;
		const settled = publishResults[i]!;
		const entry = responseTargets[targetKey]!;

		const result = settled.status === "fulfilled"
			? settled.value
			: { success: false as const, error: { code: "PUBLISH_ERROR", message: settled.reason?.message ?? "Unknown error" } };

		if (result.success) {
			dbUpdatePromises.push(
				db.update(postTargets).set({
					status: "published",
					platformPostId: result.platform_post_id ?? null,
					platformUrl: result.platform_url ?? null,
					publishedAt: new Date(),
				}).where(and(eq(postTargets.postId, postId), eq(postTargets.socialAccountId, accountId))),
			);
			entry.accounts.push({ id: accountId, username, url: result.platform_url ?? null });
			successCounts[targetKey] = (successCounts[targetKey] ?? 0) + 1;
		} else {
			dbUpdatePromises.push(
				db.update(postTargets).set({
					status: "failed",
					error: result.error?.message ?? "Unknown error",
				}).where(and(eq(postTargets.postId, postId), eq(postTargets.socialAccountId, accountId))),
			);
			entry.accounts.push({ id: accountId, username, url: null });
			failureCounts[targetKey] = (failureCounts[targetKey] ?? 0) + 1;
			if (!entry.error) {
				entry.error = result.error;
			}
		}
	}

	// Compute per-target status
	for (const target of targets) {
		const entry = responseTargets[target.key];
		if (!entry) continue;
		const hasSuccess = (successCounts[target.key] ?? 0) > 0;
		const hasFailure = (failureCounts[target.key] ?? 0) > 0;
		const hasAttempts = entry.accounts.length > 0;
		if (!hasAttempts) {
			entry.status = "failed";
		} else if (hasSuccess && hasFailure) {
			entry.status = "partial";
		} else if (hasFailure) {
			entry.status = "failed";
		} else {
			entry.status = "published";
		}
	}

	// Flush all DB updates in parallel
	await Promise.all(dbUpdatePromises);

	// Compute final status
	const statuses = Object.values(responseTargets).map((t) => t.status);
	const finalStatus = statuses.every((s) => s === "published")
		? "published"
		: statuses.every((s) => s === "failed")
			? "failed"
			: "partial";

	await db
		.update(posts)
		.set({
			status: finalStatus,
			publishedAt: finalStatus === "published" ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(posts.id, postId));

	// Trigger webhook delivery
	const webhookEvent =
		finalStatus === "published"
			? "post.published"
			: finalStatus === "failed"
				? "post.failed"
				: "post.partial";

	await dispatchWebhookEvent(env, db, orgId, webhookEvent, {
		post_id: postId,
		status: finalStatus,
		targets: responseTargets,
	});

	// Push real-time update to connected dashboard clients
	await notifyRealtime(env, orgId, { type: "post.updated", post_id: postId, status: finalStatus });

	// Update posting streak (any successful publish counts)
	if (finalStatus === "published" || finalStatus === "partial") {
		updateStreak(env, db, orgId).catch((err) =>
			console.error("[publisher-runner] Failed to update streak:", err),
		);
	}

	// Schedule engagement rule checks for published targets
	if (finalStatus === "published" || finalStatus === "partial") {
		scheduleEngagementChecks(env, db, orgId, postId).catch((err) =>
			console.error("[publisher-runner] Failed to schedule engagement checks:", err),
		);
	}

	return responseTargets;
}

/**
 * Schedule engagement rule checks for all published targets of a post.
 * For each matching active rule, enqueues delayed messages at the rule's check intervals.
 */
async function scheduleEngagementChecks(
	env: Env,
	db: ReturnType<typeof createDb>,
	orgId: string,
	postId: string,
): Promise<void> {
	// Fetch published targets for this post
	const targets = await db
		.select({ id: postTargets.id, socialAccountId: postTargets.socialAccountId })
		.from(postTargets)
		.where(and(eq(postTargets.postId, postId), eq(postTargets.status, "published")));

	if (targets.length === 0) return;

	const accountIds = [...new Set(targets.map((t) => t.socialAccountId))];

	// Fetch active rules for these accounts
	const rules = await db
		.select()
		.from(engagementRules)
		.where(
			and(
				eq(engagementRules.organizationId, orgId),
				eq(engagementRules.status, "active"),
				inArray(engagementRules.accountId, accountIds),
			),
		);

	if (rules.length === 0) return;

	// For each rule × matching target, schedule delayed checks
	for (const rule of rules) {
		const matchingTargets = targets.filter((t) => t.socialAccountId === rule.accountId);
		for (const target of matchingTargets) {
			for (let check = 1; check <= rule.maxChecks; check++) {
				const delaySeconds = rule.checkIntervalMinutes * 60 * check;
				if (delaySeconds > 86_400) continue; // Cloudflare Queue max delay is 24h
				await env.PUBLISH_QUEUE.send(
					{
						type: "engagement_check",
						rule_id: rule.id,
						post_target_id: target.id,
						check_number: check,
						organization_id: orgId,
					},
					{ delaySeconds },
				);
			}
		}
	}
}

/**
 * Publishes a post by ID — used by queue consumer and scheduler.
 */
export async function publishPostById(
	env: Env,
	postId: string,
	orgId: string,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [post] = await db
		.select()
		.from(posts)
		.where(and(eq(posts.id, postId), eq(posts.organizationId, orgId)))
		.limit(1);

	if (!post || !["scheduled", "publishing"].includes(post.status)) return;

	// Atomically claim the post by transitioning status.
	// For "scheduled" → "publishing", for "publishing" → same but with updated timestamp.
	// This prevents duplicate publishing from at-least-once queue delivery.
	const claimed = await db
		.update(posts)
		.set({ status: "publishing", updatedAt: new Date() })
		.where(and(eq(posts.id, postId), eq(posts.status, post.status)))
		.returning({ id: posts.id });

	if (claimed.length === 0) return;

	// Get all pending targets
	const targets = await db
		.select()
		.from(postTargets)
		.where(eq(postTargets.postId, postId));

	// Guard: if any target is already published, another worker completed — bail
	if (targets.some((t) => t.status === "published")) return;

	// Filter to actionable targets
	const actionableTargets = targets.filter((t) =>
		["draft", "scheduled", "publishing"].includes(t.status),
	);

	// Batch-fetch all social accounts in one query
	const accountIds = [...new Set(actionableTargets.map((t) => t.socialAccountId))];
	const accountRows = accountIds.length > 0
		? await db
				.select({
					id: socialAccounts.id,
					username: socialAccounts.username,
				})
				.from(socialAccounts)
				.where(inArray(socialAccounts.id, accountIds))
		: [];
	const accountMap = new Map(accountRows.map((a) => [a.id, a]));

	// Group targets by platform
	const targetMap = new Map<string, PublishTargetInput>();
	for (const t of actionableTargets) {
		const account = accountMap.get(t.socialAccountId);
		if (!account) continue;

		const key = t.platform;
		const existing = targetMap.get(key);
		if (existing) {
			existing.accounts.push(account);
		} else {
			targetMap.set(key, {
				key,
				platform: t.platform as Platform,
				accounts: [account],
			});
		}
	}

	const overrides = (post.platformOverrides as Record<
		string,
		unknown
	>) ?? {};

	// Media URLs are stored under the _media key in platformOverrides at creation time.
	// Extract them and remove _media from the target overrides passed to publishers.
	const mediaItems = (
		Array.isArray(overrides._media) ? overrides._media : []
	) as PublishRequest["media"];

	const { _media: _, ...restOverrides } = overrides;
	const targetOverrides = (Object.keys(restOverrides).length > 0
		? restOverrides
		: null) as Record<string, Record<string, unknown>> | null;

	const results = await publishToTargets(
		env,
		postId,
		orgId,
		post.content,
		mediaItems,
		targetOverrides,
		Array.from(targetMap.values()),
	);

	// Send in-app + email notification for the post result
	if (post.createdBy) {
		const platforms = [...new Set(Object.values(results).map((r) => r.platform))];
		const statuses = Object.values(results).map((r) => r.status);
		const finalStatus = statuses.every((s) => s === "published")
			? "published"
			: statuses.every((s) => s === "failed")
				? "failed"
				: "partial";

		const platformList = platforms.join(", ");

		sendNotification(env, {
			type: finalStatus === "published" ? "post_published" : "post_failed",
			userId: post.createdBy,
			orgId,
			title:
				finalStatus === "published"
					? "Post published successfully"
					: "Post failed to publish",
			body:
				finalStatus === "published"
					? `Your post was published to ${platformList}`
					: `Your post failed on ${platformList}`,
			data: { postId, status: finalStatus, platforms },
		}).catch((err) =>
			console.error("[Notification] Failed to send post notification:", err),
		);
	}
}
