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
	/** Exact PostgreSQL producer generation. Manual/webhook work claims on read. */
	poll_generation?: number;
}

export interface GenerateExternalPreviewMessage {
	type: "generate_external_preview";
	external_post_id: string;
	organization_id: string;
	social_account_id: string;
	platform: string;
}

export interface SyncAutomationBindingMessage {
	type: "sync_automation_binding";
	binding_id: string;
	organization_id: string;
	revision: number;
	dispatch_generation: number;
}

export type SyncQueueMessage =
	| SyncPostsMessage
	| GenerateExternalPreviewMessage
	| SyncAutomationBindingMessage;

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
	 * Refresh one post by its platform ID. Platforms with expiring media URLs
	 * implement this so the durable-preview backfill can obtain a fresh source.
	 */
	fetchPost?(
		accessToken: string,
		platformAccountId: string,
		platformPostId: string,
	): Promise<ExternalPostData | null>;

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
