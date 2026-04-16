import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createDb, socialAccounts, socialAccountSyncState } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import {
	OAUTH_CONFIGS,
	INSTAGRAM_DIRECT_CONFIG,
	buildAuthUrl,
	exchangeCode,
	generatePkce,
	generateStateToken,
} from "../config/oauth";
import type { Platform } from "../schemas/common";
import { ErrorResponse } from "../schemas/common";
import { maybeEncrypt, maybeDecrypt } from "../lib/crypto";
import { isAllowedCustomerRedirectUrl } from "../lib/customer-redirect";
import {
	assertAllWorkspaceScope,
	assertWriteAccess,
} from "../lib/request-access";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { dispatchWebhookEvent } from "../services/webhook-delivery";
import {
	sanitizeSocialAccountMetadata,
	withMetaAdsUserAccessToken,
} from "../services/ad-access-token";
import { socialPlatformToAdPlatform } from "../services/ad-platforms";
import { discoverAdAccounts } from "../services/ad-service";
import { getSupportedSyncPlatforms } from "../services/external-post-sync/index";
import type { SyncPostsMessage } from "../services/external-post-sync/types";
import { logConnectionEvent } from "./connections";
import { subscribeFacebookPage, subscribeInstagramAccount, verifyInstagramWebhookSubscription, verifyWhatsAppWebhookSubscription } from "../services/webhook-subscription";
import {
	CompleteOAuthBody,
	CompleteOAuthParams,
	CompleteOAuthResponse,
	ConnectBeehiivBody,
	ConnectBlueskyBody,
	ConnectConvertKitBody,
	ConnectListMonkBody,
	ConnectMailchimpBody,
	ConnectTelegramDirectBody,
	FacebookPagesResponse,
	GBPLocationsResponse,
	InitTelegramResponse,
	LinkedInOrgsResponse,
	PendingDataQuery,
	PendingDataResponse,
	PinterestBoardsResponse,
	SelectFacebookPageBody,
	SelectGBPLocationBody,
	SelectLinkedInOrgBody,
	SelectPinterestBoardBody,
	SelectSnapchatProfileBody,
	SnapchatProfilesResponse,
	StartOAuthParams,
	StartOAuthQuery,
	StartOAuthResponse,
	TelegramStatusQuery,
	TelegramStatusResponse,
	WhatsAppCredentialsBody,
	WhatsAppEmbeddedSignupBody,
	WhatsAppSDKConfigResponse,
} from "../schemas/connect";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
	const denied = assertWriteAccess(c) ?? assertAllWorkspaceScope(
		c,
		"Connecting or managing accounts requires an API key with access to all workspaces.",
	);
	if (denied) return denied;
	return next();
});

// ===========================================================================
// Core OAuth flow
// ===========================================================================

