import {
	PlatformAnalyticsError,
	type PlatformAnalyticsFetcher,
	type PlatformOverview,
	type PlatformPostMetrics,
	type PlatformAudienceDemographics,
	type DailyMetricPoint,
	type DateRange,
} from "./types";

const WA_API_BASE = "https://graph.facebook.com/v25.0";

// ---------------------------------------------------------------------------
// Helper: classify WhatsApp/Meta Graph API error into PlatformAnalyticsError
// ---------------------------------------------------------------------------
function classifyWaError(
	status: number,
	fbCode: number | undefined,
	fbSubcode: number | undefined,
	message: string,
): PlatformAnalyticsError {
	if (fbCode === 190 || status === 401) {
		return new PlatformAnalyticsError(
			"WhatsApp access token has expired or been revoked. Please reconnect the account.",
			"TOKEN_EXPIRED",
		);
	}
	if (status === 403 || fbCode === 200 || fbSubcode === 33) {
		return new PlatformAnalyticsError(
			"Missing required WhatsApp Business permissions. Please reconnect the account.",
			"MISSING_PERMISSIONS",
		);
	}
	return new PlatformAnalyticsError(
		`WhatsApp API error: ${message}`,
		"API_ERROR",
	);
}

// ---------------------------------------------------------------------------
// Helper: authenticated GET against the WhatsApp Business / Graph API
// ---------------------------------------------------------------------------
async function waFetch<T = unknown>(
	path: string,
	accessToken: string,
	params: Record<string, string> = {},
): Promise<T> {
	const url = new URL(`${WA_API_BASE}${path}`);
	url.searchParams.set("access_token", accessToken);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	try {
		const res = await fetch(url.toString());
		if (!res.ok) {
			const errorBody = await res.text();
			console.error(
				`[whatsapp-analytics] API error ${res.status} for ${path}: ${errorBody}`,
			);
			let fbError:
				| { message?: string; code?: number; error_subcode?: number }
				| undefined;
			try {
				const parsed = JSON.parse(errorBody);
				fbError = parsed?.error;
			} catch {
				/* not JSON */
			}
			throw classifyWaError(
				res.status,
				fbError?.code,
				fbError?.error_subcode,
				fbError?.message ?? `HTTP ${res.status}`,
			);
		}
		return (await res.json()) as T;
	} catch (err) {
		if (err instanceof PlatformAnalyticsError) throw err;
		console.error(`[whatsapp-analytics] Network error for ${path}:`, err);
		throw new PlatformAnalyticsError(
			"Failed to reach WhatsApp API. Please try again later.",
			"API_ERROR",
		);
	}
}

// ---------------------------------------------------------------------------
// Graph API response shapes for WABA conversation analytics
// ---------------------------------------------------------------------------
interface WabaAnalyticsDataPoint {
	start: number;
	end: number;
	sent: number;
	delivered: number;
}

