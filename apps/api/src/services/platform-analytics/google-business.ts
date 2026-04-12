import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const BASE_URL = "https://businessprofileperformance.googleapis.com/v1";

const DAILY_METRICS = [
	"BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
	"BUSINESS_IMPRESSIONS_MOBILE_MAPS",
	"BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
	"BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
	"CALL_CLICKS",
	"WEBSITE_CLICKS",
	"BUSINESS_DIRECTION_REQUESTS",
] as const;

const IMPRESSION_METRICS = [
	"BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
	"BUSINESS_IMPRESSIONS_MOBILE_MAPS",
	"BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
	"BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
] as const;

const ENGAGEMENT_METRICS = [
	"CALL_CLICKS",
	"WEBSITE_CLICKS",
	"BUSINESS_DIRECTION_REQUESTS",
] as const;

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

function normalizeLocationId(platformAccountId: string): string {
	if (platformAccountId.startsWith("locations/")) return platformAccountId;
	return `locations/${platformAccountId}`;
}

function parseDateStr(dateStr: string): { year: number; month: number; day: number } {
	const d = new Date(`${dateStr}T00:00:00Z`);
	return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

interface GBPDate {
	year: number;
	month: number;
	day: number;
}

interface GBPTimeSeries {
	dailyMetric: string;
	timeSeries?: {
		datedValues?: Array<{
			date: GBPDate;
			value?: string;
		}>;
	};
}

interface GBPMultiDailyResponse {
	multiDailyMetricTimeSeries?: GBPTimeSeries[];
}

function buildFetchUrl(locationId: string, dateRange: DateRange): string {
	const from = parseDateStr(dateRange.from);
	const to = parseDateStr(dateRange.to);

	const params = new URLSearchParams();
	for (const metric of DAILY_METRICS) {
		params.append("dailyMetrics", metric);
	}
	params.set("dailyRange.startDate.year", String(from.year));
	params.set("dailyRange.startDate.month", String(from.month));
	params.set("dailyRange.startDate.day", String(from.day));
	params.set("dailyRange.endDate.year", String(to.year));
	params.set("dailyRange.endDate.month", String(to.month));
	params.set("dailyRange.endDate.day", String(to.day));

	return `${BASE_URL}/${locationId}:fetchMultiDailyMetricsTimeSeries?${params.toString()}`;
}

async function fetchMetrics(
	accessToken: string,
	locationId: string,
	dateRange: DateRange,
): Promise<GBPMultiDailyResponse | null> {
	const url = buildFetchUrl(locationId, dateRange);

	try {
		const res = await fetch(url, { headers: authHeaders(accessToken) });
		if (!res.ok) {
			console.error(
				`[google-business-analytics] API error ${res.status}: ${await res.text()}`,
			);
			return null;
		}
		return (await res.json()) as GBPMultiDailyResponse;
	} catch (err) {
		console.error("[google-business-analytics] Fetch error:", err);
		return null;
	}
}

function sumMetricFromTimeSeries(
	data: GBPMultiDailyResponse | null,
	metricNames: readonly string[],
): number {
	if (!data?.multiDailyMetricTimeSeries) return 0;

	let total = 0;
	for (const ts of data.multiDailyMetricTimeSeries) {
		if (!metricNames.includes(ts.dailyMetric)) continue;
		for (const dv of ts.timeSeries?.datedValues ?? []) {
			total += Number.parseInt(dv.value ?? "0", 10) || 0;
		}
	}
	return total;
}

function dateToString(d: GBPDate): string {
	return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export const googleBusinessAnalytics: PlatformAnalyticsFetcher = {
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		const locationId = normalizeLocationId(platformAccountId);

		const [current, previous] = await Promise.all([
			fetchMetrics(accessToken, locationId, dateRange),
			fetchMetrics(accessToken, locationId, previousPeriod(dateRange)),
		]);

		const curImpressions = sumMetricFromTimeSeries(current, IMPRESSION_METRICS);
		const curEngagement = sumMetricFromTimeSeries(current, ENGAGEMENT_METRICS);
		const curCallClicks = sumMetricFromTimeSeries(current, ["CALL_CLICKS"]);
		const curWebClicks = sumMetricFromTimeSeries(current, ["WEBSITE_CLICKS"]);
		const curDirections = sumMetricFromTimeSeries(current, ["BUSINESS_DIRECTION_REQUESTS"]);

		const prevImpressions = sumMetricFromTimeSeries(previous, IMPRESSION_METRICS);
		const prevEngagement = sumMetricFromTimeSeries(previous, ENGAGEMENT_METRICS);

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
				call_clicks: curCallClicks,
				website_clicks: curWebClicks,
				direction_requests: curDirections,
				maps_impressions: sumMetricFromTimeSeries(current, [
					"BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
					"BUSINESS_IMPRESSIONS_MOBILE_MAPS",
				]),
				search_impressions: sumMetricFromTimeSeries(current, [
					"BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
					"BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
				]),
			},
		};
	},

	async getPostMetrics(
		_accessToken: string,
		_platformAccountId: string,
		_dateRange: DateRange,
		_limit?: number,
	): Promise<PlatformPostMetrics[]> {
		return [];
	},

	async getAudience(
		_accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		return null;
	},

	async getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		const locationId = normalizeLocationId(platformAccountId);
		const data = await fetchMetrics(accessToken, locationId, dateRange);

		if (!data?.multiDailyMetricTimeSeries) return [];

		const dailyMap = new Map<string, { impressions: number; engagement: number }>();

		for (const ts of data.multiDailyMetricTimeSeries) {
			const isImpression = (IMPRESSION_METRICS as readonly string[]).includes(ts.dailyMetric);
			const isEngagement = (ENGAGEMENT_METRICS as readonly string[]).includes(ts.dailyMetric);

			for (const dv of ts.timeSeries?.datedValues ?? []) {
				const date = dateToString(dv.date);
				const value = Number.parseInt(dv.value ?? "0", 10) || 0;

				const existing = dailyMap.get(date) || { impressions: 0, engagement: 0 };
				if (isImpression) existing.impressions += value;
				if (isEngagement) existing.engagement += value;
				dailyMap.set(date, existing);
			}
		}

		return Array.from(dailyMap.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, vals]) => ({
				date,
				impressions: vals.impressions,
				engagement: vals.engagement,
				reach: vals.impressions,
				followers: 0,
			}));
	},
};
