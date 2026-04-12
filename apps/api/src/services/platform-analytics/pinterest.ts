import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const BASE_URL = "https://api.pinterest.com/v5";

function authHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
	};
}

function pctChange(current: number, previous: number): number | null {
	if (previous === 0) return current > 0 ? 100 : null;
	return Math.round(((current - previous) / previous) * 10000) / 100;
}

function previousPeriod(dateRange: DateRange): DateRange {
	const fromMs = new Date(`${dateRange.from}T00:00:00Z`).getTime();
	const toMs = new Date(`${dateRange.to}T00:00:00Z`).getTime();
	const durationMs = toMs - fromMs;
	const prevTo = new Date(fromMs - 86_400_000);
	const prevFrom = new Date(prevTo.getTime() - durationMs);
	return {
		from: prevFrom.toISOString().slice(0, 10),
		to: prevTo.toISOString().slice(0, 10),
	};
}

interface PinterestAnalyticsResponse {
	all: {
		daily_metrics?: Array<{
			date: string;
			data_status: string;
			metrics: Record<string, number>;
		}>;
		summary_metrics?: Record<string, number>;
	};
}

interface PinterestTopPinsResponse {
	metadata?: {
		available_metrics?: string[];
	};
	pins?: Array<{
		metrics: Record<string, number>;
		pin_id: string;
		data_status: string;
	}>;
}

interface PinterestPinResponse {
	id: string;
	title?: string;
	description?: string;
	created_at?: string;
	media?: {
		media_type?: string;
		images?: Record<string, { url: string }>;
	};
	link?: string;
}

async function pinterestFetch<T = unknown>(
	path: string,
	accessToken: string,
): Promise<T | null> {
	try {
		const res = await fetch(`${BASE_URL}${path}`, {
			headers: authHeaders(accessToken),
		});

		if (!res.ok) {
			console.error(
				`[pinterest-analytics] API error ${res.status} for ${path}: ${await res.text()}`,
			);
			return null;
		}

		return (await res.json()) as T;
	} catch (err) {
		console.error(`[pinterest-analytics] Fetch failed for ${path}:`, err);
		return null;
	}
}

function sumMetricsFromDaily(
	dailyMetrics: Array<{ metrics: Record<string, number> }> | undefined,
	metricName: string,
): number {
	if (!dailyMetrics) return 0;
	return dailyMetrics.reduce((sum, day) => sum + (day.metrics?.[metricName] ?? 0), 0);
}

export const pinterestAnalytics: PlatformAnalyticsFetcher = {
	async getOverview(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		const current = await pinterestFetch<PinterestAnalyticsResponse>(
			`/user_account/analytics?start_date=${dateRange.from}&end_date=${dateRange.to}&metric_types=IMPRESSION,ENGAGEMENT,PIN_CLICK,OUTBOUND_CLICK,SAVE`,
			accessToken,
		);

		const prev = previousPeriod(dateRange);
		const previous = await pinterestFetch<PinterestAnalyticsResponse>(
			`/user_account/analytics?start_date=${prev.from}&end_date=${prev.to}&metric_types=IMPRESSION,ENGAGEMENT,PIN_CLICK,OUTBOUND_CLICK,SAVE`,
			accessToken,
		);

		const curImpressions = current?.all?.summary_metrics?.IMPRESSION ?? 0;
		const curEngagement = current?.all?.summary_metrics?.ENGAGEMENT ?? 0;
		const curPinClicks = current?.all?.summary_metrics?.PIN_CLICK ?? 0;
		const curOutboundClicks = current?.all?.summary_metrics?.OUTBOUND_CLICK ?? 0;
		const curSaves = current?.all?.summary_metrics?.SAVE ?? 0;

		const prevImpressions = previous?.all?.summary_metrics?.IMPRESSION ?? 0;
		const prevEngagement = previous?.all?.summary_metrics?.ENGAGEMENT ?? 0;

		const engagementRate =
			curImpressions > 0
				? Math.round((curEngagement / curImpressions) * 10000) / 100
				: null;

		return {
			followers: null,
			follower_change: null,
			impressions: curImpressions || null,
			impression_change: pctChange(curImpressions, prevImpressions),
			engagement: curEngagement || null,
			engagement_change: pctChange(curEngagement, prevEngagement),
			engagement_rate: engagementRate,
			posts_count: null,
			reach: curImpressions || null,
			reach_change: pctChange(curImpressions, prevImpressions),
			platform_specific: {
				pin_clicks: curPinClicks,
				outbound_clicks: curOutboundClicks,
				saves: curSaves,
			},
		};
	},

	async getPostMetrics(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
		limit = 25,
	): Promise<PlatformPostMetrics[]> {
		try {
			const topPins = await pinterestFetch<PinterestTopPinsResponse>(
				`/user_account/analytics/top_pins?start_date=${dateRange.from}&end_date=${dateRange.to}&sort_by=IMPRESSION&from_claimed_content=BOTH&metric_types=IMPRESSION,ENGAGEMENT,PIN_CLICK,OUTBOUND_CLICK,SAVE`,
				accessToken,
			);

			const pins = topPins?.pins ?? [];
			if (pins.length === 0) return [];

			const results: PlatformPostMetrics[] = [];

			for (const pin of pins.slice(0, limit)) {
				const pinData = await pinterestFetch<PinterestPinResponse>(
					`/pins/${pin.pin_id}`,
					accessToken,
				);

				const impressions = pin.metrics?.IMPRESSION ?? 0;
				const engagement = pin.metrics?.ENGAGEMENT ?? 0;
				const pinClicks = pin.metrics?.PIN_CLICK ?? 0;
				const outboundClicks = pin.metrics?.OUTBOUND_CLICK ?? 0;
				const saves = pin.metrics?.SAVE ?? 0;
				const engagementRate = impressions > 0 ? (engagement / impressions) * 100 : 0;

				const imageUrl =
					pinData?.media?.images?.["600x"]?.url ??
					pinData?.media?.images?.["400x300"]?.url ??
					null;

				results.push({
					platform_post_id: pin.pin_id,
					content: pinData?.title ?? pinData?.description ?? null,
					published_at: pinData?.created_at ?? "",
					media_url: imageUrl,
					media_type: pinData?.media?.media_type ?? null,
					impressions,
					reach: impressions,
					likes: 0,
					comments: 0,
					shares: 0,
					saves,
					clicks: pinClicks + outboundClicks,
					engagement_rate: engagementRate,
					platform_url: pinData ? `https://www.pinterest.com/pin/${pin.pin_id}/` : null,
				});
			}

			return results;
		} catch (err) {
			console.error("[pinterest-analytics] getPostMetrics error:", err);
			return [];
		}
	},

	async getAudience(
		_accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		return null;
	},

	async getDailyMetrics(
		accessToken: string,
		_platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		try {
			const data = await pinterestFetch<PinterestAnalyticsResponse>(
				`/user_account/analytics?start_date=${dateRange.from}&end_date=${dateRange.to}&metric_types=IMPRESSION,ENGAGEMENT`,
				accessToken,
			);

			const dailyMetrics = data?.all?.daily_metrics ?? [];
			if (dailyMetrics.length === 0) return [];

			return dailyMetrics.map((day) => ({
				date: day.date,
				impressions: day.metrics?.IMPRESSION ?? 0,
				engagement: day.metrics?.ENGAGEMENT ?? 0,
				reach: day.metrics?.IMPRESSION ?? 0,
				followers: 0,
			}));
		} catch (err) {
			console.error("[pinterest-analytics] getDailyMetrics error:", err);
			return [];
		}
	},
};