interface WabaAnalyticsResponse {
	analytics?: {
		phone_numbers?: string[];
		data_points?: WabaAnalyticsDataPoint[];
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert YYYY-MM-DD to unix seconds */
function toUnix(dateStr: string): number {
	return Math.floor(new Date(dateStr).getTime() / 1000);
}

/** Calculate percentage change between two values */
function pctChange(current: number, previous: number): number | null {
	if (previous === 0) return current > 0 ? 100 : null;
	return Math.round(((current - previous) / previous) * 10000) / 100;
}

/** Compute the previous period DateRange of equal length */
function previousPeriod(dateRange: DateRange): DateRange {
	const from = new Date(dateRange.from);
	const to = new Date(dateRange.to);
	const durationMs = to.getTime() - from.getTime();
	const prevTo = new Date(from.getTime());
	const prevFrom = new Date(from.getTime() - durationMs);
	return {
		from: prevFrom.toISOString().slice(0, 10),
		to: prevTo.toISOString().slice(0, 10),
	};
}

/**
 * Fetch WABA conversation analytics for a given date range.
 *
 * The platformAccountId for WhatsApp is expected to be the WABA ID.
 *
 * WABA Analytics endpoint:
 * GET https://graph.facebook.com/v25.0/{waba_id}?fields=analytics.start({start_unix}).end({end_unix}).granularity(DAY)
 * https://developers.facebook.com/docs/whatsapp/business-management-api/analytics
 */
async function fetchConversationAnalytics(
	accessToken: string,
	wabaId: string,
	dateRange: DateRange,
): Promise<WabaAnalyticsDataPoint[]> {
	const startUnix = toUnix(dateRange.from);
	const endUnix = toUnix(dateRange.to) + 86400; // include the entire "to" day

	const data = await waFetch<WabaAnalyticsResponse>(
		`/${wabaId}`,
		accessToken,
		{
			fields: `analytics.start(${startUnix}).end(${endUnix}).granularity(DAY)`,
		},
	);

	return data.analytics?.data_points ?? [];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const whatsappAnalytics: PlatformAnalyticsFetcher = {
	// -----------------------------------------------------------------------
	// getOverview
	// -----------------------------------------------------------------------
	async getOverview(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<PlatformOverview> {
		// Fetch current period
		const currentPoints = await fetchConversationAnalytics(
			accessToken,
			platformAccountId,
			dateRange,
		);

		// Fetch previous period (same length) -- non-critical, don't throw
		const prev = previousPeriod(dateRange);
		let previousPoints: WabaAnalyticsDataPoint[] = [];
		try {
			previousPoints = await fetchConversationAnalytics(
				accessToken,
				platformAccountId,
				prev,
			);
		} catch {
			/* previous period is best-effort */
		}

		const curSent = currentPoints.reduce((sum, p) => sum + (p.sent ?? 0), 0);
		const curDelivered = currentPoints.reduce(
			(sum, p) => sum + (p.delivered ?? 0),
			0,
		);
		const deliveryRate =
			curSent > 0
				? Math.round((curDelivered / curSent) * 10000) / 100
				: null;

		const prevSent = previousPoints.reduce(
			(sum, p) => sum + (p.sent ?? 0),
			0,
		);
		const prevDelivered = previousPoints.reduce(
			(sum, p) => sum + (p.delivered ?? 0),
			0,
		);

		return {
			followers: null,
			follower_change: null,
			impressions: curSent || null,
			impression_change: pctChange(curSent, prevSent),
			engagement: curDelivered || null,
			engagement_change: pctChange(curDelivered, prevDelivered),
			engagement_rate: deliveryRate,
			posts_count: null,
			reach: curDelivered || null,
			reach_change: pctChange(curDelivered, prevDelivered),
			platform_specific: {
				messages_sent: curSent,
				messages_delivered: curDelivered,
				delivery_rate: deliveryRate,
			},
		};
	},

	// -----------------------------------------------------------------------
	// getPostMetrics
	// -----------------------------------------------------------------------
	async getPostMetrics(
		_accessToken: string,
		_platformAccountId: string,
		_dateRange: DateRange,
		_limit?: number,
	): Promise<PlatformPostMetrics[]> {
		// WhatsApp doesn't have "posts" -- broadcasts could be mapped here in the future
		return [];
	},

	// -----------------------------------------------------------------------
	// getAudience
	// -----------------------------------------------------------------------
	async getAudience(
		_accessToken: string,
		_platformAccountId: string,
	): Promise<PlatformAudienceDemographics | null> {
		// WhatsApp doesn't expose audience demographics via the WABA API
		return null;
	},

	// -----------------------------------------------------------------------
	// getDailyMetrics
	// -----------------------------------------------------------------------
	async getDailyMetrics(
		accessToken: string,
		platformAccountId: string,
		dateRange: DateRange,
	): Promise<DailyMetricPoint[]> {
		const points = await fetchConversationAnalytics(
			accessToken,
			platformAccountId,
			dateRange,
		);

		return points.map((point) => ({
			date: new Date(point.start * 1000).toISOString().split("T")[0]!,
			impressions: point.sent ?? 0,
			engagement: point.delivered ?? 0,
			reach: point.delivered ?? 0,
			followers: 0,
		}));
	},
};
