// ---------------------------------------------------------------------------
// External Post Sync — Cron Handler (runs every 5 minutes)
// ---------------------------------------------------------------------------

import { createDb, socialAccountSyncState } from "@relayapi/db";
import { sql } from "drizzle-orm";
import { EXTERNAL_POST_POLL } from "../../lib/async-policy";
import type { Env } from "../../types";
import type { SyncPostsMessage } from "./types";

const BATCH_SIZE = 100; // CF Queue sendBatch limit

// ---------------------------------------------------------------------------
// Enqueue accounts due for content sync. Metrics polling has one canonical
// producer in analytics-refresh.ts.
// ---------------------------------------------------------------------------

export async function enqueueExternalPostSync(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	await enqueueDueAccounts(db, env, now);
}

// ---------------------------------------------------------------------------
// Enqueue accounts whose nextSyncAt has passed
// ---------------------------------------------------------------------------

async function enqueueDueAccounts(
	db: ReturnType<typeof createDb>,
	env: Env,
	now: Date,
): Promise<void> {
	// PostgreSQL is the schedule authority. Rank due rows within each tenant
	// first, then interleave ranks globally so one large tenant cannot fill the
	// whole claim page. The generation/lease is reserved in this same UPDATE.
	const leaseExpiresAt = new Date(
		now.getTime() + EXTERNAL_POST_POLL.leaseSeconds * 1000,
	);
	const dueAccounts = await db
		.update(socialAccountSyncState)
		.set({
			pollGeneration: sql`${socialAccountSyncState.pollGeneration} + 1`,
			pollLeaseExpiresAt: leaseExpiresAt,
			pollStartedAt: null,
			updatedAt: now,
		})
		.where(
			sql`${socialAccountSyncState.id} IN (
				SELECT ranked.id
				FROM (
					SELECT
						s.id,
						s.organization_id,
						s.next_sync_at,
						row_number() OVER (
							PARTITION BY s.organization_id
							ORDER BY s.next_sync_at, s.id
						) AS tenant_rank
					FROM social_account_sync_state s
					WHERE s.enabled = true
						AND s.next_sync_at <= ${now}
						AND s.consecutive_errors < ${EXTERNAL_POST_POLL.maxAutomaticAttempts}
						AND (
							s.poll_lease_expires_at IS NULL
							OR s.poll_lease_expires_at <= ${now}
						)
						AND (
							s.rate_limit_reset_at IS NULL
							OR s.rate_limit_reset_at <= ${now}
						)
				) ranked
				WHERE ranked.tenant_rank <= ${EXTERNAL_POST_POLL.maxClaimsPerTenant}
				ORDER BY
					ranked.tenant_rank,
					ranked.next_sync_at,
					ranked.organization_id,
					ranked.id
				LIMIT ${EXTERNAL_POST_POLL.maxClaimsPerRun}
			)`,
		)
		.returning({
			socialAccountId: socialAccountSyncState.socialAccountId,
			organizationId: socialAccountSyncState.organizationId,
			platform: socialAccountSyncState.platform,
			pollGeneration: socialAccountSyncState.pollGeneration,
		});

	if (dueAccounts.length === 0) return;

	// Batch-enqueue to SYNC_QUEUE (100 per sendBatch call)
	const messages: { body: SyncPostsMessage }[] = dueAccounts.map((a) => ({
		body: {
			type: "sync_posts" as const,
			social_account_id: a.socialAccountId,
			organization_id: a.organizationId,
			platform: a.platform,
			poll_generation: a.pollGeneration,
		},
	}));

	for (let i = 0; i < messages.length; i += BATCH_SIZE) {
		const batch = messages.slice(i, i + BATCH_SIZE);
		await env.SYNC_QUEUE.sendBatch(batch);
	}

	console.log(`[Sync Cron] Enqueued ${dueAccounts.length} account syncs`);
}
