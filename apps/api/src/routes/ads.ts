// ---------------------------------------------------------------------------
// Ads API Routes — /v1/ads/*
// ---------------------------------------------------------------------------

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { adAccounts, adAudiences, adCampaigns, ads, eq } from "@relayapi/db";
import { and, desc, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { durableCredentialAuthorityAdmission } from "../lib/durable-credential-authority";
import { trackAuthoritativeAmbiguousMutation } from "../lib/mutation-effect";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { refreshFeatureEntitlements } from "../middleware/feature-gate";
import { requireManageSpendMiddleware } from "../middleware/permissions";
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
	SyncQueuedResponse,
	UpdateAdBody,
	UpdateCampaignBody,
} from "../schemas/ads";
import { ErrorResponse, IdParam } from "../schemas/common";
import * as adAnalytics from "../services/ad-analytics";
import * as adAudienceService from "../services/ad-audience";
import { getAdPlatformAdapter } from "../services/ad-platforms";
import type { AdTargeting } from "../services/ad-platforms/types";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "../services/ad-platforms/types";
import * as adService from "../services/ad-service";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const requireManageSpendForMutations = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
		const response = await requireManageSpendMiddleware(c, next);
		if (response instanceof Response && response.status === 403) {
			markAdMutationNotApplied(c);
		}
		return response;
	}
	return next();
});
app.use("*", requireManageSpendForMutations);
const RequiredIdempotencyKeyHeaders = z.object({
	"idempotency-key": z.string().min(1).openapi({
		description:
			"Caller-generated key that identifies one logical paid-object creation",
		example: "paid-operation-018f1f6e",
	}),
});

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

function markAdMutationNotApplied(c: AppContext): void {
	if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
		c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
			kind: "not_applied",
		});
	}
}

function markDeniedAdMutation(
	c: AppContext,
	response: Response | undefined,
): Response | undefined {
	if (response) markAdMutationNotApplied(c);
	return response;
}

async function authorizeAdAccount(
	c: AppContext,
	id: string,
): Promise<Response | undefined> {
	const [row] = await c
		.get("db")
		.select({ workspaceId: adAccounts.workspaceId })
		.from(adAccounts)
		.where(
			and(eq(adAccounts.id, id), eq(adAccounts.organizationId, c.get("orgId"))),
		)
		.limit(1);
	if (!row) {
		markAdMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Ad account not found" } },
			404,
		);
	}
	return markDeniedAdMutation(c, assertWorkspaceScope(c, row.workspaceId));
}

async function authorizeCampaign(
	c: AppContext,
	id: string,
): Promise<Response | undefined> {
	const [row] = await c
		.get("db")
		.select({ workspaceId: adCampaigns.workspaceId })
		.from(adCampaigns)
		.where(
			and(
				eq(adCampaigns.id, id),
				eq(adCampaigns.organizationId, c.get("orgId")),
			),
		)
		.limit(1);
	if (!row) {
		markAdMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Campaign not found" } },
			404,
		);
	}
	return markDeniedAdMutation(c, assertWorkspaceScope(c, row.workspaceId));
}

async function authorizeAd(
	c: AppContext,
	id: string,
): Promise<Response | undefined> {
	const [row] = await c
		.get("db")
		.select({ workspaceId: ads.workspaceId })
		.from(ads)
		.where(and(eq(ads.id, id), eq(ads.organizationId, c.get("orgId"))))
		.limit(1);
	if (!row) {
		markAdMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Ad not found" } },
			404,
		);
	}
	return markDeniedAdMutation(c, assertWorkspaceScope(c, row.workspaceId));
}

async function authorizeAudience(
	c: AppContext,
	id: string,
): Promise<Response | undefined> {
	const [row] = await c
		.get("db")
		.select({ workspaceId: adAudiences.workspaceId })
		.from(adAudiences)
		.where(
			and(
				eq(adAudiences.id, id),
				eq(adAudiences.organizationId, c.get("orgId")),
			),
		)
		.limit(1);
	if (!row) {
		markAdMutationNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Audience not found" } },
			404,
		);
	}
	return markDeniedAdMutation(c, assertWorkspaceScope(c, row.workspaceId));
}

