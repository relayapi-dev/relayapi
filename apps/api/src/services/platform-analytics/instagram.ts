import type {
	PlatformAnalyticsFetcher,
	PlatformOverview,
	PlatformPostMetrics,
	PlatformAudienceDemographics,
	DailyMetricPoint,
	DateRange,
} from "./types";

const API_VERSION = "v25.0";

function toUnix(dateStr: string): number {
	return Math.floor(new Date(`${dateStr}T00:00:00Z`).getTime() / 1000);
}

/** Compute the previous period of equal length ending the day before `from`. */
function getPreviousPeriod(range: DateRange): DateRange {
	const fromMs = new Date(`${range.from}T00:00:00Z`).getTime();
	const toMs = new Date(`${range.to}T00:00:00Z`).getTime();
	const durationMs = toMs - fromMs;
	const prevTo = new Date(fromMs - 86_400_000); // day before `from`
	const prevFrom = new Date(prevTo.getTime() - durationMs);
	return {
		from: prevFrom.toISOString().slice(0, 10),
		to: prevTo.toISOString().slice(0, 10),
	};
}

async function igFetch(
	graphHost: string,
	accessToken: string,
	path: string,
): Promise<any | null> {
	const separator = path.includes("?") ? "&" : "?";
	const url = `https://${graphHost}/${API_VERSION}${path}${separator}access_token=${accessToken}`;

	try {
		const res = await fetch(url);
		if (!res.ok) {
			const body = await res.text();
			console.error(
				`[instagram-analytics] API error ${res.status} for ${path}: ${body}`,
			);
			return null;
		}
		return await res.json();
	} catch (err) {
		console.error(`[instagram-analytics] Fetch failed for ${path}:`, err);
		return null;
	}
}

/**
 * Sum daily values from an Instagram Insights response for a given metric name.
 * The API returns `{ data: [{ name, values: [{ value, end_time }] }] }`.
 */
function sumMetric(
	insightsData: any[] | undefined,
	metricName: string,
): number {
	if (!insightsData) return 0;
	const metric = insightsData.find((m: any) => m.name === metricName);
	if (!metric?.values) return 0;
	return metric.values.reduce(
		(sum: number, v: any) => sum + (typeof v.value === "number" ? v.value : 0),
		0,
	);
}

/**
 * Extract a single total from a metric_type=total_value Insights response.
 * Response shape: `{ data: [{ name, total_value: { value: number } }] }`.
 */
function getTotalValue(
	insightsData: any[] | undefined,
	metricName: string,
): number {
	if (!insightsData) return 0;
	const metric = insightsData.find((m: any) => m.name === metricName);
	if (typeof metric?.total_value?.value === "number")
		return metric.total_value.value;
	return 0;
}

async function fetchInsightsSums(
	graphHost: string,
	accessToken: string,
	userId: string,
	range: DateRange,
): Promise<{ reach: number; totalInteractions: number }> {
	const since = toUnix(range.from);
	const until = toUnix(range.to);

	// reach supports time_series; total_interactions only supports total_value
	const [reachData, engData] = await Promise.all([
		igFetch(
			graphHost,
			accessToken,
			`/${userId}/insights?metric=reach&period=day&metric_type=time_series&since=${since}&until=${until}`,
		),
		igFetch(
			graphHost,
			accessToken,
			`/${userId}/insights?metric=total_interactions&period=day&metric_type=total_value&since=${since}&until=${until}`,
		),
	]);

	return {
		reach: sumMetric(reachData?.data ?? [], "reach"),
		totalInteractions: getTotalValue(engData?.data ?? [], "total_interactions"),
	};
}

