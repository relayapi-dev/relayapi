/**
 * Resumable scheduled broadcast processor — runs on the every-minute cron.
 *
 * Picks up broadcasts that are due (`scheduled` and scheduledAt <= now) or
 * already in flight (`sending`), and sends their pending recipients in bounded
 * per-tick chunks. Capping the work per invocation keeps a single run well under
 * the Workers subrequest / wall-time limits; a large broadcast simply resumes on
 * the next tick until no recipient is left pending. Counts are finalized from the
 * recipients' persisted DB statuses, so resumption across ticks is safe.
 *
 * Mirrors the WhatsApp-specific processor (whatsapp-broadcast-processor.ts).
 */

import {
	createDb,
	broadcasts,
	broadcastRecipients,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Env } from "../types";
import { sendMessage } from "./message-sender";
import { refreshTokenIfNeeded } from "./token-refresh";
import { notifyRealtime } from "../lib/notify-post-update";

// Cap recipients processed per cron tick (across all broadcasts handled in the
// tick). Each recipient costs ~1 send + 1 update subrequest, so 200 is well
// under the per-invocation limit. Larger broadcasts resume on subsequent ticks.
const MAX_RECIPIENTS_PER_TICK = 200;
const CHUNK_SIZE = 50;
const INTER_CHUNK_DELAY_MS = 1000;
// A recipient claimed (`sending`) by a tick that then died is reverted to
// `pending` once its broadcast hasn't been touched for this long. A live tick
// bumps the broadcast's updatedAt every run (well under this window), so the
// sweep can never steal rows from an in-flight tick.
const STALE_CLAIM_MS = 10 * 60 * 1000;

