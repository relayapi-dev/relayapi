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
import { and, eq, lte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getPublisher } from "../publishers";
import type { EngagementAccount } from "../publishers/types";
import { refreshTokenIfNeeded } from "./token-refresh";
import { dispatchWebhookEvent } from "./webhook-delivery";

export async function processCrossPostActions(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Find pending actions whose execution time has arrived
	const due = await db
		.select()
		.from(crossPostActions)
		.where(
			and(
				eq(crossPostActions.status, "pending"),
				lte(crossPostActions.executeAt, new Date()),
			),
		)
		.limit(10);

	for (const action of due) {
		// Atomic claim: prevent concurrent cron runs from double-processing.
		// Set executedAt as a claim marker; only one worker can succeed since
		// the WHERE ensures status is still "pending".
		const [claimed] = await db
			.update(crossPostActions)
			.set({ executedAt: new Date() })
			.where(and(eq(crossPostActions.id, action.id), eq(crossPostActions.status, "pending")))
			.returning({ id: crossPostActions.id });
		if (!claimed) continue;

		try {
			// Fetch the post to get the org ID for webhooks
			const [post] = await db
				.select({
					id: posts.id,
					organizationId: posts.organizationId,
					workspaceId: posts.workspaceId,
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

			// Dispatch webhook
			await dispatchWebhookEvent(env, db, post.organizationId, "cross_post_action.executed", {
				action_id: action.id,
				post_id: action.postId,
				action_type: action.actionType,
				target_account_id: action.targetAccountId,
				result_post_id: resultPostId,
			}, post.workspaceId);
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
					await dispatchWebhookEvent(env, db, post.organizationId, "cross_post_action.failed", {
						action_id: action.id,
						post_id: action.postId,
						action_type: action.actionType,
						target_account_id: action.targetAccountId,
						error: errorMessage,
					}, post.workspaceId);
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
