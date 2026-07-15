// ---------------------------------------------------------------------------
// Ad Sync Service — imports external ads + refreshes metrics
// ---------------------------------------------------------------------------

import {
	adAccounts,
	adCampaigns,
	adSyncLogs,
	ads,
	createDb,
	eq,
	socialAccounts,
} from "@relayapi/db";
import { and, inArray, sql } from "drizzle-orm";
import type { Env } from "../types";
import { resolveAdsAccessToken } from "./ad-access-token";
import { fetchAndStoreAdMetrics } from "./ad-analytics";
import { getAdPlatformAdapter } from "./ad-platforms";

type SyncedCampaignObjective = (typeof adCampaigns.$inferInsert)["objective"];
type SyncedAdStatus = (typeof ads.$inferInsert)["status"];
type SyncedTargeting = (typeof ads.$inferInsert)["targeting"];

function asCampaignObjective(
	objective: string | undefined,
	fallback: SyncedCampaignObjective = "engagement",
): SyncedCampaignObjective {
	return (objective ?? fallback) as SyncedCampaignObjective;
}

function asAdStatus(status: string): SyncedAdStatus {
	return status as SyncedAdStatus;
}

function asAdTargeting(targeting: unknown): SyncedTargeting {
	return targeting as SyncedTargeting;
}

// ---------------------------------------------------------------------------
// Sync external ads for a single ad account
// ---------------------------------------------------------------------------

