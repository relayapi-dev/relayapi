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

	async list(
		_opts?: unknown,
	): Promise<{
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
		return { value: this.store.get(key) ?? null, metadata: null, cacheStatus: null };
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
		REALTIME: {} as unknown as DurableObjectNamespace,
		FREE_RATE_LIMITER: {
			limit: async () => ({ success: true }),
		} as unknown as RateLimit,
		PRO_RATE_LIMITER: {
			limit: async () => ({ success: true }),
		} as unknown as RateLimit,
		STRIPE_SECRET_KEY: "sk_test_mock",
		STRIPE_WEBHOOK_SECRET: "whsec_test_mock",
		RESEND_API_KEY: "re_test_mock",
		ENCRYPTION_KEY: "a".repeat(64),
		API_BASE_URL: "https://api.test.dev",
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
	await kv.put(`apikey:${hashedKey}`, JSON.stringify(data));
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
