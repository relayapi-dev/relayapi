// ---------------------------------------------------------------------------
// Instagram Business/Creator Posts Fetcher
// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
	FetchPostsResult,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const API_VERSION = "v25.0";
const BASE = `https://graph.instagram.com/${API_VERSION}`;
const DEFAULT_LIMIT = 25;

const MEDIA_FIELDS = [
	"id",
	"caption",
	"timestamp",
	"media_url",
	"thumbnail_url",
	"permalink",
	"media_type",
	"children{media_url,media_type,thumbnail_url}",
].join(",");

async function igFetch(
	url: string,
	accessToken: string,
): Promise<{ data: any; headers: Headers }> {
	const sep = url.includes("?") ? "&" : "?";
	const res = await fetch(`${url}${sep}access_token=${accessToken}`);
	if (res.status === 429) {
		const rl = parseRateLimitHeaders(res.headers);
		throw new RateLimitError(
			rl?.resetAt ?? new Date(Date.now() + 3600_000),
			rl?.remaining ?? 0,
		);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Instagram API ${res.status}: ${body}`);
	}
	return { data: await res.json(), headers: res.headers };
}

function parseMediaType(raw: string | undefined): string | null {
	switch (raw) {
		case "IMAGE":
			return "image";
		case "VIDEO":
			return "video";
		case "CAROUSEL_ALBUM":
			return "carousel";
		case "REELS":
			return "reel";
		case "STORIES":
			return "story";
		default:
			return raw?.toLowerCase() ?? null;
	}
}

function parsePost(raw: any): ExternalPostData {
	const mediaUrls: string[] = [];
	const mediaType = parseMediaType(raw.media_type);

	if (raw.children?.data) {
		for (const child of raw.children.data) {
			if (child.media_url) mediaUrls.push(child.media_url);
		}
	} else if (raw.media_url) {
		mediaUrls.push(raw.media_url);
	}

	return {
		platformPostId: raw.id,
		platformUrl: raw.permalink ?? null,
		content: raw.caption ?? null,
		mediaUrls,
		mediaType,
		thumbnailUrl: raw.thumbnail_url ?? null,
		publishedAt: raw.timestamp ? new Date(raw.timestamp) : new Date(),
		platformData: { media_type: raw.media_type },
		metrics: {},
	};
}

export const instagramPostFetcher: ExternalPostFetcher = {
	platform: "instagram",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = options.limit ?? DEFAULT_LIMIT;
		let url: string;

		if (options.cursor) {
			url = options.cursor;
		} else {
			// Instagram /media endpoint does not support "since" — filtering is done client-side
			url = `${BASE}/${platformAccountId}/media?fields=${MEDIA_FIELDS}&limit=${limit}`;
		}

		const { data: json, headers } = await igFetch(url, accessToken);
		const posts: ExternalPostData[] = (json.data ?? []).map(parsePost);

		const nextCursor = json.paging?.next ?? null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return { posts, nextCursor, hasMore: nextCursor != null, rateLimit };
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		for (const postId of platformPostIds) {
			try {
				const { data: json } = await igFetch(
					`${BASE}/${postId}/insights?metric=impressions,reach,likes,comments,shares,saved`,
					accessToken,
				);

				const values: Record<string, number> = {};
				for (const m of json.data ?? []) {
					values[m.name] = m.values?.[0]?.value ?? 0;
				}

				metrics.set(postId, {
					impressions: values.impressions ?? 0,
					reach: values.reach ?? 0,
					likes: values.likes ?? 0,
					comments: values.comments ?? 0,
					shares: values.shares ?? 0,
					saves: values.saved ?? 0,
				});
			} catch {
				// Skip individual post metric failures
			}
		}

		return metrics;
	},
};