const startOAuth = createRoute({
	operationId: "startOAuth",
	method: "get",
	path: "/{platform}",
	tags: ["Connect"],
	summary: "Start OAuth flow",
	description:
		"Returns an auth_url to redirect the user for OAuth authorization.",
	security: [{ Bearer: [] }],
	request: { params: StartOAuthParams, query: StartOAuthQuery },
	responses: {
		200: {
			description: "OAuth URL",
			content: { "application/json": { schema: StartOAuthResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const completeOAuth = createRoute({
	operationId: "completeOAuth",
	method: "post",
	path: "/{platform}",
	tags: ["Connect"],
	summary: "Complete OAuth callback",
	description: "Exchange OAuth code for tokens and save the account.",
	security: [{ Bearer: [] }],
	request: {
		params: CompleteOAuthParams,
		body: { content: { "application/json": { schema: CompleteOAuthBody } } },
	},
	responses: {
		201: {
			description: "Account connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ===========================================================================
// Newsletter platforms (API-key-based)
// ===========================================================================

const connectBeehiiv = createRoute({
	operationId: "connectBeehiiv",
	method: "post",
	path: "/beehiiv",
	tags: ["Connect"],
	summary: "Connect Beehiiv newsletter",
	security: [{ Bearer: [] }],
	request: { body: { content: { "application/json": { schema: ConnectBeehiivBody } } } },
	responses: {
		200: { description: "Connected", content: { "application/json": { schema: CompleteOAuthResponse } } },
		400: { description: "Auth failed", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const connectConvertKit = createRoute({
	operationId: "connectConvertKit",
	method: "post",
	path: "/convertkit",
	tags: ["Connect"],
	summary: "Connect ConvertKit (Kit) newsletter",
	security: [{ Bearer: [] }],
	request: { body: { content: { "application/json": { schema: ConnectConvertKitBody } } } },
	responses: {
		200: { description: "Connected", content: { "application/json": { schema: CompleteOAuthResponse } } },
		400: { description: "Auth failed", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const connectMailchimp = createRoute({
	operationId: "connectMailchimp",
	method: "post",
	path: "/mailchimp",
	tags: ["Connect"],
	summary: "Connect Mailchimp newsletter",
	security: [{ Bearer: [] }],
	request: { body: { content: { "application/json": { schema: ConnectMailchimpBody } } } },
	responses: {
		200: { description: "Connected", content: { "application/json": { schema: CompleteOAuthResponse } } },
		400: { description: "Auth failed", content: { "application/json": { schema: ErrorResponse } } },
	},
});

const connectListMonk = createRoute({
	operationId: "connectListMonk",
	method: "post",
	path: "/listmonk",
	tags: ["Connect"],
	summary: "Connect self-hosted ListMonk newsletter",
	security: [{ Bearer: [] }],
	request: { body: { content: { "application/json": { schema: ConnectListMonkBody } } } },
	responses: {
		200: { description: "Connected", content: { "application/json": { schema: CompleteOAuthResponse } } },
		400: { description: "Auth failed", content: { "application/json": { schema: ErrorResponse } } },
	},
});

// ===========================================================================
// Bluesky (credentials)
// ===========================================================================

const connectBluesky = createRoute({
	operationId: "connectBluesky",
	method: "post",
	path: "/bluesky",
	tags: ["Connect"],
	summary: "Connect Bluesky via app password",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ConnectBlueskyBody } },
		},
	},
	responses: {
		201: {
			description: "Account connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ===========================================================================
// Telegram
// ===========================================================================

const initTelegram = createRoute({
	operationId: "initTelegram",
	method: "post",
	path: "/telegram",
	tags: ["Connect"],
	summary: "Initiate Telegram bot connection",
	description: "Generates a 6-character access code (valid 15 minutes).",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Access code generated",
			content: { "application/json": { schema: InitTelegramResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const pollTelegram = createRoute({
	operationId: "pollTelegram",
	method: "get",
	path: "/telegram",
	tags: ["Connect"],
	summary: "Poll Telegram connection status",
	security: [{ Bearer: [] }],
	request: { query: TelegramStatusQuery },
	responses: {
		200: {
			description: "Connection status",
			content: {
				"application/json": { schema: TelegramStatusResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const connectTelegramDirect = createRoute({
	operationId: "connectTelegramDirect",
	method: "post",
	path: "/telegram/direct",
	tags: ["Connect"],
	summary: "Connect Telegram directly with chat ID",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: ConnectTelegramDirectBody },
			},
		},
	},
	responses: {
		201: {
			description: "Account connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ===========================================================================
// Pending data (headless)
// ===========================================================================

const getPendingData = createRoute({
	operationId: "getPendingData",
	method: "get",
	path: "/pending-data",
	tags: ["Connect"],
	summary: "Fetch pending OAuth data",
	description:
		"One-time use, expires after 10 minutes. For headless OAuth flows.",
	security: [{ Bearer: [] }],
	request: { query: PendingDataQuery },
	responses: {
		200: {
			description: "Pending OAuth data",
			content: { "application/json": { schema: PendingDataResponse } },
		},
		404: {
			description: "Token not found or expired",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ===========================================================================
// Secondary selection routes
// ===========================================================================

const listFacebookPages = createRoute({
	operationId: "listConnectFacebookPages",
	method: "get",
	path: "/facebook/pages",
	tags: ["Connect"],
	summary: "List Facebook Pages after OAuth",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Available pages",
			content: {
				"application/json": { schema: FacebookPagesResponse },
			},
		},
	},
});

const selectFacebookPage = createRoute({
	operationId: "selectFacebookPage",
	method: "post",
	path: "/facebook/pages",
	tags: ["Connect"],
	summary: "Select Facebook Page to connect",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: SelectFacebookPageBody },
			},
		},
	},
	responses: {
		201: {
			description: "Page connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

const listLinkedInOrgs = createRoute({
	operationId: "listConnectLinkedInOrgs",
	method: "get",
	path: "/linkedin/organizations",
	tags: ["Connect"],
	summary: "List LinkedIn organizations after OAuth",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Available organizations",
			content: { "application/json": { schema: LinkedInOrgsResponse } },
		},
	},
});

const selectLinkedInOrg = createRoute({
	operationId: "selectLinkedInOrg",
	method: "post",
	path: "/linkedin/organizations",
	tags: ["Connect"],
	summary: "Select LinkedIn organization",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: SelectLinkedInOrgBody },
			},
		},
	},
	responses: {
		201: {
			description: "Organization connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

const listPinterestBoards = createRoute({
	operationId: "listConnectPinterestBoards",
	method: "get",
	path: "/pinterest/boards",
	tags: ["Connect"],
	summary: "List Pinterest boards after OAuth",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Available boards",
			content: {
				"application/json": { schema: PinterestBoardsResponse },
			},
		},
	},
});

const selectPinterestBoard = createRoute({
	operationId: "selectPinterestBoard",
	method: "post",
	path: "/pinterest/boards",
	tags: ["Connect"],
	summary: "Select Pinterest board",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: SelectPinterestBoardBody },
			},
		},
	},
	responses: {
		201: {
			description: "Board connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

const listGBPLocations = createRoute({
	operationId: "listConnectGBPLocations",
	method: "get",
	path: "/googlebusiness/locations",
	tags: ["Connect"],
	summary: "List Google Business locations after OAuth",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Available locations",
			content: { "application/json": { schema: GBPLocationsResponse } },
		},
	},
});

const selectGBPLocation = createRoute({
	operationId: "selectGBPLocation",
	method: "post",
	path: "/googlebusiness/locations",
	tags: ["Connect"],
	summary: "Select Google Business location",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: SelectGBPLocationBody },
			},
		},
	},
	responses: {
		201: {
			description: "Location connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

const listSnapchatProfiles = createRoute({
	operationId: "listConnectSnapchatProfiles",
	method: "get",
	path: "/snapchat/profiles",
	tags: ["Connect"],
	summary: "List Snapchat Public Profiles after OAuth",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Available profiles",
			content: {
				"application/json": { schema: SnapchatProfilesResponse },
			},
		},
	},
});

const selectSnapchatProfile = createRoute({
	operationId: "selectSnapchatProfile",
	method: "post",
	path: "/snapchat/profiles",
	tags: ["Connect"],
	summary: "Select Snapchat Public Profile",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: SelectSnapchatProfileBody },
			},
		},
	},
	responses: {
		201: {
			description: "Profile connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

// ===========================================================================
// WhatsApp
// ===========================================================================

const whatsappSdkConfig = createRoute({
	operationId: "getWhatsAppSDKConfig",
	method: "get",
	path: "/whatsapp/sdk-config",
	tags: ["Connect"],
	summary: "Get WhatsApp Embedded Signup SDK config",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "SDK configuration",
			content: {
				"application/json": { schema: WhatsAppSDKConfigResponse },
			},
		},
	},
});

const whatsappEmbeddedSignup = createRoute({
	operationId: "completeWhatsAppEmbeddedSignup",
	method: "post",
	path: "/whatsapp/embedded-signup",
	tags: ["Connect"],
	summary: "Complete WhatsApp Embedded Signup",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: WhatsAppEmbeddedSignupBody },
			},
		},
	},
	responses: {
		201: {
			description: "WhatsApp account connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

const whatsappCredentials = createRoute({
	operationId: "connectWhatsAppCredentials",
	method: "post",
	path: "/whatsapp/credentials",
	tags: ["Connect"],
	summary: "Connect WhatsApp via System User credentials",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: WhatsAppCredentialsBody },
			},
		},
	},
	responses: {
		201: {
			description: "WhatsApp account connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
	},
});

// ===========================================================================
// Helper: format account response
// ===========================================================================

function formatAccountResponse(account: {
	id: string;
	platform: string;
	platformAccountId: string;
	username: string | null;
	displayName: string | null;
	avatarUrl: string | null;
	metadata: unknown;
	connectedAt: Date;
	updatedAt: Date;
}) {
	return {
		account: {
			id: account.id,
			platform: account.platform,
			platform_account_id: account.platformAccountId,
			username: account.username,
			display_name: account.displayName,
			avatar_url: account.avatarUrl,
			metadata: sanitizeSocialAccountMetadata(account.metadata),
			connected_at: account.connectedAt.toISOString(),
			updated_at: account.updatedAt.toISOString(),
		},
	};
}

// ===========================================================================
// Shared OAuth exchange logic
// ===========================================================================

const SECONDARY_SELECTION_PLATFORMS = new Set([
	"facebook",
	"linkedin",
	"pinterest",
	"googlebusiness",
	"snapchat",
]);

export type OAuthExchangeResult =
	| { status: "success"; account: ReturnType<typeof formatAccountResponse>["account"] }
	| { status: "pending_selection"; platform: string }
	| { status: "error"; code: string; message: string };

/**
 * Shared logic: exchange OAuth code for tokens, fetch profile, upsert account.
 * Used by both the POST completeOAuth endpoint and the GET server-side callback route.
 */
export async function exchangeAndSaveAccount(params: {
	env: Env;
	orgId: string;
	platform: string;
	code: string;
	redirectUri: string;
	codeVerifier?: string;
	method?: string;
}): Promise<OAuthExchangeResult> {
	const { env, orgId, platform, code, redirectUri, codeVerifier, method } = params;

	const isInstagramDirect = platform === "instagram" && method === "direct";
	const oauthConfig = isInstagramDirect
		? INSTAGRAM_DIRECT_CONFIG
		: OAUTH_CONFIGS[platform as Platform];
	if (!oauthConfig) {
		return { status: "error", code: "OAUTH_NOT_SUPPORTED", message: `OAuth is not configured for ${platform}.` };
	}

	const clientId = oauthConfig.getClientId(env);
	const clientSecret = oauthConfig.getClientSecret(env);
	if (!clientId || !clientSecret) {
		return { status: "error", code: "MISSING_CREDENTIALS", message: `OAuth credentials not configured for ${platform}.` };
	}

	// Exchange code for tokens
	const tokens = await exchangeCode(oauthConfig, clientId, clientSecret, code, redirectUri, codeVerifier);
	console.log(`[oauth][${platform}] Token exchange success: token_received=${!!tokens.access_token}, user_id=${tokens.user_id ?? "none"}, expires_in=${tokens.expires_in ?? "none"}`);

	// Threads: exchange short-lived token (1h) for long-lived token (60 days)
	// Note: Meta docs specify GET-only for this endpoint — secrets in URL is an accepted platform limitation
	if (platform === "threads" && tokens.access_token) {
		try {
			const llRes = await fetch(
				`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${clientSecret}&access_token=${tokens.access_token}`,
			);
			if (llRes.ok) {
				const llData = (await llRes.json()) as { access_token: string; expires_in?: number };
				tokens.access_token = llData.access_token;
				tokens.expires_in = llData.expires_in;
			}
		} catch {
			// Continue with short-lived token if exchange fails
		}
	}

	// Instagram (direct): exchange short-lived token for long-lived token (60 days)
	// Docs: https://developers.facebook.com/docs/instagram-platform/reference/access_token
	// Note: Meta docs specify GET-only — secrets in URL is an accepted platform limitation
	if (isInstagramDirect && tokens.access_token) {
		try {
			const llParams = new URLSearchParams({
				grant_type: "ig_exchange_token",
				client_secret: clientSecret,
				access_token: tokens.access_token,
			});
			const llRes = await fetch(`https://graph.instagram.com/v25.0/access_token?${llParams}`);
			if (llRes.ok) {
				const llData = (await llRes.json()) as { access_token: string; expires_in?: number };
				tokens.access_token = llData.access_token;
				tokens.expires_in = llData.expires_in;
			} else {
				console.warn(`[oauth][${platform}] Long-lived token exchange failed: ${llRes.status} ${await llRes.text()}`);
			}
		} catch (err) {
			console.warn(`[oauth][${platform}] Long-lived token exchange error:`, err);
		}
	}

	// Facebook/Instagram (via Facebook): exchange short-lived token for long-lived token (60 days)
	// Note: Meta docs specify GET-only — secrets in URL is an accepted platform limitation
	if ((platform === "facebook" || (platform === "instagram" && !isInstagramDirect)) && tokens.access_token) {
		try {
			const llRes = await fetch(
				`https://graph.facebook.com/v25.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${tokens.access_token}`,
			);
			if (llRes.ok) {
				const llData = (await llRes.json()) as { access_token: string; expires_in?: number };
				tokens.access_token = llData.access_token;
				tokens.expires_in = llData.expires_in;
			}
		} catch {
			// Continue with short-lived token if exchange fails
		}
	}

	// Fetch user profile
	let profileId: string | null = null;
	let igAppScopedId: string | null = null; // Instagram Login: app-scoped IGUID used by webhooks
	let username: string | null = null;
	let displayName = `${platform} account`;
	let avatarUrl: string | null = null;

	try {
		// Instagram Graph API (graph.instagram.com) requires access_token as query param, not Bearer header
		let profileUrl: string;
		if (isInstagramDirect) {
			const url = new URL(oauthConfig.profileUrl);
			url.searchParams.set("access_token", tokens.access_token);
			profileUrl = url.toString();
		} else {
			profileUrl = oauthConfig.profileUrl;
		}
		console.log(`[oauth][${platform}] Profile fetch URL: ${profileUrl.replace(/access_token=[^&]+/, "access_token=REDACTED")}`);
		const profileRes = await fetch(profileUrl, isInstagramDirect
			? {}
			: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
		);
		if (profileRes.ok) {
			const profile = (await profileRes.json()) as Record<string, unknown>;
			console.log(`[oauth][${platform}] Profile fetched: id=${profile.id}`);

			if (platform === "twitter") {
				const data = (profile as { data?: { id?: string; username?: string; name?: string; profile_image_url?: string } }).data;
				profileId = data?.id ?? null;
				username = data?.username ?? null;
				displayName = data?.name ?? displayName;
				avatarUrl = data?.profile_image_url ?? null;
			} else if (platform === "linkedin") {
				profileId = (profile as { sub?: string }).sub ?? null;
				username = (profile as { name?: string }).name ?? null;
				displayName = username ?? displayName;
				avatarUrl = (profile as { picture?: string }).picture ?? null;
			} else if (isInstagramDirect) {
				// Instagram API with Instagram Login returns: user_id, username, name, profile_picture_url
				// IMPORTANT: user_id is the IG Professional Account ID — always prefer it over id (app-scoped IGUID)
				// We store user_id as platformAccountId (needed for Graph API calls).
				// The webhook entry.id uses the IGBA ID (from Facebook Page link), which differs from
				// both user_id and id. The webhook handler auto-resolves this via username matching.
				const igUserId = (profile as { user_id?: string }).user_id;
				const igId = (profile as { id?: string }).id;
				profileId = igUserId ?? igId ?? null;
				igAppScopedId = igId ?? null;
				console.log(`[oauth][${platform}] Profile ID resolved: ${profileId} (source: ${igUserId ? "profile.user_id" : igId ? "profile.id" : "none"}), appScopedId: ${igAppScopedId}`);
				username = (profile as { username?: string }).username ?? null;
				displayName = (profile as { name?: string }).name ?? username ?? displayName;
				avatarUrl = (profile as { profile_picture_url?: string }).profile_picture_url ?? null;
			} else if (platform === "instagram" && !isInstagramDirect) {
				// Instagram via Facebook Login: the /me profile returns the Facebook User ID.
				// We need the linked Instagram Business Account ID from the user's Pages.
				// Fetch pages with instagram_business_account to find the IGBA.
				try {
					const pagesRes = await fetch(
						`https://graph.facebook.com/v25.0/me/accounts?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${tokens.access_token}`,
					);
					if (pagesRes.ok) {
						const pagesData = (await pagesRes.json()) as {
							data: Array<{
								instagram_business_account?: {
									id: string;
									username?: string;
									name?: string;
									profile_picture_url?: string;
								};
							}>;
						};
						// Find the first page with a linked Instagram Business Account
						const igba = pagesData.data
							?.map((p) => p.instagram_business_account)
							.find((iga) => iga?.id);
						if (igba) {
							profileId = igba.id;
							username = igba.username ?? null;
							displayName = igba.name ?? igba.username ?? displayName;
							avatarUrl = igba.profile_picture_url ?? null;
							console.log(`[oauth][instagram] Resolved IGBA from Facebook Pages: id=${igba.id}`);
						}
					}
				} catch (err) {
					console.error("[oauth][instagram] Failed to fetch IGBA from Pages:", err);
				}
				// Fallback to Facebook user profile if no IGBA found
				if (!profileId) {
					profileId = (profile as { id?: string }).id ?? null;
					username = (profile as { name?: string }).name ?? null;
					displayName = username ?? displayName;
					console.warn("[oauth][instagram] No IGBA found on any Facebook Page, falling back to Facebook User ID");
				}
			} else if (platform === "facebook") {
				profileId = (profile as { id?: string }).id ?? null;
				username = (profile as { name?: string }).name ?? null;
				displayName = username ?? displayName;
			} else if (platform === "youtube") {
				const items = (profile as { items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }> }).items;
				const channel = items?.[0];
				profileId = channel?.id ?? null;
				displayName = channel?.snippet?.title ?? displayName;
				avatarUrl = channel?.snippet?.thumbnails?.default?.url ?? null;
			} else if (platform === "threads") {
				profileId = (profile as { id?: string }).id ?? null;
				username = (profile as { username?: string }).username ?? null;
				displayName = (profile as { name?: string }).name ?? username ?? displayName;
				avatarUrl = (profile as { threads_profile_picture_url?: string }).threads_profile_picture_url ?? null;
			} else {
				profileId = (profile as { id?: string }).id ?? (profile as { user_id?: string }).user_id ?? null;
				username = (profile as { username?: string }).username ?? (profile as { name?: string }).name ?? null;
				displayName = username ?? displayName;
			}
		} else {
			const errBody = await profileRes.text().catch(() => "");
			console.error(`[oauth][${platform}] Profile fetch failed: ${profileRes.status} ${errBody}`);
		}
	} catch (err) {
		console.error(`[oauth][${platform}] Profile fetch error:`, err);
	}

	// Fallback: use user_id from token response
	// IMPORTANT: For Instagram direct, tokens.user_id is an app-scoped ID that differs from
	// the profile's user_id (IG Professional Account ID). Using it would create ghost duplicates
	// that the unique constraint can't catch. Reject instead of creating inconsistent data.
	if (!profileId && tokens.user_id) {
		if (isInstagramDirect) {
			console.error(`[oauth][${platform}] Profile fetch failed — refusing to fall back to token user_id (different ID type would create duplicates)`);
			return { status: "error", code: "PROFILE_FETCH_FAILED", message: "Could not retrieve your Instagram profile. Please try again." };
		}
		console.log(`[oauth][${platform}] Using user_id from token response as fallback profileId: ${tokens.user_id}`);
		profileId = String(tokens.user_id);
	}

	if (!profileId) {
		console.error(`[oauth][${platform}] No profileId available — profile fetch and token user_id both failed`);
		return { status: "error", code: "PROFILE_FETCH_FAILED", message: `Could not retrieve your ${platform} profile. Please try again.` };
	}

	const tokenExpiresAt = tokens.expires_in
		? new Date(Date.now() + tokens.expires_in * 1000)
		: null;

	// Multi-select platforms: store token for secondary selection step
	if (SECONDARY_SELECTION_PLATFORMS.has(platform)) {
		// SECURITY: Encrypt access token before storing in KV (consistent with DB encryption at rest)
		const encryptedToken = await maybeEncrypt(tokens.access_token, env.ENCRYPTION_KEY);
		await env.KV.put(
			`pending-secondary:${orgId}:${platform}`,
			JSON.stringify({
				access_token: encryptedToken,
				profile_id: profileId,
				expires_at: tokenExpiresAt?.toISOString() ?? null,
			}),
			{ expirationTtl: 600 },
		);
		return { status: "pending_selection", platform };
	}

	// Single-select platforms: atomic upsert account
	console.log(`[oauth][${platform}] Upserting account: orgId=${orgId}, profileId=${profileId}`);
	const db = createDb(env.HYPERDRIVE.connectionString);

	const encKey = env.ENCRYPTION_KEY;
	const encAccessToken = await maybeEncrypt(tokens.access_token, encKey);
	const encRefreshToken = await maybeEncrypt(tokens.refresh_token, encKey);
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: platform as Platform,
				platformAccountId: profileId,
				username,
				displayName,
				avatarUrl,
				accessToken: encAccessToken,
				refreshToken: encRefreshToken,
				tokenExpiresAt,
				scopes: oauthConfig.scopes,
				...(igAppScopedId ? { webhookAccountId: igAppScopedId } : {}),
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					username,
					displayName,
					avatarUrl,
					accessToken: encAccessToken,
					refreshToken: encRefreshToken,
					tokenExpiresAt,
					scopes: oauthConfig.scopes,
					updatedAt: new Date(),
					...(igAppScopedId ? { webhookAccountId: igAppScopedId } : {}),
				},
			})
			.returning();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[oauth][${platform}] Account upsert failed:`, message);
		return { status: "error", code: "ACCOUNT_SAVE_FAILED", message: `Failed to save your ${platform} account. Please try connecting again.` };
	}

	if (!account) {
		console.error(`[oauth][${platform}] Upsert returned no account`);
		return { status: "error", code: "INTERNAL_ERROR", message: "Failed to save account" };
	}

	// Detect whether this was a new insert or an update to an existing account
	const isNewAccount = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewAccount) {
		console.log(`[oauth][${platform}] Inserted new account ${account.id}`);
		await dispatchWebhookEvent(env, db, orgId, "account.connected", {
			account_id: account.id,
			platform: account.platform,
			username: account.username,
			display_name: account.displayName,
		});
		await logConnectionEvent(env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || platform} account`,
		});
	} else {
		console.log(`[oauth][${platform}] Updated existing account ${account.id}`);
		await logConnectionEvent(env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Reconnected ${account.displayName || account.username || platform} account`,
		});
	}

	// Subscribe YouTube channels to PubSubHubbub for video upload notifications
	if (platform === "youtube" && profileId) {
		const apiBaseUrl = env.API_BASE_URL || "https://api.relayapi.dev";
		await env.INBOX_QUEUE.send({
			type: "youtube_subscribe" as const,
			platform: "youtube",
			platform_account_id: profileId,
			organization_id: orgId,
			account_id: account.id,
			event_type: "subscribe",
			payload: { callback_url: `${apiBaseUrl}/webhooks/platform/youtube` },
			received_at: new Date().toISOString(),
		});
	}

	// Subscribe Instagram app and user account to receive webhook events (messages, comments)
	if (platform === "instagram") {
		const igAppId = env.INSTAGRAM_LOGIN_APP_ID;
		const igAppSecret = env.INSTAGRAM_LOGIN_APP_SECRET;
		const verifyToken = env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;
		if (igAppId && igAppSecret && verifyToken) {
			const apiBaseUrl = env.API_BASE_URL || "https://api.relayapi.dev";
			const result = await verifyInstagramWebhookSubscription(
				igAppId,
				igAppSecret,
				`${apiBaseUrl}/webhooks/platform/facebook`,
				verifyToken,
			);
			if (!result.success) {
				console.error("[webhook-sub] Instagram subscription failed:", result.error);
			}
		}

		// Per-user subscription — required by Meta to deliver webhooks for this account
		// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/webhooks
		if (tokens.access_token) {
			const userSubResult = await subscribeInstagramAccount(profileId, tokens.access_token);
			if (!userSubResult.success) {
				console.error("[webhook-sub] Instagram user subscription failed:", userSubResult.error);
			}
		}
	}

	// Initialize external post sync state and enqueue immediate sync
	if (getSupportedSyncPlatforms().includes(platform)) {
		await db
			.insert(socialAccountSyncState)
			.values({
				socialAccountId: account.id,
				organizationId: orgId,
				platform: account.platform,
				nextSyncAt: new Date(),
			})
			.onConflictDoUpdate({
				target: socialAccountSyncState.socialAccountId,
				set: {
					enabled: true,
					nextSyncAt: new Date(),
					updatedAt: new Date(),
				},
			});

		// Enqueue immediately — don't wait for the 5-min cron
		await env.SYNC_QUEUE.send({
			type: "sync_posts",
			social_account_id: account.id,
			organization_id: orgId,
			platform,
		} satisfies SyncPostsMessage);
	}

	// Auto-discover ad accounts for platforms that support ads
	if (socialPlatformToAdPlatform(platform)) {
		try {
			await discoverAdAccounts(env, orgId, account.id);
			console.log(`[oauth][${platform}] Auto-discovered ad accounts for ${account.id}`);
		} catch (err) {
			// Non-critical — don't fail the connect flow if ad discovery fails
			console.error(`[oauth][${platform}] Ad account discovery failed (non-critical):`, err);
		}
	}

	return { status: "success", account: formatAccountResponse(account).account };
}

// ===========================================================================
// Route handlers — Bluesky and Telegram Direct must be registered
// BEFORE the /{platform} catch-all routes
// ===========================================================================

// --- Newsletter: Beehiiv ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectBeehiiv, async (c) => {
	const orgId = c.get("orgId");
	const { api_key, publication_id } = c.req.valid("json");
	const db = c.get("db");

	try {
		// Validate credentials by fetching publication info
		const res = await fetch(`https://api.beehiiv.com/v2/publications/${publication_id}`, {
			headers: { Authorization: `Bearer ${api_key}` },
		});
		if (!res.ok) {
			return c.json({ error: { code: "AUTH_FAILED", message: "Invalid Beehiiv API key or publication ID." } } as never, 400 as never);
		}
		const pub = (await res.json()) as { data?: { name?: string } };
		const pubName = pub.data?.name ?? "Beehiiv Newsletter";

		const encrypted = await maybeEncrypt(api_key, c.env.ENCRYPTION_KEY);
		const [account] = await db.insert(socialAccounts).values({
			organizationId: orgId, platform: "beehiiv", platformAccountId: publication_id,
			username: pubName, displayName: pubName, accessToken: encrypted,
			metadata: { publication_id, publication_name: pubName },
		}).onConflictDoUpdate({
			target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
			set: { username: pubName, displayName: pubName, accessToken: encrypted, metadata: { publication_id, publication_name: pubName }, updatedAt: new Date() },
		}).returning();

		c.executionCtx.waitUntil(dispatchWebhookEvent(c.env, db, orgId, "account.connected", { account_id: account!.id, platform: "beehiiv", username: pubName }));
		return c.json({ account_id: account!.id, platform: "beehiiv", username: pubName, display_name: pubName }, 200);
	} catch (err) {
		console.error("[connect] Connection failed:", err instanceof Error ? err.message : err);
		return c.json({ error: { code: "INTERNAL_ERROR", message: "Connection failed. Please try again." } } as never, 500 as never);
	}
});

// --- Newsletter: ConvertKit ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectConvertKit, async (c) => {
	const orgId = c.get("orgId");
	const { api_key, api_secret } = c.req.valid("json");
	const db = c.get("db");

	try {
		const res = await fetch(`https://api.convertkit.com/v3/account?api_secret=${api_secret}`);
		if (!res.ok) {
			return c.json({ error: { code: "AUTH_FAILED", message: "Invalid ConvertKit credentials." } } as never, 400 as never);
		}
		const account_info = (await res.json()) as { name?: string; primary_email_address?: string };
		const name = account_info.name ?? "ConvertKit";

		const encryptedKey = await maybeEncrypt(api_key, c.env.ENCRYPTION_KEY);
		const encryptedSecret = await maybeEncrypt(api_secret, c.env.ENCRYPTION_KEY);
		const [account] = await db.insert(socialAccounts).values({
			organizationId: orgId, platform: "convertkit", platformAccountId: api_key.slice(-8),
			username: name, displayName: name, accessToken: encryptedKey, refreshToken: encryptedSecret,
			metadata: { account_name: name },
		}).onConflictDoUpdate({
			target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
			set: { username: name, displayName: name, accessToken: encryptedKey, refreshToken: encryptedSecret, updatedAt: new Date() },
		}).returning();

		c.executionCtx.waitUntil(dispatchWebhookEvent(c.env, db, orgId, "account.connected", { account_id: account!.id, platform: "convertkit", username: name }));
		return c.json({ account_id: account!.id, platform: "convertkit", username: name, display_name: name }, 200);
	} catch (err) {
		console.error("[connect] Connection failed:", err instanceof Error ? err.message : err);
		return c.json({ error: { code: "INTERNAL_ERROR", message: "Connection failed. Please try again." } } as never, 500 as never);
	}
});

// --- Newsletter: Mailchimp ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectMailchimp, async (c) => {
	const orgId = c.get("orgId");
	const { api_key } = c.req.valid("json");
	const db = c.get("db");

	try {
		const datacenter = api_key.split("-").pop() ?? "us1";
		const authHeader = `Basic ${btoa(`relayapi:${api_key}`)}`;
		const res = await fetch(`https://${datacenter}.api.mailchimp.com/3.0/`, { headers: { Authorization: authHeader } });
		if (!res.ok) {
			return c.json({ error: { code: "AUTH_FAILED", message: "Invalid Mailchimp API key." } } as never, 400 as never);
		}
		const info = (await res.json()) as { account_name?: string; login_id?: string; account_id?: string };
		const name = info.account_name ?? "Mailchimp";
		const accountId = info.account_id ?? api_key.slice(-8);

		const encrypted = await maybeEncrypt(api_key, c.env.ENCRYPTION_KEY);
		const [account] = await db.insert(socialAccounts).values({
			organizationId: orgId, platform: "mailchimp", platformAccountId: accountId,
			username: name, displayName: name, accessToken: encrypted,
			metadata: { datacenter, account_name: name },
		}).onConflictDoUpdate({
			target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
			set: { username: name, displayName: name, accessToken: encrypted, metadata: { datacenter, account_name: name }, updatedAt: new Date() },
		}).returning();

		c.executionCtx.waitUntil(dispatchWebhookEvent(c.env, db, orgId, "account.connected", { account_id: account!.id, platform: "mailchimp", username: name }));
		return c.json({ account_id: account!.id, platform: "mailchimp", username: name, display_name: name }, 200);
	} catch (err) {
		console.error("[connect] Connection failed:", err instanceof Error ? err.message : err);
		return c.json({ error: { code: "INTERNAL_ERROR", message: "Connection failed. Please try again." } } as never, 500 as never);
	}
});

// --- Newsletter: ListMonk ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectListMonk, async (c) => {
	const orgId = c.get("orgId");
	const { instance_url, username: user, password } = c.req.valid("json");
	const db = c.get("db");

	try {
		const cleanUrl = instance_url.replace(/\/$/, "");

		// SSRF protection: block private/reserved IPs and non-HTTPS URLs
		if (await isBlockedUrlWithDns(cleanUrl)) {
			return c.json({ error: { code: "BAD_REQUEST", message: "instance_url must be a public host. Private/reserved IPs are not allowed." } } as never, 400 as never);
		}
		try {
			const parsed = new URL(cleanUrl);
			if (parsed.protocol !== "https:") {
				return c.json({ error: { code: "BAD_REQUEST", message: "instance_url must use HTTPS." } } as never, 400 as never);
			}
		} catch {
			return c.json({ error: { code: "BAD_REQUEST", message: "instance_url is not a valid URL." } } as never, 400 as never);
		}

		const basicAuth = btoa(`${user}:${password}`);
		const res = await fetch(`${cleanUrl}/api/settings`, {
			headers: { Authorization: `Basic ${basicAuth}` },
			redirect: "error",
		});
		if (!res.ok) {
			return c.json({ error: { code: "AUTH_FAILED", message: "Invalid ListMonk credentials or instance URL." } } as never, 400 as never);
		}

		const encrypted = await maybeEncrypt(basicAuth, c.env.ENCRYPTION_KEY);
		const name = `ListMonk (${new URL(cleanUrl).hostname})`;
		const [account] = await db.insert(socialAccounts).values({
			organizationId: orgId, platform: "listmonk", platformAccountId: cleanUrl,
			username: name, displayName: name, accessToken: encrypted,
			metadata: { instance_url: cleanUrl },
		}).onConflictDoUpdate({
			target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
			set: { username: name, displayName: name, accessToken: encrypted, metadata: { instance_url: cleanUrl }, updatedAt: new Date() },
		}).returning();

		c.executionCtx.waitUntil(dispatchWebhookEvent(c.env, db, orgId, "account.connected", { account_id: account!.id, platform: "listmonk", username: name }));
		return c.json({ account_id: account!.id, platform: "listmonk", username: name, display_name: name }, 200);
	} catch (err) {
		console.error("[connect] Connection failed:", err instanceof Error ? err.message : err);
		return c.json({ error: { code: "INTERNAL_ERROR", message: "Connection failed. Please try again." } } as never, 500 as never);
	}
});

// --- Bluesky (credential-based) ---
app.openapi(connectBluesky, async (c) => {
	const orgId = c.get("orgId");
	const { handle, app_password } = c.req.valid("json");
	const db = c.get("db");

	try {
		// Bluesky: Create an authenticated session using handle + app password
		// https://docs.bsky.app/docs/api/com-atproto-server-create-session
		const res = await fetch(
			"https://bsky.social/xrpc/com.atproto.server.createSession",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					identifier: handle,
					password: app_password,
				}),
			},
		);

		if (!res.ok) {
			return c.json(
				{
					error: {
						code: "AUTH_FAILED",
						message:
							"Bluesky authentication failed. Check handle and app password.",
					},
				} as never,
				400 as never,
			);
		}

		const session = (await res.json()) as {
			did: string;
			handle: string;
			email?: string;
		};

		// Atomic upsert: update if already connected
		const encryptedAppPw = await maybeEncrypt(app_password, c.env.ENCRYPTION_KEY);
		let account;
		try {
			[account] = await db
				.insert(socialAccounts)
				.values({
					organizationId: orgId,
					platform: "bluesky",
					platformAccountId: session.did,
					username: session.handle,
					displayName: session.handle,
					accessToken: encryptedAppPw,
				})
				.onConflictDoUpdate({
					target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
					set: {
						username: session.handle,
						displayName: session.handle,
						accessToken: encryptedAppPw,
						updatedAt: new Date(),
					},
				})
				.returning();
		} catch (err) {
			console.error("[oauth][bluesky] Account upsert failed:", err instanceof Error ? err.message : err);
			return c.json(
				{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save Bluesky account. Please try again." } } as never,
				500 as never,
			);
		}

		if (!account) {
			return c.json(
				{
					error: {
						code: "INTERNAL_ERROR",
						message: "Failed to save account",
					},
				} as never,
				500 as never,
			);
		}

		const isNewBlueskyAccount = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
		if (isNewBlueskyAccount) {
			c.executionCtx.waitUntil(
				dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
					account_id: account.id,
					platform: account.platform,
					username: account.username,
					display_name: account.displayName,
				}),
			);
			c.executionCtx.waitUntil(
				logConnectionEvent(c.env, orgId, {
					account_id: account.id,
					platform: account.platform,
					event: "connected",
					message: `Connected ${account.displayName || "bluesky"} account`,
				}),
			);
		} else {
			c.executionCtx.waitUntil(
				logConnectionEvent(c.env, orgId, {
					account_id: account.id,
					platform: account.platform,
					event: "connected",
					message: `Reconnected ${account.displayName || "bluesky"} account`,
				}),
			);
		}

		return c.json(formatAccountResponse(account) as never, 201 as never);
	} catch {
		return c.json(
			{
				error: {
					code: "CONNECTION_FAILED",
					message: "Failed to connect Bluesky account",
				},
			} as never,
			500 as never,
		);
	}
});

