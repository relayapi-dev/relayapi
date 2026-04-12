// ---------------------------------------------------------------------------
// Ad Analytics Service — fetches, stores, and aggregates ad metrics
// ---------------------------------------------------------------------------

import { createDb, adMetrics, ads, adAccounts, socialAccounts, eq } from "@relayapi/db";
import { and, gte, lte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getAdPlatformAdapter } from "./ad-platforms";
import { resolveAdsAccessToken } from "./ad-access-token";
import type { AdMetricPoint } from "./ad-platforms/types";
import { AdPlatformError } from "./ad-platforms/types";

type Database = ReturnType<typeof createDb>;

// ---------------------------------------------------------------------------
// Fetch + Store metrics for a single ad
// ---------------------------------------------------------------------------

export async function fetchAndStoreAdMetrics(
	env: Env,
	adId: string,
	startDate: string,
	endDate: string,
): Promise<AdMetricPoint[]> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Fetch ad + account details
	const [ad] = await db
		.select({
			ad: ads,
			adAccount: adAccounts,
			socialAccount: socialAccounts,
		})
		.from(ads)
		.innerJoin(adAccounts, eq(ads.adAccountId, adAccounts.id))
		.innerJoin(
			socialAccounts,
			eq(adAccounts.socialAccountId, socialAccounts.id),
		)
		.where(eq(ads.id, adId))
		.limit(1);

	if (!ad || !ad.ad.platformAdId) return [];

	const accessToken = await resolveAdsAccessToken(ad.socialAccount, env);

	const adapter = getAdPlatformAdapter(ad.adAccount.platform);
	if (!adapter) return [];

	const result = await adapter.getAdMetrics(
		accessToken,
		ad.ad.platformAdId,
		{ startDate, endDate },
	);

	// Upsert daily metrics
	for (const point of result.daily) {
		await db
			.insert(adMetrics)
			.values({
				adId,
				date: new Date(point.date),
				impressions: point.impressions,
				reach: point.reach,
				clicks: point.clicks,
				spendCents: point.spendCents,
				conversions: point.conversions,
				videoViews: point.videoViews,
				engagement: point.engagement,
				ctr: point.ctr ? Math.round(point.ctr * 10000) : null,
				cpcCents: point.cpcCents ?? null,
				cpmCents: point.cpmCents ?? null,
			})
			.onConflictDoUpdate({
				target: [adMetrics.adId, adMetrics.date],
				set: {
					impressions: point.impressions,
					reach: point.reach,
					clicks: point.clicks,
					spendCents: point.spendCents,
					conversions: point.conversions,
					videoViews: point.videoViews,
					engagement: point.engagement,
					ctr: point.ctr ? Math.round(point.ctr * 10000) : null,
					cpcCents: point.cpcCents ?? null,
					cpmCents: point.cpmCents ?? null,
					collectedAt: new Date(),
				},
			});
	}

	return result.daily;
}

// ---------------------------------------------------------------------------
// Get analytics for a single ad (from stored metrics)
// ---------------------------------------------------------------------------

