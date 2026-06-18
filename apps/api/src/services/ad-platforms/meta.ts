// ---------------------------------------------------------------------------
// Meta (Facebook + Instagram) Ad Platform Adapter
// Uses Facebook Marketing API v25.0
// Docs: https://developers.facebook.com/docs/marketing-apis
// ---------------------------------------------------------------------------

import type {
	AdMetricPoint,
	AdMetricsWithDemographics,
	AdPlatformAdapter,
	AdTargeting,
	BoostPostParams,
	CreateAdParams,
	CreateAudienceParams,
	CreateCampaignParams,
	ExternalAdData,
	ExternalAdSyncResult,
	HashedUser,
	PlatformAdAccount,
	PlatformAdResult,
	PlatformAudience,
	PlatformAudienceResult,
	PlatformCampaignResult,
	PromotablePage,
	DateRange,
	TargetingInterest,
	UpdateAdParams,
} from "./types";
import { AdPlatformError } from "./types";
import { GRAPH_BASE } from "../../config/api-versions";
import { fetchWithTimeout } from "../../lib/fetch-timeout";

const GRAPH_API = GRAPH_BASE.facebook;

// Cap every Meta Graph call so a hung graph.facebook.com cannot stall the worker.
// Generous enough for ad-creation calls (campaign/adset/creative/ad) while still
// failing fast instead of waiting out the platform's own long timeout.
const META_FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function metaFetch<T = unknown>(
	url: string,
	accessToken: string,
	options: RequestInit = {},
): Promise<T> {
	const separator = url.includes("?") ? "&" : "?";
	const res = await fetchWithTimeout(`${url}${separator}access_token=${accessToken}`, {
		timeout: META_FETCH_TIMEOUT_MS,
		...options,
		headers: {
			"Content-Type": "application/json",
			...options.headers,
		},
	});

	const data = (await res.json()) as T & { error?: { message: string; code: number } };

	if (!res.ok || (data as { error?: unknown }).error) {
		const err = (data as { error?: { message: string; code: number } }).error;
		throw new AdPlatformError(
			"META_API_ERROR",
			err?.message ?? `Meta API error: ${res.status}`,
			data,
		);
	}

	return data;
}

function mapObjectiveToMeta(objective: string): string {
	const map: Record<string, string> = {
		awareness: "OUTCOME_AWARENESS",
		traffic: "OUTCOME_TRAFFIC",
		engagement: "OUTCOME_ENGAGEMENT",
		leads: "OUTCOME_LEADS",
		conversions: "OUTCOME_SALES",
		video_views: "OUTCOME_AWARENESS",
	};
	return map[objective] ?? "OUTCOME_ENGAGEMENT";
}

export function mapMetaObjectiveToLocal(objective?: string): string {
	const map: Record<string, string> = {
		OUTCOME_AWARENESS: "awareness",
		OUTCOME_TRAFFIC: "traffic",
		OUTCOME_ENGAGEMENT: "engagement",
		OUTCOME_LEADS: "leads",
		OUTCOME_SALES: "conversions",
		OUTCOME_APP_PROMOTION: "conversions",
		BRAND_AWARENESS: "awareness",
		REACH: "awareness",
		LINK_CLICKS: "traffic",
		TRAFFIC: "traffic",
		POST_ENGAGEMENT: "engagement",
		PAGE_LIKES: "engagement",
		MESSAGES: "engagement",
		LEAD_GENERATION: "leads",
		CONVERSIONS: "conversions",
		PRODUCT_CATALOG_SALES: "conversions",
		VIDEO_VIEWS: "video_views",
	};

	return map[objective ?? ""] ?? "engagement";
}

/**
 * Map a Meta custom audience `subtype` to our local `audience_type` enum
 * (only `customer_list | website | lookalike` exist locally). Meta exposes
 * many more subtypes (CUSTOM, LOOKALIKE, WEBSITE, IG_BUSINESS, FB_EVENT,
 * CLAIM, …); collapse anything that isn't clearly a lookalike or website
 * audience into `customer_list`.
 */
export function mapMetaSubtypeToLocal(
	subtype?: string,
): "customer_list" | "website" | "lookalike" {
	switch (subtype) {
		case "LOOKALIKE":
			return "lookalike";
		case "WEBSITE":
			return "website";
		default:
			return "customer_list";
	}
}

