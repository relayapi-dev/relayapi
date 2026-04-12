// ---------------------------------------------------------------------------
// Ad Service — orchestrates DB operations + platform adapter calls
// ---------------------------------------------------------------------------

import {
	createDb,
	ads,
	adAccounts,
	adCampaigns,
	posts,
	postTargets,
	socialAccounts,
	eq,
} from "@relayapi/db";
import { and, desc, sql } from "drizzle-orm";
import type { Env } from "../types";
import {
	getAdPlatformAdapter,
	socialPlatformToAdPlatform,
} from "./ad-platforms";
import { resolveAdsAccessToken } from "./ad-access-token";
import type {
	AdPlatform,
	AdTargeting,
} from "./ad-platforms/types";
import { AdPlatformError } from "./ad-platforms/types";

// Re-export for route handlers
export { AdPlatformError };

type Database = ReturnType<typeof createDb>;

async function getAccountWithToken(
	db: Database,
	adAccountId: string,
	orgId: string,
	env: Env,
) {
	const [adAcc] = await db
		.select({
			adAccount: adAccounts,
			socialAccount: socialAccounts,
		})
		.from(adAccounts)
		.innerJoin(socialAccounts, eq(adAccounts.socialAccountId, socialAccounts.id))
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!adAcc) return null;

	const accessToken = await resolveAdsAccessToken(adAcc.socialAccount, env);

	return {
		...adAcc,
		accessToken,
		adPlatform: adAcc.adAccount.platform,
	};
}

// ---------------------------------------------------------------------------
// Ad Account Operations
// ---------------------------------------------------------------------------

export async function discoverAdAccounts(
	env: Env,
	orgId: string,
	socialAccountId: string,
): Promise<
	{
		id: string;
		name: string;
		currency?: string;
		timezone?: string;
		status?: string;
	}[]
> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [socialAcc] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, socialAccountId),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!socialAcc) throw new AdPlatformError("NOT_FOUND", "Social account not found");

	const adPlatform = socialPlatformToAdPlatform(socialAcc.platform);
	if (!adPlatform) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`Platform "${socialAcc.platform}" does not support ads`,
		);
	}

	const adapter = getAdPlatformAdapter(adPlatform);
	if (!adapter) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform "${adPlatform}"`,
		);
	}

	const accessToken = await resolveAdsAccessToken(socialAcc, env);

	const platformAccounts = await adapter.listAdAccounts(
		accessToken,
		socialAcc.platformAccountId,
	);

	// Batch upsert discovered accounts (inherit workspaceId from social account)
	const socialAccountWorkspaceId = socialAcc.workspaceId;
	if (platformAccounts.length > 0) {
		const CHUNK = 100;
		for (let i = 0; i < platformAccounts.length; i += CHUNK) {
			const chunk = platformAccounts.slice(i, i + CHUNK);
			await db
				.insert(adAccounts)
				.values(
					chunk.map((pa) => ({
						organizationId: orgId,
						workspaceId: socialAccountWorkspaceId,
						socialAccountId,
						platform: adPlatform,
						platformAdAccountId: pa.id,
						name: pa.name,
						currency: pa.currency ?? "USD",
						timezone: pa.timezone,
						status: pa.status ?? "active",
					})),
				)
				.onConflictDoUpdate({
					target: [
						adAccounts.organizationId,
						adAccounts.platform,
						adAccounts.platformAdAccountId,
					],
					set: {
						name: sql`excluded.name`,
						currency: sql`excluded.currency`,
						timezone: sql`excluded.timezone`,
						status: sql`excluded.status`,
						updatedAt: new Date(),
					},
				});
		}
	}

	return platformAccounts;
}

// ---------------------------------------------------------------------------
// Campaign Operations
// ---------------------------------------------------------------------------

export async function createCampaign(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		name: string;
		objective: string;
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		currency?: string;
		startDate?: string;
		endDate?: string;
		specialAdCategories?: string[];
	},
) {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const ctx = await getAccountWithToken(db, params.adAccountId, orgId, env);
	if (!ctx) throw new AdPlatformError("NOT_FOUND", "Ad account not found");

	const adapter = getAdPlatformAdapter(ctx.adPlatform);
	if (!adapter) throw new AdPlatformError("UNSUPPORTED_PLATFORM", "No adapter");

	const result = await adapter.createCampaign(
		ctx.accessToken,
		ctx.adAccount.platformAdAccountId,
		{
			name: params.name,
			objective: params.objective,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			currency: params.currency,
			startDate: params.startDate,
			endDate: params.endDate,
			specialAdCategories: params.specialAdCategories,
		},
	);

	const [campaign] = await db
		.insert(adCampaigns)
		.values({
			organizationId: orgId,
			workspaceId: ctx.adAccount.workspaceId,
			adAccountId: params.adAccountId,
			platform: ctx.adPlatform,
			platformCampaignId: result.platformCampaignId,
			name: params.name,
			objective: params.objective as any,
			status: "active",
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			currency: params.currency ?? "USD",
			startDate: params.startDate ? new Date(params.startDate) : null,
			endDate: params.endDate ? new Date(params.endDate) : null,
			metadata: { platformAdSetId: result.platformAdSetId },
		})
		.returning();

	return campaign;
}

// ---------------------------------------------------------------------------
// Ad Operations
// ---------------------------------------------------------------------------

export async function createAd(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		campaignId?: string;
		name: string;
		objective?: string;
		headline?: string;
		body?: string;
		callToAction?: string;
		linkUrl?: string;
		imageUrl?: string;
		videoUrl?: string;
		targeting?: AdTargeting;
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		durationDays?: number;
		startDate?: string;
		endDate?: string;
	},
) {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const ctx = await getAccountWithToken(db, params.adAccountId, orgId, env);
	if (!ctx) throw new AdPlatformError("NOT_FOUND", "Ad account not found");

	const adapter = getAdPlatformAdapter(ctx.adPlatform);
	if (!adapter) throw new AdPlatformError("UNSUPPORTED_PLATFORM", "No adapter");

	// Auto-create campaign if needed
	let campaignId = params.campaignId;
	let platformCampaignId: string | undefined;
	let platformAdSetId: string | undefined;

	if (!campaignId) {
		if (!params.objective) {
			throw new AdPlatformError(
				"MISSING_OBJECTIVE",
				"objective is required when campaign_id is not provided",
			);
		}

		const campaignResult = await adapter.createCampaign(
			ctx.accessToken,
			ctx.adAccount.platformAdAccountId,
			{
				name: params.name,
				objective: params.objective,
				dailyBudgetCents: params.dailyBudgetCents,
				lifetimeBudgetCents: params.lifetimeBudgetCents,
				startDate: params.startDate,
				endDate: params.endDate,
			},
		);

		const [newCampaign] = await db
			.insert(adCampaigns)
			.values({
				organizationId: orgId,
				workspaceId: ctx.adAccount.workspaceId,
				adAccountId: params.adAccountId,
				platform: ctx.adPlatform,
				platformCampaignId: campaignResult.platformCampaignId,
				name: params.name,
				objective: (params.objective as any) ?? "engagement",
				status: "active",
				dailyBudgetCents: params.dailyBudgetCents,
				lifetimeBudgetCents: params.lifetimeBudgetCents,
				metadata: { platformAdSetId: campaignResult.platformAdSetId },
			})
			.returning();

		campaignId = newCampaign!.id;
		platformCampaignId = campaignResult.platformCampaignId;
		platformAdSetId = campaignResult.platformAdSetId;
	} else {
		// Fetch existing campaign
		const [existing] = await db
			.select()
			.from(adCampaigns)
			.where(
				and(
					eq(adCampaigns.id, campaignId),
					eq(adCampaigns.organizationId, orgId),
				),
			)
			.limit(1);

		if (!existing) throw new AdPlatformError("NOT_FOUND", "Campaign not found");

		platformCampaignId = existing.platformCampaignId ?? undefined;
		platformAdSetId = (existing.metadata as any)?.platformAdSetId;
	}

	// Create ad on platform
	const adResult = await adapter.createAd(
		ctx.accessToken,
		ctx.adAccount.platformAdAccountId,
		{
			campaignId: platformCampaignId!,
			adSetId: platformAdSetId,
			name: params.name,
			headline: params.headline,
			body: params.body,
			callToAction: params.callToAction,
			linkUrl: params.linkUrl,
			imageUrl: params.imageUrl,
			videoUrl: params.videoUrl,
			targeting: params.targeting,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			startDate: params.startDate,
			endDate: params.endDate,
			durationDays: params.durationDays,
		},
	);

	// Insert into DB
	const [ad] = await db
		.insert(ads)
		.values({
			organizationId: orgId,
			workspaceId: ctx.adAccount.workspaceId,
			campaignId: campaignId!,
			adAccountId: params.adAccountId,
			platform: ctx.adPlatform,
			platformAdId: adResult.platformAdId,
			name: params.name,
			status: adResult.status as any,
			headline: params.headline,
			body: params.body,
			callToAction: params.callToAction,
			linkUrl: params.linkUrl,
			imageUrl: params.imageUrl,
			videoUrl: params.videoUrl,
			targeting: params.targeting as any,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			startDate: params.startDate ? new Date(params.startDate) : null,
			endDate: params.endDate ? new Date(params.endDate) : null,
			durationDays: params.durationDays,
		})
		.returning();

	return ad;
}

export async function boostPost(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		postTargetId: string;
		name?: string;
		objective?: string;
		targeting?: AdTargeting;
		dailyBudgetCents: number;
		lifetimeBudgetCents?: number;
		currency?: string;
		durationDays: number;
		startDate?: string;
		endDate?: string;
		bidAmount?: number;
		tracking?: { pixelId?: string; urlTags?: string };
		specialAdCategories?: string[];
	},
) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	// Verify the post target exists, is published, and belongs to this org
	const [target] = await db
		.select()
		.from(postTargets)
		.innerJoin(posts, eq(postTargets.postId, posts.id))
		.where(and(eq(postTargets.id, params.postTargetId), eq(posts.organizationId, orgId)))
		.limit(1)
		.then((rows) => rows.map((r) => r.post_targets));

	if (!target) throw new AdPlatformError("NOT_FOUND", "Post target not found");
	if (target.status !== "published") {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Can only boost published posts",
		);
	}
	if (!target.platformPostId) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Post has no platform post ID",
		);
	}

	const ctx = await getAccountWithToken(db, params.adAccountId, orgId, env);
	if (!ctx) throw new AdPlatformError("NOT_FOUND", "Ad account not found");

	const adapter = getAdPlatformAdapter(ctx.adPlatform);
	if (!adapter) throw new AdPlatformError("UNSUPPORTED_PLATFORM", "No adapter");

	const adName = params.name ?? `Boost - ${target.platformPostId}`;

	const result = await adapter.boostPost(
		ctx.accessToken,
		ctx.adAccount.platformAdAccountId,
		{
			platformPostId: target.platformPostId,
			name: adName,
			objective: params.objective ?? "engagement",
			targeting: params.targeting,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			currency: params.currency,
			durationDays: params.durationDays,
			startDate: params.startDate,
			endDate: params.endDate,
			bidAmount: params.bidAmount,
			tracking: params.tracking
				? {
						pixelId: params.tracking.pixelId,
						urlTags: params.tracking.urlTags,
					}
				: undefined,
			specialAdCategories: params.specialAdCategories,
		},
	);

	// Create campaign + ad in DB
	const [campaign] = await db
		.insert(adCampaigns)
		.values({
			organizationId: orgId,
			workspaceId: ctx.adAccount.workspaceId,
			adAccountId: params.adAccountId,
			platform: ctx.adPlatform,
			platformCampaignId: result.platformCampaignId,
			name: adName,
			objective: (params.objective ?? "engagement") as any,
			status: "active",
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			metadata: { platformAdSetId: result.platformAdSetId },
		})
		.returning();

	const endDate = params.endDate
		? new Date(params.endDate)
		: new Date(Date.now() + params.durationDays * 86400000);

	const [ad] = await db
		.insert(ads)
		.values({
			organizationId: orgId,
			workspaceId: ctx.adAccount.workspaceId,
			campaignId: campaign!.id,
			adAccountId: params.adAccountId,
			platform: ctx.adPlatform,
			platformAdId: result.platformAdId,
			name: adName,
			status: "pending_review",
			boostPostTargetId: params.postTargetId,
			boostPlatformPostId: target.platformPostId,
			targeting: params.targeting as any,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			endDate,
			durationDays: params.durationDays,
		})
		.returning();

	return ad;
}

export async function updateAd(
	env: Env,
	orgId: string,
	adId: string,
	params: {
		name?: string;
		status?: "active" | "paused";
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		targeting?: AdTargeting;
	},
) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [ad] = await db
		.select()
		.from(ads)
		.where(and(eq(ads.id, adId), eq(ads.organizationId, orgId)))
		.limit(1);

	if (!ad) throw new AdPlatformError("NOT_FOUND", "Ad not found");

	if (["completed", "rejected", "cancelled"].includes(ad.status)) {
		throw new AdPlatformError(
			"INVALID_STATE",
			`Cannot update ad with status "${ad.status}"`,
		);
	}

	// Push changes to platform
	if (ad.platformAdId) {
		const ctx = await getAccountWithToken(db, ad.adAccountId, orgId, env);
		if (ctx) {
			const adapter = getAdPlatformAdapter(ctx.adPlatform);
			if (adapter) {
				await adapter.updateAd(ctx.accessToken, ad.platformAdId, {
					name: params.name,
					status: params.status,
					dailyBudgetCents: params.dailyBudgetCents,
					lifetimeBudgetCents: params.lifetimeBudgetCents,
					targeting: params.targeting,
				});
			}
		}
	}

	// Update DB
	const updateData: Record<string, unknown> = { updatedAt: new Date() };
	if (params.name) updateData.name = params.name;
	if (params.status) updateData.status = params.status;
	if (params.dailyBudgetCents) updateData.dailyBudgetCents = params.dailyBudgetCents;
	if (params.lifetimeBudgetCents) updateData.lifetimeBudgetCents = params.lifetimeBudgetCents;
	if (params.targeting) updateData.targeting = params.targeting;

	const [updated] = await db
		.update(ads)
		.set(updateData)
		.where(eq(ads.id, adId))
		.returning();

	return updated;
}

export async function cancelAd(env: Env, orgId: string, adId: string) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [ad] = await db
		.select()
		.from(ads)
		.where(and(eq(ads.id, adId), eq(ads.organizationId, orgId)))
		.limit(1);

	if (!ad) throw new AdPlatformError("NOT_FOUND", "Ad not found");

	// Cancel on platform
	if (ad.platformAdId) {
		const ctx = await getAccountWithToken(db, ad.adAccountId, orgId, env);
		if (ctx) {
			const adapter = getAdPlatformAdapter(ctx.adPlatform);
			if (adapter) {
				try {
					await adapter.cancelAd(ctx.accessToken, ad.platformAdId);
				} catch {
					// Best effort — platform might already be cancelled
				}
			}
		}
	}

	await db
		.update(ads)
		.set({ status: "cancelled", updatedAt: new Date() })
		.where(eq(ads.id, adId));
}

export async function updateCampaignStatus(
	env: Env,
	orgId: string,
	campaignId: string,
	status: "active" | "paused",
) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [campaign] = await db
		.select()
		.from(adCampaigns)
		.where(
			and(
				eq(adCampaigns.id, campaignId),
				eq(adCampaigns.organizationId, orgId),
			),
		)
		.limit(1);

	if (!campaign) throw new AdPlatformError("NOT_FOUND", "Campaign not found");

	if (campaign.platformCampaignId) {
		const ctx = await getAccountWithToken(db, campaign.adAccountId, orgId, env);
		if (ctx) {
			const adapter = getAdPlatformAdapter(ctx.adPlatform);
			if (adapter) {
				if (status === "paused") {
					await adapter.pauseCampaign(
						ctx.accessToken,
						campaign.platformCampaignId,
					);
				} else {
					await adapter.resumeCampaign(
						ctx.accessToken,
						campaign.platformCampaignId,
					);
				}
			}
		}
	}

	// Update campaign + child ads in DB
	await db
		.update(adCampaigns)
		.set({ status, updatedAt: new Date() })
		.where(eq(adCampaigns.id, campaignId));

	// Bulk update non-terminal ads in the campaign
	const result = await db
		.update(ads)
		.set({ status, updatedAt: new Date() })
		.where(
			and(
				eq(ads.campaignId, campaignId),
				sql`${ads.status} NOT IN ('completed', 'rejected', 'cancelled')`,
			),
		)
		.returning({ id: ads.id });

	// Count skipped (terminal) ads
	const [totalCount] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(ads)
		.where(eq(ads.campaignId, campaignId));

	const updated = result.length;
	const skipped = (totalCount?.count ?? 0) - updated;

	return { updated, skipped };
}
