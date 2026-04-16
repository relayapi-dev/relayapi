export interface Env {
	KV: KVNamespace;
	MEDIA_BUCKET: R2Bucket;
	HYPERDRIVE: Hyperdrive;
	PUBLISH_QUEUE: Queue;
	EMAIL_QUEUE: Queue;
	REFRESH_QUEUE: Queue;
	INBOX_QUEUE: Queue;
	TOOLS_QUEUE: Queue;
	ADS_QUEUE: Queue;
	SYNC_QUEUE: Queue;
	AI?: Ai; // Optional — Cloudflare Workers AI binding
	REALTIME: DurableObjectNamespace;
	FREE_RATE_LIMITER: RateLimit;
	PRO_RATE_LIMITER: RateLimit;

	// Downloader service (Python VPS)
	DOWNLOADER_SERVICE_URL?: string;
	DOWNLOADER_SERVICE_KEY?: string;

	// Platform OAuth credentials
	TWITTER_CLIENT_ID?: string;
	TWITTER_CLIENT_SECRET?: string;
	FACEBOOK_APP_ID?: string;
	FACEBOOK_APP_SECRET?: string;
	INSTAGRAM_APP_ID?: string;
	INSTAGRAM_APP_SECRET?: string;
	INSTAGRAM_LOGIN_APP_ID?: string;
	INSTAGRAM_LOGIN_APP_SECRET?: string;
	LINKEDIN_CLIENT_ID?: string;
	LINKEDIN_CLIENT_SECRET?: string;
	TIKTOK_CLIENT_KEY?: string;
	TIKTOK_CLIENT_SECRET?: string;
	YOUTUBE_CLIENT_ID?: string;
	YOUTUBE_CLIENT_SECRET?: string;
	PINTEREST_APP_ID?: string;
	PINTEREST_APP_SECRET?: string;
	REDDIT_CLIENT_ID?: string;
	REDDIT_CLIENT_SECRET?: string;
	THREADS_APP_ID?: string;
	THREADS_APP_SECRET?: string;
	SNAPCHAT_CLIENT_ID?: string;
	SNAPCHAT_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	WHATSAPP_APP_ID?: string;
	WHATSAPP_APP_SECRET?: string;
	WHATSAPP_CONFIG_ID?: string;
	MASTODON_CLIENT_ID?: string;
	MASTODON_CLIENT_SECRET?: string;
	TELEGRAM_BOT_TOKEN?: string;
	ENCRYPTION_KEY: string;

	// Twilio SMS webhook verification
	TWILIO_AUTH_TOKEN?: string;

	// Telnyx phone number provisioning
	TELNYX_API_KEY?: string;
	STRIPE_WA_PHONE_PRICE_ID?: string;

	// Inbound platform webhook verification
	FACEBOOK_WEBHOOK_VERIFY_TOKEN?: string;

	// Base URL for OAuth callbacks (e.g. "https://api.relayapi.dev")
	API_BASE_URL?: string;

	// R2 S3 API credentials for presigned URLs
	// Docs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
	// Create via Dashboard: R2 > Account Details > Manage API Tokens
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	CF_ACCOUNT_ID?: string;

	// Stripe
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;

	// Email (Resend)
	RESEND_API_KEY: string;
}

import type { Database } from "@relayapi/db";

export interface Variables {
	orgId: string;
	keyId: string;
	permissions: string[];
	workspaceScope: "all" | string[];
	plan: "free" | "pro";
	callsIncluded: number;
	aiEnabled: boolean;
	dailyToolLimit: number;
	parsedBody: Record<string, unknown> | null;
	/** Per-request Drizzle instance. Set by dbContextMiddleware on /v1/*. */
	db: Database;
}

/** Shape stored in KV for each API key */
export interface KVKeyData {
	org_id: string;
	key_id: string;
	permissions: string[];
	workspace_scope?: "all" | string[];
	expires_at: string | null;
	plan: "free" | "pro";
	calls_included: number;
	ai_enabled?: boolean;
	daily_tool_limit?: number;
	/** @deprecated Rate limiting now uses CF Rate Limiting binding */
	rate_limit_max?: number;
	/** @deprecated Rate limiting now uses CF Rate Limiting binding */
	rate_limit_window?: number;
}

// Pricing is now centralized in @relayapi/config — inline copy for wrangler compatibility
export const PRICING = {
	freeCallsIncluded: 200,
	monthlyPriceCents: 500,
	proCallsIncluded: 10_000,
	pricePerThousandCallsCents: 100,
	freeRateLimitMax: 100,
	freeRateLimitWindow: 60,
	proRateLimitMax: 1_000,
	proRateLimitWindow: 60,
} as const;
