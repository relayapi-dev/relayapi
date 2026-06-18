// ---------------------------------------------------------------------------
// YouTube Channel Videos Fetcher
// Docs: https://developers.google.com/youtube/v3/docs/search/list
//       https://developers.google.com/youtube/v3/docs/videos/list
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const BASE = "https://www.googleapis.com/youtube/v3";
const DEFAULT_LIMIT = 25;

interface YouTubeThumbnails {
	high?: { url?: string };
	medium?: { url?: string };
	default?: { url?: string };
}

interface YouTubeSnippet {
	title?: string;
	description?: string;
	channelTitle?: string;
	tags?: string[];
	publishedAt?: string;
	thumbnails?: YouTubeThumbnails;
}

interface YouTubeStatistics {
	viewCount?: string | number;
	likeCount?: string | number;
	commentCount?: string | number;
}

interface YouTubeSearchItem {
	id?: { videoId?: string } | string;
	snippet?: YouTubeSnippet;
}

interface YouTubeVideoItem {
	id: string;
	statistics?: YouTubeStatistics;
}

interface YouTubeSearchResponse {
	items?: YouTubeSearchItem[];
	nextPageToken?: string;
}

interface YouTubeVideosResponse {
	items?: YouTubeVideoItem[];
}

async function ytFetch<T = unknown>(
	url: string,
	accessToken: string,
): Promise<{ data: T; headers: Headers }> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (res.status === 429 || res.status === 403) {
		const rl = parseRateLimitHeaders(res.headers);
		throw new RateLimitError(
			rl?.resetAt ?? new Date(Date.now() + 86400_000),
			rl?.remaining ?? 0,
			`YouTube API ${res.status}`,
		);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`YouTube API ${res.status}: ${body}`);
	}
	return { data: (await res.json()) as T, headers: res.headers };
}

function parseVideo(
	item: YouTubeSearchItem,
	stats?: YouTubeStatistics,
): ExternalPostData {
	const snippet = item.snippet ?? {};
	const videoId =
		(typeof item.id === "string" ? item.id : item.id?.videoId) ?? "";
	const thumbnails = snippet.thumbnails ?? {};
	const thumbnailUrl =
		thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url ?? null;

	const s = stats ?? {};

	return {
		platformPostId: videoId,
		platformUrl: `https://www.youtube.com/watch?v=${videoId}`,
		content: snippet.title ?? null,
		mediaUrls: thumbnailUrl ? [thumbnailUrl] : [],
		mediaType: "video",
		thumbnailUrl,
		publishedAt: snippet.publishedAt
			? new Date(snippet.publishedAt)
			: new Date(),
		platformData: {
			description: snippet.description,
			channelTitle: snippet.channelTitle,
			tags: snippet.tags,
		},
		metrics: {
			views: Number(s.viewCount ?? 0),
			likes: Number(s.likeCount ?? 0),
			comments: Number(s.commentCount ?? 0),
		},
	};
}

export const youtubePostFetcher: ExternalPostFetcher = {
	platform: "youtube",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 50);
		let url = `${BASE}/search?channelId=${platformAccountId}&type=video&order=date&part=snippet&maxResults=${limit}`;

		if (options.cursor) {
			url += `&pageToken=${options.cursor}`;
		}
		if (options.since) {
			url += `&publishedAfter=${options.since.toISOString()}`;
		}

		const { data: searchJson, headers } = await ytFetch<YouTubeSearchResponse>(
			url,
			accessToken,
		);
		const items = searchJson.items ?? [];

		const getVideoId = (item: YouTubeSearchItem): string | undefined =>
			typeof item.id === "string" ? item.id : item.id?.videoId;

		if (items.length === 0) {
			return {
				posts: [],
				nextCursor: null,
				hasMore: false,
				rateLimit: parseRateLimitHeaders(headers) ?? undefined,
			};
		}

		// Batch-fetch video statistics
		const videoIds = items
			.map(getVideoId)
			.filter((id): id is string => Boolean(id));
		const statsMap: Record<string, YouTubeStatistics | undefined> = {};

		if (videoIds.length > 0) {
			const { data: videosJson } = await ytFetch<YouTubeVideosResponse>(
				`${BASE}/videos?id=${videoIds.join(",")}&part=statistics`,
				accessToken,
			);
			for (const v of videosJson.items ?? []) {
				statsMap[v.id] = v.statistics;
			}
		}

		const posts: ExternalPostData[] = items.map((item) => {
			const videoId = getVideoId(item);
			return parseVideo(item, videoId ? statsMap[videoId] : undefined);
		});

		const nextCursor = searchJson.nextPageToken ?? null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return { posts, nextCursor, hasMore: nextCursor != null, rateLimit };
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		// Batch up to 50 video IDs per request
		const ids = platformPostIds.slice(0, 50).join(",");
		try {
			const { data: json } = await ytFetch<YouTubeVideosResponse>(
				`${BASE}/videos?id=${ids}&part=statistics`,
				accessToken,
			);

			for (const v of json.items ?? []) {
				const s = v.statistics ?? {};
				metrics.set(v.id, {
					views: Number(s.viewCount ?? 0),
					likes: Number(s.likeCount ?? 0),
					comments: Number(s.commentCount ?? 0),
				});
			}
		} catch {
			// Batch failed
		}

		return metrics;
	},
};
