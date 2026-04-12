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

async function ytFetch(
	url: string,
	accessToken: string,
): Promise<{ data: any; headers: Headers }> {
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
	return { data: await res.json(), headers: res.headers };
}

function parseVideo(
	item: any,
	stats?: Record<string, any>,
): ExternalPostData {
	const snippet = item.snippet ?? {};
	const videoId = typeof item.id === "string" ? item.id : item.id?.videoId;
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
		publishedAt: new Date(snippet.publishedAt),
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

		const { data: searchJson, headers } = await ytFetch(url, accessToken);
		const items = searchJson.items ?? [];

		if (items.length === 0) {
			return {
				posts: [],
				nextCursor: null,
				hasMore: false,
				rateLimit: parseRateLimitHeaders(headers) ?? undefined,
			};
		}

		// Batch-fetch video statistics
		const videoIds = items.map((i: any) => i.id?.videoId).filter(Boolean);
		let statsMap: Record<string, any> = {};

		if (videoIds.length > 0) {
			const { data: videosJson } = await ytFetch(
				`${BASE}/videos?id=${videoIds.join(",")}&part=statistics`,
				accessToken,
			);
			for (const v of videosJson.items ?? []) {
				statsMap[v.id] = v.statistics;
			}
		}

		const posts: ExternalPostData[] = items.map((item: any) => {
			const videoId = item.id?.videoId;
			return parseVideo(item, statsMap[videoId]);
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
			const { data: json } = await ytFetch(
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
