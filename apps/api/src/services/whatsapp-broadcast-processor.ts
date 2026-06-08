/**
 * Resumable WhatsApp broadcast processor — runs on the every-minute cron.
 *
 * Picks up legacy `whatsapp_broadcasts` that are due (`scheduled` and
 * scheduledAt <= now) or already in flight (`sending`), and sends their pending
 * recipients in bounded per-tick chunks. Capping the work per invocation keeps a
 * single run well under the Workers subrequest / wall-time limits; a large
 * broadcast simply resumes on the next tick until no recipient is left pending.
 *
 * This is the async send path for the (deprecated) WhatsApp-specific broadcast
 * endpoints. POST /broadcasts/{id}/send now only marks the broadcast scheduled
 * and returns immediately — this processor performs the actual delivery. It also
 * makes POST /broadcasts/{id}/schedule functional (previously nothing ever sent
 * scheduled WhatsApp broadcasts).
 */

import {
	createDb,
	socialAccounts,
	whatsappBroadcasts,
	whatsappBroadcastRecipients,
} from "@relayapi/db";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { notifyRealtime } from "../lib/notify-post-update";
import type { Env } from "../types";
import { sendMessage } from "./message-sender";

// Cap recipients processed per cron tick (across all broadcasts handled in the
// tick). Each recipient costs ~1 send + 1 update subrequest, so 200 ≈ 400
// subrequests — comfortably under the per-invocation limit. Larger broadcasts
// resume on subsequent ticks.
const MAX_RECIPIENTS_PER_TICK = 200;
const CHUNK_SIZE = 25;
const INTER_CHUNK_DELAY_MS = 500;

export async function processScheduledWhatsAppBroadcasts(
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const due = await db
		.select()
		.from(whatsappBroadcasts)
		.where(
			or(
				and(
					eq(whatsappBroadcasts.status, "scheduled"),
					lte(whatsappBroadcasts.scheduledAt, new Date()),
				),
				eq(whatsappBroadcasts.status, "sending"),
			),
		)
		.orderBy(asc(whatsappBroadcasts.scheduledAt))
		.limit(5);

	if (due.length === 0) return;

	let budget = MAX_RECIPIENTS_PER_TICK;
	for (const broadcast of due) {
		if (budget <= 0) break;
		try {
			budget -= await processBroadcast(db, broadcast, env, budget);
		} catch (err) {
			console.error(
				`[wa-broadcast-processor] Failed to process broadcast ${broadcast.id}:`,
				err,
			);
			await db
				.update(whatsappBroadcasts)
				.set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
				.where(eq(whatsappBroadcasts.id, broadcast.id));
			await notifyRealtime(env, broadcast.organizationId, {
				type: "broadcast.updated",
				broadcast_id: broadcast.id,
				status: "failed",
			}).catch(() => {});
		}
	}
}

/**
 * Process up to `budget` pending recipients of a single broadcast. Returns the
 * number of recipients actually processed this tick. If recipients remain, the
 * broadcast is left in `sending` and resumes next tick; otherwise it is
 * finalized from the recipients' DB statuses (resumption-safe — no reliance on
 * in-memory accumulators that reset between ticks).
 */
