// ---------------------------------------------------------------------------
// Ad Sync Service — imports external ads + refreshes metrics
// ---------------------------------------------------------------------------

import {
	createDb,
	ads,
	adAccounts,
	adCampaigns,
	adSyncLogs,
	socialAccounts,
	eq,
} from "@relayapi/db";
import { and, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getAdPlatformAdapter } from "./ad-platforms";
import { resolveAdsAccessToken } from "./ad-access-token";
import { fetchAndStoreAdMetrics } from "./ad-analytics";

type Database = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// Sync external ads for a single ad account
// ---------------------------------------------------------------------------

export async function syncExternalAds(
	env: Env,
	adAccountId: string,
	orgId: string,
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
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!ctx) {
		console.error(`[Ad Sync] Ad account ${adAccountId} not found`);
		return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };
	}

	const accessToken = await resolveAdsAccessToken(ctx.socialAccount, env);

	const adapter = getAdPlatformAdapter(ctx.adAccount.platform);
	if (!adapter) return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };

	let adsCreated = 0;
	let adsUpdated = 0;
	let metricsUpdated = 0;
	let error: string | undefined;

	const logStart = new Date();

	try {
		const result = await adapter.syncExternalAds(
			accessToken,
			ctx.adAccount.platformAdAccountId,
		);

		for (const externalAd of result.ads) {
			// Upsert campaign
			let [campaign] = await db
				.select()
				.from(adCampaigns)
				.where(
					and(
						eq(adCampaigns.organizationId, orgId),
						eq(
							adCampaigns.platformCampaignId,
							externalAd.platformCampaignId,
						),
					),
				)
				.limit(1);

			if (!campaign) {
				[campaign] = await db
					.insert(adCampaigns)
					.values({
						organizationId: orgId,
						adAccountId,
						platform: ctx.adAccount.platform,
						platformCampaignId: externalAd.platformCampaignId,
						name: externalAd.campaignName,
						objective: (externalAd.objective as any) ?? "engagement",
						status: externalAd.status as any,
						dailyBudgetCents: externalAd.dailyBudgetCents,
						lifetimeBudgetCents: externalAd.lifetimeBudgetCents,
						isExternal: true,
						metadata: {
							platformAdSetId: externalAd.platformAdSetId,
						},
					})
					.returning();
			}

			// Upsert ad
			const [existingAd] = await db
				.select()
				.from(ads)
				.where(
					and(
						eq(ads.organizationId, orgId),
						eq(ads.platformAdId, externalAd.platformAdId),
					),
				)
				.limit(1);

			if (existingAd) {
				await db
					.update(ads)
					.set({
						status: externalAd.status as any,
						name: externalAd.adName,
						updatedAt: new Date(),
					})
					.where(eq(ads.id, existingAd.id));
				adsUpdated++;
			} else {
				await db.insert(ads).values({
					organizationId: orgId,
					campaignId: campaign!.id,
					adAccountId,
					platform: ctx.adAccount.platform,
					platformAdId: externalAd.platformAdId,
					name: externalAd.adName,
					status: externalAd.status as any,
					headline: externalAd.creative?.headline,
					body: externalAd.creative?.body,
					imageUrl: externalAd.creative?.imageUrl,
					videoUrl: externalAd.creative?.videoUrl,
					linkUrl: externalAd.creative?.linkUrl,
					callToAction: externalAd.creative?.callToAction,
					targeting: externalAd.targeting as any,
					dailyBudgetCents: externalAd.dailyBudgetCents,
					lifetimeBudgetCents: externalAd.lifetimeBudgetCents,
					startDate: externalAd.startDate
						? new Date(externalAd.startDate)
						: null,
					endDate: externalAd.endDate
						? new Date(externalAd.endDate)
						: null,
					isExternal: true,
				});
				adsCreated++;
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

		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
		const endDate = new Date().toISOString().split("T")[0]!;
		const startDate = thirtyDaysAgo.toISOString().split("T")[0]!;

		// Process in batches of 5 for bounded concurrency
		for (let i = 0; i < activeAds.length; i += 5) {
			const batch = activeAds.slice(i, i + 5);
			const results = await Promise.allSettled(
				batch.map((ad) => fetchAndStoreAdMetrics(env, ad.id, startDate, endDate)),
			);
			for (const r of results) {
				if (r.status === "fulfilled") metricsUpdated++;
				else console.error("[Ad Sync] Metrics fetch failed:", r.reason);
			}
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		console.error(
			`[Ad Sync] Failed for ad account ${adAccountId}:`,
			error,
		);
	}

	// Log the sync
	await db.insert(adSyncLogs).values({
		organizationId: orgId,
		adAccountId,
		platform: ctx.adAccount.platform,
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

		// Enqueue sync jobs via the ads queue for bounded concurrency
		for (const account of page) {
			try {
				await env.ADS_QUEUE.send({
					type: "sync_external",
					org_id: account.organizationId,
					ad_account_id: account.id,
				});
				totalEnqueued++;
			} catch (err) {
				console.error(`[Ad Sync] Failed to enqueue ${account.id}:`, err);
			}
		}

		lastId = page[page.length - 1]!.id;
		if (page.length < PAGE_SIZE) break;
	}

	console.log(`[Ad Sync] Enqueued ${totalEnqueued} ad accounts for sync`);
}
