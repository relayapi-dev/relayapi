// ---------------------------------------------------------------------------
// External Post Sync — Cron Handler (runs every 5 minutes)
// ---------------------------------------------------------------------------

import {
	createDb,
	externalPosts,
	socialAccountSyncState,
} from "@relayapi/db";
import { and, inArray, or, isNull, gt, lt, sql } from "drizzle-orm";
import type { Env } from "../../types";
import type { SyncPostsMessage, RefreshMetricsMessage } from "./types";

const BATCH_SIZE = 100; // CF Queue sendBatch limit
const MAX_ACCOUNTS_PER_RUN = 500;
// How far to push nextSyncAt when claiming a row for enqueue. Long enough that a
// slow backlog drain doesn't re-enqueue the same accounts on the next 5-min tick,
// short enough that a row whose consumer never ran becomes due again promptly.
const SYNC_CLAIM_WINDOW_MS = 15 * 60_000;
// Same idea for metrics refresh — claim by advancing metricsUpdatedAt.
const METRICS_CLAIM_WINDOW_MS = 15 * 60_000;
const METRICS_REFRESH_HOURS = 6;
const METRICS_POST_AGE_DAYS = 7;
const METRICS_BATCH_SIZE = 50;
// Cursor loop: keep pulling pages until we run out or hit this cap per tick.
// 2500 = 5 pages × 500; any single org rarely has that much stale, but orgs
// that do will catch up across ticks instead of stalling at 500 forever.
const METRICS_PAGE_SIZE = 500;
const METRICS_MAX_POSTS_PER_RUN = 2500;

// ---------------------------------------------------------------------------
// Enqueue accounts due for sync + metrics refresh
// ---------------------------------------------------------------------------

export async function enqueueExternalPostSync(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	// 1. Find accounts due for sync
	await enqueueDueAccounts(db, env, now);

	// 2. Enqueue metrics refresh for recent posts
	await enqueueMetricsRefresh(db, env, now);
}

// ---------------------------------------------------------------------------
// Enqueue accounts whose nextSyncAt has passed
// ---------------------------------------------------------------------------

async function enqueueDueAccounts(
	db: ReturnType<typeof createDb>,
	env: Env,
	now: Date,
): Promise<void> {
	// Claim due rows at enqueue time: push nextSyncAt forward by a short claim
	// window in the SAME statement that selects them (UPDATE ... RETURNING over a
	// CTE that picks the due rows). Without this, when the backlog takes longer
	// than the 5-minute cron period to drain, the next tick re-selects and
	// re-enqueues the same accounts (the consumer only advances nextSyncAt on
	// completion), multiplying external API calls and queue depth. The consumer
	// later overwrites nextSyncAt with the real poll interval; if it never runs,
	// the row simply becomes due again after the claim window.
	const claimUntil = new Date(now.getTime() + SYNC_CLAIM_WINDOW_MS);
	const dueAccounts = await db
		.update(socialAccountSyncState)
		.set({ nextSyncAt: claimUntil, updatedAt: now })
		.where(
			sql`${socialAccountSyncState.id} IN (
				SELECT id FROM ${socialAccountSyncState}
				WHERE ${socialAccountSyncState.enabled} = true
					AND ${socialAccountSyncState.nextSyncAt} <= ${now}
					AND (
						${socialAccountSyncState.rateLimitResetAt} IS NULL
						OR ${socialAccountSyncState.rateLimitResetAt} <= ${now}
					)
				ORDER BY ${socialAccountSyncState.nextSyncAt}
				LIMIT ${MAX_ACCOUNTS_PER_RUN}
			)`,
		)
		.returning({
			socialAccountId: socialAccountSyncState.socialAccountId,
			organizationId: socialAccountSyncState.organizationId,
			platform: socialAccountSyncState.platform,
		});

	if (dueAccounts.length === 0) return;

	// Batch-enqueue to SYNC_QUEUE (100 per sendBatch call)
	const messages: { body: SyncPostsMessage }[] = dueAccounts.map((a) => ({
		body: {
			type: "sync_posts" as const,
			social_account_id: a.socialAccountId,
			organization_id: a.organizationId,
			platform: a.platform,
		},
	}));

	for (let i = 0; i < messages.length; i += BATCH_SIZE) {
		const batch = messages.slice(i, i + BATCH_SIZE);
		await env.SYNC_QUEUE.sendBatch(batch);
	}

	console.log(`[Sync Cron] Enqueued ${dueAccounts.length} account syncs`);
}

