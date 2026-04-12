// ---------------------------------------------------------------------------
// External Post Sync — Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Queue messages
// ---------------------------------------------------------------------------

export interface SyncPostsMessage {
	type: "sync_posts";
	social_account_id: string;
	organization_id: string;
	platform: string;
	/** If set, this was triggered by a webhook rather than a poll */
	webhook_triggered?: boolean;
	/** Platform-specific hint (e.g. a specific post ID to fetch) */
	hint?: {
		platform_post_id?: string;
		event_type?: string;
	};
}

export interface RefreshMetricsMessage {
	type: "refresh_metrics";
	organization_id: string;
	social_account_id: string;
	platform: string;
	/** External post IDs to refresh (batch of up to 50) */
	external_post_ids: string[];
}

export type SyncQueueMessage = SyncPostsMessage | RefreshMetricsMessage;

// ---------------------------------------------------------------------------
// Platform fetcher interface
// ---------------------------------------------------------------------------

export interface ExternalPostData {
	platformPostId: string;
	platformUrl: string | null;
	content: string | null;
	mediaUrls: string[];
	mediaType: string | null; // "image" | "video" | "carousel" | "text" | "reel" | "story"
	thumbnailUrl: string | null;
	publishedAt: Date;
	platformData: Record<string, unknown>;
	metrics: {
		impressions?: number;
		reach?: number;
		likes?: number;
		comments?: number;
		shares?: number;
		saves?: number;
		clicks?: number;
		views?: number;
	};
}

export interface FetchPostsResult {
	posts: ExternalPostData[];
	/** Cursor for next incremental fetch (stored in sync state) */
	nextCursor: string | null;
	/** If true, there are more pages to fetch */
	hasMore: boolean;
	/** Rate limit info from response headers */
	rateLimit?: {
		remaining: number;
		resetAt: Date;
	};
}

export interface ExternalPostFetcher {
	readonly platform: string;

	/**
	 * Fetch posts published on the platform.
	 * Uses cursor for incremental pagination.
	 */
	fetchPosts(
		accessToken: string,
		platformAccountId: string,
		options: {
			since?: Date;
			cursor?: string | null;
			limit?: number;
		},
	): Promise<FetchPostsResult>;

	/**
	 * Fetch updated metrics for specific posts.
	 */
	fetchPostMetrics(
		accessToken: string,
		platformAccountId: string,
		platformPostIds: string[],
	): Promise<Map<string, ExternalPostData["metrics"]>>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RateLimitError extends Error {
	constructor(
		public readonly resetAt: Date,
		public readonly remaining: number = 0,
		message?: string,
	) {
		const resetStr = Number.isNaN(resetAt.getTime())
			? "unknown"
			: resetAt.toISOString();
		super(message ?? `Rate limited until ${resetStr}`);
		this.name = "RateLimitError";
	}
}