async function requireSpendEligiblePlan(
	c: AppContext,
): Promise<Response | undefined> {
	await refreshFeatureEntitlements(c);
	if (
		c.get("plan") === "pro" &&
		!(c.get("billingSource") === "stripe" && !c.get("billable"))
	) {
		return undefined;
	}
	markAdMutationNotApplied(c);
	return c.json(
		{
			error: {
				code: "PLAN_UPGRADE_REQUIRED",
				message:
					"Creating or increasing ad spend requires an eligible Pro plan",
			},
		},
		403,
	);
}

async function mayIncreaseSpend(c: AppContext): Promise<boolean> {
	await refreshFeatureEntitlements(c);
	return (
		c.get("plan") === "pro" &&
		!(c.get("billingSource") === "stripe" && !c.get("billable"))
	);
}

// ---------------------------------------------------------------------------
// Error handler helper
// ---------------------------------------------------------------------------

function handleAdError(c: AppContext, err: unknown) {
	if (err instanceof AdPlatformError) {
		if (
			err instanceof AdAuthoritativeNotAppliedError ||
			err.code === "PLAN_UPGRADE_REQUIRED" ||
			err.code === "UNSUPPORTED_TARGETING"
		) {
			// The marker is explicit proof about this attempt, independent of its
			// public error code. The two policy codes are also emitted only by
			// route/service preflights today.
			c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
				kind: "not_applied",
			});
		}
		if (
			err.code === "AD_MUTATION_IN_PROGRESS" ||
			err.code === "AD_MUTATION_UNKNOWN" ||
			err.code === "AD_MUTATION_MANUAL_REVIEW" ||
			err.code === "AUTHORITY_REVOKED_PENDING"
		) {
			c.header("Idempotency-Retryable", "true");
			c.header("Retry-After", "60");
		}
		const status =
			err.code === "NOT_FOUND"
				? 404
				: err.code === "PLAN_UPGRADE_REQUIRED" ||
						err.code === "CREDENTIAL_NO_LONGER_AUTHORIZED"
					? 403
					: err.code === "IDEMPOTENCY_KEY_REQUIRED" ||
							err.code === "IDEMPOTENCY_KEY_REUSED"
						? 400
						: err.code === "OPERATION_IN_PROGRESS" ||
								err.code === "UNKNOWN_EXTERNAL_OUTCOME" ||
								err.code === "MANUAL_REVIEW_REQUIRED" ||
								err.code === "AD_MUTATION_IN_PROGRESS" ||
								err.code === "AD_MUTATION_UNKNOWN" ||
								err.code === "AD_MUTATION_MANUAL_REVIEW" ||
								err.code === "AUTHORITY_REVOKED_PENDING"
							? 409
							: err.code === "INVALID_STATE" ||
									err.code === "INVALID_BUDGET" ||
									err.code === "CURRENCY_MISMATCH"
								? 400
								: err.code === "UNSUPPORTED_PLATFORM" ||
										err.code === "UNSUPPORTED_FEATURE" ||
										err.code === "UNSUPPORTED_TARGETING" ||
										err.code === "UNSUPPORTED_CURRENCY"
									? 422
									: 500;
		return c.json(
			{ error: { code: err.code, message: err.message } },
			status as ContentfulStatusCode,
		) as never;
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
	) as never;
}

/** Audience service codes emitted only before its first provider mutation. */
function markAudiencePreboundaryError(c: AppContext, err: unknown): void {
	if (
		err instanceof AdPlatformError &&
		[
			"NOT_FOUND",
			"UNSUPPORTED_PLATFORM",
			"INVALID_SOURCE",
			"INVALID_TYPE",
			"INVALID_STATE",
			"INVALID_AUDIENCE_TYPE",
		].includes(err.code)
	) {
		markAdMutationNotApplied(c);
	}
}

// ---------------------------------------------------------------------------
// Cursor helpers — composite keyset pagination on (created_at, id)
//
// List endpoints sort by `desc(createdAt)` but resource ids are random (not
// monotonic), so a plain `id < cursor` filter slices the keyspace in an order
// unrelated to the sort, duplicating and silently dropping rows across pages.
// We encode an opaque `<createdAt ISO>|<id>` cursor and compare the (createdAt,
// id) tuple as a total order that matches the ORDER BY, guaranteeing stable
// keyset pagination.
// ---------------------------------------------------------------------------