// ---------------------------------------------------------------------------
// Enqueue metrics refresh for recent external posts
// ---------------------------------------------------------------------------

async function enqueueMetricsRefresh(
	db: ReturnType<typeof createDb>,
	env: Env,
	now: Date,
): Promise<void> {
	const staleThreshold = new Date(
		now.getTime() - METRICS_REFRESH_HOURS * 3600_000,
	);
	const ageThreshold = new Date(
		now.getTime() - METRICS_POST_AGE_DAYS * 86400_000,
	);

	// Cursor-paginated scan so backlogs larger than one page still drain.
	// Uses `id` as a stable keyset cursor; `externalPosts_metrics_updated_idx`
	// handles the staleness filter and we order by id to paginate deterministically.
	let cursorId: string | null = null;
	let totalStale = 0;
	const byAccount = new Map<
		string,
		{ organizationId: string; platform: string; postIds: string[] }
	>();

	while (totalStale < METRICS_MAX_POSTS_PER_RUN) {
		const conditions = [
			gt(externalPosts.publishedAt, ageThreshold),
			or(
				isNull(externalPosts.metricsUpdatedAt),
				lt(externalPosts.metricsUpdatedAt, staleThreshold),
			),
		];
		if (cursorId) conditions.push(gt(externalPosts.id, cursorId));

		const page = await db
			.select({
				id: externalPosts.id,
				socialAccountId: externalPosts.socialAccountId,
				organizationId: externalPosts.organizationId,
				platform: externalPosts.platform,
			})
			.from(externalPosts)
			.where(and(...conditions))
			.orderBy(externalPosts.id)
			.limit(METRICS_PAGE_SIZE);

		if (page.length === 0) break;

		for (const post of page) {
			const data = byAccount.get(post.socialAccountId) ?? {
				organizationId: post.organizationId,
				platform: post.platform,
				postIds: [],
			};
			data.postIds.push(post.id);
			byAccount.set(post.socialAccountId, data);
		}
		totalStale += page.length;
		const lastRow = page[page.length - 1];
		if (!lastRow) break;
		cursorId = lastRow.id;
		if (page.length < METRICS_PAGE_SIZE) break;
	}

	if (totalStale === 0) return;

	// Claim the selected posts by pushing metricsUpdatedAt into the future so the
	// next 5-min tick does not re-enqueue them while this batch is still draining
	// (the consumer only sets metricsUpdatedAt = now on completion). If the
	// consumer never runs, the claim window lapses and the post becomes stale
	// again. One bulk UPDATE for all claimed ids.
	const claimedIds: string[] = [];
	for (const data of byAccount.values()) claimedIds.push(...data.postIds);
	if (claimedIds.length > 0) {
		const claimUntil = new Date(now.getTime() + METRICS_CLAIM_WINDOW_MS);
		await db
			.update(externalPosts)
			.set({ metricsUpdatedAt: claimUntil })
			.where(inArray(externalPosts.id, claimedIds));
	}

	// Enqueue metrics refresh messages (batches of 50 post IDs each)
	const messages: { body: RefreshMetricsMessage }[] = [];

	for (const [accountId, data] of byAccount) {
		for (let i = 0; i < data.postIds.length; i += METRICS_BATCH_SIZE) {
			messages.push({
				body: {
					type: "refresh_metrics",
					organization_id: data.organizationId,
					social_account_id: accountId,
					platform: data.platform,
					external_post_ids: data.postIds.slice(i, i + METRICS_BATCH_SIZE),
				},
			});
		}
	}

	for (let i = 0; i < messages.length; i += BATCH_SIZE) {
		const batch = messages.slice(i, i + BATCH_SIZE);
		await env.SYNC_QUEUE.sendBatch(batch);
	}

	console.log(
		`[Sync Cron] Enqueued ${messages.length} metrics refresh batches for ${totalStale} posts`,
	);
}