// --- Telegram ---
app.openapi(initTelegram, async (c) => {
	const code = Array.from(crypto.getRandomValues(new Uint8Array(3)))
		.map((b) => b.toString(16).padStart(2, "0").toUpperCase())
		.join("");
	const fullCode = `RLAY-${code}`;
	const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

	await c.env.KV.put(
		`telegram-code:${fullCode}`,
		JSON.stringify({ org_id: c.get("orgId"), status: "pending" }),
		{ expirationTtl: 900 },
	);

	return c.json(
		{
			code: fullCode,
			expires_at: expiresAt.toISOString(),
			expires_in: 900,
			bot_username: "RelayAPIBot",
			instructions: [
				"1. Add @RelayAPIBot as an administrator in your channel/group",
				"2. Open a private chat with @RelayAPIBot",
				`3. Send: ${fullCode} @yourchannel (replace @yourchannel with your channel username)`,
				"4. Wait for confirmation — poll GET /v1/connect/telegram?code=... for status",
			],
		} as never,
		200 as never,
	);
});

app.openapi(pollTelegram, async (c) => {
	const orgId = c.get("orgId");
	const { code } = c.req.valid("query");
	const data = await c.env.KV.get<{
		org_id: string;
		status: string;
		chat_id?: string;
		chat_title?: string;
	}>(`telegram-code:${code}`, "json");

	if (!data) {
		return c.json({ status: "expired" } as never, 200 as never);
	}

	// SECURITY: Verify the code belongs to the requesting org
	if (data.org_id !== orgId) {
		return c.json({ status: "expired" } as never, 200 as never);
	}

	return c.json(
		{
			status: data.status,
			chat_id: data.chat_id,
			chat_title: data.chat_title,
		} as never,
		200 as never,
	);
});

