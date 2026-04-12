// ---------------------------------------------------------------------------
// External Post Sync — Cron Handler (runs every 5 minutes)
// ---------------------------------------------------------------------------

import {
	createDb,
	externalPosts,
	socialAccountSyncState,
} from "@relayapi/db";
import { and, eq, lte, or, isNull, gt, lt, sql } from "drizzle-orm";
import type { Env } from "../../types";
import type { SyncPostsMessage, RefreshMetricsMessage } from "./types";

const BATCH_SIZE = 100; // CF Queue sendBatch limit
const MAX_ACCOUNTS_PER_RUN = 500;
const METRICS_REFRESH_HOURS = 6;
const METRICS_POST_AGE_DAYS = 7;
const METRICS_BATCH_SIZE = 50;

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
	const dueAccounts = await db
		.select({
			socialAccountId: socialAccountSyncState.socialAccountId,
			organizationId: socialAccountSyncState.organizationId,
			platform: socialAccountSyncState.platform,
		})
		.from(socialAccountSyncState)
		.where(
			and(
				eq(socialAccountSyncState.enabled, true),
				lte(socialAccountSyncState.nextSyncAt, now),
				or(
					isNull(socialAccountSyncState.rateLimitResetAt),
					lte(socialAccountSyncState.rateLimitResetAt, now),
				),
			),
		)
		.orderBy(socialAccountSyncState.nextSyncAt)
		.limit(MAX_ACCOUNTS_PER_RUN);

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

	// Find external posts needing metric refresh:
	// - Published within last 7 days
	// - Metrics not updated in last 6 hours
	const stalePosts = await db
		.select({
			id: externalPosts.id,
			socialAccountId: externalPosts.socialAccountId,
			organizationId: externalPosts.organizationId,
			platform: externalPosts.platform,
		})
		.from(externalPosts)
		.where(
			and(
				gt(externalPosts.publishedAt, ageThreshold),
				or(
					isNull(externalPosts.metricsUpdatedAt),
					lt(externalPosts.metricsUpdatedAt, staleThreshold),
				),
			),
		)
		.limit(500);

	if (stalePosts.length === 0) return;

	// Group by social account for batching
	const byAccount = new Map<
		string,
		{ organizationId: string; platform: string; postIds: string[] }
	>();

	for (const post of stalePosts) {
		const key = post.socialAccountId;
		if (!byAccount.has(key)) {
			byAccount.set(key, {
				organizationId: post.organizationId,
				platform: post.platform,
				postIds: [],
			});
		}
		byAccount.get(key)!.postIds.push(post.id);
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
		`[Sync Cron] Enqueued ${messages.length} metrics refresh batches for ${stalePosts.length} posts`,
	);
}
