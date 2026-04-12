// ---------------------------------------------------------------------------
// Threads Posts Fetcher
// Docs: https://developers.facebook.com/docs/threads/threads-media
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const API_VERSION = "v1.0";
const BASE = `https://graph.threads.net/${API_VERSION}`;
const DEFAULT_LIMIT = 25;

// Docs: https://developers.facebook.com/docs/threads/threads-media
// Base: https://graph.threads.net/v1.0/me/threads
const THREAD_FIELDS = [
	"id",
	"text",
	"timestamp",
	"media_url",
	"thumbnail_url",
	"permalink",
	"media_type",
	"username",
].join(",");

async function threadsFetch(
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
		throw new Error(`Threads API ${res.status}: ${body}`);
	}
	return { data: await res.json(), headers: res.headers };
}

function parseMediaType(raw: string | undefined): string | null {
	switch (raw) {
		case "TEXT_POST":
			return "text";
		case "IMAGE":
			return "image";
		case "VIDEO":
			return "video";
		case "CAROUSEL_ALBUM":
			return "carousel";
		default:
			return raw?.toLowerCase() ?? null;
	}
}

function parseSafeDate(value: unknown): Date {
	if (!value) return new Date();
	const d = new Date(value as string);
	return Number.isNaN(d.getTime()) ? new Date() : d;
}

function parseThread(raw: any): ExternalPostData {
	const mediaUrls: string[] = [];
	const mediaType = parseMediaType(raw.media_type);

	if (raw.media_url) {
		mediaUrls.push(raw.media_url);
	}

	return {
		platformPostId: raw.id,
		platformUrl: raw.permalink ?? null,
		content: raw.text ?? null,
		mediaUrls,
		mediaType,
		thumbnailUrl: raw.thumbnail_url ?? null,
		publishedAt: parseSafeDate(raw.timestamp),
		platformData: { media_type: raw.media_type, username: raw.username },
		metrics: {},
	};
}

export const threadsPostFetcher: ExternalPostFetcher = {
	platform: "threads",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = options.limit ?? DEFAULT_LIMIT;
		let url: string;

		if (options.cursor) {
			url = options.cursor;
		} else {
			url = `${BASE}/me/threads?fields=${THREAD_FIELDS}&limit=${limit}`;
			if (options.since) {
				url += `&since=${Math.floor(options.since.getTime() / 1000)}`;
			}
		}

		const { data: json, headers } = await threadsFetch(url, accessToken);
		const posts: ExternalPostData[] = (json.data ?? []).map(parseThread);

		const nextCursor = json.paging?.next ?? null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return { posts, nextCursor, hasMore: nextCursor != null, rateLimit };
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		for (const postId of platformPostIds) {
			try {
				const { data: json } = await threadsFetch(
					`${BASE}/${postId}/insights?metric=views,likes,replies,reposts`,
					accessToken,
				);

				const values: Record<string, number> = {};
				for (const m of json.data ?? []) {
					values[m.name] = m.values?.[0]?.value ?? 0;
				}

				metrics.set(postId, {
					views: values.views ?? 0,
					likes: values.likes ?? 0,
					comments: values.replies ?? 0,
					shares: values.reposts ?? 0,
				});
			} catch {
				// Skip individual metric failures
			}
		}

		return metrics;
	},
};