app.openapi(connectTelegramDirect, async (c) => {
	const orgId = c.get("orgId");
	const { chat_id } = c.req.valid("json");
	const db = c.get("db");

	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "telegram",
				platformAccountId: chat_id,
				username: null,
				displayName: `Telegram ${chat_id}`,
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					displayName: `Telegram ${chat_id}`,
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][telegram] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save Telegram account. Please try again." } } as never,
			500 as never,
		);
	}

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewTelegramAccount = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewTelegramAccount) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewTelegramAccount ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Pending data ---
app.openapi(getPendingData, async (c) => {
	const { token } = c.req.valid("query");
	const data = await c.env.KV.get(`pending-oauth:${token}`, "json");

	if (!data) {
		return c.json(
			{
				error: { code: "NOT_FOUND", message: "Token not found or expired" },
			} as never,
			404 as never,
		);
	}

	await c.env.KV.delete(`pending-oauth:${token}`);
	return c.json(data as never, 200 as never);
});

// --- WhatsApp ---
app.openapi(whatsappSdkConfig, async (c) => {
	const appId = c.env.WHATSAPP_APP_ID;
	const configId = c.env.WHATSAPP_CONFIG_ID;

	if (!appId || !configId) {
		return c.json(
			{
				error: {
					code: "MISSING_CREDENTIALS",
					message:
						"WhatsApp SDK credentials not configured. Set WHATSAPP_APP_ID and WHATSAPP_CONFIG_ID environment variables.",
				},
			} as never,
			400 as never,
		);
	}

	return c.json(
		{
			app_id: appId,
			config_id: configId,
		} as never,
		200 as never,
	);
});

