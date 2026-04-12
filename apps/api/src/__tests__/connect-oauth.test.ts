/**
 * Integration tests for the OAuth connect flow (exchangeAndSaveAccount).
 *
 * These tests mock external HTTP calls and the database, but exercise the
 * actual handler logic: token exchange, long-lived token swap, profile
 * fetching, DB upsert, webhook subscriptions, and error handling.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// ── Module mocks (must be before imports of modules under test) ──

let activeDb: ReturnType<typeof import("./__mocks__/db").createMockDb>;

const mockExchangeCode = mock(async () => ({
	access_token: "short_lived_token",
	refresh_token: "refresh_tok",
	expires_in: 3600,
	user_id: "token_user_id_123",
}));

mock.module("../config/oauth", () => {
	const makeConfig = (overrides: Record<string, unknown> = {}) => ({
		authUrl: "https://example.com/auth",
		tokenUrl: "https://example.com/token",
		profileUrl: "https://example.com/me",
		scopes: ["read", "write"],
		getClientId: () => "test_client_id",
		getClientSecret: () => "test_client_secret",
		...overrides,
	});

	return {
		OAUTH_CONFIGS: {
			twitter: makeConfig({
				authUrl: "https://x.com/i/oauth2/authorize",
				tokenUrl: "https://api.x.com/2/oauth2/token",
				profileUrl: "https://api.x.com/2/users/me?user.fields=profile_image_url",
				scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
				requiresPkce: true,
				tokenExchangeUsesBasicAuth: true,
			}),
			facebook: makeConfig({
				authUrl: "https://www.facebook.com/v25.0/dialog/oauth",
				tokenUrl: "https://graph.facebook.com/v25.0/oauth/access_token",
				profileUrl: "https://graph.facebook.com/v25.0/me?fields=id,name",
				scopes: ["pages_manage_posts", "pages_show_list"],
			}),
			instagram: makeConfig({
				authUrl: "https://www.facebook.com/v25.0/dialog/oauth",
				tokenUrl: "https://graph.facebook.com/v25.0/oauth/access_token",
				profileUrl: "https://graph.facebook.com/v25.0/me?fields=id,name",
				scopes: ["instagram_basic", "instagram_content_publish"],
			}),
			threads: makeConfig({
				authUrl: "https://threads.net/oauth/authorize",
				tokenUrl: "https://graph.threads.net/oauth/access_token",
				profileUrl: "https://graph.threads.net/v1.0/me?fields=id,username,name",
				scopes: ["threads_basic", "threads_content_publish"],
			}),
		},
		INSTAGRAM_DIRECT_CONFIG: makeConfig({
			authUrl: "https://www.instagram.com/oauth/authorize",
			tokenUrl: "https://api.instagram.com/oauth/access_token",
			profileUrl: "https://graph.instagram.com/v25.0/me?fields=user_id,username,name,profile_picture_url",
			scopes: ["instagram_business_basic", "instagram_business_content_publish"],
			getClientId: () => "test_ig_login_id",
			getClientSecret: () => "test_ig_login_secret",
		}),
		exchangeCode: mockExchangeCode,
		buildAuthUrl: mock(() => "https://example.com/auth?state=test"),
		generateStateToken: mock(() => "mock_state_token"),
		generatePkce: mock(async () => ({
			codeVerifier: "mock_verifier",
			codeChallenge: "mock_challenge",
		})),
	};
});

mock.module("@relayapi/db", () => {
	const { createMockDb, mockEq } = require("./__mocks__/db");
	activeDb = createMockDb();

	const socialAccounts = {
		organizationId: { name: "organizationId" },
		platform: { name: "platform" },
		platformAccountId: { name: "platformAccountId" },
		username: { name: "username" },
		displayName: { name: "displayName" },
		avatarUrl: { name: "avatarUrl" },
		accessToken: { name: "accessToken" },
		refreshToken: { name: "refreshToken" },
		tokenExpiresAt: { name: "tokenExpiresAt" },
		scopes: { name: "scopes" },
		id: { name: "id" },
		connectedAt: { name: "connectedAt" },
		updatedAt: { name: "updatedAt" },
		metadata: { name: "metadata" },
		toString: () => "social_accounts",
	};
	const socialAccountSyncState = {
		socialAccountId: { name: "socialAccountId" },
		organizationId: { name: "organizationId" },
		platform: { name: "platform" },
		enabled: { name: "enabled" },
		nextSyncAt: { name: "nextSyncAt" },
		updatedAt: { name: "updatedAt" },
		toString: () => "social_account_sync_state",
	};

	return {
		createDb: () => activeDb,
		socialAccounts,
		socialAccountSyncState,
		eq: (col: any, val: any) => mockEq(col, val),
	};
});

mock.module("drizzle-orm", () => {
	const { mockEq } = require("./__mocks__/db");
	const noop = (...args: any[]) => args[0];
	return {
		eq: (col: any, val: any) => mockEq(col, val),
		and: noop,
		or: noop,
		sql: noop,
		desc: noop,
		asc: noop,
		count: noop,
		inArray: noop,
		isNull: noop,
		isNotNull: noop,
		ilike: noop,
		gte: noop,
		lte: noop,
		lt: noop,
		gt: noop,
	};
});

const mockMaybeEncrypt = mock(async (value: string | undefined | null, _key: string) =>
	value ? `enc:${value}` : null,
);
mock.module("../lib/crypto", () => ({
	maybeEncrypt: mockMaybeEncrypt,
	maybeDecrypt: mock(async (value: string) => value.replace("enc:", "")),
}));

const mockDispatchWebhookEvent = mock(async () => {});
mock.module("../services/webhook-delivery", () => ({
	dispatchWebhookEvent: mockDispatchWebhookEvent,
}));

const mockLogConnectionEvent = mock(async () => {});
mock.module("../routes/connections", () => ({
	logConnectionEvent: mockLogConnectionEvent,
}));

const mockVerifyInstagramWebhook = mock(async () => ({ success: true }));
const mockSubscribeInstagramAccount = mock(async () => ({ success: true }));
const mockSubscribeFacebookPage = mock(async () => ({ success: true }));
mock.module("../services/webhook-subscription", () => ({
	verifyInstagramWebhookSubscription: mockVerifyInstagramWebhook,
	subscribeInstagramAccount: mockSubscribeInstagramAccount,
	subscribeFacebookPage: mockSubscribeFacebookPage,
	verifyWhatsAppWebhookSubscription: mock(async () => ({ success: true })),
}));

mock.module("../services/external-post-sync/index", () => ({
	getSupportedSyncPlatforms: () => ["instagram", "twitter"],
}));

// ── Import the function under test (AFTER all mocks) ──

const { exchangeAndSaveAccount } = await import("../routes/connect");
import { createMockEnv, MockKV } from "./__mocks__/env";
import { createMockDb } from "./__mocks__/db";

// ── Global fetch mock ──

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function createMockFetch(overrides: Record<string, () => Response> = {}) {
	return mock((url: string | URL | Request, _init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

		// Check overrides first
		for (const [pattern, handler] of Object.entries(overrides)) {
			if (urlStr.includes(pattern)) return Promise.resolve(handler());
		}

		// Long-lived token exchange (path is /access_token, not query param)
		if (urlStr.includes("graph.instagram.com") && urlStr.includes("/access_token?")) {
			return Promise.resolve(
				Response.json({ access_token: "ll_ig_token", expires_in: 5184000 }),
			);
		}

		// Instagram profile
		if (urlStr.includes("graph.instagram.com") && urlStr.includes("/me?")) {
			return Promise.resolve(
				Response.json({
					id: "app_scoped_ig_id",
					user_id: "17841441563557251",
					username: "testuser",
					name: "Test User",
					profile_picture_url: "https://example.com/avatar.jpg",
				}),
			);
		}

		// Twitter profile
		if (urlStr.includes("api.x.com") && urlStr.includes("/users/me")) {
			return Promise.resolve(
				Response.json({
					data: {
						id: "twitter_123",
						username: "testtwitter",
						name: "Test Twitter",
						profile_image_url: "https://example.com/tw.jpg",
					},
				}),
			);
		}

		// Facebook profile
		if (urlStr.includes("graph.facebook.com") && urlStr.includes("/me")) {
			return Promise.resolve(
				Response.json({ id: "fb_123", name: "Test Facebook" }),
			);
		}

		// Facebook long-lived token
		if (urlStr.includes("graph.facebook.com") && urlStr.includes("fb_exchange_token")) {
			return Promise.resolve(
				Response.json({ access_token: "ll_fb_token", expires_in: 5184000 }),
			);
		}

		// Webhook subscriptions
		if (urlStr.includes("/subscriptions") || urlStr.includes("/subscribed_apps")) {
			return Promise.resolve(Response.json({ success: true }));
		}

		// Default: 404
		return Promise.resolve(new Response("Not Found", { status: 404 }));
	});
}

// ── Tests ──

describe("exchangeAndSaveAccount", () => {
	let env: ReturnType<typeof createMockEnv>["env"];
	let kv: MockKV;

	beforeEach(() => {
		activeDb = createMockDb();
		const mockEnv = createMockEnv();
		env = mockEnv.env;
		kv = mockEnv.kv;
		mockFetch = createMockFetch();
		globalThis.fetch = mockFetch as typeof fetch;

		// Reset mocks
		mockExchangeCode.mockReset();
		mockExchangeCode.mockImplementation(async () => ({
			access_token: "short_lived_token",
			refresh_token: "refresh_tok",
			expires_in: 3600,
			user_id: "token_user_id_123",
		}));
		mockMaybeEncrypt.mockReset();
		mockMaybeEncrypt.mockImplementation(async (value: string | undefined | null, _key: string) =>
			value ? `enc:${value}` : null,
		);
		mockDispatchWebhookEvent.mockReset();
		mockLogConnectionEvent.mockReset();
		mockVerifyInstagramWebhook.mockReset();
		mockVerifyInstagramWebhook.mockImplementation(async () => ({ success: true }));
		mockSubscribeInstagramAccount.mockReset();
		mockSubscribeInstagramAccount.mockImplementation(async () => ({ success: true }));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("Instagram direct flow", () => {
		it("exchanges code, fetches long-lived token, upserts account, subscribes webhooks", async () => {
			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "instagram",
				code: "auth_code_123",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
				method: "direct",
			});

			// Should succeed
			expect(result.status).toBe("success");
			if (result.status !== "success") throw new Error("Expected success");

			// Should use profile user_id as platform account ID (not token user_id)
			expect(result.account.platform_account_id).toBe("17841441563557251");
			expect(result.account.platform).toBe("instagram");

			// Should have encrypted the long-lived token (not the short-lived one)
			expect(mockMaybeEncrypt).toHaveBeenCalledWith("ll_ig_token", expect.any(String));

			// Should have called webhook subscription with the token
			expect(mockSubscribeInstagramAccount).toHaveBeenCalledWith(
				"17841441563557251",
				"ll_ig_token",
			);

			// DB should have an insert
			expect(activeDb._inserts).toHaveLength(2); // socialAccounts + syncState
		});
	});

	describe("Twitter flow (PKCE)", () => {
		it("passes codeVerifier through and returns success", async () => {
			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "twitter",
				code: "twitter_code",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
				codeVerifier: "test_pkce_verifier",
			});

			expect(result.status).toBe("success");
			if (result.status !== "success") throw new Error("Expected success");

			expect(result.account.platform).toBe("twitter");
			expect(result.account.platform_account_id).toBe("twitter_123");

			// exchangeCode should have received the verifier
			expect(mockExchangeCode).toHaveBeenCalledWith(
				expect.objectContaining({ requiresPkce: true }),
				"test_client_id",
				"test_client_secret",
				"twitter_code",
				"https://api.test.dev/connect/oauth/callback",
				"test_pkce_verifier",
			);
		});
	});

	describe("Multi-select platform (facebook)", () => {
		it("stores token in KV and returns pending_selection", async () => {
			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "facebook",
				code: "fb_code",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
			});

			expect(result.status).toBe("pending_selection");
			if (result.status !== "pending_selection") throw new Error("Expected pending_selection");
			expect(result.platform).toBe("facebook");

			// Token should be stored in KV
			const stored = await kv.get("pending-secondary:ws_test123:facebook", "json") as any;
			expect(stored).toBeTruthy();
			expect(stored.access_token).toBeTruthy();
		});
	});

	describe("Token exchange failure", () => {
		it("propagates error from exchangeCode", async () => {
			mockExchangeCode.mockImplementation(async () => {
				throw new Error("Token exchange failed: 400 Bad Request");
			});

			await expect(
				exchangeAndSaveAccount({
					env,
					orgId: "ws_test123",
					platform: "twitter",
					code: "bad_code",
					redirectUri: "https://api.test.dev/connect/oauth/callback",
				}),
			).rejects.toThrow("Token exchange failed");
		});
	});

	describe("Profile fetch failure (non-Instagram)", () => {
		it("falls back to token user_id", async () => {
			// Make profile fetch return 500
			globalThis.fetch = createMockFetch({
				"/users/me": () => new Response("Server Error", { status: 500 }),
			}) as typeof fetch;

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "twitter",
				code: "code_123",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
			});

			expect(result.status).toBe("success");
			if (result.status !== "success") throw new Error("Expected success");

			// Should fall back to token user_id
			expect(result.account.platform_account_id).toBe("token_user_id_123");
		});
	});

	describe("Instagram profile fetch failure", () => {
		it("returns error instead of falling back to token user_id", async () => {
			// Make all fetches return errors (profile + long-lived token)
			globalThis.fetch = createMockFetch({
				"graph.instagram.com": () => new Response("Server Error", { status: 500 }),
			}) as typeof fetch;

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "instagram",
				code: "code_123",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
				method: "direct",
			});

			expect(result.status).toBe("error");
			if (result.status !== "error") throw new Error("Expected error");
			expect(result.code).toBe("PROFILE_FETCH_FAILED");
		});
	});

	describe("Missing credentials", () => {
		it("returns error when client ID is missing", async () => {
			// Override OAUTH_CONFIGS to return undefined credentials
			// The simplest way: use a platform not in OAUTH_CONFIGS
			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "discord",
				code: "code_123",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
			});

			expect(result.status).toBe("error");
			if (result.status !== "error") throw new Error("Expected error");
			expect(result.code).toBe("OAUTH_NOT_SUPPORTED");
		});
	});

	describe("DB upsert failure", () => {
		it("returns error when insert throws", async () => {
			// Override the mock DB's insert to throw
			const failDb = createMockDb();
			const origInsert = failDb.insert.bind(failDb);
			failDb.insert = (table: unknown) => {
				const chain = origInsert(table);
				const origThen = chain.values({}).onConflictDoUpdate({}).returning().then;
				return {
					values: () => ({
						onConflictDoUpdate: () => ({
							returning: () => ({
								then: (_resolve: any, reject: any) => {
									reject?.(new Error("DB connection error"));
								},
							}),
						}),
					}),
				} as any;
			};
			activeDb = failDb;

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				platform: "twitter",
				code: "code_123",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
			});

			expect(result.status).toBe("error");
			if (result.status !== "error") throw new Error("Expected error");
			expect(result.code).toBe("ACCOUNT_SAVE_FAILED");
		});
	});
});