export async function syncExternalAds(
	env: Env,
	adAccountId: string,
	orgId: string,
	opts?: { windowDays?: number },
): Promise<{ adsCreated: number; adsUpdated: number; metricsUpdated: number }> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [ctx] = await db
		.select({
			adAccount: adAccounts,
			socialAccount: socialAccounts,
		})
		.from(adAccounts)
		.innerJoin(
			socialAccounts,
			eq(adAccounts.socialAccountId, socialAccounts.id),
		)
		.where(
			and(eq(adAccounts.id, adAccountId), eq(adAccounts.organizationId, orgId)),
		)
		.limit(1);

	if (!ctx) {
		console.error(`[Ad Sync] Ad account ${adAccountId} not found`);
		return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };
	}

	// Stable non-null reference so nested closures below don't lose the `ctx`
	// narrowing from the early `if (!ctx)` return.
	const adAccount = ctx.adAccount;
	const accessToken = await resolveAdsAccessToken(ctx.socialAccount, env);

	const adapter = getAdPlatformAdapter(adAccount.platform);
	if (!adapter) return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };

	let adsCreated = 0;
	let adsUpdated = 0;
	let metricsUpdated = 0;
	let error: string | undefined;

	try {
		const result = await adapter.syncExternalAds(
			accessToken,
			adAccount.platformAdAccountId,
		);

		// Pre-fetch this ad account's existing remote ad IDs once for reporting.
		// Identity itself is enforced by composite unique indexes and atomic
		// ON CONFLICT upserts below, so overlapping cron/manual syncs cannot race
		// through a check-then-insert window.
		const platformAdIds = [
			...new Set(
				result.ads
					.map((a) => a.platformAdId)
					.filter((id): id is string => Boolean(id)),
			),
		];

		const existingAdRows = await (platformAdIds.length > 0
			? db
					.select({ id: ads.id, platformAdId: ads.platformAdId })
					.from(ads)
					.where(
						and(
							eq(ads.adAccountId, adAccountId),
							inArray(ads.platformAdId, platformAdIds),
						),
					)
			: Promise.resolve([] as { id: string; platformAdId: string | null }[]));

		const existingAdIds = new Set(
			existingAdRows
				.filter((a) => a.platformAdId)
				.map((a) => a.platformAdId as string),
		);

		// Resolve (upsert) the internal campaign id for a platform campaign id
		// exactly once per sync, caching the result so ads sharing a campaign
		// don't repeat the upsert.
		const resolvedCampaignId = new Map<string, string>();

		async function upsertCampaign(
			externalAd: (typeof result.ads)[number],
		): Promise<string | null> {
			const platformCampaignId = externalAd.platformCampaignId;
			const alreadyResolved = resolvedCampaignId.get(platformCampaignId);
			if (alreadyResolved !== undefined) {
				return alreadyResolved;
			}

			const campaignValues = {
				organizationId: orgId,
				workspaceId: adAccount.workspaceId,
				adAccountId,
				platform: adAccount.platform,
				platformCampaignId,
				name: externalAd.campaignName,
				objective: asCampaignObjective(externalAd.objective),
				status: asAdStatus(externalAd.status),
				dailyBudgetCents: externalAd.dailyBudgetCents,
				lifetimeBudgetCents: externalAd.lifetimeBudgetCents,
				currency: adAccount.currency,
				isExternal: true,
				metadata: { platformAdSetId: externalAd.platformAdSetId },
				updatedAt: new Date(),
			};
			const [campaign] = await db
				.insert(adCampaigns)
				.values(campaignValues)
				.onConflictDoUpdate({
					target: [adCampaigns.adAccountId, adCampaigns.platformCampaignId],
					set: {
						workspaceId: campaignValues.workspaceId,
						name: campaignValues.name,
						// Some provider sync payloads omit objective. Preserve the
						// existing campaign value instead of silently resetting it.
						objective:
							externalAd.objective === undefined
								? sql`${adCampaigns.objective}`
								: campaignValues.objective,
						status: campaignValues.status,
						dailyBudgetCents: campaignValues.dailyBudgetCents,
						lifetimeBudgetCents: campaignValues.lifetimeBudgetCents,
						currency: campaignValues.currency,
						metadata: campaignValues.metadata,
						isExternal: true,
						updatedAt: campaignValues.updatedAt,
					},
				})
				.returning();

			if (!campaign) return null;
			resolvedCampaignId.set(platformCampaignId, campaign.id);
			return campaign.id;
		}

		for (const externalAd of result.ads) {
			const campaignId = await upsertCampaign(externalAd);

			if (!campaignId) {
				console.warn(
					`[Ad Sync] Skipping ad ${externalAd.platformAdId} because its campaign could not be upserted`,
				);
				continue;
			}

			const adValues = {
				organizationId: orgId,
				workspaceId: adAccount.workspaceId,
				campaignId,
				adAccountId,
				platform: adAccount.platform,
				platformAdId: externalAd.platformAdId,
				name: externalAd.adName,
				status: asAdStatus(externalAd.status),
				headline: externalAd.creative?.headline,
				body: externalAd.creative?.body,
				imageUrl: externalAd.creative?.imageUrl,
				videoUrl: externalAd.creative?.videoUrl,
				linkUrl: externalAd.creative?.linkUrl,
				callToAction: externalAd.creative?.callToAction,
				targeting: asAdTargeting(externalAd.targeting),
				dailyBudgetCents: externalAd.dailyBudgetCents,
				lifetimeBudgetCents: externalAd.lifetimeBudgetCents,
				startDate: externalAd.startDate ? new Date(externalAd.startDate) : null,
				endDate: externalAd.endDate ? new Date(externalAd.endDate) : null,
				isExternal: true,
				updatedAt: new Date(),
			};
			await db
				.insert(ads)
				.values(adValues)
				.onConflictDoUpdate({
					target: [ads.adAccountId, ads.platformAdId],
					set: {
						workspaceId: adValues.workspaceId,
						campaignId: adValues.campaignId,
						name: adValues.name,
						status: adValues.status,
						headline: adValues.headline,
						body: adValues.body,
						imageUrl: adValues.imageUrl,
						videoUrl: adValues.videoUrl,
						linkUrl: adValues.linkUrl,
						callToAction: adValues.callToAction,
						targeting: adValues.targeting,
						dailyBudgetCents: adValues.dailyBudgetCents,
						lifetimeBudgetCents: adValues.lifetimeBudgetCents,
						startDate: adValues.startDate,
						endDate: adValues.endDate,
						isExternal: true,
						updatedAt: adValues.updatedAt,
					},
				});

			if (existingAdIds.has(externalAd.platformAdId)) adsUpdated++;
			else {
				adsCreated++;
				existingAdIds.add(externalAd.platformAdId);
			}
		}

		// Refresh metrics for active ads only (with limit to avoid timeout)
		const activeAds = await db
			.select({ id: ads.id })
			.from(ads)
			.where(
				and(
					eq(ads.adAccountId, adAccountId),
					eq(ads.organizationId, orgId),
					sql`${ads.status} NOT IN ('completed', 'rejected', 'cancelled')`,
				),
			)
			.limit(200);

		// An explicit windowDays (e.g. a user-triggered full sync) always wins.
		// Otherwise the recurring */30 cron only needs a short window to catch
		// Meta's attribution backfill; re-pulling the full 30 days every cycle
		// re-fetches 29+ days of unchanged history and burns Meta's rate limit.
		// Sweep the full 30-day window once per day (the single 00:00 UTC run —
		// gated on minutes so the 00:30 run doesn't double-sweep) and use a 3-day
		// window otherwise.
		const now = new Date();
		const windowDays =
			opts?.windowDays ??
			(now.getUTCHours() === 0 && now.getUTCMinutes() < 30 ? 30 : 3);
		const windowStart = new Date(now);
		windowStart.setDate(windowStart.getDate() - windowDays);
		const endDate = now.toISOString().split("T")[0] ?? "";
		const startDate = windowStart.toISOString().split("T")[0] ?? "";

		// Process in batches of 5 for bounded concurrency. Reuse this sync's db
		// client instead of opening a fresh postgres client per ad.
		for (let i = 0; i < activeAds.length; i += 5) {
			const batch = activeAds.slice(i, i + 5);
			const results = await Promise.allSettled(
				batch.map((ad) =>
					fetchAndStoreAdMetrics(env, ad.id, startDate, endDate, db),
				),
			);
			for (const r of results) {
				if (r.status === "fulfilled") metricsUpdated++;
				else console.error("[Ad Sync] Metrics fetch failed:", r.reason);
			}
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		console.error(`[Ad Sync] Failed for ad account ${adAccountId}:`, error);
	}

	// Log the sync
	await db.insert(adSyncLogs).values({
		organizationId: orgId,
		adAccountId,
		platform: adAccount.platform,
		syncType: "full",
		adsCreated,
		adsUpdated,
		metricsUpdated,
		error,
		completedAt: new Date(),
	});

	return { adsCreated, adsUpdated, metricsUpdated };
}