async function processBroadcast(
	db: ReturnType<typeof createDb>,
	broadcast: typeof whatsappBroadcasts.$inferSelect,
	env: Env,
	budget: number,
): Promise<number> {
	// Claim a freshly-due broadcast so the next tick doesn't re-pick it.
	if (broadcast.status === "scheduled") {
		await db
			.update(whatsappBroadcasts)
			.set({ status: "sending", updatedAt: new Date() })
			.where(eq(whatsappBroadcasts.id, broadcast.id));
		await notifyRealtime(env, broadcast.organizationId, {
			type: "broadcast.updated",
			broadcast_id: broadcast.id,
			status: "sending",
		}).catch(() => {});
	}

	const [account] = await db
		.select({
			accessToken: socialAccounts.accessToken,
			platformAccountId: socialAccounts.platformAccountId,
		})
		.from(socialAccounts)
		.where(eq(socialAccounts.id, broadcast.socialAccountId))
		.limit(1);

	const token = account
		? await maybeDecrypt(account.accessToken, env.ENCRYPTION_KEY)
		: null;

	if (!account || !token || !account.platformAccountId) {
		await db
			.update(whatsappBroadcasts)
			.set({ status: "failed", completedAt: new Date(), updatedAt: new Date() })
			.where(eq(whatsappBroadcasts.id, broadcast.id));
		await notifyRealtime(env, broadcast.organizationId, {
			type: "broadcast.updated",
			broadcast_id: broadcast.id,
			status: "failed",
		}).catch(() => {});
		return 0;
	}

	const phoneNumberId = account.platformAccountId;
	const templateComponents =
		(broadcast.templateComponents as unknown[] | null) ?? undefined;

	let processed = 0;
	while (processed < budget) {
		const batch = await db
			.select()
			.from(whatsappBroadcastRecipients)
			.where(
				and(
					eq(whatsappBroadcastRecipients.broadcastId, broadcast.id),
					eq(whatsappBroadcastRecipients.status, "pending"),
				),
			)
			.orderBy(asc(whatsappBroadcastRecipients.id))
			.limit(Math.min(CHUNK_SIZE, budget - processed));

		if (batch.length === 0) break;

		const results = await Promise.allSettled(
			batch.map((recipient) =>
				sendMessage({
					platform: "whatsapp",
					accessToken: token,
					platformAccountId: phoneNumberId,
					recipientId: recipient.phone,
					text: "",
					templateName: broadcast.templateName,
					templateLanguage: broadcast.templateLanguage,
					templateComponents,
				}),
			),
		);

		const updates: Promise<unknown>[] = [];
		for (let i = 0; i < results.length; i++) {
			const recipient = batch[i]!;
			const settled = results[i]!;
			if (settled.status === "fulfilled" && settled.value.success) {
				updates.push(
					db
						.update(whatsappBroadcastRecipients)
						.set({
							status: "sent",
							messageId: settled.value.messageId ?? null,
							sentAt: new Date(),
						})
						.where(eq(whatsappBroadcastRecipients.id, recipient.id)),
				);
			} else {
				const error =
					settled.status === "fulfilled"
						? (settled.value.error ?? "Unknown error")
						: settled.reason instanceof Error
							? settled.reason.message
							: "Unknown error";
				updates.push(
					db
						.update(whatsappBroadcastRecipients)
						.set({ status: "failed", error })
						.where(eq(whatsappBroadcastRecipients.id, recipient.id)),
				);
			}
		}
		await Promise.all(updates);
		processed += batch.length;

		// Brief pause between chunks to respect platform rate limits.
		await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
	}

	const countByStatus = async (status: string): Promise<number> => {
		const rows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(whatsappBroadcastRecipients)
			.where(
				and(
					eq(whatsappBroadcastRecipients.broadcastId, broadcast.id),
					eq(whatsappBroadcastRecipients.status, status),
				),
			);
		return rows[0]?.count ?? 0;
	};

	// More recipients to go — keep it in `sending` and resume on the next tick.
	if ((await countByStatus("pending")) > 0) {
		await db
			.update(whatsappBroadcasts)
			.set({ status: "sending", updatedAt: new Date() })
			.where(eq(whatsappBroadcasts.id, broadcast.id));
		return processed;
	}

	// Done — finalize from the recipients' persisted statuses.
	const sentCount = await countByStatus("sent");
	const failedCount = await countByStatus("failed");
	const finalStatus =
		failedCount === 0 ? "sent" : sentCount === 0 ? "failed" : "partially_failed";

	await db
		.update(whatsappBroadcasts)
		.set({
			status: finalStatus,
			sentCount,
			failedCount,
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(whatsappBroadcasts.id, broadcast.id));
	await notifyRealtime(env, broadcast.organizationId, {
		type: "broadcast.updated",
		broadcast_id: broadcast.id,
		status: finalStatus,
	}).catch(() => {});

	return processed;
}