export async function getAdAnalytics(
	db: Database,
	adId: string,
	startDate?: string,
	endDate?: string,
) {
	// Default to last 30 days, cap at 365 days max
	const now = new Date();
	const effectiveEnd = endDate ? new Date(endDate) : now;
	const defaultStart = new Date(effectiveEnd);
	defaultStart.setDate(defaultStart.getDate() - 30);
	const effectiveStart = startDate ? new Date(startDate) : defaultStart;

	// Cap max range at 365 days
	const maxStart = new Date(effectiveEnd);
	maxStart.setDate(maxStart.getDate() - 365);
	const clampedStart =
		effectiveStart < maxStart ? maxStart : effectiveStart;

	const conditions = [
		eq(adMetrics.adId, adId),
		gte(adMetrics.date, clampedStart),
		lte(adMetrics.date, effectiveEnd),
	];

	const metrics = await db
		.select()
		.from(adMetrics)
		.where(and(...conditions))
		.orderBy(adMetrics.date)
		.limit(366);

	// Compute summary
	const summary = {
		impressions: 0,
		reach: 0,
		clicks: 0,
		spend_cents: 0,
		conversions: 0,
		ctr: 0,
		cpc_cents: 0,
		cpm_cents: 0,
	};

	for (const m of metrics) {
		summary.impressions += m.impressions ?? 0;
		summary.reach += m.reach ?? 0;
		summary.clicks += m.clicks ?? 0;
		summary.spend_cents += m.spendCents ?? 0;
		summary.conversions += m.conversions ?? 0;
	}

	if (summary.impressions > 0) {
		summary.ctr = (summary.clicks / summary.impressions) * 100;
		summary.cpm_cents = Math.round(
			(summary.spend_cents / summary.impressions) * 1000,
		);
	}
	if (summary.clicks > 0) {
		summary.cpc_cents = Math.round(summary.spend_cents / summary.clicks);
	}

	const daily = metrics.map((m) => ({
		date: m.date.toISOString().split("T")[0],
		impressions: m.impressions ?? 0,
		reach: m.reach ?? 0,
		clicks: m.clicks ?? 0,
		spend_cents: m.spendCents ?? 0,
		conversions: m.conversions ?? 0,
		video_views: m.videoViews ?? 0,
		engagement: m.engagement ?? 0,
		ctr: m.ctr ? m.ctr / 10000 : undefined,
		cpc_cents: m.cpcCents ?? undefined,
		cpm_cents: m.cpmCents ?? undefined,
	}));

	return { summary, daily };
}

// ---------------------------------------------------------------------------
// Get real-time analytics from platform (with optional breakdowns)
// ---------------------------------------------------------------------------

export async function getAdAnalyticsLive(
	env: Env,
	adId: string,
	startDate: string,
	endDate: string,
	breakdowns?: string[],
) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [ad] = await db
		.select({
			ad: ads,
			adAccount: adAccounts,
			socialAccount: socialAccounts,
		})
		.from(ads)
		.innerJoin(adAccounts, eq(ads.adAccountId, adAccounts.id))
		.innerJoin(
			socialAccounts,
			eq(adAccounts.socialAccountId, socialAccounts.id),
		)
		.where(eq(ads.id, adId))
		.limit(1);

	if (!ad || !ad.ad.platformAdId) {
		throw new AdPlatformError("NOT_FOUND", "Ad not found or has no platform ID");
	}

	const accessToken = await resolveAdsAccessToken(ad.socialAccount, env);

	const adapter = getAdPlatformAdapter(ad.adAccount.platform);
	if (!adapter) {
		throw new AdPlatformError("UNSUPPORTED_PLATFORM", "No adapter for platform");
	}

	const result = await adapter.getAdMetrics(
		accessToken,
		ad.ad.platformAdId,
		{ startDate, endDate },
		breakdowns,
	);

	// Compute summary from daily data
	const summary = {
		impressions: 0,
		reach: 0,
		clicks: 0,
		spend_cents: 0,
		conversions: 0,
		ctr: 0,
		cpc_cents: 0,
		cpm_cents: 0,
	};

	for (const d of result.daily) {
		summary.impressions += d.impressions;
		summary.reach += d.reach;
		summary.clicks += d.clicks;
		summary.spend_cents += d.spendCents;
		summary.conversions += d.conversions;
	}

	if (summary.impressions > 0) {
		summary.ctr = (summary.clicks / summary.impressions) * 100;
		summary.cpm_cents = Math.round(
			(summary.spend_cents / summary.impressions) * 1000,
		);
	}
	if (summary.clicks > 0) {
		summary.cpc_cents = Math.round(summary.spend_cents / summary.clicks);
	}

	return {
		summary,
		daily: result.daily.map((d) => ({
			date: d.date,
			impressions: d.impressions,
			reach: d.reach,
			clicks: d.clicks,
			spend_cents: d.spendCents,
			conversions: d.conversions,
			video_views: d.videoViews,
			engagement: d.engagement,
		})),
		demographics: result.demographics
			? {
					age_gender: result.demographics.ageGender,
					locations: result.demographics.locations,
				}
			: undefined,
	};
}
