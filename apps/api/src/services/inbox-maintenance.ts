/**
 * Inbox maintenance service — periodic cleanup tasks.
 *
 * - cleanupOldConversations: archives conversations with no activity for 90+ days
 *
 * Runs daily at 9am UTC via cron trigger.
 */

import { createDb, inboxConversations } from "@relayapi/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// cleanupOldConversations — archive stale conversations
// ---------------------------------------------------------------------------

export async function cleanupOldConversations(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const cutoff = sql`NOW() - INTERVAL '90 days'`;

	const result = await db
		.update(inboxConversations)
		.set({
			status: "archived",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(inboxConversations.status, "open"),
				lt(inboxConversations.lastMessageAt, cutoff),
			),
		)
		.returning({ id: inboxConversations.id });

	console.log(
		`[inbox-maintenance] Archived ${result.length} stale conversations (no activity for 90+ days)`,
	);
}
