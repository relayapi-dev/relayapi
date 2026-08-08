import { BASELINE_GENERATION } from "@relayapi/config";
import type { Env, KVKeyData } from "../../types";

export class MockKV {
	private store = new Map<string, string>();

	async get(key: string, opts?: unknown): Promise<unknown> {
		const raw = this.store.get(key);
		if (!raw) return null;
		if (opts === "json") return JSON.parse(raw);
		if (opts === "text") return raw;
		return raw;
	}

	async put(key: string, value: string, _opts?: unknown): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list(_opts?: unknown): Promise<{
		keys: Array<{ name: string }>;
		list_complete: boolean;
		cacheStatus: null;
	}> {
		return {
			keys: Array.from(this.store.keys()).map((name) => ({ name })),
			list_complete: true,
			cacheStatus: null,
		};
	}

	async getWithMetadata(
		key: string,
		_opts?: unknown,
	): Promise<{ value: string | null; metadata: unknown; cacheStatus: null }> {
		return {
			value: this.store.get(key) ?? null,
			metadata: null,
			cacheStatus: null,
		};
	}

	/** Test helper: inspect raw store */
	_raw(): Map<string, string> {
		return this.store;
	}

	/** Test helper: clear all data */
	_clear(): void {
		this.store.clear();
	}
}

function createMockQueue(): Queue {
	return { send: async () => {} } as unknown as Queue;
}

export class MockR2Bucket {
	async put(_key: string, _body: unknown, _opts?: unknown) {
		return {};
	}
	async head(_key: string) {
		return null;
	}
	async get(_key: string) {
		return null;
	}
	async delete(_key: string) {}
	async createMultipartUpload(_key: string, _opts?: unknown) {
		return { uploadId: "mock-upload-id" };
	}
}