export function createInstagramAnalytics(
	graphHost = "graph.instagram.com",
): PlatformAnalyticsFetcher {
	return {
		// -----------------------------------------------------------------
		// getOverview
		// -----------------------------------------------------------------
		async getOverview(
			accessToken: string,
			platformAccountId: string,
			dateRange: DateRange,
		): Promise<PlatformOverview> {
			const emptyOverview: PlatformOverview = {
				followers: null,
				follower_change: null,
				impressions: null,
				impression_change: null,
				engagement: null,
				engagement_change: null,
				engagement_rate: null,
				posts_count: null,
				reach: null,
				reach_change: null,
				platform_specific: {},
			};

			try {
				const since = toUnix(dateRange.from);
				const until = toUnix(dateRange.to);

				// Current period insights — split by metric_type
				// reach supports time_series; engagement metrics only support total_value
				const [timeSeriesData, totalValueData] = await Promise.all([
					igFetch(
						graphHost,
						accessToken,
						`/${platformAccountId}/insights?metric=reach&period=day&metric_type=time_series&since=${since}&until=${until}`,
					),
					igFetch(
						graphHost,
						accessToken,
						`/${platformAccountId}/insights?metric=total_interactions,accounts_engaged,follows_and_unfollows&period=day&metric_type=total_value&since=${since}&until=${until}`,
					),
				]);

				const reach = sumMetric(timeSeriesData?.data ?? [], "reach");
				const totalInteractions = getTotalValue(totalValueData?.data ?? [], "total_interactions");
				const accountsEngaged = getTotalValue(totalValueData?.data ?? [], "accounts_engaged");
				const followsAndUnfollows = getTotalValue(
					totalValueData?.data ?? [],
					"follows_and_unfollows",
				);

				// Follower count
				const profileData = await igFetch(
					graphHost,
					accessToken,
					`/${platformAccountId}?fields=followers_count`,
				);
				const followers: number | null =
					profileData?.followers_count ?? null;

				// Previous period for % changes
				const prevRange = getPreviousPeriod(dateRange);
				const prev = await fetchInsightsSums(
					graphHost,
					accessToken,
					platformAccountId,
					prevRange,
				);

				const reachChange =
					prev.reach > 0
						? ((reach - prev.reach) / prev.reach) * 100
						: null;
				const engagementChange =
					prev.totalInteractions > 0
						? ((totalInteractions - prev.totalInteractions) /
								prev.totalInteractions) *
							100
						: null;

				const engagementRate =
					reach > 0 ? (totalInteractions / reach) * 100 : null;

				return {
					followers,
					follower_change: followsAndUnfollows || null,
					impressions: reach, // IG Insights v18+ uses reach as the primary metric
					impression_change: reachChange,
					engagement: totalInteractions,
					engagement_change: engagementChange,
					engagement_rate: engagementRate,
					posts_count: null,
					reach,
					reach_change: reachChange,
					platform_specific: {
						accounts_engaged: accountsEngaged,
						follows_and_unfollows: followsAndUnfollows,
					},
				};
			} catch (err) {
				console.error("[instagram-analytics] getOverview failed:", err);
				return emptyOverview;
			}
		},

		// -----------------------------------------------------------------
		// getPostMetrics
		// -----------------------------------------------------------------
		async getPostMetrics(
			accessToken: string,
			platformAccountId: string,
			dateRange: DateRange,
			limit = 20,
		): Promise<PlatformPostMetrics[]> {
			try {
				// Don't rely on since/until for IG /media edge — it can be
				// unreliable on newer Graph API versions. Fetch recent media
				// and filter client-side by timestamp (same approach as Facebook).
				const mediaData = await igFetch(
					graphHost,
					accessToken,
					`/${platformAccountId}/media?fields=id,caption,timestamp,media_type,media_url,thumbnail_url,permalink&limit=${limit}`,
				);

				const allItems: any[] = mediaData?.data ?? [];
				if (allItems.length === 0) return [];

				const fromTs = toUnix(dateRange.from);
				const untilTs = toUnix(dateRange.to) + 86400; // include entire "to" day
				const mediaItems = allItems.filter((item: any) => {
					const ts = Math.floor(new Date(item.timestamp).getTime() / 1000);
					return ts >= fromTs && ts < untilTs;
				});

				const results: PlatformPostMetrics[] = [];

				for (const item of mediaItems) {
					const insightsData = await igFetch(
						graphHost,
						accessToken,
						`/${item.id}/insights?metric=reach,likes,comments,shares,saved,views,total_interactions`,
					);

					const metrics: any[] = insightsData?.data ?? [];
					const getValue = (name: string): number => {
						const m = metrics.find((x: any) => x.name === name);
						// Media insights return a single value, not an array
						if (m?.values?.[0]?.value != null) return m.values[0].value;
						if (typeof m?.total_value?.value === "number")
							return m.total_value.value;
						return 0;
					};

					const postReach = getValue("reach");
					const likes = getValue("likes");
					const comments = getValue("comments");
					const shares = getValue("shares");
					const saved = getValue("saved");
					const views = getValue("views");
					const totalInteractions = getValue("total_interactions");

					const engagementRate =
						postReach > 0
							? (totalInteractions / postReach) * 100
							: 0;

					// Use thumbnail_url for video types, otherwise media_url
					const isVideo =
						item.media_type === "VIDEO" ||
						item.media_type === "REELS";
					const mediaUrl = isVideo
						? (item.thumbnail_url ?? item.media_url ?? null)
						: (item.media_url ?? null);

					results.push({
						platform_post_id: item.id,
						content: item.caption ?? null,
						published_at: item.timestamp,
						media_url: mediaUrl,
						media_type: item.media_type ?? null,
						impressions: postReach, // IG uses reach
						reach: postReach,
						likes,
						comments,
						shares,
						saves: saved,
						clicks: 0, // Not available in IG media insights
						engagement_rate: engagementRate,
						platform_url: item.permalink ?? null,
					});
				}

				return results;
			} catch (err) {
				console.error(
					"[instagram-analytics] getPostMetrics failed:",
					err,
				);
				return [];
			}
		},

		// -----------------------------------------------------------------
		// getAudience
		// -----------------------------------------------------------------
		async getAudience(
			accessToken: string,
			platformAccountId: string,
		): Promise<PlatformAudienceDemographics | null> {
			try {
				// Fetch all three breakdowns in parallel
				const [cityData, countryData, ageGenderData] =
					await Promise.all([
						igFetch(
							graphHost,
							accessToken,
							`/${platformAccountId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=city`,
						),
						igFetch(
							graphHost,
							accessToken,
							`/${platformAccountId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=country`,
						),
						igFetch(
							graphHost,
							accessToken,
							`/${platformAccountId}/insights?metric=follower_demographics&period=lifetime&metric_type=total_value&breakdown=age,gender`,
						),
					]);

				// --- Cities ---
				const cityBreakdown: Record<string, number> =
					cityData?.data?.[0]?.total_value?.breakdowns?.[0]
						?.results?.reduce(
							(acc: Record<string, number>, r: any) => {
								const name =
									r.dimension_values?.[0] ?? "Unknown";
								acc[name] = r.value ?? 0;
								return acc;
							},
							{},
						) ?? {};

				const topCities = Object.entries(cityBreakdown)
					.map(([name, count]) => ({ name, count }))
					.sort((a, b) => b.count - a.count)
					.slice(0, 20);

				// --- Countries ---
				const countryBreakdown: Record<string, number> =
					countryData?.data?.[0]?.total_value?.breakdowns?.[0]
						?.results?.reduce(
							(acc: Record<string, number>, r: any) => {
								const code =
									r.dimension_values?.[0] ?? "XX";
								acc[code] = r.value ?? 0;
								return acc;
							},
							{},
						) ?? {};

				const topCountries = Object.entries(countryBreakdown)
					.map(([code, count]) => ({ code, name: code, count }))
					.sort((a, b) => b.count - a.count)
					.slice(0, 20);

				// --- Age + Gender ---
				const ageGenderMap: Record<
					string,
					{ male: number; female: number; other: number }
				> = {};

				const ageGenderResults =
					ageGenderData?.data?.[0]?.total_value?.breakdowns?.[0]
						?.results ?? [];

				for (const r of ageGenderResults) {
					// dimension_values: ["age_range", "gender"] e.g. ["25-34", "M"]
					const ageRange = r.dimension_values?.[0] ?? "unknown";
					const gender = (
						r.dimension_values?.[1] ?? ""
					).toUpperCase();
					const value: number = r.value ?? 0;

					if (!ageGenderMap[ageRange]) {
						ageGenderMap[ageRange] = {
							male: 0,
							female: 0,
							other: 0,
						};
					}

					if (gender === "M" || gender === "MALE") {
						ageGenderMap[ageRange].male += value;
					} else if (gender === "F" || gender === "FEMALE") {
						ageGenderMap[ageRange].female += value;
					} else {
						ageGenderMap[ageRange].other += value;
					}
				}

				const ageGender = Object.entries(ageGenderMap)
					.map(([age_range, counts]) => ({
						age_range,
						...counts,
					}))
					.sort(
						(a, b) =>
							b.male +
							b.female +
							b.other -
							(a.male + a.female + a.other),
					)
					.slice(0, 20);

				return {
					top_cities: topCities,
					top_countries: topCountries,
					age_gender: ageGender,
				};
			} catch (err) {
				console.error(
					"[instagram-analytics] getAudience failed:",
					err,
				);
				return null;
			}
		},

		// -----------------------------------------------------------------
		// getDailyMetrics
		// -----------------------------------------------------------------
		async getDailyMetrics(
			accessToken: string,
			platformAccountId: string,
			dateRange: DateRange,
		): Promise<DailyMetricPoint[]> {
			try {
				const since = toUnix(dateRange.from);
				const until = toUnix(dateRange.to);

				// reach supports time_series; total_interactions only supports total_value
				const [reachData, engagementData] = await Promise.all([
					igFetch(
						graphHost,
						accessToken,
						`/${platformAccountId}/insights?metric=reach&period=day&metric_type=time_series&since=${since}&until=${until}`,
					),
					igFetch(
						graphHost,
						accessToken,
						`/${platformAccountId}/insights?metric=total_interactions&period=day&metric_type=total_value&since=${since}&until=${until}`,
					),
				]);

				const reachMetric = (reachData?.data ?? []).find(
					(m: any) => m.name === "reach",
				);
				const reachValues: any[] = reachMetric?.values ?? [];
				if (reachValues.length === 0) return [];

				const totalEngagement = getTotalValue(
					engagementData?.data ?? [],
					"total_interactions",
				);
				const totalReach = reachValues.reduce(
					(s: number, v: any) => s + (v.value ?? 0),
					0,
				);

				return reachValues
					.map((v: any) => {
						const date = v.end_time?.slice(0, 10) ?? "";
						if (!date) return null;
						const dailyReach = v.value ?? 0;
						// Distribute total engagement proportionally by daily reach
						const dailyEngagement =
							totalReach > 0
								? Math.round(
										totalEngagement * (dailyReach / totalReach),
									)
								: 0;
						return {
							date,
							impressions: dailyReach,
							engagement: dailyEngagement,
							reach: dailyReach,
							followers: 0,
						};
					})
					.filter((p): p is DailyMetricPoint => p !== null)
					.sort((a, b) => a.date.localeCompare(b.date));
			} catch (err) {
				console.error(
					"[instagram-analytics] getDailyMetrics failed:",
					err,
				);
				return [];
			}
		},
	};
}
