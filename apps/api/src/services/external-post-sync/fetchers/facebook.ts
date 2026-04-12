// ---------------------------------------------------------------------------
// Facebook Page Posts Fetcher
// Docs: https://developers.facebook.com/docs/graph-api/reference/page/feed/
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
	FetchPostsResult,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const API_VERSION = "v25.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const DEFAULT_LIMIT = 25;

const POST_FIELDS = [
	"id",
	"message",
	"created_time",
	"full_picture",
	"permalink_url",
	"status_type",
	"attachments{media_type,unshimmed_url,title,description}",
].join(",");

async function fbFetch(
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
		throw new Error(`Facebook API ${res.status}: ${body}`);
	}
	return { data: await res.json(), headers: res.headers };
}

function parsePost(raw: any): ExternalPostData {
	const thumbnailUrl: string | null = raw.full_picture ?? null;
	const mediaUrls: string[] = thumbnailUrl ? [thumbnailUrl] : [];

	// Infer media type from attachments (replaces deprecated top-level `type` field)
	let mediaType: string | null = null;
	const attachment = raw.attachments?.data?.[0];
	const attachmentMediaType = attachment?.media_type?.toLowerCase();
	if (attachmentMediaType === "video") mediaType = "video";
	else if (attachmentMediaType === "photo" || attachmentMediaType === "image") mediaType = "image";
	else if (attachmentMediaType === "album") mediaType = "carousel";
	else if (raw.status_type === "added_video") mediaType = "video";
	else if (raw.status_type === "added_photos") mediaType = "image";
	else if (raw.full_picture) mediaType = "image";

	return {
		platformPostId: raw.id,
		platformUrl: raw.permalink_url ?? null,
		content: raw.message ?? null,
		mediaUrls,
		mediaType,
		thumbnailUrl,
		publishedAt: raw.created_time ? new Date(raw.created_time) : new Date(),
		platformData: { status_type: raw.status_type, media_type: attachmentMediaType },
		metrics: {},
	};
}

export const facebookPostFetcher: ExternalPostFetcher = {
	platform: "facebook",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = options.limit ?? DEFAULT_LIMIT;
		let url: string;

		if (options.cursor) {
			// Cursor is the full paging URL from Facebook
			url = options.cursor;
		} else {
			url = `${BASE}/${platformAccountId}/feed?fields=${POST_FIELDS}&limit=${limit}`;
			if (options.since) {
				url += `&since=${Math.floor(options.since.getTime() / 1000)}`;
			}
		}

		const { data: json, headers } = await fbFetch(url, accessToken);
		const posts: ExternalPostData[] = (json.data ?? []).map(parsePost);

		const nextCursor = json.paging?.next ?? null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return {
			posts,
			nextCursor,
			hasMore: nextCursor != null,
			rateLimit,
		};
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		// Facebook insights: batch up to 50 per request
		for (const postId of platformPostIds) {
			try {
				const { data: json } = await fbFetch(
					`${BASE}/${postId}/insights?metric=post_media_view,post_clicks,post_reactions_like_total`,
					accessToken,
				);

				const values: Record<string, number> = {};
				for (const m of json.data ?? []) {
					values[m.name] = m.values?.[0]?.value ?? 0;
				}

				metrics.set(postId, {
					impressions: values.post_media_view ?? 0,
					reach: values.post_media_view ?? 0,
					clicks: values.post_clicks ?? 0,
					likes: values.post_reactions_like_total ?? 0,
				});
			} catch {
				// Skip individual post metric failures
			}
		}

		return metrics;
	},
};
