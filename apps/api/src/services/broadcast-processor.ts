/**
 * Scheduled broadcast processor — runs on the every-minute cron trigger.
 * Finds broadcasts with status "scheduled" and scheduledAt <= now(), then sends them.
 */

import {
	createDb,
	broadcasts,
	broadcastRecipients,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { Env } from "../types";
import { sendMessage } from "./message-sender";
import { refreshTokenIfNeeded } from "./token-refresh";
import { notifyRealtime } from "../lib/notify-post-update";

export async function processScheduledBroadcasts(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const dueBroadcasts = await db
		.select()
		.from(broadcasts)
		.where(
			and(
				eq(broadcasts.status, "scheduled"),
				lte(broadcasts.scheduledAt, new Date()),
			),
		)
		.orderBy(asc(broadcasts.scheduledAt))
		.limit(5);

	if (dueBroadcasts.length === 0) return;

	// The query caps at 5 due broadcasts per tick, so running them concurrently
	// is safe — one slow broadcast can no longer delay the others.
	await Promise.allSettled(
		dueBroadcasts.map(async (broadcast) => {
			try {
				await executeBroadcast(db, broadcast, env);
			} catch (err) {
				console.error(
					`[broadcast-processor] Failed to process broadcast ${broadcast.id}:`,
					err,
				);
				// Mark as failed so it doesn't retry forever
				await db
					.update(broadcasts)
					.set({
						status: "failed",
						completedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(broadcasts.id, broadcast.id));
				await notifyRealtime(env, broadcast.organizationId, {
					type: "broadcast.updated",
					broadcast_id: broadcast.id,
					status: "failed",
				}).catch(() => {});
			}
		}),
	);
}

async function executeBroadcast(
	db: ReturnType<typeof createDb>,
	broadcast: typeof broadcasts.$inferSelect,
	env: Env,
): Promise<void> {
	// Get the social account's access token
	const [account] = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			accessToken: socialAccounts.accessToken,
			refreshToken: socialAccounts.refreshToken,
			tokenExpiresAt: socialAccounts.tokenExpiresAt,
			platformAccountId: socialAccounts.platformAccountId,
		})
		.from(socialAccounts)
		.where(eq(socialAccounts.id, broadcast.socialAccountId))
		.limit(1);

	if (!account) {
		console.error(
			`[broadcast-processor] Account ${broadcast.socialAccountId} not found`,
		);
		await db
			.update(broadcasts)
			.set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
			.where(eq(broadcasts.id, broadcast.id));
		return;
	}

	const token = await refreshTokenIfNeeded(env, account);
	if (!token) {
		console.error(
			`[broadcast-processor] No access token for account ${broadcast.socialAccountId}`,
		);
		await db
			.update(broadcasts)
			.set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
			.where(eq(broadcasts.id, broadcast.id));
		return;
	}

	// Mark as sending
	await db
		.update(broadcasts)
		.set({ status: "sending", updatedAt: new Date() })
		.where(eq(broadcasts.id, broadcast.id));
	await notifyRealtime(env, broadcast.organizationId, { type: "broadcast.updated", broadcast_id: broadcast.id, status: "sending" }).catch(() => {});

	let sent = 0;
	let failed = 0;

	// Cursor-based batching to avoid loading all recipients into memory at once
	const BATCH_SIZE = 50;
	let cursor: string | null = null;

	while (true) {
		const conditions = [
			eq(broadcastRecipients.broadcastId, broadcast.id),
			eq(broadcastRecipients.status, "pending"),
		];
		if (cursor) {
			conditions.push(gt(broadcastRecipients.id, cursor));
		}

		const batch = await db
			.select()
			.from(broadcastRecipients)
			.where(and(...conditions))
			.orderBy(broadcastRecipients.id)
			.limit(BATCH_SIZE);

		if (batch.length === 0) break;

		cursor = batch[batch.length - 1]!.id;

		const results = await Promise.allSettled(
			batch.map((recipient) =>
				sendMessage({
					platform: broadcast.platform,
					accessToken: token,
					platformAccountId: account.platformAccountId ?? "",
					recipientId: recipient.contactIdentifier,
					text: broadcast.messageText ?? "",
					templateName: broadcast.templateName ?? undefined,
					templateLanguage: broadcast.templateLanguage ?? undefined,
					templateComponents: (recipient.variables
						? (recipient.variables as unknown[])
						: (broadcast.templateComponents as unknown[] | null)) ?? undefined,
				}),
			),
		);

		// Batch DB updates for this chunk
		const dbUpdates: Promise<unknown>[] = [];
		for (let j = 0; j < results.length; j++) {
			const recipient = batch[j]!;
			const settled = results[j]!;

			if (settled.status === "fulfilled" && settled.value.success) {
				dbUpdates.push(
					db.update(broadcastRecipients).set({
						status: "sent",
						messageId: settled.value.messageId ?? null,
						sentAt: new Date(),
					}).where(eq(broadcastRecipients.id, recipient.id)),
				);
				sent++;
			} else {
				const error = settled.status === "fulfilled"
					? (settled.value.error ?? "Unknown error")
					: (settled.reason instanceof Error ? settled.reason.message : "Unknown error");
				dbUpdates.push(
					db.update(broadcastRecipients).set({
						status: "failed",
						error,
					}).where(eq(broadcastRecipients.id, recipient.id)),
				);
				failed++;
			}
		}
		await Promise.all(dbUpdates);

		// Delay between batches to respect platform rate limits
		await new Promise(r => setTimeout(r, 1000));
	}

	const finalStatus =
		failed === 0 ? "sent" : sent === 0 ? "failed" : "partially_failed";

	await db
		.update(broadcasts)
		.set({
			status: finalStatus,
			sentCount: sent,
			failedCount: failed,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(broadcasts.id, broadcast.id));
	await notifyRealtime(env, broadcast.organizationId, { type: "broadcast.updated", broadcast_id: broadcast.id, status: finalStatus }).catch(() => {});
}
