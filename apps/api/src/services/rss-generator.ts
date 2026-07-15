import {
	autoPostFeedItems,
	autoPostRules,
	createDb,
	posts,
	postTargets,
	publishOutbox,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "../types";
import {
	canonicalFeedItemIdentity,
	parseFeed,
	renderTemplate,
	rssFeedItemOperationId,
} from "./feed-parser";
import { dispatchPublishOutbox, publishOutboxRow } from "./publish-outbox";
import {
	enqueuePersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "./webhook-delivery";

const RULE_LEASE_MS = 5 * 60 * 1000;
const MAX_ITEMS_PER_POLL = 5;

type ClaimedRule = typeof autoPostRules.$inferSelect;

async function claimDueRules(
	db: ReturnType<typeof createDb>,
	now: Date,
): Promise<ClaimedRule[]> {
	const candidates = await db
		.select()
		.from(autoPostRules)
		.where(
			and(
				eq(autoPostRules.status, "active"),
				or(
					isNull(autoPostRules.leaseExpiresAt),
					lte(autoPostRules.leaseExpiresAt, now),
				),
				or(
					isNull(autoPostRules.lastProcessedAt),
					sql`${autoPostRules.lastProcessedAt} + (${autoPostRules.pollingIntervalMinutes} * interval '1 minute') <= ${now.toISOString()}`,
				),
			),
		)
		.limit(10);

	const claimed: ClaimedRule[] = [];
	for (const candidate of candidates) {
		const [row] = await db
			.update(autoPostRules)
			.set({
				leaseToken: sql`${autoPostRules.leaseToken} + 1`,
				leaseExpiresAt: new Date(now.getTime() + RULE_LEASE_MS),
			})
			.where(
				and(
					eq(autoPostRules.id, candidate.id),
					eq(autoPostRules.status, "active"),
					eq(autoPostRules.leaseToken, candidate.leaseToken),
					or(
						isNull(autoPostRules.leaseExpiresAt),
						lte(autoPostRules.leaseExpiresAt, now),
					),
				),
			)
			.returning();
		if (row) claimed.push(row);
	}
	return claimed;
}

export async function processAutoPostRules(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const rules = await claimDueRules(db, new Date());

	for (const rule of rules) {
		try {
			await processRule(db, env, rule);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const consecutiveErrors = rule.consecutiveErrors + 1;
			const shouldPause = consecutiveErrors >= 5;
			const now = new Date();
			const webhook = await db.transaction(async (tx) => {
				const [updated] = await tx
					.update(autoPostRules)
					.set({
						consecutiveErrors,
						lastError: message,
						lastProcessedAt: now,
						...(shouldPause ? { status: "error" as const } : {}),
						leaseExpiresAt: null,
						updatedAt: now,
					})
					.where(
						and(
							eq(autoPostRules.id, rule.id),
							eq(autoPostRules.status, "active"),
							eq(autoPostRules.leaseToken, rule.leaseToken),
						),
					)
					.returning({ id: autoPostRules.id });
				if (!updated || !shouldPause) return null;
				return persistWebhookEventInTransaction(
					tx,
					rule.organizationId,
					"auto_post.error",
					{ rule_id: rule.id, error: message },
					{
						workspaceId: rule.workspaceId,
						occurrenceId: `auto-post:${rule.id}:error:${consecutiveErrors}`,
					},
				);
			});
			if (webhook) await enqueuePersistedWebhookEvent(env, db, webhook);
		}
	}
	if (rules.length > 0) {
		try {
			await dispatchPublishOutbox(env);
		} catch (error) {
			console.error("[rss-generator] Durable publish dispatch deferred", error);
		}
	}
}

async function assertAndRenewRuleLease(
	tx: Parameters<Parameters<ReturnType<typeof createDb>["transaction"]>[0]>[0],
	rule: ClaimedRule,
	now: Date,
): Promise<void> {
	const [fenced] = await tx
		.update(autoPostRules)
		.set({ leaseExpiresAt: new Date(now.getTime() + RULE_LEASE_MS) })
		.where(
			and(
				eq(autoPostRules.id, rule.id),
				eq(autoPostRules.status, "active"),
				eq(autoPostRules.leaseToken, rule.leaseToken),
			),
		)
		.returning({ id: autoPostRules.id });
	if (!fenced) throw new Error("RSS rule lease lost");
}

async function processRule(
	db: ReturnType<typeof createDb>,
	env: Env,
	rule: ClaimedRule,
): Promise<void> {
	const items = await parseFeed(rule.feedUrl);
	const identified = await Promise.all(
		items.map(async (item) => ({
			item,
			...(await canonicalFeedItemIdentity(item)),
		})),
	);

	const isFirstPoll = rule.lastProcessedAt === null;
	if (isFirstPoll && identified.length > 1) {
		await db.transaction(async (tx) => {
			const now = new Date();
			await assertAndRenewRuleLease(tx, rule, now);
			await tx
				.insert(autoPostFeedItems)
				.values(
					identified
						.slice(1)
						.map(({ item, canonicalFeedItemId, canonicalUrl }) => ({
							operationId: rssFeedItemOperationId(rule.id, canonicalFeedItemId),
							ruleId: rule.id,
							organizationId: rule.organizationId,
							canonicalFeedItemId,
							sourceItemId: item.sourceId ?? null,
							canonicalUrl,
							publishedAt: item.publishedAt,
							status: "ignored" as const,
							completedAt: now,
						})),
				)
				.onConflictDoNothing();
		});
	}

	const canonicalIds = identified.map((entry) => entry.canonicalFeedItemId);
	const existing = canonicalIds.length
		? await db
				.select({ canonicalFeedItemId: autoPostFeedItems.canonicalFeedItemId })
				.from(autoPostFeedItems)
				.where(
					and(
						eq(autoPostFeedItems.ruleId, rule.id),
						inArray(autoPostFeedItems.canonicalFeedItemId, canonicalIds),
					),
				)
		: [];
	const existingIds = new Set(existing.map((row) => row.canonicalFeedItemId));
	const candidates = (isFirstPoll ? identified.slice(0, 1) : identified)
		.filter((entry) => !existingIds.has(entry.canonicalFeedItemId))
		.slice(0, MAX_ITEMS_PER_POLL)
		.reverse();

	// An unchanged feed is a successful no-op. Resolve targets only when a new
	// item actually needs a post; otherwise a temporarily unavailable account
	// would incorrectly accumulate rule errors and eventually pause the feed.
	const accountConditions = [
		eq(socialAccounts.organizationId, rule.organizationId),
		eq(socialAccounts.lifecycleStatus, "active"),
	];
	if (rule.workspaceId) {
		accountConditions.push(eq(socialAccounts.workspaceId, rule.workspaceId));
	}
	if (rule.accountIds.length > 0) {
		accountConditions.push(inArray(socialAccounts.id, rule.accountIds));
	}
	const accounts =
		candidates.length === 0
			? []
			: await db
					.select({ id: socialAccounts.id, platform: socialAccounts.platform })
					.from(socialAccounts)
					.where(and(...accountConditions));
	if (candidates.length > 0 && accounts.length === 0) {
		throw new Error("No eligible target accounts found");
	}

	for (const entry of candidates) {
		const now = new Date();
		const operationId = rssFeedItemOperationId(
			rule.id,
			entry.canonicalFeedItemId,
		);
		const result = await db.transaction(async (tx) => {
			await assertAndRenewRuleLease(tx, rule, now);
			const [ledger] = await tx
				.insert(autoPostFeedItems)
				.values({
					operationId,
					ruleId: rule.id,
					organizationId: rule.organizationId,
					canonicalFeedItemId: entry.canonicalFeedItemId,
					sourceItemId: entry.item.sourceId ?? null,
					canonicalUrl: entry.canonicalUrl,
					publishedAt: entry.item.publishedAt,
					status: "processing",
				})
				.onConflictDoNothing()
				.returning({ id: autoPostFeedItems.id });
			if (!ledger) return null;

			const [createdPost] = await tx
				.insert(posts)
				.values({
					organizationId: rule.organizationId,
					workspaceId: rule.workspaceId,
					content: renderTemplate(
						rule.contentTemplate,
						entry.item,
						rule.appendFeedUrl,
					),
					status: "scheduled",
					scheduledAt: now,
				})
				.returning();
			if (!createdPost) throw new Error("Failed to create RSS post");

			await tx.insert(postTargets).values(
				accounts.map((account) => ({
					organizationId: rule.organizationId,
					postId: createdPost.id,
					socialAccountId: account.id,
					platform: account.platform,
					status: "scheduled" as const,
				})),
			);
			await tx.insert(publishOutbox).values(
				publishOutboxRow({
					organizationId: rule.organizationId,
					postId: createdPost.id,
					operationId,
				}),
			);
			await tx
				.update(autoPostFeedItems)
				.set({ status: "committed", postId: createdPost.id, completedAt: now })
				.where(eq(autoPostFeedItems.id, ledger.id));
			await tx
				.update(autoPostRules)
				.set({ lastProcessedUrl: entry.item.url || null, lastProcessedAt: now })
				.where(
					and(
						eq(autoPostRules.id, rule.id),
						eq(autoPostRules.status, "active"),
						eq(autoPostRules.leaseToken, rule.leaseToken),
					),
				);
			const webhook = await persistWebhookEventInTransaction(
				tx,
				rule.organizationId,
				"auto_post.created",
				{
					rule_id: rule.id,
					post_id: createdPost.id,
					feed_item_url: entry.item.url,
					feed_item_title: entry.item.title,
					operation_id: operationId,
				},
				{
					workspaceId: rule.workspaceId,
					occurrenceId: `auto-post:${operationId}:created`,
				},
			);
			return { post: createdPost, webhook };
		});

		if (result) {
			await enqueuePersistedWebhookEvent(env, db, result.webhook);
		}
	}

	const finishedAt = new Date();
	await db
		.update(autoPostRules)
		.set({
			lastProcessedAt: finishedAt,
			consecutiveErrors: 0,
			lastError: null,
			leaseExpiresAt: null,
			updatedAt: finishedAt,
		})
		.where(
			and(
				eq(autoPostRules.id, rule.id),
				eq(autoPostRules.status, "active"),
				eq(autoPostRules.leaseToken, rule.leaseToken),
			),
		);
}