function encodeCursor(createdAt: Date, id: string): string {
	// base64url(<createdAt ISO>|<id>) — matches the inbox cursor idiom (btoa +
	// url-safe substitution) so we don't depend on Node's Buffer global.
	return btoa(`${createdAt.toISOString()}|${id}`)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function decodeCursor(
	cursor: string | undefined,
): { createdAt: Date; id: string } | null {
	if (!cursor) return null;
	try {
		const decoded = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
		const sep = decoded.lastIndexOf("|");
		if (sep === -1) return null;
		const createdAt = new Date(decoded.slice(0, sep));
		const id = decoded.slice(sep + 1);
		if (Number.isNaN(createdAt.getTime()) || !id) return null;
		return { createdAt, id };
	} catch {
		return null;
	}
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
	const { social_account_id, workspace_id, q, cursor, limit } =
		c.req.valid("query");

	try {
		// Discovering ad accounts is an external Meta crawl (1 + N×(1-10) Graph
		// calls) plus upsert/prune writes. Only run it when explicitly filtering
		// by a social account, never on cursor-paginated follow-up pages (they
		// re-read already-imported data), and gate it behind a short-TTL KV
		// freshness marker so routine filtered list calls don't re-crawl Meta on
		// every request. The first/stale call stays inline so the dashboard
		// Discover flow still returns fresh data.
		if (social_account_id && !cursor) {
			const discoverKey = `ad-discovery:${orgId}:${social_account_id}`;
			let fresh = false;
			try {
				fresh = (await c.env.KV.get(discoverKey)) !== null;
			} catch (err) {
				console.error("[Ads] ad-account discovery gating failed", err);
			}
			if (!fresh) {
				await adService.discoverAdAccounts(
					c.env,
					orgId,
					social_account_id,
					c.get("db"),
					c.get("workspaceScope"),
				);
				try {
					await c.env.KV.put(discoverKey, "1", { expirationTtl: 600 });
				} catch (err) {
					console.error("[Ads] ad-account discovery marker put failed", err);
				}
			}
		}

		const db = c.get("db");
		const conditions = [eq(adAccounts.organizationId, orgId)];
		applyWorkspaceScope(c, conditions, adAccounts.workspaceId);
		// Only surface ad accounts that can promote at least one connected
		// Page/IG. Filtering by a specific social account checks membership in
		// the boostable set (an ad account may promote several connected pages).
		if (social_account_id) {
			conditions.push(
				sql`${adAccounts.metadata}->'boostable_social_account_ids' @> ${JSON.stringify(social_account_id)}::jsonb`,
			);
		} else {
			conditions.push(
				sql`jsonb_array_length(coalesce(${adAccounts.metadata}->'boostable_social_account_ids', '[]'::jsonb)) > 0`,
			);
		}
		if (workspace_id) {
			conditions.push(eq(adAccounts.workspaceId, workspace_id));
		}
		if (q) {
			conditions.push(
				sql`(${adAccounts.name} ILIKE ${`%${q}%`} OR ${adAccounts.platformAdAccountId} ILIKE ${`%${q}%`})`,
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

		return c.json(
			{
				data: items.map((a) => {
					const md = (a.metadata ?? {}) as Record<string, unknown>;
					return {
						id: a.id,
						social_account_id: a.socialAccountId,
						platform: a.platform,
						platform_ad_account_id: a.platformAdAccountId,
						name: a.name,
						currency: a.currency,
						timezone: a.timezone,
						status: a.status,
						boostable_social_account_ids: Array.isArray(
							md.boostable_social_account_ids,
						)
							? (md.boostable_social_account_ids as string[])
							: [],
						boostable_accounts: Array.isArray(md.boostable_accounts)
							? (md.boostable_accounts as {
									id: string;
									platform: string;
									username: string | null;
								}[])
							: [],
					};
				}),
				next_cursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
				has_more: hasMore,
			} as {
				data: z.infer<typeof AdAccountResponse>[];
				next_cursor: string | null;
				has_more: boolean;
			},
			200,
		);
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
		headers: RequiredIdempotencyKeyHeaders,
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeAdAccount(c, body.ad_account_id);
	if (denied) return denied as never;
	const planDenied = await requireSpendEligiblePlan(c);
	if (planDenied) return planDenied as never;

	try {
		const campaign = await adService.createCampaign(
			c.env,
			orgId,
			{
				adAccountId: body.ad_account_id,
				name: body.name,
				objective: body.objective,
				dailyBudgetCents: body.daily_budget_cents,
				lifetimeBudgetCents: body.lifetime_budget_cents,
				currency: body.currency,
				startDate: body.start_date,
				endDate: body.end_date,
				specialAdCategories: body.special_ad_categories,
				operationKey,
			},
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
		);

		if (!campaign) {
			return c.json(
				{
					error: {
						code: "CREATE_FAILED",
						message: "Failed to create campaign",
					},
				},
				400,
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
	const decodedCursor = decodeCursor(cursor);
	if (decodedCursor) {
		conditions.push(
			sql`(${adCampaigns.createdAt}, ${adCampaigns.id}) < (${decodedCursor.createdAt.toISOString()}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const campaigns = await db
		.select()
		.from(adCampaigns)
		.where(and(...conditions))
		.orderBy(desc(adCampaigns.createdAt), desc(adCampaigns.id))
		.limit(limit + 1);

	const hasMore = campaigns.length > limit;
	const items = campaigns.slice(0, limit);
	const lastItem = items[items.length - 1];

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
		next_cursor:
			hasMore && lastItem
				? encodeCursor(lastItem.createdAt, lastItem.id)
				: null,
		has_more: hasMore,
	} as z.infer<typeof CampaignListResponse>);
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
			content: {
				"application/json": { schema: z.object({ data: CampaignResponse }) },
			},
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
				ad_count: adCount?.count ?? 0,
				metrics: null,
				created_at: campaign.createdAt.toISOString(),
				updated_at: campaign.updatedAt.toISOString(),
			},
		} as { data: z.infer<typeof CampaignResponse> },
		200,
	);
});

const updateCampaignStatus = createRoute({
	operationId: "updateAdCampaignStatus",
	method: "patch",
	path: "/campaigns/{id}",
	tags: ["Ads"],
	summary: "Update campaign (pause/resume)",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredIdempotencyKeyHeaders,
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeCampaign(c, id);
	if (denied) return denied as never;

	try {
		const result = await adService.updateCampaign(
			c.env,
			orgId,
			id,
			{
				name: body.name,
				status: body.status,
				dailyBudgetCents: body.daily_budget_cents,
				lifetimeBudgetCents: body.lifetime_budget_cents,
				allowSpendIncrease: await mayIncreaseSpend(c),
				operationKey,
			},
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
		);
		return c.json(result, 200);
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
	request: { headers: RequiredIdempotencyKeyHeaders, params: IdParam },
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeCampaign(c, id);
	if (denied) return denied as never;

	try {
		await adService.cancelCampaign(
			c.env,
			orgId,
			id,
			operationKey,
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
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
		headers: RequiredIdempotencyKeyHeaders,
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeAdAccount(c, body.ad_account_id);
	if (denied) return denied as never;
	const planDenied = await requireSpendEligiblePlan(c);
	if (planDenied) return planDenied as never;
	if (body.campaign_id) {
		const campaignDenied = await authorizeCampaign(c, body.campaign_id);
		if (campaignDenied) return campaignDenied as never;
		const ignoredSharedAdSetFields = [
			body.objective,
			body.targeting,
			body.daily_budget_cents,
			body.lifetime_budget_cents,
			body.duration_days,
			body.start_date,
			body.end_date,
		].some((value) => value !== undefined);
		if (ignoredSharedAdSetFields) {
			// The current provider model reuses the campaign's shared ad set. Do not
			// accept per-ad authority that would be stored locally but never sent to
			// Meta. This guard can be removed if the product adopts one ad set per ad.
			c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
				kind: "not_applied",
			});
			return c.json(
				{
					error: {
						code: "INVALID_EXISTING_CAMPAIGN_OPTIONS",
						message:
							"objective, targeting, budgets, duration, and schedule cannot be overridden when reusing a campaign",
					},
				},
				400,
			);
		}
	}

	try {
		const ad = await adService.createAd(
			c.env,
			orgId,
			{
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
				targeting: body.targeting as AdTargeting | undefined,
				dailyBudgetCents: body.daily_budget_cents,
				lifetimeBudgetCents: body.lifetime_budget_cents,
				durationDays: body.duration_days,
				startDate: body.start_date,
				endDate: body.end_date,
				operationKey,
			},
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
		);

		if (!ad) throw new Error("Failed to create ad");
		return c.json(
			{ data: formatAdResponse(ad) as z.infer<typeof AdResponse> },
			201,
		);
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
		headers: RequiredIdempotencyKeyHeaders,
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeAdAccount(c, body.ad_account_id);
	if (denied) return denied as never;
	const planDenied = await requireSpendEligiblePlan(c);
	if (planDenied) return planDenied as never;

	try {
		const ad = await adService.boostPost(
			c.env,
			orgId,
			{
				adAccountId: body.ad_account_id,
				postTargetId: body.post_target_id,
				externalPostId: body.external_post_id,
				name: body.name,
				objective: body.objective,
				targeting: body.targeting as AdTargeting | undefined,
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
				operationKey,
			},
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
		);

		if (!ad) throw new Error("Failed to create ad");
		return c.json(
			{ data: formatAdResponse(ad) as z.infer<typeof AdResponse> },
			201,
		);
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
	const decodedCursor = decodeCursor(cursor);
	if (decodedCursor) {
		conditions.push(
			sql`(${ads.createdAt}, ${ads.id}) < (${decodedCursor.createdAt.toISOString()}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const results = await db
		.select()
		.from(ads)
		.where(and(...conditions))
		.orderBy(desc(ads.createdAt), desc(ads.id))
		.limit(limit + 1);

	const hasMore = results.length > limit;
	const items = results.slice(0, limit);
	const lastItem = items[items.length - 1];

	return c.json({
		data: items.map(formatAdResponse),
		next_cursor:
			hasMore && lastItem
				? encodeCursor(lastItem.createdAt, lastItem.id)
				: null,
		has_more: hasMore,
	} as z.infer<typeof AdListResponse>);
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
	const denied = await authorizeAd(c, id);
	if (denied) return denied as never;

	const startDate =
		from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
	const endDate = to ?? new Date().toISOString().slice(0, 10);

	try {
		// Use stored metrics first; fall back to live if breakdowns requested or stored is empty
		if (!breakdowns) {
			const db = c.get("db");
			const stored = await adAnalytics.getAdAnalytics(
				db,
				id,
				orgId,
				c.get("workspaceScope"),
				startDate,
				endDate,
			);
			if (stored.daily.length > 0) {
				return c.json(
					{ data: stored } as { data: z.infer<typeof AdAnalyticsResponse> },
					200,
				);
			}
		}

		// Live path: fetches from platform API (supports breakdowns/demographics)
		const result = await adAnalytics.getAdAnalyticsLive(
			c.env,
			id,
			orgId,
			c.get("workspaceScope"),
			startDate,
			endDate,
			breakdowns?.split(","),
			c.get("db"),
		);

		return c.json(
			{ data: result } as { data: z.infer<typeof AdAnalyticsResponse> },
			200,
		);
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

	const firstAdAccount = adAccountRows[0];
	if (!firstAdAccount) {
		return c.json({ data: [] as z.infer<typeof InterestResponse>[] });
	}

	const adapter = getAdPlatformAdapter(firstAdAccount.platform);
	if (!adapter)
		return c.json({ data: [] as z.infer<typeof InterestResponse>[] });

	// Get access token from the linked social account
	const { socialAccounts: saTable } = await import("@relayapi/db");
	const [sa] = await db
		.select({
			id: saTable.id,
			accessToken: saTable.accessToken,
			workspaceId: saTable.workspaceId,
		})
		.from(saTable)
		.where(
			and(eq(saTable.id, social_account_id), eq(saTable.organizationId, orgId)),
		)
		.limit(1);

	if (!sa) return c.json({ data: [] as z.infer<typeof InterestResponse>[] });

	const denied = assertWorkspaceScope(c, sa.workspaceId);
	if (denied) return denied as never;

	const accessToken = await decryptAccountToken(
		sa.accessToken,
		c.env.ENCRYPTION_KEY,
		sa.id,
		"access_token",
	);

	try {
		const interests = await adapter.searchInterests(accessToken ?? "", q);
		return c.json({
			data: interests.map((i) => ({
				id: i.id,
				name: i.name,
				category: i.category,
				audience_size: i.audienceSize,
			})),
		} as { data: z.infer<typeof InterestResponse>[] });
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
		400: {
			description: "Bad request",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createAudience, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const denied = await authorizeAdAccount(c, body.ad_account_id);
	if (denied) return denied as never;
	if (body.source_audience_id) {
		const sourceDenied = await authorizeAudience(c, body.source_audience_id);
		if (sourceDenied) return sourceDenied as never;
	}

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
				400,
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
			} as { data: z.infer<typeof AudienceResponse> },
			201,
		);
	} catch (err) {
		markAudiencePreboundaryError(c, err);
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
	const denied = await authorizeAdAccount(c, ad_account_id);
	if (denied) return denied as never;

	// Import existing custom audiences from the platform before reading (mirrors
	// how listAdAccounts discovers accounts). This is an expensive external Meta
	// crawl + DB upserts, so we never block the response on it:
	//   1. Skip discovery entirely on cursor-paginated follow-up pages — they
	//      re-read already-imported data, so re-discovery is pure waste.
	//   2. On the first page, gate discovery behind a short-TTL KV marker so it
	//      runs at most once per org+account per window, and run it via
	//      waitUntil() so the response is served from the local table
	//      immediately (data is eventually consistent within the TTL window).
	if (!cursor) {
		const discoverKey = `ad-discovery:${orgId}:audience:${ad_account_id}`;
		try {
			const marker = await c.env.KV.get(discoverKey);
			if (!marker) {
				await c.env.KV.put(discoverKey, "1", { expirationTtl: 600 });
				c.executionCtx.waitUntil(
					adAudienceService
						.discoverAudiences(c.env, orgId, ad_account_id)
						.catch((err) =>
							console.error("[Ads] audience discovery failed", err),
						),
				);
			}
		} catch (err) {
			// A KV hiccup must not fail the list — fall through to the DB read.
			console.error("[Ads] audience discovery gating failed", err);
		}
	}

	const conditions = [
		eq(adAudiences.organizationId, orgId),
		eq(adAudiences.adAccountId, ad_account_id),
	];
	applyWorkspaceScope(c, conditions, adAudiences.workspaceId);
	const decodedCursor = decodeCursor(cursor);
	if (decodedCursor) {
		conditions.push(
			sql`(${adAudiences.createdAt}, ${adAudiences.id}) < (${decodedCursor.createdAt.toISOString()}::timestamptz, ${decodedCursor.id})`,
		);
	}

	const audiences = await db
		.select()
		.from(adAudiences)
		.where(and(...conditions))
		.orderBy(desc(adAudiences.createdAt), desc(adAudiences.id))
		.limit(limit + 1);

	const hasMore = audiences.length > limit;
	const items = audiences.slice(0, limit);
	const lastItem = items[items.length - 1];

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
		next_cursor:
			hasMore && lastItem
				? encodeCursor(lastItem.createdAt, lastItem.id)
				: null,
		has_more: hasMore,
	} as z.infer<typeof AudienceListResponse>);
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
		403: {
			description: "Workspace access denied",
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
	if (isWorkspaceScopeDenied(c, audience.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
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
		} as { data: z.infer<typeof AudienceResponse> },
		200,
	);
});

const addAudienceUsers = createRoute({
	operationId: "addUsersToAdAudience",
	method: "post",
	path: "/audiences/{id}/users",
	tags: ["Ads"],
	summary: "Upload hashed users to audience",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredIdempotencyKeyHeaders,
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
	const denied = await authorizeAudience(c, id);
	if (denied) return denied as never;

	try {
		const result = await adAudienceService.addUsersToAudience(
			c.env,
			orgId,
			id,
			users,
		);
		return c.json({
			added: result.added,
			invalid: result.invalid,
			stored: result.stored,
		});
	} catch (err) {
		markAudiencePreboundaryError(c, err);
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
	const denied = await authorizeAudience(c, id);
	if (denied) return denied as never;

	try {
		await adAudienceService.deleteAudience(c.env, orgId, id);
		return c.json({ message: "Audience deleted" });
	} catch (err) {
		markAudiencePreboundaryError(c, err);
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
	description:
		"Enqueues a full external sync (Graph fetch + ad/campaign upserts + metrics refresh) on the ads queue and returns immediately. Poll the list/analytics endpoints for results.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		202: {
			description: "Sync queued",
			content: { "application/json": { schema: SyncQueuedResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(triggerSync, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const denied = await authorizeAdAccount(c, id);
	if (denied) return denied as never;

	try {
		// The full sync (external Graph fetch, per-ad upserts, and metrics refresh
		// of up to 200 ads) can exceed the request window, so run it on the ADS
		// queue instead of inline. The same job type the cron enqueues.
		const tracker = c.get("mutationEffectTracker");
		if (!tracker) throw new Error("Mutation effect tracker is unavailable");
		await trackAuthoritativeAmbiguousMutation(
			tracker,
			() =>
				c.env.ADS_QUEUE.send({
					type: "sync_external",
					org_id: orgId,
					ad_account_id: id,
					// Manual sync is a full refresh — pull the complete 30-day window
					// regardless of the consumer's wall-clock hour.
					window_days: 30,
				}),
			1,
		);

		return c.json({ status: "queued" as const }, 202);
	} catch (err) {
		return handleAdError(c, err);
	}
});

// =========================================================================
// ADS BY ID
// IMPORTANT: these single-segment "/{id}" routes are registered LAST, after
// every literal /v1/ads/* route (e.g. /interests, /audiences). Hono resolves
// overlapping routes in registration order (first match wins), so registering
// "/{id}" before a literal like "/audiences" would shadow it — the request
// would hit getAd and 404 with "Ad not found". Do not move these back up.
// =========================================================================

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
		403: {
			description: "Workspace access denied",
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
	if (isWorkspaceScopeDenied(c, ad.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	return c.json(
		{ data: formatAdResponse(ad) as z.infer<typeof AdResponse> },
		200,
	);
});

const updateAdRoute = createRoute({
	operationId: "updateAd",
	method: "patch",
	path: "/{id}",
	tags: ["Ads"],
	summary: "Update ad (name, budget, targeting, pause/resume)",
	security: [{ Bearer: [] }],
	request: {
		headers: RequiredIdempotencyKeyHeaders,
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeAd(c, id);
	if (denied) return denied as never;

	try {
		const updated = await adService.updateAd(
			c.env,
			orgId,
			id,
			{
				name: body.name,
				status: body.status,
				dailyBudgetCents: body.daily_budget_cents,
				lifetimeBudgetCents: body.lifetime_budget_cents,
				targeting: body.targeting as AdTargeting | undefined,
				allowSpendIncrease: await mayIncreaseSpend(c),
				operationKey,
			},
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
		);

		if (!updated) throw new Error("Failed to update ad");
		return c.json(
			{ data: formatAdResponse(updated) as z.infer<typeof AdResponse> },
			200,
		);
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
	request: { headers: RequiredIdempotencyKeyHeaders, params: IdParam },
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
	const operationKey = c.req.valid("header")["idempotency-key"];
	const denied = await authorizeAd(c, id);
	if (denied) return denied as never;

	try {
		await adService.cancelAd(
			c.env,
			orgId,
			id,
			operationKey,
			c.get("db"),
			c.get("usageReservation"),
			durableCredentialAuthorityAdmission(c, "manage_spend"),
		);
		return c.json({ message: "Ad cancelled" });
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
		boost_external_post_id: ad.boostExternalPostId,
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
