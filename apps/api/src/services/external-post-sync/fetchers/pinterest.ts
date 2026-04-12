// ---------------------------------------------------------------------------
// Pinterest Pins Fetcher
// Docs: https://developers.pinterest.com/docs/api/v5/pins-list/
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const BASE = "https://api.pinterest.com/v5";
const DEFAULT_LIMIT = 25;

async function pinFetch(
	url: string,
	accessToken: string,
): Promise<{ data: any; headers: Headers }> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (res.status === 429) {
		const rl = parseRateLimitHeaders(res.headers);
		throw new RateLimitError(
			rl?.resetAt ?? new Date(Date.now() + 3600_000),
			rl?.remaining ?? 0,
		);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Pinterest API ${res.status}: ${body}`);
	}
	return { data: await res.json(), headers: res.headers };
}

function parsePin(raw: any): ExternalPostData {
	const mediaUrls: string[] = [];
	let mediaType: string | null = null;
	let thumbnailUrl: string | null = null;

	const media = raw.media;
	if (media?.media_type === "video") {
		mediaType = "video";
		thumbnailUrl = media.images?.["600x"]?.url ?? raw.media?.cover_image_url ?? null;
	} else if (media?.media_type === "multiple_images") {
		mediaType = "carousel";
	} else {
		mediaType = "image";
	}

	// Pin images
	const images = raw.media?.images ?? raw.images;
	if (images) {
		const best =
			images.original?.url ?? images["1200x"]?.url ?? images["600x"]?.url;
		if (best) {
			mediaUrls.push(best);
			thumbnailUrl = thumbnailUrl ?? best;
		}
	}

	return {
		platformPostId: raw.id,
		platformUrl: raw.link ?? `https://www.pinterest.com/pin/${raw.id}/`,
		content: raw.title || raw.description || null,
		mediaUrls,
		mediaType,
		thumbnailUrl,
		publishedAt: new Date(raw.created_at),
		platformData: {
			board_id: raw.board_id,
			dominant_color: raw.dominant_color,
		},
		metrics: {
			saves: raw.pin_metrics?.save ?? 0,
			clicks: raw.pin_metrics?.pin_click ?? 0,
			impressions: raw.pin_metrics?.impression ?? 0,
			comments: raw.pin_metrics?.comment ?? 0,
		},
	};
}

export const pinterestPostFetcher: ExternalPostFetcher = {
	platform: "pinterest",

	async fetchPosts(accessToken, _platformAccountId, options) {
		// Docs: https://developers.pinterest.com/docs/api/v5/pins-list
		// Max page_size: 250, pin_metrics returns 90-day + lifetime metrics inline
		const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 250);
		let url = `${BASE}/pins?page_size=${limit}&pin_metrics=true`;

		if (options.cursor) {
			url += `&bookmark=${options.cursor}`;
		}

		const { data: json, headers } = await pinFetch(url, accessToken);
		const items = json.items ?? [];

		let posts: ExternalPostData[] = items.map(parsePin);

		// Filter by since if provided (Pinterest doesn't support since param)
		if (options.since) {
			posts = posts.filter((p) => p.publishedAt >= options.since!);
		}

		const nextCursor = json.bookmark ?? null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return {
			posts,
			nextCursor: nextCursor && items.length === limit ? nextCursor : null,
			hasMore: nextCursor != null && items.length === limit && posts.length === items.length,
			rateLimit,
		};
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		// Pinterest: fetch each pin individually for metrics
		for (const pinId of platformPostIds) {
			try {
				const { data: json } = await pinFetch(
					`${BASE}/pins/${pinId}?pin_metrics=true`,
					accessToken,
				);

				const pm = json.pin_metrics ?? {};
				metrics.set(pinId, {
					saves: pm.save ?? 0,
					clicks: pm.pin_click ?? 0,
					impressions: pm.impression ?? 0,
					comments: pm.comment ?? 0,
				});
			} catch {
				// Skip individual metric failures
			}
		}

		return metrics;
	},
};