app.openapi(whatsappEmbeddedSignup, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const appId = c.env.WHATSAPP_APP_ID;
	const appSecret = c.env.WHATSAPP_APP_SECRET;

	if (!appId || !appSecret) {
		return c.json(
			{
				error: {
					code: "MISSING_CREDENTIALS",
					message:
						"WhatsApp credentials not configured. Set WHATSAPP_APP_ID and WHATSAPP_APP_SECRET environment variables.",
				},
			} as never,
			400 as never,
		);
	}

	// Step 1: Exchange the code for an access token
	// https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow#exchangecode
	const tokenUrl = new URL("https://graph.facebook.com/v25.0/oauth/access_token");
	tokenUrl.searchParams.set("client_id", appId);
	tokenUrl.searchParams.set("client_secret", appSecret);
	tokenUrl.searchParams.set("code", body.code);

	const tokenRes = await fetch(tokenUrl.toString());
	const tokenData = (await tokenRes.json()) as {
		access_token?: string;
		error?: { message: string };
	};

	if (!tokenRes.ok || !tokenData.access_token) {
		return c.json(
			{
				error: {
					code: "TOKEN_EXCHANGE_FAILED",
					message:
						tokenData.error?.message ||
						"Failed to exchange code for access token",
				},
			} as never,
			400 as never,
		);
	}

	const accessToken = tokenData.access_token;

	// Step 2: Debug token to get WABA ID
	// https://developers.facebook.com/docs/graph-api/reference/debug_token/
	const appAccessToken = `${appId}|${appSecret}`;
	const debugUrl = new URL("https://graph.facebook.com/v25.0/debug_token");
	debugUrl.searchParams.set("input_token", accessToken);
	debugUrl.searchParams.set("access_token", appAccessToken);

	const debugRes = await fetch(debugUrl.toString());
	const debugData = (await debugRes.json()) as {
		data?: {
			granular_scopes?: Array<{
				scope: string;
				target_ids?: string[];
			}>;
		};
		error?: { message: string };
	};

	if (!debugRes.ok || !debugData.data) {
		return c.json(
			{
				error: {
					code: "DEBUG_TOKEN_FAILED",
					message:
						debugData.error?.message || "Failed to debug token for WABA ID",
				},
			} as never,
			400 as never,
		);
	}

	const wabaScope = debugData.data.granular_scopes?.find(
		(s) => s.scope === "whatsapp_business_management",
	);
	const wabaId = wabaScope?.target_ids?.[0];

	if (!wabaId) {
		return c.json(
			{
				error: {
					code: "WABA_NOT_FOUND",
					message:
						"No WhatsApp Business Account found in token permissions. Ensure whatsapp_business_management scope was granted.",
				},
			} as never,
			400 as never,
		);
	}

	// Step 3: Fetch phone number ID from WABA
	// https://developers.facebook.com/docs/whatsapp/business-management-api/manage-phone-numbers
	const phoneUrl = new URL(
		`https://graph.facebook.com/v25.0/${wabaId}/phone_numbers`,
	);
	phoneUrl.searchParams.set("access_token", accessToken);

	const phoneRes = await fetch(phoneUrl.toString());
	const phoneData = (await phoneRes.json()) as {
		data?: Array<{
			id: string;
			display_phone_number: string;
		}>;
		error?: { message: string };
	};

	if (!phoneRes.ok || !phoneData.data?.length) {
		return c.json(
			{
				error: {
					code: "PHONE_NUMBER_NOT_FOUND",
					message:
						phoneData.error?.message ||
						"No phone numbers found for this WhatsApp Business Account",
				},
			} as never,
			400 as never,
		);
	}

	const phone = phoneData.data![0]!;
	const phoneNumberId = phone.id;
	const displayPhoneNumber = phone.display_phone_number;

	// Step 4: Atomic upsert to handle re-connections gracefully
	const encryptedWaToken = await maybeEncrypt(accessToken, c.env.ENCRYPTION_KEY);
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "whatsapp",
				platformAccountId: phoneNumberId,
				accessToken: encryptedWaToken,
				displayName: displayPhoneNumber || "WhatsApp Business",
				metadata: { waba_id: wabaId, phone_number: displayPhoneNumber },
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					accessToken: encryptedWaToken,
					displayName: displayPhoneNumber || "WhatsApp Business",
					metadata: { waba_id: wabaId, phone_number: displayPhoneNumber },
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][whatsapp] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save WhatsApp account. Please try again." } } as never,
			500 as never,
		);
	}

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewWaAccount = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewWaAccount) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewWaAccount ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	if (c.env.WHATSAPP_APP_ID && c.env.WHATSAPP_APP_SECRET && c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) {
		c.executionCtx.waitUntil(
			verifyWhatsAppWebhookSubscription(
				c.env.WHATSAPP_APP_ID,
				c.env.WHATSAPP_APP_SECRET,
				`${c.env.API_BASE_URL || "https://api.relayapi.dev"}/webhooks/platform/whatsapp`,
				c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN,
			),
		);
	}

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

