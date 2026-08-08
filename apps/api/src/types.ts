/**
 * Wrangler generates every configured binding into `Cloudflare.Env`. Keep only
 * secrets and operator-provided variables here so config drift fails typegen CI.
 */
interface RelayEnvironmentOverrides {
	BASELINE_GENERATION?: string;
	PERF_LOGS?: "0" | "1";
	PUBLIC_LINK_BASE_URL?: string;
	R2_EVENT_ACCOUNT_ID: string;
	R2_MEDIA_BUCKET_NAME: string;
	R2_MEDIA_BUCKET_JURISDICTION: "default" | "eu";
	R2_THUMBNAIL_BUCKET_NAME: string;
	R2_THUMBNAIL_BUCKET_JURISDICTION: "default" | "eu";
	DEPLOYMENT_MODE?: "hosted" | "self_hosted";
	SELF_HOSTED_FEATURE_AI?: "0" | "1";
	SELF_HOSTED_FEATURE_EMAIL?: "0" | "1";
	SELF_HOSTED_FEATURE_DOWNLOADER?: "0" | "1";
	AI_EMBEDDING_PROVIDER?: "openai";
	AI_EMBEDDING_MODEL?: "text-embedding-3-small";
	AI_INFERENCE_PROVIDER?: "workers_ai";
	AI_INFERENCE_MODEL?: "@cf/zai-org/glm-4.7-flash";
	OPENAI_API_KEY?: string;
	/** Optional HTTPS sink for sanitized, durable operator-alert deliveries. */
	OPERATIONS_ALERT_WEBHOOK_URL?: string;
	/** Optional admin mailbox used only when the operator-alert webhook fails. */
	OPERATIONS_ALERT_EMAIL?: string;
	APP_BASE_URL?: string;
	MEDIA_PUBLIC_HOST?: string;
	THUMBNAIL_PUBLIC_HOST?: string;
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
	/** Server-held value passed to Telegram setWebhook as secret_token. */
	TELEGRAM_WEBHOOK_SECRET?: string;
	ENCRYPTION_KEY: string;

	// Telnyx phone number provisioning
	TELNYX_API_KEY?: string;
	STRIPE_WA_PHONE_PRICE_ID?: string;

	// Inbound platform webhook verification
	FACEBOOK_WEBHOOK_VERIFY_TOKEN?: string;
	YOUTUBE_HUB_SECRET?: string;

	// Base URL for OAuth callbacks (e.g. "https://api.relayapi.dev")
	API_BASE_URL?: string;
	// SHA-256 of the generation-domain-separated maintenance smoke token.
	MAINTENANCE_SMOKE_BYPASS_SHA256?: string;

	// R2 S3 API credentials for presigned URLs
	// Docs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
	// Create via Dashboard: R2 > Account Details > Manage API Tokens
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
	CF_ACCOUNT_ID?: string;
	// Stripe
	STRIPE_SECRET_KEY: string;
	STRIPE_PRO_PRICE_ID: string;
	STRIPE_WEBHOOK_SECRET: string;
	/** Reviewed portal configuration used only with a single-purpose deep link. */
	STRIPE_PORTAL_CONFIGURATION_ID: string;

	// Email (Resend)
	RESEND_API_KEY: string;
}

export type Env = Omit<Cloudflare.Env, keyof RelayEnvironmentOverrides> &
	RelayEnvironmentOverrides;

import type { Database } from "@relayapi/db";

export interface Variables {
	orgId: string;
	keyId: string;
	/** SHA-256 lookup key for invalidating this request's API-key KV projection. */
	keyHash: string;
	permissions: string[];
	workspaceScope: "all" | string[];
	principalType: "service" | "dashboard_user";
	/** Stable organization principal ID (`prn_*`). */
	principalId: string;
	/** Global user identity for member principals; null for services. */
	principalUserId: string | null;
	plan: "free" | "pro";
	quotaMode: "hard" | "metered" | "unlimited";
	callsIncluded: number | null;
	billingSource: "stripe" | "complimentary" | "self_hosted" | "free";
	billable: boolean;
	/** Current immutable billing authority; null for free/self-hosted/tool buckets. */
	billingPeriodId: string | null;
	/** Hosted Pro is pending until an exact immutable period/bucket pair exists. */
	billingAuthorityState: "ready" | "pending";
	aiEnabled: boolean;
	/** PostgreSQL feature authority was refreshed for this gated request. */
	featureEntitlementsVerified?: boolean;
	dailyToolLimit: number | null;
	toolUsageDisposition?: "unowned" | "deferred";
	toolUsageReservation?: import("./services/usage-meter").UsageReservation;
	/** Armed successful-mutation reservation available to durable operation writers. */
	usageReservation?: import("./services/usage-meter").UsageReservation;
	/** Current Stripe billing-period bounds (ISO). Absent for free/period-less orgs. */
	periodStart?: string | null;
	periodEnd?: string | null;
	/** Hosted paid-authority boundary that must be projected before mutation. */
	billingTransitionAt?: string | null;
	parsedBody: Record<string, unknown> | null;
	/** Per-request Drizzle instance. Set by dbContextMiddleware on /v1/*. */
	db: Database;
	/** Monotonic evidence for the customer-visible mutation in this request. */
	mutationEffectTracker?: import("./lib/mutation-effect").MutationEffectTracker;
	/** Per-request perf tracker. Set by perfLogMiddleware when PERF_LOGS=1. */
	perf?: import("./lib/perf").PerfTracker;
}

/** Shape stored in KV for each API key */
export interface KVKeyData {
	org_id: string;
	key_id: string;
	permissions: string[];
	workspace_scope?: "all" | string[];
	principal_type?: "service" | "dashboard_user";
	/** Stable organization principal ID (`prn_*`). */
	principal_id?: string;
	/** Global user identity for member principals; null for services. */
	principal_user_id?: string | null;
	expires_at: string | null;
	plan: "free" | "pro";
	quota_mode?: "hard" | "metered" | "unlimited";
	calls_included: number | null;
	billing_source?: "stripe" | "complimentary" | "self_hosted" | "free";
	billable?: boolean;
	billing_period_id?: string | null;
	/** Internal fail-closed state; pending Pro must be reconciled before usage. */
	billing_authority_state?: "ready" | "pending";
	ai_enabled?: boolean;
	daily_tool_limit?: number | null;
	/**
	 * The org's current Stripe billing period (ISO strings), carried so the
	 * usage-record write path keys on the actual billing window without a
	 * per-request subscription lookup. Null/absent for free orgs and subs
	 * missing period bounds — the usage period then falls back to calendar month.
	 */
	period_start?: string | null;
	period_end?: string | null;
	/** Force a PostgreSQL rehydrate at time-based entitlement/period boundaries. */
	entitlement_recheck_at?: string | null;
	/** Internal boundary used to close stale paid usage authority idempotently. */
	billing_transition_at?: string | null;
}
