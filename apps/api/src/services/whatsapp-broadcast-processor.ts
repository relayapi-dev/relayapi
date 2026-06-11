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
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
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
// A recipient claimed (`sending`) by a tick that then died is reverted to
// `pending` once its broadcast hasn't been touched for this long. A live tick
// bumps the broadcast's updatedAt every run (well under this window), so the
// sweep can never steal rows from an in-flight tick.
const STALE_CLAIM_MS = 10 * 60 * 1000;

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
	// Stale-claim sweep: if this broadcast has been in flight but untouched for
	// longer than STALE_CLAIM_MS (its tick died mid-send), revert any recipients
	// stuck in `sending` back to `pending` so they get re-claimed and re-sent.
	// The sweep is claimed atomically by bumping updatedAt only while it is still
	// stale (compare-and-set): if another tick won, `.returning()` is empty and we
	// skip — so the sweep can never revert rows a live tick is currently holding.
	if (broadcast.status === "sending") {
		const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
		const sweepClaim = await db
			.update(whatsappBroadcasts)
			.set({ updatedAt: new Date() })
			.where(
				and(
					eq(whatsappBroadcasts.id, broadcast.id),
					eq(whatsappBroadcasts.status, "sending"),
					lte(whatsappBroadcasts.updatedAt, staleBefore),
				),
			)
			.returning({ id: whatsappBroadcasts.id });
		if (sweepClaim.length > 0) {
			await db
				.update(whatsappBroadcastRecipients)
				.set({ status: "pending" })
				.where(
					and(
						eq(whatsappBroadcastRecipients.broadcastId, broadcast.id),
						eq(whatsappBroadcastRecipients.status, "sending"),
					),
				);
		}
	}

	// Claim a freshly-due broadcast so the next tick doesn't re-pick it.
	// Compare-and-set on the broadcast status: if a concurrent tick already
	// claimed it (`.returning()` empty), skip — that tick owns this broadcast.
	if (broadcast.status === "scheduled") {
		const claimed = await db
			.update(whatsappBroadcasts)
			.set({ status: "sending", updatedAt: new Date() })
			.where(
				and(
					eq(whatsappBroadcasts.id, broadcast.id),
					eq(whatsappBroadcasts.status, "scheduled"),
				),
			)
			.returning({ id: whatsappBroadcasts.id });
		if (claimed.length === 0) return 0;
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
		const chunkLimit = Math.min(CHUNK_SIZE, budget - processed);

		// Atomically claim a chunk of pending recipients: flip them to `sending`
		// under FOR UPDATE SKIP LOCKED so an overlapping cron tick can never read
		// the same still-`pending` rows and send the template message twice. Only
		// the rows this statement returns are sent by this tick.
		const batch = (await db.execute(sql`
			WITH claimed AS (
				SELECT id
				  FROM whatsapp_broadcast_recipients
				 WHERE broadcast_id = ${broadcast.id}
				   AND status = 'pending'
				 ORDER BY id ASC
				 LIMIT ${chunkLimit}
				 FOR UPDATE SKIP LOCKED
			)
			UPDATE whatsapp_broadcast_recipients r
			   SET status = 'sending'
			  FROM claimed
			 WHERE r.id = claimed.id
			RETURNING r.id, r.phone
		`)) as unknown as Array<{ id: string; phone: string }>;

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

		// Collapse the chunk's outcomes into at most two set-based UPDATEs (one for
		// successes, one for failures) instead of one round trip per recipient.
		const sentRows: Array<{ id: string; messageId: string | null }> = [];
		const failedRows: Array<{ id: string; error: string }> = [];
		for (let i = 0; i < results.length; i++) {
			const recipient = batch[i]!;
			const settled = results[i]!;
			if (settled.status === "fulfilled" && settled.value.success) {
				sentRows.push({ id: recipient.id, messageId: settled.value.messageId ?? null });
			} else {
				const error =
					settled.status === "fulfilled"
						? (settled.value.error ?? "Unknown error")
						: settled.reason instanceof Error
							? settled.reason.message
							: "Unknown error";
				failedRows.push({ id: recipient.id, error });
			}
		}

		const writes: Promise<unknown>[] = [];
		if (sentRows.length > 0) {
			const values = sql.join(
				sentRows.map((r) => sql`(${r.id}::text, ${r.messageId}::text)`),
				sql`, `,
			);
			writes.push(
				db.execute(sql`
					UPDATE whatsapp_broadcast_recipients r
					   SET status = 'sent', message_id = v.message_id, sent_at = NOW()
					  FROM (VALUES ${values}) AS v(id, message_id)
					 WHERE r.id = v.id
				`),
			);
		}
		if (failedRows.length > 0) {
			const values = sql.join(
				failedRows.map((r) => sql`(${r.id}::text, ${r.error}::text)`),
				sql`, `,
			);
			writes.push(
				db.execute(sql`
					UPDATE whatsapp_broadcast_recipients r
					   SET status = 'failed', error = v.error
					  FROM (VALUES ${values}) AS v(id, error)
					 WHERE r.id = v.id
				`),
			);
		}
		await Promise.all(writes);
		processed += batch.length;

		// Brief pause between chunks to respect platform rate limits.
		await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
	}

	const countByStatus = async (
		...statuses: string[]
	): Promise<number> => {
		const rows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(whatsappBroadcastRecipients)
			.where(
				and(
					eq(whatsappBroadcastRecipients.broadcastId, broadcast.id),
					inArray(whatsappBroadcastRecipients.status, statuses),
				),
			);
		return rows[0]?.count ?? 0;
	};

	// More recipients to go — keep it in `sending` and resume on the next tick.
	// Also wait while any recipient is still `sending` (claimed by a concurrent
	// tick): finalizing now would close the broadcast before those settle.
	if ((await countByStatus("pending", "sending")) > 0) {
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