app.openapi(whatsappCredentials, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const encWaCredToken = await maybeEncrypt(body.access_token, c.env.ENCRYPTION_KEY);
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "whatsapp",
				platformAccountId: body.phone_number_id,
				accessToken: encWaCredToken,
				displayName: "WhatsApp Business",
				metadata: { waba_id: body.waba_id },
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					accessToken: encWaCredToken,
					displayName: "WhatsApp Business",
					metadata: { waba_id: body.waba_id },
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][whatsapp] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save WhatsApp account. Please try again." } } as never,
			500 as never,
		);
	}

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewWaCred = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewWaCred) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewWaCred ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	if (c.env.WHATSAPP_APP_ID && c.env.WHATSAPP_APP_SECRET && c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) {
		c.executionCtx.waitUntil(
			verifyWhatsAppWebhookSubscription(
				c.env.WHATSAPP_APP_ID,
				c.env.WHATSAPP_APP_SECRET,
				`${c.env.API_BASE_URL || "https://api.relayapi.dev"}/webhooks/platform/whatsapp`,
				c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN,
			),
		);
	}

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Facebook Pages ---
app.openapi(listFacebookPages, async (c) => {
	const orgId = c.get("orgId");
	const pendingData = await c.env.KV.get<{
		access_token: string;
		profile_id?: string;
		expires_at?: string | null;
	}>(`pending-secondary:${orgId}:facebook`, "json");

	if (!pendingData?.access_token) {
		return c.json({ pages: [] } as never, 200 as never);
	}
	// SECURITY: Decrypt token from KV
	const accessToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	try {
		// Facebook Pages API: List pages managed by the authenticated user
		// https://developers.facebook.com/docs/pages-api/overview
		const res = await fetch(
			`https://graph.facebook.com/v25.0/me/accounts?fields=id,name,category,access_token&access_token=${accessToken}`,
		);
		if (!res.ok) {
			return c.json({ pages: [] } as never, 200 as never);
		}
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				name: string;
				access_token: string;
				category: string;
			}>;
		};
		return c.json(
			{
				pages: json.data.map((p) => ({
					id: p.id,
					name: p.name,
					category: p.category,
				})),
			} as never,
			200 as never,
		);
	} catch {
		return c.json({ pages: [] } as never, 200 as never);
	}
});

app.openapi(selectFacebookPage, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const pendingData = await c.env.KV.get<{
		access_token: string;
		profile_id?: string;
		expires_at?: string | null;
	}>(`pending-secondary:${orgId}:facebook`, "json");

	if (!pendingData?.access_token) {
		return c.json(
			{
				error: {
					code: "NO_PENDING_DATA",
					message: "No pending Facebook OAuth data. Start OAuth flow first.",
				},
			} as never,
			400 as never,
		);
	}
	// SECURITY: Decrypt token from KV
	const decryptedFbToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	// Fetch page access token
	try {
		// Facebook Pages API: List pages to find the selected page's access token
		// https://developers.facebook.com/docs/pages-api/overview
		const res = await fetch(
			`https://graph.facebook.com/v25.0/me/accounts?access_token=${decryptedFbToken}`,
		);
		const json = (await res.json()) as {
			data: Array<{
				id: string;
				name: string;
				access_token: string;
			}>;
		};
		const page = json.data?.find((p) => p.id === body.page_id);

		if (!page) {
			return c.json(
				{
					error: { code: "NOT_FOUND", message: "Page not found in user's pages" },
				} as never,
				404 as never,
			);
		}

		// Fetch page avatar (picture)
		let pageAvatarUrl: string | null = null;
		try {
			const picRes = await fetch(
				`https://graph.facebook.com/v25.0/${page.id}/picture?redirect=false&type=small&access_token=${page.access_token}`,
			);
			if (picRes.ok) {
				const picJson = (await picRes.json()) as { data?: { url?: string } };
				pageAvatarUrl = picJson.data?.url ?? null;
			}
		} catch {
			// Avatar fetch failed — proceed without it
		}

		// Atomic upsert: update if page already connected, insert otherwise
		const encryptedPageToken = await maybeEncrypt(page.access_token, c.env.ENCRYPTION_KEY);
		const [existingAccount] = await db
			.select({ metadata: socialAccounts.metadata })
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.organizationId, orgId),
					eq(socialAccounts.platform, "facebook"),
					eq(socialAccounts.platformAccountId, page.id),
				),
			)
			.limit(1);
		const metadata = withMetaAdsUserAccessToken(
			existingAccount?.metadata ?? null,
			pendingData.access_token,
			pendingData.profile_id,
			pendingData.expires_at ?? null,
		);
		let account;
		try {
			[account] = await db
				.insert(socialAccounts)
				.values({
					organizationId: orgId,
					platform: "facebook",
					platformAccountId: page.id,
					username: page.name,
					displayName: page.name,
					avatarUrl: pageAvatarUrl,
					accessToken: encryptedPageToken,
					scopes: OAUTH_CONFIGS.facebook!.scopes,
					metadata,
				})
				.onConflictDoUpdate({
					target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
					set: {
						username: page.name,
						displayName: page.name,
						avatarUrl: pageAvatarUrl,
						accessToken: encryptedPageToken,
						scopes: OAUTH_CONFIGS.facebook!.scopes,
						metadata,
						updatedAt: new Date(),
					},
				})
				.returning();
		} catch (err) {
			console.error("[oauth][facebook] Account upsert failed:", err instanceof Error ? err.message : err);
			return c.json(
				{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save Facebook page. Please try again." } } as never,
				500 as never,
			);
		}

		if (account) {
			const isNewFbPage = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
			if (isNewFbPage) {
				c.executionCtx.waitUntil(
					dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
						account_id: account.id,
						platform: account.platform,
						username: account.username,
						display_name: account.displayName,
					}),
				);
				c.executionCtx.waitUntil(
					logConnectionEvent(c.env, orgId, {
						account_id: account.id,
						platform: account.platform,
						event: "connected",
						message: `Connected ${account.displayName || "facebook"} page`,
					}),
				);
			} else {
				c.executionCtx.waitUntil(
					logConnectionEvent(c.env, orgId, {
						account_id: account.id,
						platform: account.platform,
						event: "connected",
						message: `Reconnected ${account.displayName || "facebook"} page`,
					}),
				);
			}
		}

		// Subscribe page to platform webhooks for real-time comment/message events
		if (account) {
			c.executionCtx.waitUntil(
				subscribeFacebookPage(page.id, page.access_token).then((result) => {
					if (!result.success) {
						console.error(
							`[webhook-sub] Facebook page ${page.id} subscription failed:`,
							result.error,
						);
					}
				}),
			);
			c.executionCtx.waitUntil(
				discoverAdAccounts(c.env, orgId, account.id)
					.then(() => {
						console.log(`[oauth][facebook] Auto-discovered ad accounts for ${account.id}`);
					})
					.catch((err) => {
						console.error("[oauth][facebook] Ad account discovery failed (non-critical):", err);
					}),
			);
		}

		await c.env.KV.delete(`pending-secondary:${orgId}:facebook`);

		if (!account) {
			return c.json(
				{
					error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
				} as never,
				500 as never,
			);
		}

		return c.json(formatAccountResponse(account) as never, 201 as never);
	} catch {
		return c.json(
			{
				error: { code: "API_ERROR", message: "Failed to fetch Facebook pages" },
			} as never,
			500 as never,
		);
	}
});

// --- Secondary selection: LinkedIn Organizations ---
app.openapi(listLinkedInOrgs, async (c) => {
	const orgId = c.get("orgId");
	const pendingData = await c.env.KV.get<{
		access_token: string;
	}>(`pending-secondary:${orgId}:linkedin`, "json");

	if (!pendingData?.access_token) {
		return c.json({ organizations: [] } as never, 200 as never);
	}
	// SECURITY: Decrypt token from KV
	const decryptedLiToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	try {
		// LinkedIn Organizations: List organizations where the user has an admin role
		// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role
		const res = await fetch(
			"https://api.linkedin.com/v2/organizationAcls?q=roleAssignee",
			{
				headers: {
					Authorization: `Bearer ${decryptedLiToken}`,
				},
			},
		);
		if (!res.ok) {
			return c.json({ organizations: [] } as never, 200 as never);
		}
		const json = (await res.json()) as {
			elements: Array<{
				organization: string;
				organizationId: number;
			}>;
		};
		return c.json(
			{
				organizations: json.elements.map((e) => ({
					id: String(e.organizationId),
					name: e.organization,
				})),
			} as never,
			200 as never,
		);
	} catch {
		return c.json({ organizations: [] } as never, 200 as never);
	}
});

