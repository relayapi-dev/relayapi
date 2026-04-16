// ---------------------------------------------------------------------------
// Ads API Routes — /v1/ads/*
// ---------------------------------------------------------------------------

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	adAccounts,
	adAudiences,
	adCampaigns,
	ads,
	createDb,
	eq,
} from "@relayapi/db";
import { and, desc, inArray, sql } from "drizzle-orm";
import {
	AdAccountResponse,
	AdAnalyticsParams,
	AdAnalyticsResponse,
	AddAudienceUsersBody,
	AdListParams,
	AdListResponse,
	AdResponse,
	AudienceListParams,
	AudienceListResponse,
	AudienceResponse,
	BoostPostBody,
	CampaignListParams,
	CampaignListResponse,
	CampaignResponse,
	CreateAdBody,
	CreateAudienceBody,
	CreateCampaignBody,
	InterestResponse,
	ListAdAccountsParams,
	SearchInterestsParams,
	SyncResponse,
	UpdateAdBody,
	UpdateCampaignBody,
} from "../schemas/ads";
import { ErrorResponse, IdParam } from "../schemas/common";
import * as adAnalytics from "../services/ad-analytics";
import * as adAudienceService from "../services/ad-audience";
import {
	getAdPlatformAdapter,
	socialPlatformToAdPlatform,
} from "../services/ad-platforms";
import { AdPlatformError } from "../services/ad-platforms/types";
import * as adService from "../services/ad-service";
import * as adSync from "../services/ad-sync";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Error handler helper
// ---------------------------------------------------------------------------

function handleAdError(c: any, err: unknown) {
	if (err instanceof AdPlatformError) {
		const status =
			err.code === "NOT_FOUND"
				? 404
				: err.code === "INVALID_STATE"
					? 400
					: err.code === "UNSUPPORTED_PLATFORM" ||
							err.code === "UNSUPPORTED_FEATURE"
						? 422
						: 500;
		return c.json(
			{ error: { code: err.code, message: err.message } },
			status as any,
		);
	}
	console.error("[Ads]", err);
	return c.json(
		{
			error: {
				code: "INTERNAL_ERROR",
				message: "An unexpected error occurred",
			},
		},
		500,
	);
}

// =========================================================================
// AD ACCOUNTS
// =========================================================================

