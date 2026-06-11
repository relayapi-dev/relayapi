// ---------------------------------------------------------------------------
// Cross-Post Action Processor
//
// Executes pending cross-post actions (repost, comment, quote) when their
// scheduled time arrives. Run from the every-minute cron.
// ---------------------------------------------------------------------------

import {
	createDb,
	crossPostActions,
	postTargets,
	posts,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, isNull, lte } from "drizzle-orm";
import type { Env } from "../types";
import { getPublisher } from "../publishers";
import type { EngagementAccount } from "../publishers/types";
import { refreshTokenIfNeeded } from "./token-refresh";
import { dispatchWebhookEvent } from "./webhook-delivery";

export async function processCrossPostActions(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Find pending, not-yet-claimed actions whose execution time has arrived.
	// executedAt IS NULL is part of the predicate so a row already claimed by a
	// concurrent (overlapping) cron tick is not re-selected.
	const due = await db
		.select()
		.from(crossPostActions)
		.where(
			and(
				eq(crossPostActions.status, "pending"),
				isNull(crossPostActions.executedAt),
				lte(crossPostActions.executeAt, new Date()),
			),
		)
		.limit(10);

	for (const action of due) {
		// Atomic claim: prevent concurrent cron runs from double-executing reposts/
		// comments/quotes. This is a real compare-and-swap — the WHERE requires
		// executedAt to still be NULL, so when two overlapping cron ticks both reach
		// this row, the second UPDATE re-evaluates the predicate after acquiring the
		// row lock, sees executed_at IS NOT NULL, matches 0 rows, and skips.
		const [claimed] = await db
			.update(crossPostActions)
			.set({ executedAt: new Date() })
			.where(
				and(
					eq(crossPostActions.id, action.id),
					eq(crossPostActions.status, "pending"),
					isNull(crossPostActions.executedAt),
				),
			)
			.returning({ id: crossPostActions.id });
		if (!claimed) continue;

		try {
			// Fetch the post to get the org ID for webhooks
			const [post] = await db
				.select({
					id: posts.id,
					organizationId: posts.organizationId,
					workspaceId: posts.workspaceId,
					status: posts.status,
					scheduledAt: posts.scheduledAt,
				})
				.from(posts)
				.where(eq(posts.id, action.postId))
				.limit(1);
			if (!post) {
				await markFailed(db, action.id, "Post not found");
				continue;
			}

			// Find the first published post target to get the platform post ID
			const [sourceTarget] = await db
				.select()
				.from(postTargets)
				.where(
					and(
						eq(postTargets.postId, action.postId),
						eq(postTargets.status, "published"),
					),
				)
				.limit(1);
			if (!sourceTarget || !sourceTarget.platformPostId) {
				// The parent post has no published target yet. If the post is still in a
				// non-terminal state (e.g. it was rescheduled later, moved to draft, or is
				// mid-publish), this is NOT a terminal failure — the post simply has not
				// gone live. markFailed here would permanently strand the action (the due
				// query never retries failed rows), so the repost/comment/quote would never
				// run even after the post publishes. Instead, release the claim and defer:
				// push executeAt to (max(now, scheduledAt) + delayMinutes) and keep status
				// "pending" so a later tick retries once the post is live. Only posts in a
				// genuinely terminal state (published/failed) with no published target are a
				// real failure.
				const postPending = ["scheduled", "draft", "publishing"].includes(
					post.status,
				);
				if (postPending) {
					const anchor =
						post.scheduledAt && post.scheduledAt.getTime() > Date.now()
							? post.scheduledAt
							: new Date();
					const nextExecuteAt = new Date(
						anchor.getTime() + (action.delayMinutes ?? 0) * 60000,
					);
					await db
						.update(crossPostActions)
						.set({ executedAt: null, executeAt: nextExecuteAt })
						.where(eq(crossPostActions.id, action.id));
					continue;
				}
				await markFailed(db, action.id, "No published post target found");
				continue;
			}

			// Fetch the target account — scoped by org to prevent cross-tenant misuse
			const [targetAccount] = await db
				.select()
				.from(socialAccounts)
				.where(and(eq(socialAccounts.id, action.targetAccountId), eq(socialAccounts.organizationId, post.organizationId)))
				.limit(1);
			if (!targetAccount) {
				await markFailed(db, action.id, "Target account not found");
				continue;
			}

			const accessToken = await refreshTokenIfNeeded(env, targetAccount);
			const publisher = getPublisher(sourceTarget.platform as any);
			if (!publisher) {
				await markFailed(db, action.id, `No publisher for platform ${sourceTarget.platform}`);
				continue;
			}

			const engagementAccount: EngagementAccount = {
				access_token: accessToken,
				refresh_token: null,
				platform_account_id: targetAccount.platformAccountId,
				username: targetAccount.username,
			};

			let resultPostId: string | undefined;

			switch (action.actionType) {
				case "repost": {
					if (!publisher.repost) throw new Error(`Platform ${sourceTarget.platform} does not support repost`);
					const result = await publisher.repost(engagementAccount, sourceTarget.platformPostId);
					if (!result.success) throw new Error(result.error?.message ?? "Repost failed");
					resultPostId = result.platform_post_id;
					break;
				}
				case "comment": {
					if (!publisher.comment) throw new Error(`Platform ${sourceTarget.platform} does not support comment`);
					const result = await publisher.comment(engagementAccount, sourceTarget.platformPostId, action.content ?? "");
					if (!result.success) throw new Error(result.error?.message ?? "Comment failed");
					resultPostId = result.platform_post_id;
					break;
				}
				case "quote": {
					if (!publisher.quote) throw new Error(`Platform ${sourceTarget.platform} does not support quote`);
					const result = await publisher.quote(engagementAccount, sourceTarget.platformPostId, action.content ?? "");
					if (!result.success) throw new Error(result.error?.message ?? "Quote failed");
					resultPostId = result.platform_post_id;
					break;
				}
			}

			// Mark as executed
			await db
				.update(crossPostActions)
				.set({
					status: "executed",
					executedAt: new Date(),
					resultPostId: resultPostId ?? null,
				})
				.where(eq(crossPostActions.id, action.id));

			// Await delivery so it completes before this cron item returns (a
			// detached promise would be cancelled after the handler resolves).
			await dispatchWebhookEvent(env, db, post.organizationId, "cross_post_action.executed", {
				action_id: action.id,
				post_id: action.postId,
				action_type: action.actionType,
				target_account_id: action.targetAccountId,
				result_post_id: resultPostId,
			}, post.workspaceId).catch(console.error);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : "Unknown error";
			await markFailed(db, action.id, errorMessage);

			// Try to dispatch failure webhook
			try {
				const [post] = await db
					.select({ organizationId: posts.organizationId, workspaceId: posts.workspaceId })
					.from(posts)
					.where(eq(posts.id, action.postId))
					.limit(1);
				if (post) {
					// Await delivery so it completes before the cron item returns (dedicated
			// webhook-delivery queue is the planned non-blocking follow-up).
					await dispatchWebhookEvent(env, db, post.organizationId, "cross_post_action.failed", {
						action_id: action.id,
						post_id: action.postId,
						action_type: action.actionType,
						target_account_id: action.targetAccountId,
						error: errorMessage,
					}, post.workspaceId).catch(console.error);
				}
			} catch {
				// Non-fatal
			}
		}
	}
}

async function markFailed(
	db: ReturnType<typeof createDb>,
	actionId: string,
	error: string,
): Promise<void> {
	await db
		.update(crossPostActions)
		.set({ status: "failed", error })
		.where(eq(crossPostActions.id, actionId));
}
