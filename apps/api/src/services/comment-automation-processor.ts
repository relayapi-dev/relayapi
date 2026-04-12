/**
 * Comment automation processor — checks incoming comments against active
 * automations and sends DMs + optional public replies.
 *
 * Platform APIs:
 * - Instagram private reply: POST /{IG_USER_ID}/messages with recipient.comment_id
 *   Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies
 * - Facebook private reply: POST /{PAGE_ID}/messages with recipient.comment_id
 *   Docs: https://developers.facebook.com/docs/messenger-platform/discovery/private-replies
 */

import type { Database } from "@relayapi/db";
import {
	commentAutomations,
	commentAutomationLogs,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";

interface CommentEvent {
	organizationId: string;
	accountId: string;
	platform: string;
	postId: string;
	commentId: string;
	commenterId: string;
	commenterName?: string;
	commentText: string;
}

export async function processCommentAutomation(
	event: CommentEvent,
	db: Database,
	encryptionKey?: string,
): Promise<void> {
	if (event.platform !== "instagram" && event.platform !== "facebook") return;

	// Find active automations for this post — prefer specific post match over "all posts"
	const automations = await db
		.select()
		.from(commentAutomations)
		.where(
			and(
				eq(commentAutomations.organizationId, event.organizationId),
				eq(commentAutomations.socialAccountId, event.accountId),
				or(
					eq(commentAutomations.postId, event.postId),
					isNull(commentAutomations.postId),
				),
				eq(commentAutomations.enabled, true),
			),
		)
		.limit(2);

	if (automations.length === 0) {
		console.log("[comment-automation] No active automations found", {
			orgId: event.organizationId,
			accountId: event.accountId,
			postId: event.postId,
		});
		return;
	}

	// Prefer specific post automation over "all posts" automation
	const automation = automations.find((a) => a.postId !== null) ?? automations[0]!;

	// Check keyword match
	if (automation.keywords.length > 0) {
		const text = event.commentText.toLowerCase();
		const matched =
			automation.matchMode === "exact"
				? automation.keywords.some((k) => text === k.toLowerCase())
				: automation.keywords.some((k) =>
						text.includes(k.toLowerCase()),
					);
		if (!matched) return;
	}

	// Deduplication: if once_per_user is enabled, skip if we already SUCCESSFULLY sent
	// a DM to this commenter. If disabled, always allow re-trigger.
	let existingLog: { id: string; dmSent: boolean } | undefined;
	if (automation.oncePerUser) {
		const [log] = await db
			.select({ id: commentAutomationLogs.id, dmSent: commentAutomationLogs.dmSent })
			.from(commentAutomationLogs)
			.where(
				and(
					eq(commentAutomationLogs.automationId, automation.id),
					eq(commentAutomationLogs.commenterId, event.commenterId),
				),
			)
			.limit(1);
		existingLog = log;

		if (existingLog?.dmSent) {
			console.log("[comment-automation] Deduplicated — already sent DM to commenter", {
				automationId: automation.id,
				commenterId: event.commenterId,
			});
			return;
		}
	}

	// Get access token + platform account ID (the OAuth-issued ID used for API calls)
	const [account] = await db
		.select({
			accessToken: socialAccounts.accessToken,
			platformAccountId: socialAccounts.platformAccountId,
		})
		.from(socialAccounts)
		.where(eq(socialAccounts.id, event.accountId))
		.limit(1);

	if (!account) {
		await upsertLog(db, automation, event, false, false, "No social account found", existingLog?.id);
		return;
	}

	const token = await maybeDecrypt(account.accessToken, encryptionKey);
	if (!token) {
		await upsertLog(db, automation, event, false, false, "No access token", existingLog?.id);
		return;
	}

	// Use the OAuth platform account ID for API calls (not the webhook entry.id which
	// may be a different ID like the IGBA ID)
	const apiAccountId = account.platformAccountId;

	let dmSent = false;
	let replySent = false;
	let error: string | undefined;

	// Send DM via private reply
	try {
		const dmEndpoint =
			event.platform === "instagram"
				? `https://graph.instagram.com/v25.0/${apiAccountId}/messages`
				: `https://graph.facebook.com/v25.0/${apiAccountId}/messages`;

		console.log("[comment-automation] Sending DM", {
			endpoint: dmEndpoint,
			commentId: event.commentId,
			automationId: automation.id,
		});

		const dmAbort = new AbortController();
		const dmTimer = setTimeout(() => dmAbort.abort(), 10_000);
		try {
			const dmRes = await fetch(dmEndpoint, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					recipient: { comment_id: event.commentId },
					message: { text: automation.dmMessage },
				}),
				signal: dmAbort.signal,
			});

			if (dmRes.ok) {
				dmSent = true;
				console.log("[comment-automation] DM sent successfully");
			} else {
				const body = (await dmRes.json().catch(() => ({}))) as {
					error?: { message?: string; code?: number; error_subcode?: number };
				};
				error = body.error?.message ?? `DM failed: HTTP ${dmRes.status}`;
				console.error("[comment-automation] DM failed", {
					status: dmRes.status,
					error: body.error,
				});
			}
		} finally {
			clearTimeout(dmTimer);
		}
	} catch (err) {
		error = err instanceof Error ? err.message : "DM send failed";
		console.error("[comment-automation] DM exception", error);
	}

	// Optional public reply
	if (automation.publicReply && dmSent) {
		try {
			const replyEndpoint =
				event.platform === "instagram"
					? `https://graph.instagram.com/v25.0/${event.commentId}/replies`
					: `https://graph.facebook.com/v25.0/${event.commentId}/comments`;

			const replyAbort = new AbortController();
			const replyTimer = setTimeout(() => replyAbort.abort(), 10_000);
			try {
				const replyRes = await fetch(replyEndpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ message: automation.publicReply }),
					signal: replyAbort.signal,
				});

				replySent = replyRes.ok;
			} finally {
				clearTimeout(replyTimer);
			}
		} catch {
			// Public reply failure is non-critical
		}
	}

	await upsertLog(db, automation, event, dmSent, replySent, error, existingLog?.id);

	// Update automation stats (only increment if this is a new trigger, not a retry)
	if (!existingLog) {
		await db
			.update(commentAutomations)
			.set({
				totalTriggered: sql`${commentAutomations.totalTriggered} + 1`,
				lastTriggeredAt: new Date(),
			})
			.where(eq(commentAutomations.id, automation.id));
	}
}

async function upsertLog(
	db: Database,
	automation: typeof commentAutomations.$inferSelect,
	event: CommentEvent,
	dmSent: boolean,
	replySent: boolean,
	error?: string,
	existingLogId?: string,
): Promise<void> {
	if (existingLogId) {
		// Retry: update the existing failed log
		await db
			.update(commentAutomationLogs)
			.set({
				commentId: event.commentId,
				commentText: event.commentText,
				dmSent,
				replySent,
				error: error ?? null,
			})
			.where(eq(commentAutomationLogs.id, existingLogId));
	} else {
		await db.insert(commentAutomationLogs).values({
			automationId: automation.id,
			organizationId: event.organizationId,
			commentId: event.commentId,
			commenterId: event.commenterId,
			commenterName: event.commenterName ?? null,
			commentText: event.commentText,
			dmSent,
			replySent,
			error: error ?? null,
		});
	}
}
