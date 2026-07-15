/**
 * Integration tests for the OAuth connect flow (exchangeAndSaveAccount).
 *
 * These tests mock external HTTP calls and the database, but exercise the
 * actual handler logic: token exchange, long-lived token swap, profile
 * fetching, DB upsert, webhook subscriptions, and error handling.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

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
				profileUrl:
					"https://api.x.com/2/users/me?user.fields=profile_image_url",
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
				authUrl: "https://threads.com/oauth/authorize",
				tokenUrl: "https://graph.threads.com/oauth/access_token",
				profileUrl: "https://graph.threads.com/v1.0/me?fields=id,username,name",
				scopes: ["threads_basic", "threads_content_publish"],
			}),
			googlebusiness: makeConfig({
				profileUrl:
					"https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
				scopes: ["https://www.googleapis.com/auth/business.manage"],
			}),
			snapchat: makeConfig({
				profileUrl: "https://adsapi.snapchat.com/v1/me",
				scopes: ["snapchat-marketing-api"],
			}),
		},
		INSTAGRAM_DIRECT_CONFIG: makeConfig({
			authUrl: "https://www.instagram.com/oauth/authorize",
			tokenUrl: "https://api.instagram.com/oauth/access_token",
			profileUrl:
				"https://graph.instagram.com/v25.0/me?fields=user_id,username,name,profile_picture_url",
			scopes: [
				"instagram_business_basic",
				"instagram_business_content_publish",
			],
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
	const organization = {
		id: { name: "id" },
		lifecycleStatus: { name: "lifecycleStatus" },
		toString: () => "organization",
	};

	return {
		createDb: () => activeDb,
		organization,
		socialAccounts,
		socialAccountSyncState,
		eq: (col: unknown, val: unknown) => mockEq(col, val),
	};
});

mock.module("drizzle-orm", () => {
	const { mockEq } = require("./__mocks__/db");
	const noop = (...args: unknown[]) => args[0];
	return {
		eq: (col: unknown, val: unknown) => mockEq(col, val),
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

const mockMaybeEncrypt = mock(
	async (value: string | undefined | null, _key: string) =>
		value ? `enc:${value}` : null,
);
mock.module("../lib/crypto", () => ({
	maybeEncrypt: mockMaybeEncrypt,
	maybeDecrypt: mock(async (value: string) => value.replace("enc:", "")),
	encryptionKeyId: () => null,
	activeEncryptionKeyId: () => "default",
	encryptToken: mock(async (value: string) => value),
	decryptToken: mock(async (value: string) => value),
}));

const mockDispatchWebhookEvent = mock(async () => {});
const mockPersistWebhookEvent = mock(
	async (
		_tx: unknown,
		_orgId: string,
		_event: string,
		_data: unknown,
		options: { occurrenceId: string },
	) => ({
		eventId: "whe_test",
		occurrenceId: options.occurrenceId,
		deliveries: [],
	}),
);
const mockEnqueuePersistedWebhookEvent = mock(async () => {});
mock.module("../services/webhook-delivery", () => ({
	dispatchWebhookEvent: mockDispatchWebhookEvent,
	persistWebhookEventInTransaction: mockPersistWebhookEvent,
	enqueuePersistedWebhookEvent: mockEnqueuePersistedWebhookEvent,
}));
mock.module("../services/one-time-capability", () => ({
	issueOneTimeCapability: mock(async () => {}),
	claimOneTimeCapability: mock(async () => null),
}));
mock.module("../lib/request-access", () => ({
	assertWriteAccess: () => undefined,
	resolveOperationalCreateScope: mock(async () => ({
		ok: true,
		workspaceId: null,
		settingsRevision: 0,
	})),
	loadLiveApiKeyAuthorization: mock(
		async (_db: unknown, params: { apiKeyId: string }) => ({
			apiKeyId: params.apiKeyId,
			workspaceScope: "all" as const,
			permissions: ["write"],
		}),
	),
	validatePersistedOperationalScope: mock(async () => ({
		ok: true,
		authorization: {
			apiKeyId: "key_test",
			workspaceScope: "all" as const,
			permissions: ["write"],
		},
	})),
}));
mock.module("../services/account-revocation", () => ({
	supersedeAccountRevocationJob: mock(async () => {}),
}));
mock.module("../services/telegram-connection", () => ({
	issueTelegramConnectionChallenge: mock(async () => ({
		code: "RLAY-TESTCHALLENGE",
		expiresAt: new Date(Date.now() + 900_000),
	})),
	readTelegramConnectionChallenge: mock(async () => ({ status: "pending" })),
}));

const mockLogConnectionEvent = mock(async () => {});
mock.module("../routes/connections", () => ({
	default: new (require("@hono/zod-openapi").OpenAPIHono)(),
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

const mockDiscoverAdAccounts = mock(async () => []);
mock.module("../services/ad-service", () => ({
	discoverAdAccounts: mockDiscoverAdAccounts,
}));

// ── Import the function under test (AFTER all mocks) ──

const { exchangeAndSaveAccount } = await import("../routes/connect");

import { createMockDb } from "./__mocks__/db";
import { createMockEnv, type MockKV } from "./__mocks__/env";

// ── Global fetch mock ──

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

function createMockFetch(overrides: Record<string, () => Response> = {}) {
	return mock((url: string | URL | Request, _init?: RequestInit) => {
		const urlStr =
			typeof url === "string"
				? url
				: url instanceof URL
					? url.toString()
					: url.url;

		// Check overrides first
		for (const [pattern, handler] of Object.entries(overrides)) {
			if (urlStr.includes(pattern)) return Promise.resolve(handler());
		}

		// Long-lived token exchange (path is /access_token, not query param)
		if (
			urlStr.includes("graph.instagram.com") &&
			urlStr.includes("/access_token?")
		) {
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
		if (
			urlStr.includes("graph.facebook.com") &&
			urlStr.includes("fb_exchange_token")
		) {
			return Promise.resolve(
				Response.json({ access_token: "ll_fb_token", expires_in: 5184000 }),
			);
		}

		// Webhook subscriptions
		if (
			urlStr.includes("/subscriptions") ||
			urlStr.includes("/subscribed_apps")
		) {
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
		activeDb._seed("organization", [
			{ id: "ws_test123", lifecycleStatus: "active" },
		]);
		const mockEnv = createMockEnv();
		env = mockEnv.env;
		kv = mockEnv.kv;
		mockFetch = createMockFetch();
		globalThis.fetch = mockFetch as unknown as typeof fetch;

		// Reset mocks
		mockExchangeCode.mockReset();
		mockExchangeCode.mockImplementation(async () => ({
			access_token: "short_lived_token",
			refresh_token: "refresh_tok",
			expires_in: 3600,
			user_id: "token_user_id_123",
		}));
		mockMaybeEncrypt.mockReset();
		mockMaybeEncrypt.mockImplementation(
			async (value: string | undefined | null, _key: string) =>
				value ? `enc:${value}` : null,
		);
		mockDispatchWebhookEvent.mockReset();
		mockPersistWebhookEvent.mockReset();
		mockPersistWebhookEvent.mockImplementation(
			async (
				_tx: unknown,
				_orgId: string,
				_event: string,
				_data: unknown,
				options: { occurrenceId: string },
			) => ({
				eventId: "whe_test",
				occurrenceId: options.occurrenceId,
				deliveries: [],
			}),
		);
		mockEnqueuePersistedWebhookEvent.mockReset();
		mockLogConnectionEvent.mockReset();
		mockVerifyInstagramWebhook.mockReset();
		mockVerifyInstagramWebhook.mockImplementation(async () => ({
			success: true,
		}));
		mockSubscribeInstagramAccount.mockReset();
		mockSubscribeInstagramAccount.mockImplementation(async () => ({
			success: true,
		}));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("Instagram direct flow", () => {
		it("exchanges code, fetches long-lived token, upserts account, subscribes webhooks", async () => {
			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
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

			// The canonical writer seals the long-lived token to the stable account id.
			const credentialUpdate = activeDb._updates.find(
				(update) =>
					update.table === "socialAccounts" && "accessToken" in update.set,
			);
			expect(credentialUpdate?.set.accessToken).toBe("acct:v1:ll_ig_token");
			expect(mockMaybeEncrypt).not.toHaveBeenCalled();

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
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
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

		it("persists each connection operation as a distinct durable occurrence", async () => {
			for (const operationId of ["oauth-operation-a", "oauth-operation-b"]) {
				const result = await exchangeAndSaveAccount({
					env,
					orgId: "ws_test123",
					initiatorKeyId: "key_test",
					authorizedWorkspaceScope: "all",
					platform: "twitter",
					code: `code-${operationId}`,
					redirectUri: "https://api.test.dev/connect/oauth/callback",
					codeVerifier: "test_pkce_verifier",
					connectionOperationId: operationId,
				});
				expect(result.status).toBe("success");
			}

			expect(mockPersistWebhookEvent).toHaveBeenCalledTimes(2);
			expect(mockPersistWebhookEvent.mock.calls[0]?.[4]).toEqual({
				occurrenceId: "account-connect:oauth-operation-a",
			});
			expect(mockPersistWebhookEvent.mock.calls[1]?.[4]).toEqual({
				occurrenceId: "account-connect:oauth-operation-b",
			});
		});
	});

	describe("Multi-select platform (facebook)", () => {
		it("isolates each pending selection behind its own initiator-bound token", async () => {
			const first = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: ["ws_a"],
				workspaceId: "ws_a",
				workspaceWasExplicit: true,
				platform: "facebook",
				code: "fb_code_a",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
			});
			const second = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test_2",
				authorizedWorkspaceScope: ["ws_b"],
				workspaceId: "ws_b",
				workspaceWasExplicit: true,
				platform: "facebook",
				code: "fb_code_b",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
			});

			expect(first.status).toBe("pending_selection");
			expect(second.status).toBe("pending_selection");
			if (first.status !== "pending_selection")
				throw new Error("Expected pending_selection");
			if (second.status !== "pending_selection")
				throw new Error("Expected pending_selection");
			expect(first.platform).toBe("facebook");
			expect(second.platform).toBe("facebook");
			expect(first.connectToken).not.toBe(second.connectToken);

			const firstKey = `pending-secondary:ws_test123:facebook:${first.connectToken}`;
			const secondKey = `pending-secondary:ws_test123:facebook:${second.connectToken}`;
			const firstStored = (await kv.get(firstKey, "json")) as {
				access_token?: unknown;
				connection_operation_id?: unknown;
				initiator_key_id?: unknown;
				initial_workspace_scope?: unknown;
				workspace_id?: unknown;
			} | null;
			const secondStored = (await kv.get(secondKey, "json")) as {
				access_token?: unknown;
				connection_operation_id?: unknown;
				initiator_key_id?: unknown;
				initial_workspace_scope?: unknown;
				workspace_id?: unknown;
			} | null;
			expect(firstStored).toEqual(
				expect.objectContaining({
					access_token: expect.any(String),
					connection_operation_id: expect.any(String),
					initiator_key_id: "key_test",
					initial_workspace_scope: ["ws_a"],
					workspace_id: "ws_a",
				}),
			);
			expect(secondStored).toEqual(
				expect.objectContaining({
					access_token: expect.any(String),
					connection_operation_id: expect.any(String),
					initiator_key_id: "key_test_2",
					initial_workspace_scope: ["ws_b"],
					workspace_id: "ws_b",
				}),
			);
			expect(kv._raw().has("pending-secondary:ws_test123:facebook")).toBe(
				false,
			);
		});
	});

	describe("Transactional webhook outbox", () => {
		it("fails the account save when the source-side webhook outbox cannot persist", async () => {
			mockPersistWebhookEvent.mockImplementationOnce(async () => {
				throw new Error("webhook outbox unavailable");
			});

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
				platform: "twitter",
				code: "twitter_code",
				redirectUri: "https://api.test.dev/connect/oauth/callback",
				codeVerifier: "test_pkce_verifier",
				connectionOperationId: "oauth-operation-failing",
			});

			expect(result.status).toBe("error");
			if (result.status !== "error") throw new Error("Expected error");
			expect(result.code).toBe("ACCOUNT_SAVE_FAILED");
			expect(mockEnqueuePersistedWebhookEvent).not.toHaveBeenCalled();
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
					initiatorKeyId: "key_test",
					authorizedWorkspaceScope: "all",
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
			}) as unknown as typeof fetch;

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
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
				"graph.instagram.com": () =>
					new Response("Server Error", { status: 500 }),
			}) as unknown as typeof fetch;

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
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
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
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
			failDb.insert = (_table: unknown) => {
				return {
					values: () => ({
						onConflictDoUpdate: () => ({
							returning: () => ({
								// biome-ignore lint/suspicious/noThenProperty: intentional thenable to simulate an awaitable query that rejects
								then: (
									_resolve: (value: unknown) => void,
									reject?: (err: unknown) => void,
								) => {
									reject?.(new Error("DB connection error"));
								},
							}),
						}),
					}),
				} as unknown as ReturnType<typeof failDb.insert>;
			};
			failDb.transaction = async <T>(
				callback: (tx: typeof failDb) => Promise<T>,
			): Promise<T> => callback(failDb);
			activeDb = failDb;

			const result = await exchangeAndSaveAccount({
				env,
				orgId: "ws_test123",
				initiatorKeyId: "key_test",
				authorizedWorkspaceScope: "all",
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