app.openapi(selectLinkedInOrg, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const pendingData = await c.env.KV.get<{
		access_token: string;
		profile_id?: string;
	}>(`pending-secondary:${orgId}:linkedin`, "json");

	if (!pendingData?.access_token) {
		return c.json(
			{
				error: {
					code: "NO_PENDING_DATA",
					message: "No pending LinkedIn OAuth data. Start OAuth flow first.",
				},
			} as never,
			400 as never,
		);
	}
	// SECURITY: Decrypt token from KV, then re-encrypt for DB storage
	const decryptedLiSetToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";
	const encLinkedinToken = await maybeEncrypt(decryptedLiSetToken, c.env.ENCRYPTION_KEY);
	// For org accounts, use the org URN. For personal accounts, use the stable profile ID from OAuth.
	const linkedinPlatformId = body.organization_urn ?? pendingData.profile_id ?? `linkedin_${Date.now()}`;
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "linkedin",
				platformAccountId: linkedinPlatformId,
				displayName: `LinkedIn Org ${body.organization_urn ?? "personal"}`,
				accessToken: encLinkedinToken,
				metadata: {
					account_type: body.account_type ?? "organization",
					organization_urn: body.organization_urn,
				},
				scopes: OAUTH_CONFIGS.linkedin!.scopes,
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					displayName: `LinkedIn Org ${body.organization_urn ?? "personal"}`,
					accessToken: encLinkedinToken,
					metadata: {
						account_type: body.account_type ?? "organization",
						organization_urn: body.organization_urn,
					},
					scopes: OAUTH_CONFIGS.linkedin!.scopes,
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][linkedin] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save LinkedIn account. Please try again." } } as never,
			500 as never,
		);
	}

	await c.env.KV.delete(`pending-secondary:${orgId}:linkedin`);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewLinkedin = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewLinkedin) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewLinkedin ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Pinterest Boards ---
app.openapi(listPinterestBoards, async (c) => {
	const orgId = c.get("orgId");
	const pendingData = await c.env.KV.get<{
		access_token: string;
	}>(`pending-secondary:${orgId}:pinterest`, "json");

	if (!pendingData?.access_token) {
		return c.json({ boards: [] } as never, 200 as never);
	}
	// SECURITY: Decrypt token from KV
	const decryptedPinListToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	try {
		// Pinterest Boards API: List all boards for the authenticated user
		// https://developers.pinterest.com/docs/api/v5/boards-list/
		const res = await fetch("https://api.pinterest.com/v5/boards", {
			headers: { Authorization: `Bearer ${decryptedPinListToken}` },
		});
		if (!res.ok) {
			return c.json({ boards: [] } as never, 200 as never);
		}
		const json = (await res.json()) as {
			items: Array<{
				id: string;
				name: string;
				description: string;
				pin_count: number;
			}>;
		};
		return c.json(
			{
				boards: (json.items ?? []).map((b) => ({
					id: b.id,
					name: b.name,
					description: b.description ?? null,
					pin_count: b.pin_count ?? 0,
				})),
			} as never,
			200 as never,
		);
	} catch {
		return c.json({ boards: [] } as never, 200 as never);
	}
});

app.openapi(selectPinterestBoard, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const pendingData = await c.env.KV.get<{
		access_token: string;
		profile_id?: string;
	}>(`pending-secondary:${orgId}:pinterest`, "json");

	if (!pendingData?.access_token) {
		return c.json(
			{
				error: {
					code: "NO_PENDING_DATA",
					message: "No pending Pinterest OAuth data. Start OAuth flow first.",
				},
			} as never,
			400 as never,
		);
	}

	// SECURITY: Decrypt token from KV, then re-encrypt for DB storage
	const decryptedPinSetToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	// Fetch user profile for account creation
	let username = "Pinterest User";
	let profileId = pendingData.profile_id ?? `pinterest_${Date.now()}`;
	try {
		// Pinterest User Account API: Fetch the authenticated user's profile
		// https://developers.pinterest.com/docs/api/v5/user_account-get/
		const profileRes = await fetch(
			"https://api.pinterest.com/v5/user_account",
			{
				headers: { Authorization: `Bearer ${decryptedPinSetToken}` },
			},
		);
		if (profileRes.ok) {
			const profile = (await profileRes.json()) as {
				username?: string;
				id?: string;
			};
			username = profile.username ?? username;
			profileId = profile.id ?? profileId;
		}
	} catch {
		// Continue with defaults
	}

	const encPinterestToken = await maybeEncrypt(decryptedPinSetToken, c.env.ENCRYPTION_KEY);
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "pinterest",
				platformAccountId: profileId,
				username,
				displayName: username,
				accessToken: encPinterestToken,
				metadata: { default_board_id: body.board_id },
				scopes: OAUTH_CONFIGS.pinterest!.scopes,
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					username,
					displayName: username,
					accessToken: encPinterestToken,
					metadata: { default_board_id: body.board_id },
					scopes: OAUTH_CONFIGS.pinterest!.scopes,
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][pinterest] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save Pinterest account. Please try again." } } as never,
			500 as never,
		);
	}

	await c.env.KV.delete(`pending-secondary:${orgId}:pinterest`);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewPinterest = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewPinterest) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewPinterest ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Google Business Locations ---
app.openapi(listGBPLocations, async (c) => {
	const orgId = c.get("orgId");
	const pendingData = await c.env.KV.get<{
		access_token: string;
	}>(`pending-secondary:${orgId}:googlebusiness`, "json");

	if (!pendingData?.access_token) {
		return c.json({ locations: [] } as never, 200 as never);
	}
	// SECURITY: Decrypt token from KV
	const decryptedGbpToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	try {
		// Google Business Account Management API: List all GBP accounts for the user
		// https://developers.google.com/my-business/reference/accountmanagement/rest/v1/accounts/list
		const accountsRes = await fetch(
			"https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
			{
				headers: { Authorization: `Bearer ${decryptedGbpToken}` },
			},
		);
		if (!accountsRes.ok) {
			return c.json({ locations: [] } as never, 200 as never);
		}
		const accountsJson = (await accountsRes.json()) as {
			accounts: Array<{ name: string }>;
		};
		const gmbAccount = accountsJson.accounts?.[0];
		if (!gmbAccount) {
			return c.json({ locations: [] } as never, 200 as never);
		}

		// Persist the Google Account name so GMB management routes can use it for v4 API calls
		await c.env.KV.put(
			`pending-secondary:${orgId}:googlebusiness`,
			JSON.stringify({ ...pendingData, google_account_name: gmbAccount.name }),
			{ expirationTtl: 600 },
		);

		// Google Business Information API: List locations for a GBP account
		// https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list
		const locationsRes = await fetch(
			`https://mybusinessbusinessinformation.googleapis.com/v1/${gmbAccount.name}/locations`,
			{
				headers: { Authorization: `Bearer ${decryptedGbpToken}` },
			},
		);
		if (!locationsRes.ok) {
			return c.json({ locations: [] } as never, 200 as never);
		}
		const locationsJson = (await locationsRes.json()) as {
			locations: Array<{
				name: string;
				title: string;
				storefrontAddress?: { formattedAddress?: string };
				primaryPhone?: string;
			}>;
		};
		return c.json(
			{
				locations: (locationsJson.locations ?? []).map((l) => ({
					id: l.name,
					name: l.title,
					address: l.storefrontAddress?.formattedAddress ?? null,
					phone: l.primaryPhone ?? null,
				})),
			} as never,
			200 as never,
		);
	} catch {
		return c.json({ locations: [] } as never, 200 as never);
	}
});

app.openapi(selectGBPLocation, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const pendingData = await c.env.KV.get<{
		access_token: string;
		google_account_name?: string;
	}>(`pending-secondary:${orgId}:googlebusiness`, "json");

	if (!pendingData?.access_token) {
		return c.json(
			{
				error: {
					code: "NO_PENDING_DATA",
					message:
						"No pending Google Business OAuth data. Start OAuth flow first.",
				},
			} as never,
			400 as never,
		);
	}

	if (!pendingData.google_account_name) {
		return c.json(
			{
				error: {
					code: "MISSING_GOOGLE_ACCOUNT",
					message:
						"Google account name not found in pending data. Please start the OAuth flow again.",
				},
			} as never,
			400 as never,
		);
	}
	// SECURITY: Decrypt token from KV, then re-encrypt for DB storage
	const decryptedGbpSetToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";
	const encGbpToken = await maybeEncrypt(decryptedGbpSetToken, c.env.ENCRYPTION_KEY);
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "googlebusiness",
				platformAccountId: body.location_id,
				displayName: `Google Business ${body.location_id}`,
				accessToken: encGbpToken,
				metadata: { location_id: body.location_id, google_account_name: pendingData.google_account_name },
				scopes: OAUTH_CONFIGS.googlebusiness!.scopes,
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					displayName: `Google Business ${body.location_id}`,
					accessToken: encGbpToken,
					metadata: { location_id: body.location_id, google_account_name: pendingData.google_account_name },
					scopes: OAUTH_CONFIGS.googlebusiness!.scopes,
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][googlebusiness] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save Google Business account. Please try again." } } as never,
			500 as never,
		);
	}

	await c.env.KV.delete(`pending-secondary:${orgId}:googlebusiness`);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewGbp = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewGbp) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewGbp ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Snapchat Profiles ---