// ---------------------------------------------------------------------------
// Sync all ad accounts (called by cron)
// ---------------------------------------------------------------------------

export async function syncAllExternalAds(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const PAGE_SIZE = 100;
	let lastId: string | null = null;
	let totalEnqueued = 0;

	// Process accounts in pages to avoid loading all into memory
	while (true) {
		const conditions = [eq(adAccounts.status, "active")];
		if (lastId) conditions.push(sql`${adAccounts.id} > ${lastId}`);

		const page = await db
			.select({
				id: adAccounts.id,
				organizationId: adAccounts.organizationId,
			})
			.from(adAccounts)
			.where(and(...conditions))
			.orderBy(adAccounts.id)
			.limit(PAGE_SIZE);

		if (page.length === 0) break;

		// Enqueue the whole page in a single sendBatch (CF limit is 100 messages,
		// which matches PAGE_SIZE) instead of N serial send round trips.
		try {
			await env.ADS_QUEUE.sendBatch(
				page.map((account) => ({
					body: {
						type: "sync_external",
						org_id: account.organizationId,
						ad_account_id: account.id,
					},
				})),
			);
			totalEnqueued += page.length;
		} catch (err) {
			console.error("[Ad Sync] Failed to enqueue page:", err);
		}

		const lastRow = page[page.length - 1];
		if (!lastRow) break;
		lastId = lastRow.id;
		if (page.length < PAGE_SIZE) break;
	}

	console.log(`[Ad Sync] Enqueued ${totalEnqueued} ad accounts for sync`);
}
