// ---------------------------------------------------------------------------
// TikTok Video List Fetcher
// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

// Docs: https://developers.tiktok.com/doc/content-posting-api-reference-get-video-list
// Endpoint: GET /v2/user/{user_id}/videos/
const BASE = "https://open.tiktokapis.com/v2";
const DEFAULT_LIMIT = 20;

const VIDEO_FIELDS = [
	"id",
	"create_time",
	"share_url",
	"cover_image_url",
	"video_description",
	"like_count",
	"comment_count",
	"share_count",
	"view_count",
	"duration",
].join(",");

async function ttFetch(
	url: string,
	accessToken: string,
): Promise<{ data: any; headers: Headers }> {
	const res = await fetch(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});
	if (res.status === 429) {
		const rl = parseRateLimitHeaders(res.headers);
		throw new RateLimitError(
			rl?.resetAt ?? new Date(Date.now() + 60_000),
			rl?.remaining ?? 0,
		);
	}
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`TikTok API ${res.status}: ${text}`);
	}
	return { data: await res.json(), headers: res.headers };
}

function parseVideo(raw: any): ExternalPostData {
	return {
		platformPostId: raw.id,
		platformUrl: raw.share_url ?? null,
		content: raw.video_description || null,
		mediaUrls: raw.cover_image_url ? [raw.cover_image_url] : [],
		mediaType: "video",
		thumbnailUrl: raw.cover_image_url ?? null,
		publishedAt: new Date(raw.create_time * 1000),
		platformData: { duration: raw.duration },
		metrics: {
			views: raw.view_count ?? 0,
			likes: raw.like_count ?? 0,
			comments: raw.comment_count ?? 0,
			shares: raw.share_count ?? 0,
		},
	};
}

export const tiktokPostFetcher: ExternalPostFetcher = {
	platform: "tiktok",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 20);

		let url = `${BASE}/user/${platformAccountId}/videos/?fields=${VIDEO_FIELDS}&max_count=${limit}`;
		if (options.cursor) {
			url += `&cursor=${options.cursor}`;
		}

		const { data: json, headers } = await ttFetch(url, accessToken);

		const videoData = json.data ?? {};
		const videos = videoData.videos ?? [];

		const posts: ExternalPostData[] = videos.map(parseVideo);

		// Filter by since if provided (TikTok doesn't support since param natively)
		const filtered = options.since
			? posts.filter((p) => p.publishedAt >= options.since!)
			: posts;

		const nextCursor = videoData.cursor != null ? String(videoData.cursor) : null;
		const hasMore = videoData.has_more === true;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return {
			posts: filtered,
			nextCursor: hasMore ? nextCursor : null,
			hasMore: hasMore && filtered.length === posts.length,
			rateLimit,
		};
	},

	async fetchPostMetrics(accessToken, platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		// TikTok: re-fetch video list and match by ID (no batch metrics endpoint)
		try {
			const { data: json } = await ttFetch(
				`${BASE}/user/${platformAccountId}/videos/?fields=${VIDEO_FIELDS}&max_count=20`,
				accessToken,
			);

			const idsSet = new Set(platformPostIds);
			for (const video of json.data?.videos ?? []) {
				if (idsSet.has(video.id)) {
					metrics.set(video.id, {
						views: video.view_count ?? 0,
						likes: video.like_count ?? 0,
						comments: video.comment_count ?? 0,
						shares: video.share_count ?? 0,
					});
				}
			}
		} catch {
			// Batch failed
		}

		return metrics;
	},
};