const listAdAccounts = createRoute({
	operationId: "listAdAccounts",
	method: "get",
	path: "/accounts",
	tags: ["Ads"],
	summary: "List ad accounts for a social account",
	security: [{ Bearer: [] }],
	request: { query: ListAdAccountsParams },
	responses: {
		200: {
			description: "Ad accounts",
			content: {
				"application/json": {
					schema: z.object({
							data: z.array(AdAccountResponse),
							next_cursor: z.string().nullable(),
							has_more: z.boolean(),
						}),
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Platform not supported",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listAdAccounts, async (c) => {
	const orgId = c.get("orgId");
	const { social_account_id, workspace_id, q, cursor, limit } = c.req.valid("query");

	try {
		if (social_account_id) {
			await adService.discoverAdAccounts(c.env, orgId, social_account_id);
		}

		const db = c.get("db");
		const conditions = [eq(adAccounts.organizationId, orgId)];
		applyWorkspaceScope(c, conditions, adAccounts.workspaceId);
		if (social_account_id) {
			conditions.push(eq(adAccounts.socialAccountId, social_account_id));
		}
		if (workspace_id) {
			conditions.push(eq(adAccounts.workspaceId, workspace_id));
		}
		if (q) {
			conditions.push(
				sql`(${adAccounts.name} ILIKE ${"%" + q + "%"} OR ${adAccounts.platformAdAccountId} ILIKE ${"%" + q + "%"})`,
			);
		}
		if (cursor) {
			conditions.push(sql`${adAccounts.id} > ${cursor}`);
		}

		const accounts = await db
			.select()
			.from(adAccounts)
			.where(and(...conditions))
			.orderBy(adAccounts.id)
			.limit(limit + 1);

		const hasMore = accounts.length > limit;
		const items = accounts.slice(0, limit);

		return c.json({
			data: items.map((a) => ({
				id: a.id,
				social_account_id: a.socialAccountId,
				platform: a.platform,
				platform_ad_account_id: a.platformAdAccountId,
				name: a.name,
				currency: a.currency,
				timezone: a.timezone,
				status: a.status,
			})),
			next_cursor: hasMore ? items[items.length - 1]!.id : null,
			has_more: hasMore,
		});
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// CAMPAIGNS
// =========================================================================

const createCampaignRoute = createRoute({
	operationId: "createAdCampaign",
	method: "post",
	path: "/campaigns",
	tags: ["Ads"],
	summary: "Create a campaign",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateCampaignBody } } },
	},
	responses: {
		201: {
			description: "Campaign created",
			content: {
				"application/json": { schema: z.object({ data: CampaignResponse }) },
			},
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createCampaignRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");

	try {
		const campaign = await adService.createCampaign(c.env, orgId, {
			adAccountId: body.ad_account_id,
			name: body.name,
			objective: body.objective,
			dailyBudgetCents: body.daily_budget_cents,
			lifetimeBudgetCents: body.lifetime_budget_cents,
			currency: body.currency,
			startDate: body.start_date,
			endDate: body.end_date,
			specialAdCategories: body.special_ad_categories,
		});

		if (!campaign) {
			return c.json(
				{
					error: {
						code: "CREATE_FAILED",
						message: "Failed to create campaign",
					},
				},
				400 as any,
			);
		}

		return c.json(
			{
				data: {
					id: campaign.id,
					ad_account_id: campaign.adAccountId,
					platform: campaign.platform,
					platform_campaign_id: campaign.platformCampaignId,
					name: campaign.name,
					objective: campaign.objective,
					status: campaign.status,
					daily_budget_cents: campaign.dailyBudgetCents,
					lifetime_budget_cents: campaign.lifetimeBudgetCents,
					currency: campaign.currency,
					start_date: campaign.startDate?.toISOString() ?? null,
					end_date: campaign.endDate?.toISOString() ?? null,
					is_external: campaign.isExternal,
					metrics: null,
					created_at: campaign.createdAt.toISOString(),
					updated_at: campaign.updatedAt.toISOString(),
				},
			},
			201,
		);
	} catch (err) {
		return handleAdError(c, err);
	}
});

const listCampaigns = createRoute({
	operationId: "listAdCampaigns",
	method: "get",
	path: "/campaigns",
	tags: ["Ads"],
	summary: "List campaigns with aggregate metrics",
	security: [{ Bearer: [] }],
	request: { query: CampaignListParams },
	responses: {
		200: {
			description: "Campaigns",
			content: { "application/json": { schema: CampaignListResponse } },
		},
	},
});

app.openapi(listCampaigns, async (c) => {
	const orgId = c.get("orgId");
	const { platform, status, ad_account_id, workspace_id, cursor, limit } =
		c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(adCampaigns.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, adCampaigns.workspaceId);
	if (platform) conditions.push(eq(adCampaigns.platform, platform));
	if (status) conditions.push(eq(adCampaigns.status, status));
	if (ad_account_id)
		conditions.push(eq(adCampaigns.adAccountId, ad_account_id));
	if (workspace_id) conditions.push(eq(adCampaigns.workspaceId, workspace_id));
	if (cursor) conditions.push(sql`${adCampaigns.id} < ${cursor}`);

	const campaigns = await db
		.select()
		.from(adCampaigns)
		.where(and(...conditions))
		.orderBy(desc(adCampaigns.createdAt))
		.limit(limit + 1);

	const hasMore = campaigns.length > limit;
	const items = campaigns.slice(0, limit);

	// Count ads per campaign
	const campaignIds = items.map((c) => c.id);
	let adCounts: Record<string, number> = {};
	if (campaignIds.length > 0) {
		const counts = await db
			.select({
				campaignId: ads.campaignId,
				count: sql<number>`count(*)::int`,
			})
			.from(ads)
			.where(inArray(ads.campaignId, campaignIds))
			.groupBy(ads.campaignId);
		adCounts = Object.fromEntries(counts.map((c) => [c.campaignId, c.count]));
	}

	return c.json({
		data: items.map((camp) => ({
			id: camp.id,
			ad_account_id: camp.adAccountId,
			platform: camp.platform,
			platform_campaign_id: camp.platformCampaignId,
			name: camp.name,
			objective: camp.objective,
			status: camp.status,
			daily_budget_cents: camp.dailyBudgetCents,
			lifetime_budget_cents: camp.lifetimeBudgetCents,
			currency: camp.currency,
			start_date: camp.startDate?.toISOString() ?? null,
			end_date: camp.endDate?.toISOString() ?? null,
			is_external: camp.isExternal,
			ad_count: adCounts[camp.id] ?? 0,
			metrics: null,
			created_at: camp.createdAt.toISOString(),
			updated_at: camp.updatedAt.toISOString(),
		})),
		next_cursor: hasMore ? items[items.length - 1]!.id : null,
		has_more: hasMore,
	} as any);
});

const getCampaign = createRoute({
	operationId: "getAdCampaign",
	method: "get",
	path: "/campaigns/{id}",
	tags: ["Ads"],
	summary: "Get campaign details",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Campaign",
			content: { "application/json": { schema: z.object({ data: CampaignResponse }) } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getCampaign, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const conditions = [
		eq(adCampaigns.id, id),
		eq(adCampaigns.organizationId, orgId),
	];
	applyWorkspaceScope(c, conditions, adCampaigns.workspaceId);

	const [campaign] = await db
		.select()
		.from(adCampaigns)
		.where(and(...conditions))
		.limit(1);

	if (!campaign) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Campaign not found" } },
			404,
		);
	}

	// Count ads in this campaign
	const [adCount] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(ads)
		.where(eq(ads.campaignId, campaign.id));

	return c.json({
		data: {
			id: campaign.id,
			ad_account_id: campaign.adAccountId,
			platform: campaign.platform,
			platform_campaign_id: campaign.platformCampaignId,
			name: campaign.name,
			objective: campaign.objective,
			status: campaign.status,
			daily_budget_cents: campaign.dailyBudgetCents,
			lifetime_budget_cents: campaign.lifetimeBudgetCents,
			currency: campaign.currency,
			start_date: campaign.startDate?.toISOString() ?? null,
			end_date: campaign.endDate?.toISOString() ?? null,
			is_external: campaign.isExternal,
			ad_count: adCount?.count ?? 0,
			metrics: null,
			created_at: campaign.createdAt.toISOString(),
			updated_at: campaign.updatedAt.toISOString(),
		},
	} as any);
});

const updateCampaignStatus = createRoute({
	operationId: "updateAdCampaignStatus",
	method: "patch",
	path: "/campaigns/{id}",
	tags: ["Ads"],
	summary: "Update campaign (pause/resume)",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: UpdateCampaignBody } } },
	},
	responses: {
		200: {
			description: "Campaign updated",
			content: {
				"application/json": {
					schema: z.object({ updated: z.number(), skipped: z.number() }),
				},
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateCampaignStatus, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");

	try {
		if (body.status) {
			const result = await adService.updateCampaignStatus(
				c.env,
				orgId,
				id,
				body.status,
			);
			return c.json(result);
		}

		// Name/budget updates
		const db = c.get("db");
		const updateData: Record<string, unknown> = { updatedAt: new Date() };
		if (body.name) updateData.name = body.name;
		if (body.daily_budget_cents)
			updateData.dailyBudgetCents = body.daily_budget_cents;
		if (body.lifetime_budget_cents)
			updateData.lifetimeBudgetCents = body.lifetime_budget_cents;

		await db
			.update(adCampaigns)
			.set(updateData)
			.where(
				and(eq(adCampaigns.id, id), eq(adCampaigns.organizationId, orgId)),
			);

		return c.json({ updated: 1, skipped: 0 });
	} catch (err) {
		return handleAdError(c, err);
	}
});

const deleteCampaign = createRoute({
	operationId: "deleteAdCampaign",
	method: "delete",
	path: "/campaigns/{id}",
	tags: ["Ads"],
	summary: "Cancel/archive campaign",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Cancelled",
			content: {
				"application/json": { schema: z.object({ message: z.string() }) },
			},
		},
	},
});

app.openapi(deleteCampaign, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");

	try {
		await adService.updateCampaignStatus(c.env, orgId, id, "paused");
		const db = c.get("db");
		await db
			.update(adCampaigns)
			.set({ status: "cancelled", updatedAt: new Date() })
			.where(
				and(eq(adCampaigns.id, id), eq(adCampaigns.organizationId, orgId)),
			);
		return c.json({ message: "Campaign cancelled" });
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// ADS
// =========================================================================

const createAdRoute = createRoute({
	operationId: "createAd",
	method: "post",
	path: "/",
	tags: ["Ads"],
	summary: "Create standalone ad with custom creative",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateAdBody } } },
	},
	responses: {
		201: {
			description: "Ad created",
			content: {
				"application/json": { schema: z.object({ data: AdResponse }) },
			},
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createAdRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");

	try {
		const ad = await adService.createAd(c.env, orgId, {
			adAccountId: body.ad_account_id,
			campaignId: body.campaign_id,
			name: body.name,
			objective: body.objective,
			headline: body.headline,
			body: body.body,
			callToAction: body.call_to_action,
			linkUrl: body.link_url,
			imageUrl: body.image_url,
			videoUrl: body.video_url,
			targeting: body.targeting as any,
			dailyBudgetCents: body.daily_budget_cents,
			lifetimeBudgetCents: body.lifetime_budget_cents,
			durationDays: body.duration_days,
			startDate: body.start_date,
			endDate: body.end_date,
		});

		return c.json({ data: formatAdResponse(ad!) } as any, 201);
	} catch (err) {
		return handleAdError(c, err);
	}
});

const boostPostRoute = createRoute({
	operationId: "boostPost",
	method: "post",
	path: "/boost",
	tags: ["Ads"],
	summary: "Boost an existing published post",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BoostPostBody } } },
	},
	responses: {
		201: {
			description: "Ad created",
			content: {
				"application/json": { schema: z.object({ data: AdResponse }) },
			},
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(boostPostRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");

	try {
		const ad = await adService.boostPost(c.env, orgId, {
			adAccountId: body.ad_account_id,
			postTargetId: body.post_target_id,
			name: body.name,
			objective: body.objective,
			targeting: body.targeting as any,
			dailyBudgetCents: body.daily_budget_cents,
			lifetimeBudgetCents: body.lifetime_budget_cents,
			currency: body.currency,
			durationDays: body.duration_days,
			startDate: body.start_date,
			endDate: body.end_date,
			bidAmount: body.bid_amount,
			tracking: body.tracking
				? {
						pixelId: body.tracking.pixel_id,
						urlTags: body.tracking.url_tags,
					}
				: undefined,
			specialAdCategories: body.special_ad_categories,
		});

		return c.json({ data: formatAdResponse(ad!) } as any, 201);
	} catch (err) {
		return handleAdError(c, err);
	}
});

const listAds = createRoute({
	operationId: "listAds",
	method: "get",
	path: "/",
	tags: ["Ads"],
	summary: "List ads",
	security: [{ Bearer: [] }],
	request: { query: AdListParams },
	responses: {
		200: {
			description: "Ads",
			content: { "application/json": { schema: AdListResponse } },
		},
	},
});

app.openapi(listAds, async (c) => {
	const orgId = c.get("orgId");
	const { campaign_id, platform, status, workspace_id, source, cursor, limit } =
		c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(ads.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, ads.workspaceId);
	if (campaign_id) conditions.push(eq(ads.campaignId, campaign_id));
	if (platform) conditions.push(eq(ads.platform, platform));
	if (status) conditions.push(eq(ads.status, status));
	if (workspace_id) conditions.push(eq(ads.workspaceId, workspace_id));
	if (source === "internal") conditions.push(eq(ads.isExternal, false));
	if (source === "external") conditions.push(eq(ads.isExternal, true));
	if (cursor) conditions.push(sql`${ads.id} < ${cursor}`);

	const results = await db
		.select()
		.from(ads)
		.where(and(...conditions))
		.orderBy(desc(ads.createdAt))
		.limit(limit + 1);

	const hasMore = results.length > limit;
	const items = results.slice(0, limit);

	return c.json({
		data: items.map(formatAdResponse),
		next_cursor: hasMore ? items[items.length - 1]!.id : null,
		has_more: hasMore,
	} as any);
});

const getAd = createRoute({
	operationId: "getAd",
	method: "get",
	path: "/{id}",
	tags: ["Ads"],
	summary: "Get ad details",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Ad",
			content: {
				"application/json": { schema: z.object({ data: AdResponse }) },
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getAd, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [ad] = await db
		.select()
		.from(ads)
		.where(and(eq(ads.id, id), eq(ads.organizationId, orgId)))
		.limit(1);

	if (!ad) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Ad not found" } },
			404,
		);
	}

	return c.json({ data: formatAdResponse(ad) } as any);
});

