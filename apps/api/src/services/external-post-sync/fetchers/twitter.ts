// ---------------------------------------------------------------------------
// X/Twitter Posts Fetcher
// Docs: https://docs.x.com/x-api/posts/timelines/api-reference/get-users-id-tweets
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const BASE = "https://api.x.com/2";
const DEFAULT_LIMIT = 100;

const TWEET_FIELDS =
	"created_at,public_metrics,text,attachments,entities";
const EXPANSIONS = "attachments.media_keys";
const MEDIA_FIELDS = "url,preview_image_url,type";

interface TwitterPublicMetrics {
	impression_count?: number;
	like_count?: number;
	reply_count?: number;
	retweet_count?: number;
	quote_count?: number;
}

interface TwitterMedia {
	media_key: string;
	type?: string;
	url?: string;
	preview_image_url?: string;
}

interface TwitterRawTweet {
	id: string;
	text?: string;
	created_at?: string;
	public_metrics?: TwitterPublicMetrics;
	entities?: unknown;
	attachments?: { media_keys?: string[] };
}

interface TwitterTimelineResponse {
	data?: TwitterRawTweet[];
	includes?: { media?: TwitterMedia[] };
	meta?: { next_token?: string };
}

async function xFetch<T = unknown>(
	url: string,
	accessToken: string,
): Promise<{ data: T; headers: Headers }> {
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (res.status === 429) {
		const rl = parseRateLimitHeaders(res.headers);
		throw new RateLimitError(
			rl?.resetAt ?? new Date(Date.now() + 900_000),
			rl?.remaining ?? 0,
		);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`X API ${res.status}: ${body}`);
	}
	return { data: (await res.json()) as T, headers: res.headers };
}

function parseTweet(
	tweet: TwitterRawTweet,
	mediaMap: Map<string, TwitterMedia>,
): ExternalPostData {
	const mediaUrls: string[] = [];
	let mediaType: string | null = null;
	let thumbnailUrl: string | null = null;

	const mediaKeys: string[] = tweet.attachments?.media_keys ?? [];
	for (const key of mediaKeys) {
		const media = mediaMap.get(key);
		if (!media) continue;
		if (media.type === "video" || media.type === "animated_gif") {
			mediaType = "video";
			thumbnailUrl = media.preview_image_url ?? null;
		} else if (media.type === "photo") {
			mediaType = mediaType ?? "image";
			if (media.url) mediaUrls.push(media.url);
		}
	}

	if (mediaKeys.length > 1) mediaType = "carousel";

	const pm = tweet.public_metrics ?? {};

	return {
		platformPostId: tweet.id,
		platformUrl: `https://x.com/i/status/${tweet.id}`,
		content: tweet.text ?? null,
		mediaUrls,
		mediaType,
		thumbnailUrl,
		publishedAt: tweet.created_at ? new Date(tweet.created_at) : new Date(),
		platformData: {
			public_metrics: pm,
			entities: tweet.entities,
		},
		metrics: {
			impressions: pm.impression_count ?? 0,
			likes: pm.like_count ?? 0,
			comments: pm.reply_count ?? 0,
			shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
			views: pm.impression_count ?? 0,
		},
	};
}

export const twitterPostFetcher: ExternalPostFetcher = {
	platform: "twitter",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
		let url = `${BASE}/users/${platformAccountId}/tweets?max_results=${limit}&tweet.fields=${TWEET_FIELDS}&expansions=${EXPANSIONS}&media.fields=${MEDIA_FIELDS}`;

		if (options.cursor) {
			url += `&pagination_token=${options.cursor}`;
		}
		if (options.since) {
			url += `&start_time=${options.since.toISOString()}`;
		}

		const { data: json, headers } = await xFetch<TwitterTimelineResponse>(
			url,
			accessToken,
		);

		// Build media lookup
		const mediaMap = new Map<string, TwitterMedia>();
		for (const media of json.includes?.media ?? []) {
			mediaMap.set(media.media_key, media);
		}

		const posts: ExternalPostData[] = (json.data ?? []).map((t) =>
			parseTweet(t, mediaMap),
		);

		const nextCursor = json.meta?.next_token ?? null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return { posts, nextCursor, hasMore: nextCursor != null, rateLimit };
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		// X API: batch lookup up to 100 tweets
		const ids = platformPostIds.slice(0, 100).join(",");
		try {
			const { data: json } = await xFetch<{ data?: TwitterRawTweet[] }>(
				`${BASE}/tweets?ids=${ids}&tweet.fields=public_metrics`,
				accessToken,
			);

			for (const tweet of json.data ?? []) {
				const pm = tweet.public_metrics ?? {};
				metrics.set(tweet.id, {
					impressions: pm.impression_count ?? 0,
					likes: pm.like_count ?? 0,
					comments: pm.reply_count ?? 0,
					shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
					views: pm.impression_count ?? 0,
				});
			}
		} catch {
			// Batch metric fetch failed
		}

		return metrics;
	},
};
