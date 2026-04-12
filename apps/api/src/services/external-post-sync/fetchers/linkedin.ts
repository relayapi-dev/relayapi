// ---------------------------------------------------------------------------
// LinkedIn Organization Posts Fetcher
// Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
// ---------------------------------------------------------------------------

import type {
	ExternalPostFetcher,
	ExternalPostData,
} from "../types";
import { RateLimitError } from "../types";
import { parseRateLimitHeaders } from "../rate-limits";

const BASE = "https://api.linkedin.com";
const DEFAULT_LIMIT = 50;

async function liFetch(
	url: string,
	accessToken: string,
): Promise<{ data: any; headers: Headers }> {
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"X-Restli-Protocol-Version": "2.0.0",
			"LinkedIn-Version": "202603",
			"X-RestLi-Method": "FINDER",
		},
	});
	if (res.status === 429) {
		const rl = parseRateLimitHeaders(res.headers);
		throw new RateLimitError(
			rl?.resetAt ?? new Date(Date.now() + 86400_000),
			rl?.remaining ?? 0,
		);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new Error(`LinkedIn API ${res.status}: ${body}`);
	}
	return { data: await res.json(), headers: res.headers };
}

function parsePost(raw: any): ExternalPostData {
	const mediaUrls: string[] = [];
	let mediaType: string | null = "text";
	let thumbnailUrl: string | null = null;

	const content = raw.content ?? {};
	if (content.media) {
		mediaType = content.media.type === "urn:li:digitalmediaClass:document"
			? "document"
			: content.media.type?.includes("video")
				? "video"
				: "image";
		if (content.media.id) {
			// LinkedIn media IDs require separate resolution — store raw
		}
	}
	if (content.multiImage?.images) {
		mediaType = "carousel";
		for (const img of content.multiImage.images) {
			if (img.url) mediaUrls.push(img.url);
		}
	}

	const commentary = raw.commentary ?? "";

	return {
		platformPostId: raw.id ?? raw.urn,
		// Construct permalink from post URN: urn:li:share:123 or urn:li:ugcPost:123
		platformUrl: raw.id
			? `https://www.linkedin.com/feed/update/${raw.id}/`
			: null,
		content: commentary,
		mediaUrls,
		mediaType,
		thumbnailUrl,
		publishedAt: new Date(raw.createdAt ?? raw.publishedAt ?? Date.now()),
		platformData: {
			lifecycleState: raw.lifecycleState,
			visibility: raw.visibility,
			distribution: raw.distribution,
		},
		metrics: {},
	};
}

export const linkedinPostFetcher: ExternalPostFetcher = {
	platform: "linkedin",

	async fetchPosts(accessToken, platformAccountId, options) {
		const limit = Math.min(options.limit ?? DEFAULT_LIMIT, 100);
		const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0;

		const authorUrn = `urn:li:organization:${platformAccountId}`;
		let url = `${BASE}/rest/posts?author=${encodeURIComponent(authorUrn)}&q=author&count=${limit}&start=${start}&sortBy=LAST_MODIFIED`;

		const { data: json, headers } = await liFetch(url, accessToken);
		const elements = json.elements ?? [];

		const posts: ExternalPostData[] = elements.map(parsePost);

		const total = json.paging?.total ?? 0;
		const nextStart = start + elements.length;
		const hasMore = nextStart < total;
		const nextCursor = hasMore ? String(nextStart) : null;
		const rateLimit = parseRateLimitHeaders(headers) ?? undefined;

		return { posts, nextCursor, hasMore, rateLimit };
	},

	async fetchPostMetrics(accessToken, _platformAccountId, platformPostIds) {
		const metrics = new Map<string, ExternalPostData["metrics"]>();

		// LinkedIn: fetch socialActions per post for engagement counts
		for (const postId of platformPostIds) {
			try {
				const urn = postId.startsWith("urn:") ? postId : `urn:li:share:${postId}`;
				const { data: json } = await liFetch(
					`${BASE}/rest/socialActions/${encodeURIComponent(urn)}`,
					accessToken,
				);

				metrics.set(postId, {
					likes: json.likesSummary?.totalLikes ?? 0,
					comments: json.commentsSummary?.totalFirstLevelComments ?? 0,
				});
			} catch {
				// Skip individual metric failures
			}
		}

		return metrics;
	},
};