const updateAdRoute = createRoute({
	operationId: "updateAd",
	method: "patch",
	path: "/{id}",
	tags: ["Ads"],
	summary: "Update ad (name, budget, targeting, pause/resume)",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: UpdateAdBody } } },
	},
	responses: {
		200: {
			description: "Ad updated",
			content: {
				"application/json": { schema: z.object({ data: AdResponse }) },
			},
		},
		400: {
			description: "Invalid state",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateAdRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");

	try {
		const updated = await adService.updateAd(c.env, orgId, id, {
			name: body.name,
			status: body.status,
			dailyBudgetCents: body.daily_budget_cents,
			lifetimeBudgetCents: body.lifetime_budget_cents,
			targeting: body.targeting as any,
		});

		return c.json({ data: formatAdResponse(updated!) } as any);
	} catch (err) {
		return handleAdError(c, err);
	}
});

const deleteAdRoute = createRoute({
	operationId: "cancelAd",
	method: "delete",
	path: "/{id}",
	tags: ["Ads"],
	summary: "Cancel an ad",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Cancelled",
			content: {
				"application/json": { schema: z.object({ message: z.string() }) },
			},
		},
	},
});

app.openapi(deleteAdRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");

	try {
		await adService.cancelAd(c.env, orgId, id);
		return c.json({ message: "Ad cancelled" });
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// ANALYTICS
// =========================================================================

const getAdAnalytics = createRoute({
	operationId: "getAdAnalytics",
	method: "get",
	path: "/{id}/analytics",
	tags: ["Ads"],
	summary: "Get ad analytics with daily breakdown",
	security: [{ Bearer: [] }],
	request: { params: IdParam, query: AdAnalyticsParams },
	responses: {
		200: {
			description: "Analytics",
			content: {
				"application/json": { schema: z.object({ data: AdAnalyticsResponse }) },
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getAdAnalytics, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { from, to, breakdowns } = c.req.valid("query");

	const startDate =
		from ?? new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0]!;
	const endDate = to ?? new Date().toISOString().split("T")[0]!;

	try {
		// Use stored metrics first; fall back to live if breakdowns requested or stored is empty
		if (!breakdowns) {
			const db = c.get("db");
			const stored = await adAnalytics.getAdAnalytics(db, id, startDate, endDate);
			if (stored.daily.length > 0) {
				return c.json({ data: stored });
			}
		}

		// Live path: fetches from platform API (supports breakdowns/demographics)
		const result = await adAnalytics.getAdAnalyticsLive(
			c.env,
			id,
			startDate,
			endDate,
			breakdowns?.split(","),
		);

		return c.json({ data: result });
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// INTERESTS
// =========================================================================

const searchInterests = createRoute({
	operationId: "searchAdInterests",
	method: "get",
	path: "/interests",
	tags: ["Ads"],
	summary: "Search targeting interests",
	security: [{ Bearer: [] }],
	request: { query: SearchInterestsParams },
	responses: {
		200: {
			description: "Interests",
			content: {
				"application/json": {
					schema: z.object({
						data: z.array(InterestResponse),
					}),
				},
			},
		},
	},
});

app.openapi(searchInterests, async (c) => {
	const orgId = c.get("orgId");
	const { q, social_account_id } = c.req.valid("query");
	const db = c.get("db");

	// Find the right adapter from any ad account linked to this social account
	const adAccountRows = await db
		.select()
		.from(adAccounts)
		.where(
			and(
				eq(adAccounts.socialAccountId, social_account_id),
				eq(adAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (adAccountRows.length === 0) {
		return c.json({ data: [] } as any);
	}

	const adapter = getAdPlatformAdapter(adAccountRows[0]!.platform);
	if (!adapter) return c.json({ data: [] } as any);

	// Get access token from the linked social account
	const { socialAccounts: saTable } = await import("@relayapi/db");
	const [sa] = await db
		.select({
			accessToken: saTable.accessToken,
			workspaceId: saTable.workspaceId,
		})
		.from(saTable)
		.where(
			and(eq(saTable.id, social_account_id), eq(saTable.organizationId, orgId)),
		)
		.limit(1);

	if (!sa) return c.json({ data: [] } as any);

	const denied = assertWorkspaceScope(c, sa.workspaceId);
	if (denied) return denied;

	let accessToken = sa.accessToken;
	if (accessToken && c.env.ENCRYPTION_KEY) {
		const { maybeDecrypt } = await import("../lib/crypto");
		accessToken = await maybeDecrypt(accessToken, c.env.ENCRYPTION_KEY);
	}

	try {
		const interests = await adapter.searchInterests(accessToken ?? "", q);
		return c.json({
			data: interests.map((i) => ({
				id: i.id,
				name: i.name,
				category: i.category,
				audience_size: i.audienceSize,
			})),
		} as any);
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// AUDIENCES
// =========================================================================

const createAudience = createRoute({
	operationId: "createAdAudience",
	method: "post",
	path: "/audiences",
	tags: ["Ads"],
	summary: "Create custom audience",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateAudienceBody } } },
	},
	responses: {
		201: {
			description: "Audience created",
			content: {
				"application/json": { schema: z.object({ data: AudienceResponse }) },
			},
		},
	},
});

app.openapi(createAudience, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");

	try {
		const audience = await adAudienceService.createAudience(c.env, orgId, {
			adAccountId: body.ad_account_id,
			name: body.name,
			type: body.type,
			description: body.description,
			pixelId: body.pixel_id,
			retentionDays: body.retention_days,
			rule: body.rule,
			sourceAudienceId: body.source_audience_id,
			country: body.country,
			ratio: body.ratio,
			customerFileSource: body.customer_file_source,
		});

		if (!audience) {
			return c.json(
				{
					error: {
						code: "CREATE_FAILED",
						message: "Failed to create audience",
					},
				},
				400 as any,
			);
		}

		return c.json(
			{
				data: {
					id: audience.id,
					ad_account_id: audience.adAccountId,
					platform: audience.platform,
					platform_audience_id: audience.platformAudienceId,
					name: audience.name,
					type: audience.type,
					description: audience.description,
					size: audience.size,
					status: audience.status,
					created_at: audience.createdAt.toISOString(),
					updated_at: audience.updatedAt.toISOString(),
				},
			} as any,
			201,
		);
	} catch (err) {
		return handleAdError(c, err);
	}
});

const listAudiences = createRoute({
	operationId: "listAdAudiences",
	method: "get",
	path: "/audiences",
	tags: ["Ads"],
	summary: "List custom audiences",
	security: [{ Bearer: [] }],
	request: { query: AudienceListParams },
	responses: {
		200: {
			description: "Audiences",
			content: { "application/json": { schema: AudienceListResponse } },
		},
	},
});

app.openapi(listAudiences, async (c) => {
	const orgId = c.get("orgId");
	const { ad_account_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [
		eq(adAudiences.organizationId, orgId),
		eq(adAudiences.adAccountId, ad_account_id),
	];
	if (cursor) conditions.push(sql`${adAudiences.id} < ${cursor}`);

	const audiences = await db
		.select()
		.from(adAudiences)
		.where(and(...conditions))
		.orderBy(desc(adAudiences.createdAt))
		.limit(limit + 1);

	const hasMore = audiences.length > limit;
	const items = audiences.slice(0, limit);

	return c.json({
		data: items.map((a) => ({
			id: a.id,
			ad_account_id: a.adAccountId,
			platform: a.platform,
			platform_audience_id: a.platformAudienceId,
			name: a.name,
			type: a.type,
			description: a.description,
			size: a.size,
			status: a.status,
			created_at: a.createdAt.toISOString(),
			updated_at: a.updatedAt.toISOString(),
		})),
		next_cursor: hasMore ? items[items.length - 1]!.id : null,
		has_more: hasMore,
	} as any);
});

const getAudience = createRoute({
	operationId: "getAdAudience",
	method: "get",
	path: "/audiences/{id}",
	tags: ["Ads"],
	summary: "Get audience details",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Audience",
			content: {
				"application/json": { schema: z.object({ data: AudienceResponse }) },
			},
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getAudience, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [audience] = await db
		.select()
		.from(adAudiences)
		.where(and(eq(adAudiences.id, id), eq(adAudiences.organizationId, orgId)))
		.limit(1);

	if (!audience) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Audience not found" } },
			404,
		);
	}

	return c.json({
		data: {
			id: audience.id,
			ad_account_id: audience.adAccountId,
			platform: audience.platform,
			platform_audience_id: audience.platformAudienceId,
			name: audience.name,
			type: audience.type,
			description: audience.description,
			size: audience.size,
			status: audience.status,
			created_at: audience.createdAt.toISOString(),
			updated_at: audience.updatedAt.toISOString(),
		},
	} as any);
});

const addAudienceUsers = createRoute({
	operationId: "addUsersToAdAudience",
	method: "post",
	path: "/audiences/{id}/users",
	tags: ["Ads"],
	summary: "Upload hashed users to audience",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: { content: { "application/json": { schema: AddAudienceUsersBody } } },
	},
	responses: {
		200: {
			description: "Users added",
			content: {
				"application/json": {
					schema: z.object({
						added: z.number(),
						invalid: z.number(),
						stored: z.number(),
					}),
				},
			},
		},
	},
});

app.openapi(addAudienceUsers, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { users } = c.req.valid("json");

	try {
		const result = await adAudienceService.addUsersToAudience(
			c.env,
			orgId,
			id,
			users,
		);
		return c.json({ added: result.added, invalid: result.invalid, stored: result.stored });
	} catch (err) {
		return handleAdError(c, err);
	}
});

const deleteAudienceRoute = createRoute({
	operationId: "deleteAdAudience",
	method: "delete",
	path: "/audiences/{id}",
	tags: ["Ads"],
	summary: "Delete audience",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Deleted",
			content: {
				"application/json": { schema: z.object({ message: z.string() }) },
			},
		},
	},
});

app.openapi(deleteAudienceRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");

	try {
		await adAudienceService.deleteAudience(c.env, orgId, id);
		return c.json({ message: "Audience deleted" });
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// SYNC
// =========================================================================

const triggerSync = createRoute({
	operationId: "syncExternalAds",
	method: "post",
	path: "/accounts/{id}/sync",
	tags: ["Ads"],
	summary: "Trigger manual sync for an ad account",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Sync result",
			content: { "application/json": { schema: SyncResponse } },
		},
	},
});

app.openapi(triggerSync, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");

	try {
		const result = await adSync.syncExternalAds(c.env, id, orgId);
		return c.json({
			ads_created: result.adsCreated,
			ads_updated: result.adsUpdated,
			metrics_updated: result.metricsUpdated,
		});
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// Helpers
// =========================================================================

function formatAdResponse(
	ad: typeof ads.$inferSelect,
): Record<string, unknown> {
	return {
		id: ad.id,
		campaign_id: ad.campaignId,
		ad_account_id: ad.adAccountId,
		platform: ad.platform,
		platform_ad_id: ad.platformAdId,
		name: ad.name,
		status: ad.status,
		headline: ad.headline,
		body: ad.body,
		call_to_action: ad.callToAction,
		link_url: ad.linkUrl,
		image_url: ad.imageUrl,
		video_url: ad.videoUrl,
		boost_post_target_id: ad.boostPostTargetId,
		targeting: ad.targeting ?? null,
		daily_budget_cents: ad.dailyBudgetCents,
		lifetime_budget_cents: ad.lifetimeBudgetCents,
		start_date: ad.startDate?.toISOString() ?? null,
		end_date: ad.endDate?.toISOString() ?? null,
		duration_days: ad.durationDays,
		is_external: ad.isExternal,
		created_at: ad.createdAt.toISOString(),
		updated_at: ad.updatedAt.toISOString(),
	};
}

export default app;