app.openapi(listSnapchatProfiles, async (c) => {
	const orgId = c.get("orgId");
	const pendingData = await c.env.KV.get<{
		access_token: string;
	}>(`pending-secondary:${orgId}:snapchat`, "json");

	if (!pendingData?.access_token) {
		return c.json({ profiles: [] } as never, 200 as never);
	}
	// SECURITY: Decrypt token from KV
	const decryptedSnapListToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";

	try {
		// Snapchat Marketing API: List organizations the authenticated user belongs to
		// https://developers.snap.com/api/marketing-api/general/Myself
		const res = await fetch(
			"https://adsapi.snapchat.com/v1/me/organizations",
			{
				headers: { Authorization: `Bearer ${decryptedSnapListToken}` },
			},
		);
		if (!res.ok) {
			return c.json({ profiles: [] } as never, 200 as never);
		}
		const json = (await res.json()) as {
			organizations: Array<{
				organization: {
					id: string;
					name: string;
				};
			}>;
		};
		return c.json(
			{
				profiles: (json.organizations ?? []).map((o) => ({
					id: o.organization.id,
					display_name: o.organization.name,
					username: o.organization.name,
					profile_image_url: null,
				})),
			} as never,
			200 as never,
		);
	} catch {
		return c.json({ profiles: [] } as never, 200 as never);
	}
});

app.openapi(selectSnapchatProfile, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const pendingData = await c.env.KV.get<{
		access_token: string;
	}>(`pending-secondary:${orgId}:snapchat`, "json");

	if (!pendingData?.access_token) {
		return c.json(
			{
				error: {
					code: "NO_PENDING_DATA",
					message: "No pending Snapchat OAuth data. Start OAuth flow first.",
				},
			} as never,
			400 as never,
		);
	}

	// SECURITY: Decrypt token from KV, then re-encrypt for DB storage
	const decryptedSnapSetToken = await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY) ?? "";
	const encSnapToken = await maybeEncrypt(decryptedSnapSetToken, c.env.ENCRYPTION_KEY);
	let account;
	try {
		[account] = await db
			.insert(socialAccounts)
			.values({
				organizationId: orgId,
				platform: "snapchat",
				platformAccountId: body.profile_id,
				displayName: `Snapchat ${body.profile_id}`,
				accessToken: encSnapToken,
				scopes: OAUTH_CONFIGS.snapchat!.scopes,
			})
			.onConflictDoUpdate({
				target: [socialAccounts.organizationId, socialAccounts.platform, socialAccounts.platformAccountId],
				set: {
					displayName: `Snapchat ${body.profile_id}`,
					accessToken: encSnapToken,
					scopes: OAUTH_CONFIGS.snapchat!.scopes,
					updatedAt: new Date(),
				},
			})
			.returning();
	} catch (err) {
		console.error("[oauth][snapchat] Account upsert failed:", err instanceof Error ? err.message : err);
		return c.json(
			{ error: { code: "ACCOUNT_SAVE_FAILED", message: "Failed to save Snapchat account. Please try again." } } as never,
			500 as never,
		);
	}

	await c.env.KV.delete(`pending-secondary:${orgId}:snapchat`);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	const isNewSnap = (account.updatedAt.getTime() - account.connectedAt.getTime()) < 5000;
	if (isNewSnap) {
		c.executionCtx.waitUntil(
			dispatchWebhookEvent(c.env, db, orgId, "account.connected", {
				account_id: account.id,
				platform: account.platform,
				username: account.username,
				display_name: account.displayName,
			}),
		);
	}
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `${isNewSnap ? "Connected" : "Reconnected"} ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- OAuth catch-all (must be last due to /{platform} wildcard) ---
app.openapi(startOAuth, async (c) => {
	const orgId = c.get("orgId");
	const { platform } = c.req.valid("param");
	const query = c.req.valid("query");
	const method = query.method ?? undefined;
	// Customer's redirect URL — where we redirect after the OAuth exchange completes
	const customerRedirectUrl =
		query.redirect_url ?? "https://api.relayapi.dev/connect/callback";

	// SECURITY: Validate redirect_url against allowed domains and protocols.
	if (!isAllowedCustomerRedirectUrl(customerRedirectUrl)) {
		return c.json(
			{ error: { code: "INVALID_REDIRECT_URL", message: "Invalid redirect_url" } } as never,
			400 as never,
		);
	}

	// RelayAPI's own callback URL — this is what we register with OAuth providers
	const apiBaseUrl = c.env.API_BASE_URL || "https://api.relayapi.dev";
	const oauthRedirectUri = `${apiBaseUrl}/connect/oauth/callback`;

	// Use Instagram direct config when method=direct, otherwise standard config
	const oauthConfig =
		platform === "instagram" && method === "direct"
			? INSTAGRAM_DIRECT_CONFIG
			: OAUTH_CONFIGS[platform as Platform];
	if (!oauthConfig) {
		return c.json(
			{
				error: {
					code: "OAUTH_NOT_SUPPORTED",
					message: `OAuth is not configured for ${platform}. Use a platform-specific connection method.`,
				},
			} as never,
			400 as never,
		);
	}

	const clientId = oauthConfig.getClientId(c.env);
	if (!clientId) {
		return c.json(
			{
				error: {
					code: "MISSING_CREDENTIALS",
					message: `OAuth client ID not configured for ${platform}. Set the environment variable.`,
				},
			} as never,
			400 as never,
		);
	}

	// Generate state token and PKCE if required
	const state = generateStateToken();
	let codeChallenge: string | undefined;
	let codeVerifier: string | undefined;

	if (oauthConfig.requiresPkce) {
		const pkce = await generatePkce();
		codeChallenge = pkce.codeChallenge;
		codeVerifier = pkce.codeVerifier;
	}

	// Store the customer's redirect URL in KV — the server-side callback will redirect here
	await c.env.KV.put(
		`oauth-state:${state}`,
		JSON.stringify({
			org_id: orgId,
			platform,
			method: method ?? null,
			redirect_url: customerRedirectUrl,
			code_verifier: codeVerifier ?? null,
		}),
		{ expirationTtl: 600 }, // 10 minutes
	);

	// Build auth URL with RelayAPI's callback — NOT the customer's URL
	const authUrl = buildAuthUrl(
		oauthConfig,
		clientId,
		oauthRedirectUri,
		state,
		codeChallenge,
	);

	return c.json({ auth_url: authUrl } as never, 200 as never);
});

app.openapi(completeOAuth, async (c) => {
	const orgId = c.get("orgId");
	const { platform } = c.req.valid("param");
	const body = c.req.valid("json");

	const customerRedirectUrl =
		body.redirect_url ?? "https://api.relayapi.dev/connect/callback";

	// SECURITY: Validate redirect_url against allowed domains and protocols.
	if (!isAllowedCustomerRedirectUrl(customerRedirectUrl)) {
		return c.json(
			{ error: { code: "INVALID_REDIRECT_URL", message: "Invalid redirect_url" } } as never,
			400 as never,
		);
	}

	// RelayAPI's own callback URL — this is what we register with OAuth providers.
	const apiBaseUrl = c.env.API_BASE_URL || "https://api.relayapi.dev";
	const oauthRedirectUri = `${apiBaseUrl}/connect/oauth/callback`;
	const oauthConfig = OAUTH_CONFIGS[platform as Platform];

	// Retrieve code_verifier and method from KV state if available
	let codeVerifier: string | undefined;
	let method: string | undefined;

	if (body.state) {
		const stateData = await c.env.KV.get<{
			org_id: string;
			platform: string;
			method?: string | null;
			redirect_url?: string;
			code_verifier: string | null;
		}>("oauth-state:" + body.state, "json");
		if (
			stateData?.org_id === orgId &&
			stateData?.platform === platform
		) {
			if (
				stateData.redirect_url
				&& stateData.redirect_url !== customerRedirectUrl
			) {
				return c.json(
					{
						error: {
							code: "REDIRECT_URL_MISMATCH",
							message: "redirect_url does not match the OAuth flow that was started.",
						},
					} as never,
					400 as never,
				);
			}
			codeVerifier = stateData.code_verifier ?? undefined;
			method = stateData.method ?? undefined;
			await c.env.KV.delete("oauth-state:" + body.state);
		} else {
			return c.json(
				{
					error: {
						code: "INVALID_STATE",
						message: "Invalid or expired OAuth state token.",
					},
				} as never,
				400 as never,
			);
		}
	} else if (oauthConfig?.requiresPkce) {
		return c.json(
			{
				error: {
					code: "STATE_REQUIRED",
					message: "state is required to complete this OAuth flow securely.",
				},
			} as never,
			400 as never,
		);
	}

	if (platform === "instagram" && !body.state) {
		return c.json(
			{
				error: {
					code: "STATE_REQUIRED",
					message: "state is required to complete Instagram OAuth securely.",
				},
			} as never,
			400 as never,
		);
	}

	if (platform === "instagram" && !method && body.state) {
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message: "Instagram OAuth state is missing flow metadata.",
				},
			} as never,
			400 as never,
		);
	}

	try {
		const result = await exchangeAndSaveAccount({
			env: c.env,
			orgId,
			platform,
			code: body.code,
			redirectUri: oauthRedirectUri,
			codeVerifier,
			method,
		});

		if (result.status === "error") {
			const statusCode = result.code === "INTERNAL_ERROR" ? 500 : 400;
			return c.json(
				{ error: { code: result.code, message: result.message } } as never,
				statusCode as never,
			);
		}

		if (result.status === "pending_selection") {
			return c.json(
				{
					id: "pending",
					platform,
					platform_account_id: "pending",
					username: null,
					display_name: `${platform} account`,
					avatar_url: null,
					metadata: null,
					connected_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				} as never,
				200 as never,
			);
		}

		return c.json({ account: result.account } as never, 201 as never);
	} catch (err) {
		// SECURITY: Log full error server-side but return generic message to prevent leaking platform internals
		console.error("[oauth] Token exchange failed:", err instanceof Error ? err.message : err);
		return c.json(
			{
				error: {
					code: "TOKEN_EXCHANGE_FAILED",
					message: "OAuth token exchange failed. Please try again.",
				},
			} as never,
			400 as never,
		);
	}
});

export default app;