export function createMockEnv(kvOverride?: MockKV): { env: Env; kv: MockKV } {
	const kv = kvOverride ?? new MockKV();
	const env = {
		KV: kv as unknown as KVNamespace,
		MEDIA_BUCKET: new MockR2Bucket() as unknown as R2Bucket,
		AVATAR_BUCKET: new MockR2Bucket() as unknown as R2Bucket,
		THUMBNAIL_BUCKET: new MockR2Bucket() as unknown as R2Bucket,
		QUEUE_RESCUE_BUCKET: new MockR2Bucket() as unknown as R2Bucket,
		HYPERDRIVE: {
			connectionString: "postgresql://mock:mock@localhost:5432/mock",
		} as unknown as Hyperdrive,
		PUBLISH_QUEUE: createMockQueue(),
		EMAIL_QUEUE: createMockQueue(),
		REFRESH_QUEUE: createMockQueue(),
		INBOX_QUEUE: createMockQueue(),
		TOOLS_QUEUE: createMockQueue(),
		ADS_QUEUE: createMockQueue(),
		SYNC_QUEUE: createMockQueue(),
		CUSTOMER_WEBHOOK_QUEUE: createMockQueue(),
		QUEUE_RESCUE_QUEUE: createMockQueue(),
		AI: {
			run: async () => ({ response: "{}" }),
		} as unknown as Ai,
		IMAGES: {} as unknown as ImagesBinding,
		MEDIA: {} as unknown as MediaBinding,
		REALTIME: {} as unknown as DurableObjectNamespace,
		FREE_RATE_LIMITER: {
			limit: async () => ({ success: true }),
		} as unknown as RateLimit,
		PRO_RATE_LIMITER: {
			limit: async () => ({ success: true }),
		} as unknown as RateLimit,
		FREE_KEY_BURST_LIMITER: {
			limit: async () => ({ success: true }),
		} as unknown as RateLimit,
		PRO_KEY_BURST_LIMITER: {
			limit: async () => ({ success: true }),
		} as unknown as RateLimit,
		STRIPE_SECRET_KEY: "sk_test_mock",
		STRIPE_PRO_PRICE_ID: "price_test_pro",
		STRIPE_WEBHOOK_SECRET: "whsec_test_mock",
		STRIPE_PORTAL_CONFIGURATION_ID: "bpc_test_relayapi",
		RESEND_API_KEY: "re_test_mock",
		ENCRYPTION_KEY: `test=${"a".repeat(64)},identity=${"b".repeat(64)}`,
		OPENAI_API_KEY: "sk-test-openai",
		BASELINE_GENERATION: String(BASELINE_GENERATION),
		PERF_LOGS: "0",
		R2_EVENT_ACCOUNT_ID: "test-account",
		R2_MEDIA_BUCKET_NAME: "relayapi-media",
		R2_MEDIA_BUCKET_JURISDICTION: "default",
		R2_THUMBNAIL_BUCKET_NAME: "relayapi-media-thumbnails",
		R2_THUMBNAIL_BUCKET_JURISDICTION: "default",
		AI_EMBEDDING_PROVIDER: "openai",
		AI_EMBEDDING_MODEL: "text-embedding-3-small",
		AI_INFERENCE_PROVIDER: "workers_ai",
		AI_INFERENCE_MODEL: "@cf/zai-org/glm-4.7-flash",
		API_BASE_URL: "https://api.test.dev",
		PUBLIC_LINK_BASE_URL: "https://go.test.dev",
		MAINTENANCE_SMOKE_BYPASS_SHA256: "0".repeat(64),
		FACEBOOK_WEBHOOK_VERIFY_TOKEN: "test_verify_token",
		// Platform OAuth credentials
		TWITTER_CLIENT_ID: "test_twitter_id",
		TWITTER_CLIENT_SECRET: "test_twitter_secret",
		FACEBOOK_APP_ID: "test_facebook_id",
		FACEBOOK_APP_SECRET: "test_facebook_secret",
		INSTAGRAM_APP_ID: "test_instagram_id",
		INSTAGRAM_APP_SECRET: "test_instagram_secret",
		INSTAGRAM_LOGIN_APP_ID: "test_ig_login_id",
		INSTAGRAM_LOGIN_APP_SECRET: "test_ig_login_secret",
		LINKEDIN_CLIENT_ID: "test_linkedin_id",
		LINKEDIN_CLIENT_SECRET: "test_linkedin_secret",
		TIKTOK_CLIENT_KEY: "test_tiktok_key",
		TIKTOK_CLIENT_SECRET: "test_tiktok_secret",
		YOUTUBE_CLIENT_ID: "test_youtube_id",
		YOUTUBE_CLIENT_SECRET: "test_youtube_secret",
		PINTEREST_APP_ID: "test_pinterest_id",
		PINTEREST_APP_SECRET: "test_pinterest_secret",
		REDDIT_CLIENT_ID: "test_reddit_id",
		REDDIT_CLIENT_SECRET: "test_reddit_secret",
		THREADS_APP_ID: "test_threads_id",
		THREADS_APP_SECRET: "test_threads_secret",
		SNAPCHAT_CLIENT_ID: "test_snapchat_id",
		SNAPCHAT_CLIENT_SECRET: "test_snapchat_secret",
		GOOGLE_CLIENT_ID: "test_google_id",
		GOOGLE_CLIENT_SECRET: "test_google_secret",
		MASTODON_CLIENT_ID: "test_mastodon_id",
		MASTODON_CLIENT_SECRET: "test_mastodon_secret",
	} as Env;
	return { env, kv };
}

/** Seed an API key into KV for testing */
export async function seedApiKeyInKV(
	kv: MockKV,
	hashedKey: string,
	data: KVKeyData,
): Promise<void> {
	await kv.put(
		`apikey:${hashedKey}`,
		JSON.stringify({
			principal_type: "service",
			principal_id: data.key_id,
			principal_user_id: null,
			entitlement_recheck_at: null,
			billing_transition_at: null,
			...data,
		}),
	);
}

/** SHA-256 hash a key (same as auth middleware) */
export async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