function mapMetaStatusToLocal(status: string): string {
	const map: Record<string, string> = {
		ACTIVE: "active",
		PAUSED: "paused",
		DELETED: "cancelled",
		ARCHIVED: "cancelled",
		IN_PROCESS: "pending_review",
		WITH_ISSUES: "active",
		CAMPAIGN_PAUSED: "paused",
		ADSET_PAUSED: "paused",
		PENDING_REVIEW: "pending_review",
		DISAPPROVED: "rejected",
		PREAPPROVED: "pending_review",
		PENDING_BILLING_INFO: "draft",
	};
	return map[status] ?? "draft";
}

function buildTargetingSpec(targeting?: AdTargeting): Record<string, unknown> {
	if (!targeting) return {};

	const spec: Record<string, unknown> = {};

	if (targeting.ageMin) spec.age_min = targeting.ageMin;
	if (targeting.ageMax) spec.age_max = targeting.ageMax;

	if (targeting.genders?.length) {
		const genderMap: Record<string, number> = { male: 1, female: 2 };
		spec.genders = targeting.genders
			.map((g) => genderMap[g])
			.filter(Boolean);
	}

	if (targeting.locations?.length) {
		const countries = targeting.locations.flatMap(
			(l) => l.countries ?? [],
		);
		if (countries.length) {
			spec.geo_locations = { countries };
		}
	}

	if (targeting.interests?.length) {
		spec.flexible_spec = [
			{
				interests: targeting.interests.map((i) => ({
					id: i.id,
					name: i.name,
				})),
			},
		];
	}

	if (targeting.customAudiences?.length) {
		spec.custom_audiences = targeting.customAudiences.map((id) => ({
			id,
		}));
	}

	if (targeting.excludedAudiences?.length) {
		spec.excluded_custom_audiences = targeting.excludedAudiences.map(
			(id) => ({ id }),
		);
	}

	if (targeting.placements?.length) {
		spec.publisher_platforms = targeting.placements;
	}

	return spec;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const metaAdAdapter: AdPlatformAdapter = {
	platform: "meta",

	// -----------------------------------------------------------------------
	// Ad Accounts
	// -----------------------------------------------------------------------

	async listAdAccounts(
		accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAdAccount[]> {
		const data = await metaFetch<{
			data: {
				id: string;
				name: string;
				currency: string;
				timezone_name: string;
				account_status: number;
			}[];
		}>(
			`${GRAPH_API}/me/adaccounts?fields=id,name,currency,timezone_name,account_status&limit=100`,
			accessToken,
		);

		return data.data.map((acc) => ({
			id: acc.id,
			name: acc.name,
			currency: acc.currency,
			timezone: acc.timezone_name,
			status: acc.account_status === 1 ? "active" : "disabled",
		}));
	},

	// -----------------------------------------------------------------------
	// Promotable Pages
	// -----------------------------------------------------------------------

	/**
	 * The Pages an ad account is permitted to promote, with each Page's
	 * connected Instagram business account resolved in batched multi-get calls.
	 *
	 * Endpoints (Facebook Marketing API):
	 *  - GET /act_{ad_account_id}/promote_pages?fields=id,name
	 *      https://developers.facebook.com/docs/graph-api/reference/ad-account/promote_pages/
	 *      Returns the Page nodes this ad account can advertise.
	 *  - GET /?ids={page_ids}&fields=instagram_business_account{id}
	 *      https://developers.facebook.com/docs/graph-api/reference/page/
	 *      `instagram_business_account` is the IGUser linked to the Page.
	 *
	 * `platformAdAccountId` is already the `act_{id}` form returned by
	 * /me/adaccounts (used verbatim like every other call in this adapter).
	 */
	async listPromotablePages(
		accessToken: string,
		platformAdAccountId: string,
	): Promise<PromotablePage[]> {
		// 1. Collect promotable Pages (follow cursor pagination, bounded).
		const pages: { id: string; name?: string }[] = [];
		const MAX_PAGE_REQUESTS = 10; // 100 pages/request → up to 1000 Pages
		let after: string | undefined;
		for (let i = 0; i < MAX_PAGE_REQUESTS; i++) {
			const afterParam = after ? `&after=${encodeURIComponent(after)}` : "";
			const res = await metaFetch<{
				data?: { id: string; name?: string }[];
				paging?: { next?: string; cursors?: { after?: string } };
			}>(
				`${GRAPH_API}/${platformAdAccountId}/promote_pages?fields=id,name&limit=100${afterParam}`,
				accessToken,
			);
			for (const p of res.data ?? []) pages.push({ id: p.id, name: p.name });
			after = res.paging?.next ? res.paging?.cursors?.after : undefined;
			if (!after) break;
		}

		if (pages.length === 0) return [];

		// 2. Resolve each Page's connected Instagram business account.
		const igByPageId = new Map<string, string>();
		const IG_CHUNK = 50;
		for (let i = 0; i < pages.length; i += IG_CHUNK) {
			const chunk = pages.slice(i, i + IG_CHUNK);
			try {
				const res = await metaFetch<
					Record<
						string,
						{ instagram_business_account?: { id: string } }
					>
				>(
					`${GRAPH_API}/?ids=${chunk
						.map((p) => p.id)
						.join(",")}&fields=instagram_business_account{id}`,
					accessToken,
				);
				for (const [pageId, value] of Object.entries(res)) {
					const igId = value?.instagram_business_account?.id;
					if (igId) igByPageId.set(pageId, igId);
				}
			} catch {
				// IG resolution is best-effort; a failed chunk yields Page-only matches.
			}
		}

		return pages.map((p) => ({
			pageId: p.id,
			name: p.name,
			instagramBusinessAccountId: igByPageId.get(p.id),
		}));
	},

	// -----------------------------------------------------------------------
	// Audiences (discovery)
	// -----------------------------------------------------------------------

	async listAudiences(
		accessToken: string,
		adAccountId: string,
	): Promise<PlatformAudience[]> {
		// GET /{ad-account-id}/customaudiences
		// https://developers.facebook.com/docs/marketing-api/reference/custom-audience
		const data = await metaFetch<{
			data: {
				id: string;
				name: string;
				subtype?: string;
				description?: string;
				approximate_count_lower_bound?: number;
				approximate_count_upper_bound?: number;
				delivery_status?: { code?: number; description?: string };
				operation_status?: { code?: number; description?: string };
			}[];
		}>(
			`${GRAPH_API}/${adAccountId}/customaudiences?fields=id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status&limit=100`,
			accessToken,
		);

		return data.data.map((a) => ({
			id: a.id,
			name: a.name,
			type: mapMetaSubtypeToLocal(a.subtype),
			description: a.description ?? null,
			size:
				a.approximate_count_upper_bound ??
				a.approximate_count_lower_bound ??
				null,
			status:
				a.delivery_status?.description ??
				a.operation_status?.description ??
				null,
		}));
	},

	// -----------------------------------------------------------------------
	// Campaigns
	// -----------------------------------------------------------------------

	async createCampaign(
		accessToken: string,
		adAccountId: string,
		params: CreateCampaignParams,
	): Promise<PlatformCampaignResult> {
		// 1. Create campaign
		const campaignData = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/campaigns`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					name: params.name,
					objective: mapObjectiveToMeta(params.objective),
					status: "PAUSED",
					special_ad_categories: params.specialAdCategories ?? [],
				}),
			},
		);

		// 2. Create ad set
		const adSetBody: Record<string, unknown> = {
			name: `${params.name} - Ad Set`,
			campaign_id: campaignData.id,
			billing_event: "IMPRESSIONS",
			optimization_goal: "REACH",
			status: "PAUSED",
			targeting: { geo_locations: { countries: ["US"] } },
		};

		if (params.dailyBudgetCents) {
			adSetBody.daily_budget = params.dailyBudgetCents;
		} else if (params.lifetimeBudgetCents) {
			adSetBody.lifetime_budget = params.lifetimeBudgetCents;
			if (params.endDate) adSetBody.end_time = params.endDate;
		}

		if (params.startDate) adSetBody.start_time = params.startDate;
		if (params.endDate) adSetBody.end_time = params.endDate;

		const adSetData = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/adsets`,
			accessToken,
			{ method: "POST", body: JSON.stringify(adSetBody) },
		);

		return {
			platformCampaignId: campaignData.id,
			platformAdSetId: adSetData.id,
			status: "paused",
		};
	},

	// -----------------------------------------------------------------------
	// Ads
	// -----------------------------------------------------------------------

	async createAd(
		accessToken: string,
		adAccountId: string,
		params: CreateAdParams,
	): Promise<PlatformAdResult> {
		// 1. Create ad creative
		const creativeBody: Record<string, unknown> = {
			name: `${params.name} - Creative`,
		};

		if (params.linkUrl) {
			const linkData: Record<string, unknown> = {
				link: params.linkUrl,
			};
			if (params.imageUrl) linkData.image_url = params.imageUrl;
			if (params.headline) linkData.name = params.headline;
			if (params.body) linkData.message = params.body;
			if (params.callToAction) {
				linkData.call_to_action = {
					type: params.callToAction,
					value: { link: params.linkUrl },
				};
			}
			creativeBody.object_story_spec = {
				link_data: linkData,
			};
		} else if (params.imageUrl) {
			creativeBody.object_story_spec = {
				photo_data: {
					image_url: params.imageUrl,
					message: params.body ?? "",
				},
			};
		} else if (params.videoUrl) {
			creativeBody.object_story_spec = {
				video_data: {
					video_url: params.videoUrl,
					message: params.body ?? "",
					title: params.headline ?? "",
				},
			};
		}

		const creative = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/adcreatives`,
			accessToken,
			{ method: "POST", body: JSON.stringify(creativeBody) },
		);

		// 2. Create ad
		const adData = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/ads`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					name: params.name,
					adset_id: params.adSetId,
					creative: { creative_id: creative.id },
					status: "PAUSED",
				}),
			},
		);

		return {
			platformCampaignId: params.campaignId,
			platformAdSetId: params.adSetId,
			platformAdId: adData.id,
			status: "pending_review",
		};
	},

	async boostPost(
		accessToken: string,
		adAccountId: string,
		params: BoostPostParams,
	): Promise<PlatformAdResult> {
		// 1. Create campaign
		const campaign = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/campaigns`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					name: params.name ?? "Boosted Post",
					objective: mapObjectiveToMeta(params.objective),
					status: "PAUSED",
					special_ad_categories: params.specialAdCategories ?? [],
				}),
			},
		);

		// 2. Create ad set with targeting + budget
		const adSetBody: Record<string, unknown> = {
			name: `${params.name ?? "Boosted Post"} - Ad Set`,
			campaign_id: campaign.id,
			billing_event: "IMPRESSIONS",
			optimization_goal: "POST_ENGAGEMENT",
			daily_budget: params.dailyBudgetCents,
			status: "PAUSED",
			targeting: buildTargetingSpec(params.targeting),
		};

		if (params.startDate) adSetBody.start_time = params.startDate;
		if (params.endDate) {
			adSetBody.end_time = params.endDate;
		} else if (params.durationDays) {
			const end = new Date();
			end.setDate(end.getDate() + params.durationDays);
			adSetBody.end_time = end.toISOString();
		}

		if (params.bidAmount) {
			adSetBody.bid_amount = Math.round(params.bidAmount * 100);
		}

		if (params.tracking?.pixelId) {
			adSetBody.promoted_object = { pixel_id: params.tracking.pixelId };
		}

		const adSet = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/adsets`,
			accessToken,
			{ method: "POST", body: JSON.stringify(adSetBody) },
		);

		// 3. Create ad creative using existing post
		const creative = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/adcreatives`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					name: `Boost - ${params.platformPostId}`,
					object_story_id: params.platformPostId,
					...(params.tracking?.urlTags
						? { url_tags: params.tracking.urlTags }
						: {}),
				}),
			},
		);

		// 4. Create ad
		const ad = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/ads`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({
					name: params.name ?? "Boosted Post",
					adset_id: adSet.id,
					creative: { creative_id: creative.id },
					status: "ACTIVE",
				}),
			},
		);

		// 5. Activate the campaign + ad set
		await Promise.all([
			metaFetch(`${GRAPH_API}/${campaign.id}`, accessToken, {
				method: "POST",
				body: JSON.stringify({ status: "ACTIVE" }),
			}),
			metaFetch(`${GRAPH_API}/${adSet.id}`, accessToken, {
				method: "POST",
				body: JSON.stringify({ status: "ACTIVE" }),
			}),
		]);

		return {
			platformCampaignId: campaign.id,
			platformAdSetId: adSet.id,
			platformAdId: ad.id,
			status: "pending_review",
		};
	},

	async updateAd(
		accessToken: string,
		platformAdId: string,
		params: UpdateAdParams,
	): Promise<void> {
		const body: Record<string, unknown> = {};
		if (params.name) body.name = params.name;
		if (params.status) {
			body.status = params.status === "active" ? "ACTIVE" : "PAUSED";
		}

		if (Object.keys(body).length > 0) {
			await metaFetch(`${GRAPH_API}/${platformAdId}`, accessToken, {
				method: "POST",
				body: JSON.stringify(body),
			});
		}

		// Budget updates go to the ad set level
		if (params.dailyBudgetCents || params.lifetimeBudgetCents || params.targeting) {
			// Fetch the parent ad set
			const adInfo = await metaFetch<{
				adset_id: string;
			}>(`${GRAPH_API}/${platformAdId}?fields=adset_id`, accessToken);

			const adSetBody: Record<string, unknown> = {};
			if (params.dailyBudgetCents)
				adSetBody.daily_budget = params.dailyBudgetCents;
			if (params.lifetimeBudgetCents)
				adSetBody.lifetime_budget = params.lifetimeBudgetCents;
			if (params.targeting)
				adSetBody.targeting = buildTargetingSpec(params.targeting);

			if (Object.keys(adSetBody).length > 0) {
				await metaFetch(
					`${GRAPH_API}/${adInfo.adset_id}`,
					accessToken,
					{
						method: "POST",
						body: JSON.stringify(adSetBody),
					},
				);
			}
		}
	},

	async pauseAd(accessToken: string, platformAdId: string): Promise<void> {
		await metaFetch(`${GRAPH_API}/${platformAdId}`, accessToken, {
			method: "POST",
			body: JSON.stringify({ status: "PAUSED" }),
		});
	},

	async resumeAd(accessToken: string, platformAdId: string): Promise<void> {
		await metaFetch(`${GRAPH_API}/${platformAdId}`, accessToken, {
			method: "POST",
			body: JSON.stringify({ status: "ACTIVE" }),
		});
	},

	async cancelAd(accessToken: string, platformAdId: string): Promise<void> {
		await metaFetch(`${GRAPH_API}/${platformAdId}`, accessToken, {
			method: "POST",
			body: JSON.stringify({ status: "DELETED" }),
		});
	},

	async pauseCampaign(
		accessToken: string,
		platformCampaignId: string,
	): Promise<void> {
		await metaFetch(
			`${GRAPH_API}/${platformCampaignId}`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({ status: "PAUSED" }),
			},
		);
	},

	async resumeCampaign(
		accessToken: string,
		platformCampaignId: string,
	): Promise<void> {
		await metaFetch(
			`${GRAPH_API}/${platformCampaignId}`,
			accessToken,
			{
				method: "POST",
				body: JSON.stringify({ status: "ACTIVE" }),
			},
		);
	},

	// -----------------------------------------------------------------------
	// Analytics
	// -----------------------------------------------------------------------

	async getAdMetrics(
		accessToken: string,
		platformAdId: string,
		dateRange: DateRange,
		breakdowns?: string[],
	): Promise<AdMetricsWithDemographics> {
		const fields =
			"impressions,reach,clicks,spend,actions,ctr,cpc,cpm";
		const url = `${GRAPH_API}/${platformAdId}/insights?fields=${fields}&time_range={"since":"${dateRange.startDate}","until":"${dateRange.endDate}"}&time_increment=1`;

		const data = await metaFetch<{
			data: {
				date_start: string;
				impressions?: string;
				reach?: string;
				clicks?: string;
				spend?: string;
				actions?: { action_type: string; value: string }[];
				ctr?: string;
				cpc?: string;
				cpm?: string;
			}[];
		}>(url, accessToken);

		const daily: AdMetricPoint[] = data.data.map((d) => {
			const conversions =
				d.actions
					?.filter((a) =>
						[
							"offsite_conversion",
							"lead",
							"purchase",
						].includes(a.action_type),
					)
					.reduce((sum, a) => sum + Number(a.value), 0) ?? 0;

			return {
				date: d.date_start,
				impressions: Number(d.impressions ?? 0),
				reach: Number(d.reach ?? 0),
				clicks: Number(d.clicks ?? 0),
				spendCents: Math.round(Number(d.spend ?? 0) * 100),
				conversions,
				videoViews: Number(
					d.actions?.find((a) => a.action_type === "video_view")
						?.value ?? 0,
				),
				engagement:
					Number(d.clicks ?? 0) +
					(d.actions?.reduce(
						(sum, a) => sum + Number(a.value),
						0,
					) ?? 0),
				ctr: d.ctr ? Number(d.ctr) : undefined,
				cpcCents: d.cpc ? Math.round(Number(d.cpc) * 100) : undefined,
				cpmCents: d.cpm ? Math.round(Number(d.cpm) * 100) : undefined,
			};
		});

		const result: AdMetricsWithDemographics = { daily };

		// Optional demographic breakdowns
		if (breakdowns?.length) {
			const breakdownParam = breakdowns.join(",");
			const breakdownUrl = `${GRAPH_API}/${platformAdId}/insights?fields=${fields}&time_range={"since":"${dateRange.startDate}","until":"${dateRange.endDate}"}&breakdowns=${breakdownParam}`;

			try {
				const breakdownData = await metaFetch<{
					data: Record<string, unknown>[];
				}>(breakdownUrl, accessToken);

				result.demographics = {};
				if (
					breakdowns.includes("age") ||
					breakdowns.includes("gender")
				) {
					result.demographics.ageGender = breakdownData.data;
				}
				if (breakdowns.includes("country")) {
					result.demographics.locations = breakdownData.data;
				}
			} catch {
				// Demographic breakdowns may fail for some objectives; non-fatal
			}
		}

		return result;
	},

	// -----------------------------------------------------------------------
	// Targeting
	// -----------------------------------------------------------------------

	async searchInterests(
		accessToken: string,
		query: string,
	): Promise<TargetingInterest[]> {
		const data = await metaFetch<{
			data: {
				id: string;
				name: string;
				topic?: string;
				audience_size_lower_bound?: number;
				audience_size_upper_bound?: number;
			}[];
		}>(
			`${GRAPH_API}/search?type=adinterest&q=${encodeURIComponent(query)}&limit=25`,
			accessToken,
		);

		return data.data.map((i) => ({
			id: i.id,
			name: i.name,
			category: i.topic,
			audienceSize: i.audience_size_upper_bound,
		}));
	},

	// -----------------------------------------------------------------------
	// Audiences
	// -----------------------------------------------------------------------

	async createCustomAudience(
		accessToken: string,
		adAccountId: string,
		params: CreateAudienceParams,
	): Promise<PlatformAudienceResult> {
		let body: Record<string, unknown>;

		switch (params.type) {
			case "customer_list":
				body = {
					name: params.name,
					subtype: "CUSTOM",
					description: params.description,
					customer_file_source:
						params.customerFileSource ?? "USER_PROVIDED_ONLY",
				};
				break;
			case "website":
				body = {
					name: params.name,
					subtype: "WEBSITE",
					description: params.description,
					retention_days: params.retentionDays ?? 30,
					rule: params.rule ?? {
						inclusions: {
							operator: "or",
							rules: [
								{
									event_sources: [
										{ id: params.pixelId, type: "pixel" },
									],
									retention_seconds:
										(params.retentionDays ?? 30) *
										86400,
								},
							],
						},
					},
				};
				break;
			case "lookalike":
				body = {
					name: params.name,
					subtype: "LOOKALIKE",
					description: params.description,
					origin_audience_id: params.sourceAudienceId,
					lookalike_spec: JSON.stringify({
						type: "similarity",
						country: params.country ?? "US",
						ratio: params.ratio ?? 0.01,
					}),
				};
				break;
			default:
				throw new AdPlatformError(
					"INVALID_AUDIENCE_TYPE",
					`Unsupported audience type: ${params.type}`,
				);
		}

		const data = await metaFetch<{ id: string }>(
			`${GRAPH_API}/${adAccountId}/customaudiences`,
			accessToken,
			{ method: "POST", body: JSON.stringify(body) },
		);

		return {
			platformAudienceId: data.id,
			name: params.name,
			type: params.type,
			status: "pending",
		};
	},

	async addUsersToAudience(
		accessToken: string,
		platformAudienceId: string,
		users: HashedUser[],
	): Promise<{ added: number; invalid: number }> {
		const schema: string[] = [];
		if (users.some((u) => u.emailHash)) schema.push("EMAIL_SHA256");
		if (users.some((u) => u.phoneHash)) schema.push("PHONE_SHA256");

		const userData = users.map((u) => {
			const row: string[] = [];
			if (schema.includes("EMAIL_SHA256")) row.push(u.emailHash ?? "");
			if (schema.includes("PHONE_SHA256")) row.push(u.phoneHash ?? "");
			return row;
		});

		const data = await metaFetch<{
			audience_id: string;
			num_received: number;
			num_invalid_entries: number;
		}>(`${GRAPH_API}/${platformAudienceId}/users`, accessToken, {
			method: "POST",
			body: JSON.stringify({
				payload: {
					schema,
					data: userData,
				},
			}),
		});

		return {
			added: data.num_received - data.num_invalid_entries,
			invalid: data.num_invalid_entries,
		};
	},

	async deleteAudience(
		accessToken: string,
		platformAudienceId: string,
	): Promise<void> {
		await metaFetch(
			`${GRAPH_API}/${platformAudienceId}`,
			accessToken,
			{ method: "DELETE" },
		);
	},

	// -----------------------------------------------------------------------
	// External Sync
	// -----------------------------------------------------------------------

	async syncExternalAds(
		accessToken: string,
		adAccountId: string,
		_since?: Date,
	): Promise<ExternalAdSyncResult> {
		const fields =
			"id,name,effective_status,campaign{id,name,objective},adset{id,name,daily_budget,lifetime_budget,start_time,end_time,targeting},creative{id,name,title,body,image_url,video_id,object_story_id,effective_object_story_id,link_url,call_to_action_type}";

		const data = await metaFetch<{
			data: {
				id: string;
				name: string;
				effective_status: string;
				campaign?: {
					id: string;
					name: string;
					objective?: string;
				};
				adset?: {
					id: string;
					name: string;
					daily_budget?: string;
					lifetime_budget?: string;
					start_time?: string;
					end_time?: string;
					targeting?: Record<string, unknown>;
				};
				creative?: {
					id: string;
					name: string;
					title?: string;
					body?: string;
					image_url?: string;
					link_url?: string;
					call_to_action_type?: string;
				};
			}[];
		}>(
			`${GRAPH_API}/${adAccountId}/ads?fields=${fields}&limit=100`,
			accessToken,
		);

		const ads: ExternalAdData[] = data.data.map((ad) => ({
			platformCampaignId: ad.campaign?.id ?? "",
			campaignName: ad.campaign?.name ?? "Unknown Campaign",
			platformAdSetId: ad.adset?.id,
			adSetName: ad.adset?.name,
			platformAdId: ad.id,
			adName: ad.name,
			status: mapMetaStatusToLocal(ad.effective_status),
			objective: mapMetaObjectiveToLocal(ad.campaign?.objective),
			dailyBudgetCents: ad.adset?.daily_budget
				? Number(ad.adset.daily_budget)
				: undefined,
			lifetimeBudgetCents: ad.adset?.lifetime_budget
				? Number(ad.adset.lifetime_budget)
				: undefined,
			startDate: ad.adset?.start_time,
			endDate: ad.adset?.end_time,
			creative: {
				headline: ad.creative?.title,
				body: ad.creative?.body,
				imageUrl: ad.creative?.image_url,
				linkUrl: ad.creative?.link_url,
				callToAction: ad.creative?.call_to_action_type,
			},
			targeting: ad.adset?.targeting,
		}));

		return { ads, totalFound: ads.length };
	},
};