export async function processScheduledBroadcasts(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const dueBroadcasts = await db
		.select()
		.from(broadcasts)
		.where(
			or(
				and(
					eq(broadcasts.status, "scheduled"),
					lte(broadcasts.scheduledAt, new Date()),
				),
				eq(broadcasts.status, "sending"),
			),
		)
		.orderBy(asc(broadcasts.scheduledAt))
		.limit(5);

	if (dueBroadcasts.length === 0) return;

	let budget = MAX_RECIPIENTS_PER_TICK;
	for (const broadcast of dueBroadcasts) {
		if (budget <= 0) break;
		try {
			budget -= await executeBroadcast(db, broadcast, env, budget);
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
	}
}

/**
 * Process up to `budget` pending recipients of a single broadcast. Returns the
 * number of recipients actually processed this tick. If recipients remain, the
 * broadcast is left in `sending` and resumes next tick; otherwise it is
 * finalized from the recipients' persisted DB statuses.
 */
async function executeBroadcast(
	db: ReturnType<typeof createDb>,
	broadcast: typeof broadcasts.$inferSelect,
	env: Env,
	budget: number,
): Promise<number> {
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
		return 0;
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
		return 0;
	}

	// Stale-claim sweep: if this broadcast has been in flight but untouched for
	// longer than STALE_CLAIM_MS (its tick died mid-send), revert any recipients
	// stuck in `sending` back to `pending` so they get re-claimed and re-sent.
	// The sweep is claimed atomically by bumping updatedAt only while it is still
	// stale (compare-and-set): if another tick won, `.returning()` is empty and we
	// skip — so the sweep can never revert rows a live tick is currently holding.
	if (broadcast.status === "sending") {
		const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
		const sweepClaim = await db
			.update(broadcasts)
			.set({ updatedAt: new Date() })
			.where(
				and(
					eq(broadcasts.id, broadcast.id),
					eq(broadcasts.status, "sending"),
					lte(broadcasts.updatedAt, staleBefore),
				),
			)
			.returning({ id: broadcasts.id });
		if (sweepClaim.length > 0) {
			await db
				.update(broadcastRecipients)
				.set({ status: "pending" })
				.where(
					and(
						eq(broadcastRecipients.broadcastId, broadcast.id),
						eq(broadcastRecipients.status, "sending"),
					),
				);
		}
	}

	// Claim a freshly-due broadcast so the next tick doesn't re-pick it. Compare-
	// and-set on the status: if a concurrent tick already claimed it
	// (`.returning()` empty), skip — that tick owns this broadcast.
	if (broadcast.status === "scheduled") {
		const claimed = await db
			.update(broadcasts)
			.set({ status: "sending", updatedAt: new Date() })
			.where(
				and(
					eq(broadcasts.id, broadcast.id),
					eq(broadcasts.status, "scheduled"),
				),
			)
			.returning({ id: broadcasts.id });
		if (claimed.length === 0) return 0;
		await notifyRealtime(env, broadcast.organizationId, {
			type: "broadcast.updated",
			broadcast_id: broadcast.id,
			status: "sending",
		}).catch(() => {});
	}

	let processed = 0;
	while (processed < budget) {
		const chunkLimit = Math.min(CHUNK_SIZE, budget - processed);

		// Atomically claim a chunk of pending recipients: flip them to `sending`
		// under FOR UPDATE SKIP LOCKED so an overlapping cron tick can never read
		// the same still-`pending` rows and send the message twice. Only the rows
		// this statement returns are sent by this tick.
		const batch = (await db.execute(sql`
			WITH claimed AS (
				SELECT id
				  FROM broadcast_recipients
				 WHERE broadcast_id = ${broadcast.id}
				   AND status = 'pending'
				 ORDER BY id ASC
				 LIMIT ${chunkLimit}
				 FOR UPDATE SKIP LOCKED
			)
			UPDATE broadcast_recipients r
			   SET status = 'sending'
			  FROM claimed
			 WHERE r.id = claimed.id
			RETURNING r.id, r.contact_identifier, r.variables
		`)) as unknown as Array<{
			id: string;
			contact_identifier: string;
			variables: unknown;
		}>;

		if (batch.length === 0) break;

		const results = await Promise.allSettled(
			batch.map((recipient) =>
				sendMessage({
					platform: broadcast.platform,
					accessToken: token,
					platformAccountId: account.platformAccountId ?? "",
					recipientId: recipient.contact_identifier,
					text: broadcast.messageText ?? "",
					templateName: broadcast.templateName ?? undefined,
					templateLanguage: broadcast.templateLanguage ?? undefined,
					templateComponents:
						(recipient.variables
							? (recipient.variables as unknown[])
							: (broadcast.templateComponents as unknown[] | null)) ??
						undefined,
				}),
			),
		);

		// Collapse the chunk's outcomes into at most two set-based UPDATEs (one for
		// successes, one for failures) instead of one round trip per recipient.
		const sentRows: Array<{ id: string; messageId: string | null }> = [];
		const failedRows: Array<{ id: string; error: string }> = [];
		for (let j = 0; j < results.length; j++) {
			const recipient = batch[j]!;
			const settled = results[j]!;
			if (settled.status === "fulfilled" && settled.value.success) {
				sentRows.push({
					id: recipient.id,
					messageId: settled.value.messageId ?? null,
				});
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
					UPDATE broadcast_recipients r
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
					UPDATE broadcast_recipients r
					   SET status = 'failed', error = v.error
					  FROM (VALUES ${values}) AS v(id, error)
					 WHERE r.id = v.id
				`),
			);
		}
		await Promise.all(writes);
		processed += batch.length;

		// Delay between batches to respect platform rate limits
		await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS));
	}

	const countByStatus = async (...statuses: string[]): Promise<number> => {
		const rows = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(broadcastRecipients)
			.where(
				and(
					eq(broadcastRecipients.broadcastId, broadcast.id),
					inArray(broadcastRecipients.status, statuses),
				),
			);
		return rows[0]?.count ?? 0;
	};

	// More recipients to go — keep it in `sending` and resume on the next tick.
	// Also wait while any recipient is still `sending` (claimed by a concurrent
	// tick): finalizing now would close the broadcast before those settle.
	if ((await countByStatus("pending", "sending")) > 0) {
		await db
			.update(broadcasts)
			.set({ status: "sending", updatedAt: new Date() })
			.where(eq(broadcasts.id, broadcast.id));
		return processed;
	}

	// Done — finalize from the recipients' persisted statuses.
	const sent = await countByStatus("sent");
	const failed = await countByStatus("failed");
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
	await notifyRealtime(env, broadcast.organizationId, {
		type: "broadcast.updated",
		broadcast_id: broadcast.id,
		status: finalStatus,
	}).catch(() => {});

	return processed;
}
