import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import {
	createDb,
	type Database,
	socialAccountSyncState,
	socialAccounts,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import {
	buildAuthUrl,
	exchangeCode,
	generatePkce,
	generateStateToken,
	INSTAGRAM_DIRECT_CONFIG,
	OAUTH_CONFIGS,
} from "../config/oauth";
import { encryptAccountToken } from "../lib/account-token-crypto";
import { parseApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope";
import { maybeDecrypt, maybeEncrypt } from "../lib/crypto";
import { isAllowedCustomerRedirectUrl } from "../lib/customer-redirect";
import { sha256Hex } from "../lib/durable-operation";
import { fetchLinkedInAccessibleOrganizations } from "../lib/linkedin-rest";
import { buildMailchimpApiUrl, getMailchimpDatacenter } from "../lib/mailchimp";
import {
	assertWriteAccess,
	resolveOperationalCreateScope,
	validatePersistedOperationalScope,
} from "../lib/request-access";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import {
	assertWorkspaceScope,
	canAccessWorkspaceScope,
} from "../lib/workspace-scope";
import type { Platform } from "../schemas/common";
import { ErrorResponse } from "../schemas/common";
import {
	CompleteOAuthBody,
	CompleteOAuthParams,
	CompleteOAuthResponse,
	ConnectBeehiivBody,
	ConnectBlueskyBody,
	ConnectConvertKitBody,
	ConnectListMonkBody,
	ConnectMailchimpBody,
	FacebookPagesResponse,
	GBPLocationsResponse,
	InitTelegramQuery,
	InitTelegramResponse,
	LinkedInOrgsResponse,
	PendingDataQuery,
	PendingDataResponse,
	PendingSelectionResponse,
	PinterestBoardsResponse,
	SecondarySelectionQuery,
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
import {
	isAccountWorkspaceAccessError,
	isAccountWorkspaceConflictError,
	upsertConnectedAccountWithCredentials,
} from "../services/account-credential-write";
import {
	sanitizeSocialAccountMetadata,
	withMetaAdsUserAccessToken,
} from "../services/ad-access-token";
import { socialPlatformToAdPlatform } from "../services/ad-platforms";
import { discoverAdAccounts } from "../services/ad-service";
import { rehostAvatar } from "../services/avatar-store";
import { getSupportedSyncPlatforms } from "../services/external-post-sync/index";
import type { SyncPostsMessage } from "../services/external-post-sync/types";
import {
	claimOneTimeCapability,
	issueOneTimeCapability,
} from "../services/one-time-capability";
import {
	issueTelegramConnectionChallenge,
	readTelegramConnectionChallenge,
} from "../services/telegram-connection";
import {
	enqueuePersistedWebhookEvent,
	type PersistedWebhookEvent,
	persistWebhookEventInTransaction,
	type WebhookTransaction,
} from "../services/webhook-delivery";
import {
	subscribeFacebookPage,
	subscribeInstagramAccount,
	verifyInstagramWebhookSubscription,
	verifyWhatsAppWebhookSubscription,
} from "../services/webhook-subscription";
import type { Env, Variables } from "../types";
import { logConnectionEvent } from "./connections";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
	const denied = assertWriteAccess(c);
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
		"Returns an auth_url and binds the initiating API key plus its workspace grant to one-time OAuth state. workspace_id is required only when Require Workspace ID is enabled.",
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
	description:
		"Exchange an OAuth code and save the account after revalidating both the flow's initial workspace grant and the initiating API key's live authorization. Reconnects never move an existing identity implicitly.",
	security: [{ Bearer: [] }],
	request: {
		params: CompleteOAuthParams,
		body: { content: { "application/json": { schema: CompleteOAuthBody } } },
	},
	responses: {
		200: {
			description: "OAuth complete; secondary account selection required",
			content: { "application/json": { schema: PendingSelectionResponse } },
		},
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
	request: {
		body: { content: { "application/json": { schema: ConnectBeehiivBody } } },
	},
	responses: {
		200: {
			description: "Connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		400: {
			description: "Auth failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const connectConvertKit = createRoute({
	operationId: "connectConvertKit",
	method: "post",
	path: "/convertkit",
	tags: ["Connect"],
	summary: "Connect ConvertKit (Kit) newsletter",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: ConnectConvertKitBody } },
		},
	},
	responses: {
		200: {
			description: "Connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		400: {
			description: "Auth failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const connectMailchimp = createRoute({
	operationId: "connectMailchimp",
	method: "post",
	path: "/mailchimp",
	tags: ["Connect"],
	summary: "Connect Mailchimp newsletter",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: ConnectMailchimpBody } } },
	},
	responses: {
		200: {
			description: "Connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		400: {
			description: "Auth failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const connectListMonk = createRoute({
	operationId: "connectListMonk",
	method: "post",
	path: "/listmonk",
	tags: ["Connect"],
	summary: "Connect self-hosted ListMonk newsletter",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: ConnectListMonkBody } } },
	},
	responses: {
		200: {
			description: "Connected",
			content: { "application/json": { schema: CompleteOAuthResponse } },
		},
		400: {
			description: "Auth failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
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

// Telegram Bot API: https://core.telegram.org/bots/api
// Sections: "Making requests", "getChat", and "getChatMember"
// Request form: GET or POST https://api.telegram.org/bot<token>/METHOD_NAME
// Ownership lookup: POST https://api.telegram.org/bot<token>/getChat with field
// chat_id, then POST https://api.telegram.org/bot<token>/getChatMember with
// fields chat_id and user_id. getChatMember is guaranteed for other users only
// when the bot is an administrator in the target chat.

const initTelegram = createRoute({
	operationId: "initTelegram",
	method: "post",
	path: "/telegram",
	tags: ["Connect"],
	summary: "Initiate Telegram bot connection",
	description:
		"Generates an organization- and workspace-bound bot challenge code (valid 15 minutes).",
	security: [{ Bearer: [] }],
	request: { query: InitTelegramQuery },
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
		"One-time use, expires after 10 minutes, and may only be polled by the API key that initiated the headless OAuth flow.",
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
	request: { query: SecondarySelectionQuery },
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
	request: { query: SecondarySelectionQuery },
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
	request: { query: SecondarySelectionQuery },
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
	request: { query: SecondarySelectionQuery },
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
	request: { query: SecondarySelectionQuery },
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

type ConnectedSocialAccount = typeof socialAccounts.$inferSelect;

function accountWorkspaceConflictResponse(
	c: Parameters<typeof assertWriteAccess>[0],
	error: unknown,
): Response | undefined {
	if (isAccountWorkspaceAccessError(error)) {
		return c.json(
			{
				error: {
					code: error.code,
					message: error.message,
				},
			},
			403,
		);
	}
	if (!isAccountWorkspaceConflictError(error)) return undefined;
	return c.json(
		{
			error: {
				code: error.code,
				message: error.message,
				details: {
					existing_workspace_id: error.existingWorkspaceId,
					requested_workspace_id: error.requestedWorkspaceId,
				},
			},
		},
		409,
	);
}

function accountConnectedPayload(account: ConnectedSocialAccount) {
	return {
		account_id: account.id,
		platform: account.platform,
		username: account.username,
		display_name: account.displayName,
	};
}

/**
 * Commit the authoritative account upsert and customer-webhook outbox rows as
 * one database transaction. Queue handoff remains post-commit and best-effort;
 * the scheduled outbox dispatcher recovers a Worker stop or Queue outage.
 */
async function persistConnectedAccount(params: {
	db: Database;
	orgId: string;
	connectionOperationId: string;
	upsert: (
		tx: WebhookTransaction,
	) => Promise<ConnectedSocialAccount | undefined>;
}): Promise<{
	account: ConnectedSocialAccount;
	webhook: PersistedWebhookEvent;
}> {
	return params.db.transaction(async (tx) => {
		const account = await params.upsert(tx);
		if (!account) throw new Error("Account upsert returned no row");
		const webhook = await persistWebhookEventInTransaction(
			tx,
			params.orgId,
			"account.connected",
			accountConnectedPayload(account),
			{
				occurrenceId: `account-connect:${params.connectionOperationId}`,
			},
		);
		return { account, webhook };
	});
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

type PendingSecondaryScope = {
	initiator_key_id: string;
	initial_workspace_scope: "all" | string[];
	workspace_id: string | null;
};

function pendingSecondaryKey(
	organizationId: string,
	platform: string,
	connectToken: string,
): string {
	return `pending-secondary:${organizationId}:${platform}:${connectToken}`;
}

async function authorizePendingSecondary(
	c: Parameters<typeof assertWriteAccess>[0],
	data: PendingSecondaryScope,
): Promise<
	| { ok: true; initialWorkspaceScope: "all" | string[] }
	| { ok: false; response: Response }
> {
	if (
		data.initiator_key_id !== c.get("keyId") ||
		!("initial_workspace_scope" in data)
	) {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: "NO_PENDING_DATA",
						message: "No pending OAuth selection was found.",
					},
				},
				404,
			),
		};
	}
	const initialWorkspaceScope = parseApiKeyWorkspaceScope({
		workspace_scope: data.initial_workspace_scope,
	});
	if (initialWorkspaceScope === null) {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: "NO_PENDING_DATA",
						message: "No pending OAuth selection was found.",
					},
				},
				404,
			),
		};
	}
	if (!canAccessWorkspaceScope(initialWorkspaceScope, data.workspace_id)) {
		return {
			ok: false,
			response: c.json(
				{
					error: {
						code: "WORKSPACE_ACCESS_DENIED",
						message:
							"The initiating API key did not authorize this connection scope.",
					},
				},
				403,
			),
		};
	}
	const validation = await validatePersistedOperationalScope(c.get("db"), {
		apiKeyId: data.initiator_key_id,
		organizationId: c.get("orgId"),
		workspaceId: data.workspace_id,
		resourceName: "connected account",
	});
	if (!validation.ok) {
		return {
			ok: false,
			response: c.json(
				{ error: { code: validation.code, message: validation.message } },
				validation.status,
			),
		};
	}
	return { ok: true, initialWorkspaceScope };
}

export type OAuthExchangeResult =
	| {
			status: "success";
			account: ReturnType<typeof formatAccountResponse>["account"];
	  }
	| { status: "pending_selection"; platform: string; connectToken: string }
	| { status: "error"; code: string; message: string };

/**
 * Shared logic: exchange OAuth code for tokens, fetch profile, upsert account.
 * Used by both the POST completeOAuth endpoint and the GET server-side callback route.
 */
export async function exchangeAndSaveAccount(params: {
	env: Env;
	orgId: string;
	initiatorKeyId: string;
	authorizedWorkspaceScope: "all" | string[];
	/** Scope accepted at authenticated initiation and carried by one-time state. */
	workspaceId?: string | null;
	/**
	 * Whether the caller supplied workspace_id. In optional mode an omitted value
	 * creates new identities at organization scope, but reconnects an existing
	 * identity in place instead of silently demoting it from its workspace.
	 */
	workspaceWasExplicit?: boolean;
	platform: string;
	code: string;
	redirectUri: string;
	codeVerifier?: string;
	method?: string;
	/** Stable identifier created when this OAuth flow starts. */
	connectionOperationId?: string;
	/**
	 * Optional execution-context deferral. When provided, all best-effort
	 * post-upsert side effects (avatar re-host, webhook Queue handoff, connection
	 * log, Instagram webhook subscriptions, sync-state init, ad-account
	 * discovery) run via waitUntil AFTER the response is returned, so the
	 * user-facing OAuth redirect / JSON response is not blocked on external HTTP
	 * round-trips. When absent (e.g. tests), the work runs fire-and-forget.
	 */
	waitUntil?: (p: Promise<unknown>) => void;
}): Promise<OAuthExchangeResult> {
	const {
		env,
		orgId,
		initiatorKeyId,
		authorizedWorkspaceScope,
		workspaceId = null,
		platform,
		code,
		redirectUri,
		codeVerifier,
		method,
	} = params;
	const workspaceWasExplicit =
		params.workspaceWasExplicit ?? workspaceId !== null;
	const connectionOperationId =
		params.connectionOperationId ??
		`oauth:${await sha256Hex(`${orgId}:${platform}:${code}`)}`;
	// Defer helper: run post-response side effects without blocking the response.
	const defer = (p: Promise<unknown>): void => {
		const safe = Promise.resolve(p).catch((err) =>
			console.error(`[oauth][${platform}] Deferred side-effect failed:`, err),
		);
		if (params.waitUntil) {
			params.waitUntil(safe);
		} else {
			void safe;
		}
	};

	const isInstagramDirect = platform === "instagram" && method === "direct";
	const oauthConfig = isInstagramDirect
		? INSTAGRAM_DIRECT_CONFIG
		: OAUTH_CONFIGS[platform as Platform];
	if (!oauthConfig) {
		return {
			status: "error",
			code: "OAUTH_NOT_SUPPORTED",
			message: `OAuth is not configured for ${platform}.`,
		};
	}

	const clientId = oauthConfig.getClientId(env);
	const clientSecret = oauthConfig.getClientSecret(env);
	if (!clientId || !clientSecret) {
		return {
			status: "error",
			code: "MISSING_CREDENTIALS",
			message: `OAuth credentials not configured for ${platform}.`,
		};
	}

	// Exchange code for tokens
	const tokens = await exchangeCode(
		oauthConfig,
		clientId,
		clientSecret,
		code,
		redirectUri,
		codeVerifier,
	);
	console.log(
		`[oauth][${platform}] Token exchange success: token_received=${!!tokens.access_token}, user_id=${tokens.user_id ?? "none"}, expires_in=${tokens.expires_in ?? "none"}`,
	);

	// Threads: exchange short-lived token (1h) for long-lived token (60 days)
	// Note: Meta docs specify GET-only for this endpoint — secrets in URL is an accepted platform limitation
	if (platform === "threads" && tokens.access_token) {
		try {
			const llRes = await fetch(
				`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${clientSecret}&access_token=${tokens.access_token}`,
			);
			if (llRes.ok) {
				const llData = (await llRes.json()) as {
					access_token: string;
					expires_in?: number;
				};
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
			const llRes = await fetch(
				`${GRAPH_BASE.instagram}/access_token?${llParams}`,
			);
			if (llRes.ok) {
				const llData = (await llRes.json()) as {
					access_token: string;
					expires_in?: number;
				};
				tokens.access_token = llData.access_token;
				tokens.expires_in = llData.expires_in;
			} else {
				console.warn(
					`[oauth][${platform}] Long-lived token exchange failed: ${llRes.status} ${await llRes.text()}`,
				);
			}
		} catch (err) {
			console.warn(
				`[oauth][${platform}] Long-lived token exchange error:`,
				err,
			);
		}
	}

	// Facebook/Instagram (via Facebook): exchange short-lived token for long-lived token (60 days)
	// Note: Meta docs specify GET-only — secrets in URL is an accepted platform limitation
	if (
		(platform === "facebook" ||
			(platform === "instagram" && !isInstagramDirect)) &&
		tokens.access_token
	) {
		try {
			const llRes = await fetch(
				`${GRAPH_BASE.facebook}/oauth/access_token?grant_type=fb_exchange_token&client_id=${clientId}&client_secret=${clientSecret}&fb_exchange_token=${tokens.access_token}`,
			);
			if (llRes.ok) {
				const llData = (await llRes.json()) as {
					access_token: string;
					expires_in?: number;
				};
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
		console.log(
			`[oauth][${platform}] Profile fetch URL: ${profileUrl.replace(/access_token=[^&]+/, "access_token=REDACTED")}`,
		);
		const profileRes = await fetch(
			profileUrl,
			isInstagramDirect
				? {}
				: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
		);
		if (profileRes.ok) {
			const profile = (await profileRes.json()) as Record<string, unknown>;
			console.log(`[oauth][${platform}] Profile fetched: id=${profile.id}`);

			if (platform === "twitter") {
				const data = (
					profile as {
						data?: {
							id?: string;
							username?: string;
							name?: string;
							profile_image_url?: string;
						};
					}
				).data;
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
				console.log(
					`[oauth][${platform}] Profile ID resolved: ${profileId} (source: ${igUserId ? "profile.user_id" : igId ? "profile.id" : "none"}), appScopedId: ${igAppScopedId}`,
				);
				username = (profile as { username?: string }).username ?? null;
				displayName =
					(profile as { name?: string }).name ?? username ?? displayName;
				avatarUrl =
					(profile as { profile_picture_url?: string }).profile_picture_url ??
					null;
			} else if (platform === "instagram" && !isInstagramDirect) {
				// Instagram via Facebook Login: the /me profile returns the Facebook User ID.
				// We need the linked Instagram Business Account ID from the user's Pages.
				// Fetch pages with instagram_business_account to find the IGBA.
				try {
					const pagesRes = await fetch(
						`${GRAPH_BASE.facebook}/me/accounts?fields=instagram_business_account{id,username,name,profile_picture_url}&access_token=${tokens.access_token}`,
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
							console.log(
								`[oauth][instagram] Resolved IGBA from Facebook Pages: id=${igba.id}`,
							);
						}
					}
				} catch (err) {
					console.error(
						"[oauth][instagram] Failed to fetch IGBA from Pages:",
						err,
					);
				}
				// Fallback to Facebook user profile if no IGBA found
				if (!profileId) {
					profileId = (profile as { id?: string }).id ?? null;
					username = (profile as { name?: string }).name ?? null;
					displayName = username ?? displayName;
					console.warn(
						"[oauth][instagram] No IGBA found on any Facebook Page, falling back to Facebook User ID",
					);
				}
			} else if (platform === "facebook") {
				profileId = (profile as { id?: string }).id ?? null;
				username = (profile as { name?: string }).name ?? null;
				displayName = username ?? displayName;
			} else if (platform === "youtube") {
				const items = (
					profile as {
						items?: Array<{
							id?: string;
							snippet?: {
								title?: string;
								thumbnails?: { default?: { url?: string } };
							};
						}>;
					}
				).items;
				const channel = items?.[0];
				profileId = channel?.id ?? null;
				displayName = channel?.snippet?.title ?? displayName;
				avatarUrl = channel?.snippet?.thumbnails?.default?.url ?? null;
			} else if (platform === "threads") {
				profileId = (profile as { id?: string }).id ?? null;
				username = (profile as { username?: string }).username ?? null;
				displayName =
					(profile as { name?: string }).name ?? username ?? displayName;
				avatarUrl =
					(profile as { threads_profile_picture_url?: string })
						.threads_profile_picture_url ?? null;
			} else {
				profileId =
					(profile as { id?: string }).id ??
					(profile as { user_id?: string }).user_id ??
					null;
				username =
					(profile as { username?: string }).username ??
					(profile as { name?: string }).name ??
					null;
				displayName = username ?? displayName;
			}
		} else {
			const errBody = await profileRes.text().catch(() => "");
			console.error(
				`[oauth][${platform}] Profile fetch failed: ${profileRes.status} ${errBody}`,
			);
		}
	} catch (err) {
		console.error(`[oauth][${platform}] Profile fetch error:`, err);
	}

	// Fallback: use the stable provider user identifier from the token response.
	// IMPORTANT: For Instagram direct, tokens.user_id is an app-scoped ID that differs from
	// the profile's user_id (IG Professional Account ID). Using it would create ghost duplicates
	// that the unique constraint can't catch. Reject instead of creating inconsistent data.
	const tokenProfileId = tokens.user_id;
	if (!profileId && tokenProfileId) {
		if (isInstagramDirect) {
			console.error(
				`[oauth][${platform}] Profile fetch failed — refusing to fall back to token user_id (different ID type would create duplicates)`,
			);
			return {
				status: "error",
				code: "PROFILE_FETCH_FAILED",
				message: "Could not retrieve your Instagram profile. Please try again.",
			};
		}
		console.log(
			`[oauth][${platform}] Using token user identifier as fallback profileId: ${tokenProfileId}`,
		);
		profileId = String(tokenProfileId);
	}

	if (!profileId) {
		console.error(
			`[oauth][${platform}] No profileId available — profile fetch and token user identifier both failed`,
		);
		return {
			status: "error",
			code: "PROFILE_FETCH_FAILED",
			message: `Could not retrieve your ${platform} profile. Please try again.`,
		};
	}

	const tokenExpiresAt = tokens.expires_in
		? new Date(Date.now() + tokens.expires_in * 1000)
		: null;

	// Multi-select platforms: store token for secondary selection step
	if (SECONDARY_SELECTION_PLATFORMS.has(platform)) {
		const connectToken = crypto.randomUUID();
		// SECURITY: Encrypt access token AND refresh token before storing in KV
		// (consistent with DB encryption at rest). The refresh_token and expires_at
		// MUST be carried through to the select handler — without them the saved
		// account has no way to auto-refresh and dies when the short-lived access
		// token expires (Google/Snapchat ~1h, Pinterest ~30d).
		const encryptedToken = await maybeEncrypt(
			tokens.access_token,
			env.ENCRYPTION_KEY,
		);
		const encryptedRefreshToken = await maybeEncrypt(
			tokens.refresh_token,
			env.ENCRYPTION_KEY,
		);
		await env.KV.put(
			pendingSecondaryKey(orgId, platform, connectToken),
			JSON.stringify({
				connection_operation_id: connectionOperationId,
				initiator_key_id: initiatorKeyId,
				initial_workspace_scope: authorizedWorkspaceScope,
				workspace_id: workspaceId,
				workspace_id_was_explicit: workspaceWasExplicit,
				access_token: encryptedToken,
				refresh_token: encryptedRefreshToken,
				profile_id: profileId,
				expires_at: tokenExpiresAt?.toISOString() ?? null,
			}),
			{ expirationTtl: 600 },
		);
		return { status: "pending_selection", platform, connectToken };
	}

	// Single-select platforms: atomic upsert account
	console.log(
		`[oauth][${platform}] Upserting account: orgId=${orgId}, profileId=${profileId}`,
	);
	const db = createDb(env.HYPERDRIVE.connectionString);

	const encKey = env.ENCRYPTION_KEY;
	// Record the Instagram connection method so the token-refresh cron can pick
	// the correct refresh grant. Instagram via Facebook Login stores a Facebook
	// user token that the ig_refresh_token grant can never refresh — flagging it
	// here lets refreshToken() skip the doomed call instead of looping on it.
	const igMetadata: { ig_login_method: "direct" | "facebook" } | null =
		platform === "instagram"
			? { ig_login_method: isInstagramDirect ? "direct" : "facebook" }
			: null;
	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId,
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, encKey, {
					apiKeyId: initiatorKeyId,
					authorizedWorkspaceScope,
					insert: {
						organizationId: orgId,
						workspaceId,
						platform: platform as Platform,
						platformAccountId: profileId,
						username,
						displayName,
						avatarUrl,
						tokenExpiresAt,
						scopes: oauthConfig.scopes,
						...(igMetadata ? { metadata: igMetadata } : {}),
						...(igAppScopedId ? { webhookAccountId: igAppScopedId } : {}),
					},
					update: {
						username,
						displayName,
						avatarUrl,
						tokenExpiresAt,
						scopes: oauthConfig.scopes,
						...(igMetadata ? { metadata: igMetadata } : {}),
						...(igAppScopedId ? { webhookAccountId: igAppScopedId } : {}),
					},
					preserveExistingWorkspaceOnOmission: !workspaceWasExplicit,
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token,
				}),
		}));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[oauth][${platform}] Account upsert failed:`, message);
		if (isAccountWorkspaceConflictError(err)) {
			return {
				status: "error",
				code: err.code,
				message: err.message,
			};
		}
		if (isAccountWorkspaceAccessError(err)) {
			return {
				status: "error",
				code: err.code,
				message: err.message,
			};
		}
		return {
			status: "error",
			code: "ACCOUNT_SAVE_FAILED",
			message: `Failed to save your ${platform} account. Please try connecting again.`,
		};
	}

	const accessTokenForSubs = tokens.access_token;

	// Defer ALL best-effort post-upsert side effects so the user-facing OAuth
	// response (browser 302 / JSON) returns immediately instead of blocking on
	// external HTTP round-trips (avatar CDN fetch + R2 put, Queue handoff,
	// Instagram Graph subscriptions, ad-account discovery). The account and
	// customer-webhook outbox are already committed atomically; the response
	// carries the raw CDN avatar URL until the best-effort re-host completes.
	defer(
		(async () => {
			// Run the independent side effects concurrently; each logs its own errors.
			await Promise.allSettled([
				// Immediate Queue handoff for the already-durable outbox rows.
				enqueuePersistedWebhookEvent(env, db, persistedWebhook),

				// Avatar re-host to R2 (external fetch + R2 put + DB update).
				(async () => {
					if (!avatarUrl) return;
					const stableAvatar = await rehostAvatar(env, account.id, avatarUrl);
					if (stableAvatar) {
						await db
							.update(socialAccounts)
							.set({ avatarUrl: stableAvatar, updatedAt: new Date() })
							.where(eq(socialAccounts.id, account.id));
					}
				})(),

				// Connection log. Every completed OAuth operation is a distinct
				// occurrence, including reconnects with an identical account snapshot.
				(async () => {
					console.log(
						`[oauth][${platform}] Connected account ${account.id} (operation ${connectionOperationId})`,
					);
					await logConnectionEvent(
						env,
						orgId,
						{
							account_id: account.id,
							platform: account.platform,
							event: "connected",
							message: `Connected ${account.displayName || account.username || platform} account`,
						},
						db,
					);
				})(),

				// Subscribe YouTube channels to PubSubHubbub for video upload notifications.
				(async () => {
					if (platform === "youtube" && profileId) {
						const apiBaseUrl = env.API_BASE_URL || "https://api.relayapi.dev";
						await env.INBOX_QUEUE.send({
							type: "youtube_subscribe" as const,
							platform: "youtube",
							platform_account_id: profileId,
							organization_id: orgId,
							account_id: account.id,
							event_type: "subscribe",
							payload: {
								callback_url: `${apiBaseUrl}/webhooks/platform/youtube`,
							},
							received_at: new Date().toISOString(),
						});
					}
				})(),

				// Subscribe Instagram app + user account to receive webhook events.
				(async () => {
					if (platform !== "instagram") return;
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
							console.error(
								"[webhook-sub] Instagram subscription failed:",
								result.error,
							);
						}
					}
					// Per-user subscription — required by Meta to deliver webhooks for this account.
					// Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/webhooks
					if (accessTokenForSubs) {
						const userSubResult = await subscribeInstagramAccount(
							profileId,
							accessTokenForSubs,
						);
						if (!userSubResult.success) {
							console.error(
								"[webhook-sub] Instagram user subscription failed:",
								userSubResult.error,
							);
						}
					}
				})(),

				// Initialize external post sync state and enqueue immediate sync.
				(async () => {
					if (!getSupportedSyncPlatforms().includes(platform)) return;
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
				})(),

				// Auto-discover ad accounts for platforms that support ads.
				(async () => {
					if (!socialPlatformToAdPlatform(platform)) return;
					try {
						await discoverAdAccounts(env, orgId, account.id);
						console.log(
							`[oauth][${platform}] Auto-discovered ad accounts for ${account.id}`,
						);
					} catch (err) {
						console.error(
							`[oauth][${platform}] Ad account discovery failed (non-critical):`,
							err,
						);
					}
				})(),
			]);
		})(),
	);

	return { status: "success", account: formatAccountResponse(account).account };
}

// ===========================================================================
// Fixed-platform handlers must be registered before the /{platform} catch-all.
// ===========================================================================

// --- Newsletter: Beehiiv ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectBeehiiv, async (c) => {
	const orgId = c.get("orgId");
	const { api_key, publication_id, workspace_id } = c.req.valid("json");
	const db = c.get("db");
	const scope = await resolveOperationalCreateScope(
		c,
		workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

	try {
		// Validate credentials by fetching publication info
		const res = await fetch(
			`https://api.beehiiv.com/v2/publications/${publication_id}`,
			{
				headers: { Authorization: `Bearer ${api_key}` },
			},
		);
		if (!res.ok) {
			return c.json(
				{
					error: {
						code: "AUTH_FAILED",
						message: "Invalid Beehiiv API key or publication ID.",
					},
				} as never,
				400 as never,
			);
		}
		const pub = (await res.json()) as { data?: { name?: string } };
		const pubName = pub.data?.name ?? "Beehiiv Newsletter";

		const { account, webhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId: crypto.randomUUID(),
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId: scope.workspaceId,
						platform: "beehiiv",
						platformAccountId: publication_id,
						username: pubName,
						displayName: pubName,
						metadata: { publication_id, publication_name: pubName },
					},
					update: {
						username: pubName,
						displayName: pubName,
						metadata: { publication_id, publication_name: pubName },
					},
					preserveExistingWorkspaceOnOmission: workspace_id === undefined,
					accessToken: api_key,
				}),
		});
		c.executionCtx.waitUntil(enqueuePersistedWebhookEvent(c.env, db, webhook));
		return c.json(
			{
				account_id: account.id,
				platform: "beehiiv",
				username: pubName,
				display_name: pubName,
			},
			200,
		);
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[connect] Connection failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Connection failed. Please try again.",
				},
			} as never,
			500 as never,
		);
	}
});

// --- Newsletter: Kit (formerly ConvertKit) ---
// Official docs: https://developers.kit.com/api-reference/accounts/get-current-account
// Section "Get current account" documents:
// GET https://api.kit.com/v4/account
// Header: X-Kit-Api-Key: <api-key>
// Response fields: account.id, account.name, account.primary_email_address.
// Authentication guide: https://developers.kit.com/api-reference/authentication
// Section "Using V4 API keys" uses the same endpoint and header in its cURL.
// Upgrade guide: https://developers.kit.com/api-reference/upgrading-to-v4
// Section "General updates" states that V4 API Keys are not compatible with V3.
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectConvertKit, async (c) => {
	const orgId = c.get("orgId");
	const { api_key, workspace_id } = c.req.valid("json");
	const db = c.get("db");
	const scope = await resolveOperationalCreateScope(
		c,
		workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

	try {
		const res = await fetch("https://api.kit.com/v4/account", {
			headers: { "X-Kit-Api-Key": api_key },
		});
		if (!res.ok) {
			return c.json(
				{
					error: {
						code: "AUTH_FAILED",
						message: "Invalid Kit API v4 key.",
					},
				} as never,
				400 as never,
			);
		}
		const accountInfo = (await res.json()) as {
			account?: {
				id?: number;
				name?: string;
				primary_email_address?: string;
			};
			user?: { email?: string };
		};
		const kitAccount = accountInfo.account;
		const name = kitAccount?.name ?? "Kit";

		const { account, webhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId: crypto.randomUUID(),
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId: scope.workspaceId,
						platform: "convertkit",
						platformAccountId: api_key.slice(-8),
						username: name,
						displayName: name,
						metadata: {
							account_name: name,
							account_id: kitAccount?.id,
							primary_email_address:
								kitAccount?.primary_email_address ?? accountInfo.user?.email,
						},
					},
					update: {
						username: name,
						displayName: name,
					},
					preserveExistingWorkspaceOnOmission: workspace_id === undefined,
					accessToken: api_key,
					refreshToken: null,
				}),
		});
		c.executionCtx.waitUntil(enqueuePersistedWebhookEvent(c.env, db, webhook));
		return c.json(
			{
				account_id: account.id,
				platform: "convertkit",
				username: name,
				display_name: name,
			},
			200,
		);
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[connect] Connection failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Connection failed. Please try again.",
				},
			} as never,
			500 as never,
		);
	}
});

// --- Newsletter: Mailchimp ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectMailchimp, async (c) => {
	const orgId = c.get("orgId");
	const { api_key, workspace_id } = c.req.valid("json");
	const db = c.get("db");
	const scope = await resolveOperationalCreateScope(
		c,
		workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

	try {
		const datacenter = getMailchimpDatacenter(api_key);
		if (!datacenter) {
			return c.json(
				{
					error: {
						code: "INVALID_API_KEY",
						message: "Mailchimp API key has an invalid datacenter suffix.",
					},
				} as never,
				400 as never,
			);
		}
		const authHeader = `Basic ${btoa(`relayapi:${api_key}`)}`;
		const res = await fetch(buildMailchimpApiUrl(datacenter), {
			headers: { Authorization: authHeader },
		});
		if (!res.ok) {
			return c.json(
				{
					error: { code: "AUTH_FAILED", message: "Invalid Mailchimp API key." },
				} as never,
				400 as never,
			);
		}
		const info = (await res.json()) as {
			account_name?: string;
			login_id?: string;
			account_id?: string;
		};
		const name = info.account_name ?? "Mailchimp";
		const accountId = info.account_id ?? api_key.slice(-8);

		const { account, webhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId: crypto.randomUUID(),
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId: scope.workspaceId,
						platform: "mailchimp",
						platformAccountId: accountId,
						username: name,
						displayName: name,
						metadata: { datacenter, account_name: name },
					},
					update: {
						username: name,
						displayName: name,
						metadata: { datacenter, account_name: name },
					},
					preserveExistingWorkspaceOnOmission: workspace_id === undefined,
					accessToken: api_key,
				}),
		});
		c.executionCtx.waitUntil(enqueuePersistedWebhookEvent(c.env, db, webhook));
		return c.json(
			{
				account_id: account.id,
				platform: "mailchimp",
				username: name,
				display_name: name,
			},
			200,
		);
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[connect] Connection failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Connection failed. Please try again.",
				},
			} as never,
			500 as never,
		);
	}
});

// --- Newsletter: ListMonk ---
// @ts-expect-error — hono-zod-openapi strict typing
app.openapi(connectListMonk, async (c) => {
	const orgId = c.get("orgId");
	const {
		instance_url,
		username: user,
		password,
		workspace_id,
	} = c.req.valid("json");
	const db = c.get("db");
	const scope = await resolveOperationalCreateScope(
		c,
		workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

	try {
		const cleanUrl = instance_url.replace(/\/$/, "");

		// SSRF protection: block private/reserved IPs and non-HTTPS URLs
		if (await isBlockedUrlWithDns(cleanUrl)) {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message:
							"instance_url must be a public host. Private/reserved IPs are not allowed.",
					},
				} as never,
				400 as never,
			);
		}
		try {
			const parsed = new URL(cleanUrl);
			if (parsed.protocol !== "https:") {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "instance_url must use HTTPS.",
						},
					} as never,
					400 as never,
				);
			}
		} catch {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: "instance_url is not a valid URL.",
					},
				} as never,
				400 as never,
			);
		}

		const basicAuth = btoa(`${user}:${password}`);
		const res = await fetch(`${cleanUrl}/api/settings`, {
			headers: { Authorization: `Basic ${basicAuth}` },
			redirect: "error",
		});
		if (!res.ok) {
			return c.json(
				{
					error: {
						code: "AUTH_FAILED",
						message: "Invalid ListMonk credentials or instance URL.",
					},
				} as never,
				400 as never,
			);
		}

		const name = `ListMonk (${new URL(cleanUrl).hostname})`;
		const { account, webhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId: crypto.randomUUID(),
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId: scope.workspaceId,
						platform: "listmonk",
						platformAccountId: cleanUrl,
						username: name,
						displayName: name,
						metadata: { instance_url: cleanUrl },
					},
					update: {
						username: name,
						displayName: name,
						metadata: { instance_url: cleanUrl },
					},
					preserveExistingWorkspaceOnOmission: workspace_id === undefined,
					accessToken: basicAuth,
				}),
		});
		c.executionCtx.waitUntil(enqueuePersistedWebhookEvent(c.env, db, webhook));
		return c.json(
			{
				account_id: account.id,
				platform: "listmonk",
				username: name,
				display_name: name,
			},
			200,
		);
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[connect] Connection failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Connection failed. Please try again.",
				},
			} as never,
			500 as never,
		);
	}
});

// --- Bluesky (credential-based) ---
app.openapi(connectBluesky, async (c) => {
	const orgId = c.get("orgId");
	const { handle, app_password, workspace_id } = c.req.valid("json");
	const db = c.get("db");
	const scope = await resolveOperationalCreateScope(
		c,
		workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

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
		let account: ConnectedSocialAccount;
		let persistedWebhook: PersistedWebhookEvent;
		try {
			({ account, webhook: persistedWebhook } = await persistConnectedAccount({
				db,
				orgId,
				connectionOperationId: crypto.randomUUID(),
				upsert: async (tx) =>
					upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
						apiKeyId: c.get("keyId"),
						authorizedWorkspaceScope: c.get("workspaceScope"),
						insert: {
							organizationId: orgId,
							workspaceId: scope.workspaceId,
							platform: "bluesky",
							platformAccountId: session.did,
							username: session.handle,
							displayName: session.handle,
						},
						update: {
							username: session.handle,
							displayName: session.handle,
						},
						preserveExistingWorkspaceOnOmission: workspace_id === undefined,
						accessToken: app_password,
					}),
			}));
		} catch (err) {
			const conflict = accountWorkspaceConflictResponse(c, err);
			if (conflict) return conflict as never;
			console.error(
				"[oauth][bluesky] Account upsert failed:",
				err instanceof Error ? err.message : err,
			);
			return c.json(
				{
					error: {
						code: "ACCOUNT_SAVE_FAILED",
						message: "Failed to save Bluesky account. Please try again.",
					},
				} as never,
				500 as never,
			);
		}

		c.executionCtx.waitUntil(
			enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
		);
		c.executionCtx.waitUntil(
			logConnectionEvent(c.env, orgId, {
				account_id: account.id,
				platform: account.platform,
				event: "connected",
				message: `Connected ${account.displayName || "bluesky"} account`,
			}),
		);

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
	const { workspace_id } = c.req.valid("query");
	const scope = await resolveOperationalCreateScope(
		c,
		workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;
	const { code, expiresAt } = await issueTelegramConnectionChallenge(
		c.get("db"),
		c.get("orgId"),
		c.get("keyId"),
		c.get("workspaceScope"),
		scope.workspaceId,
	);

	return c.json(
		{
			code,
			expires_at: expiresAt.toISOString(),
			expires_in: 900,
			bot_username: "RelayAPIBot",
			instructions: [
				"1. Add @RelayAPIBot as an administrator in your channel/group",
				"2. Open a private chat with @RelayAPIBot",
				`3. Send: ${code} @yourchannel (replace @yourchannel with your channel username)`,
				"4. Wait for confirmation — poll GET /v1/connect/telegram?code=... for status",
			],
		} as never,
		200 as never,
	);
});

app.openapi(pollTelegram, async (c) => {
	const orgId = c.get("orgId");
	const { code } = c.req.valid("query");
	const data = await readTelegramConnectionChallenge(c.get("db"), orgId, code);
	if (data.apiKeyId !== undefined && data.apiKeyId !== c.get("keyId")) {
		return c.json(
			{
				error: { code: "NOT_FOUND", message: "Challenge not found" },
			} as never,
			404 as never,
		);
	}
	if (data.workspaceId !== undefined) {
		const denied = assertWorkspaceScope(c, data.workspaceId);
		if (denied) return denied as never;
	}

	return c.json(
		{
			status: data.status,
			chat_id: data.chatId,
			chat_title: data.chatTitle,
		} as never,
		200 as never,
	);
});

// --- Pending data ---
app.openapi(getPendingData, async (c) => {
	const { token } = c.req.valid("query");
	const data = await c.env.KV.get<
		Record<string, unknown> & {
			organization_id?: string;
			initiator_key_id?: string;
			initial_workspace_scope?: "all" | string[];
			workspace_id?: string | null;
		}
	>(`pending-oauth:${token}`, "json");

	if (
		!data ||
		data.organization_id !== c.get("orgId") ||
		data.initiator_key_id !== c.get("keyId") ||
		!("initial_workspace_scope" in data) ||
		!("workspace_id" in data)
	) {
		return c.json(
			{
				error: { code: "NOT_FOUND", message: "Token not found or expired" },
			} as never,
			404 as never,
		);
	}
	const initialWorkspaceScope = parseApiKeyWorkspaceScope({
		workspace_scope: data.initial_workspace_scope,
	});
	if (initialWorkspaceScope === null) {
		return c.json(
			{
				error: { code: "NOT_FOUND", message: "Token not found or expired" },
			} as never,
			404 as never,
		);
	}
	const validation = await validatePersistedOperationalScope(c.get("db"), {
		apiKeyId: data.initiator_key_id,
		organizationId: c.get("orgId"),
		workspaceId: data.workspace_id ?? null,
		resourceName: "connected account",
	});
	if (!validation.ok) {
		return c.json(
			{
				error: { code: validation.code, message: validation.message },
			} as never,
			validation.status as never,
		);
	}
	const denied = assertWorkspaceScope(c, data.workspace_id ?? null);
	if (denied) return denied as never;

	await c.env.KV.delete(`pending-oauth:${token}`);
	const {
		organization_id: _organizationId,
		initiator_key_id: _initiatorKeyId,
		initial_workspace_scope: _initialWorkspaceScope,
		...response
	} = data;
	return c.json(response as never, 200 as never);
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
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

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
	const tokenUrl = new URL(`${GRAPH_BASE.facebook}/oauth/access_token`);
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
	const debugUrl = new URL(`${GRAPH_BASE.facebook}/debug_token`);
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
	const phoneUrl = new URL(`${GRAPH_BASE.facebook}/${wabaId}/phone_numbers`);
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

	const phone = phoneData.data?.[0];
	if (!phone) {
		return c.json(
			{
				error: {
					code: "PHONE_NUMBER_NOT_FOUND",
					message: "No phone numbers found for this WhatsApp Business Account",
				},
			} as never,
			400 as never,
		);
	}
	const phoneNumberId = phone.id;
	const displayPhoneNumber = phone.display_phone_number;

	// Step 4: Atomic upsert to handle re-connections gracefully
	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId: crypto.randomUUID(),
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId: scope.workspaceId,
						platform: "whatsapp",
						platformAccountId: phoneNumberId,
						displayName: displayPhoneNumber || "WhatsApp Business",
						metadata: {
							waba_id: wabaId,
							phone_number: displayPhoneNumber,
						},
					},
					update: {
						displayName: displayPhoneNumber || "WhatsApp Business",
						metadata: {
							waba_id: wabaId,
							phone_number: displayPhoneNumber,
						},
					},
					preserveExistingWorkspaceOnOmission: body.workspace_id === undefined,
					accessToken,
				}),
		}));
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[oauth][whatsapp] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save WhatsApp account. Please try again.",
				},
			} as never,
			500 as never,
		);
	}

	c.executionCtx.waitUntil(
		enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	if (
		c.env.WHATSAPP_APP_ID &&
		c.env.WHATSAPP_APP_SECRET &&
		c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN
	) {
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
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;

	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId: crypto.randomUUID(),
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: c.get("keyId"),
					authorizedWorkspaceScope: c.get("workspaceScope"),
					insert: {
						organizationId: orgId,
						workspaceId: scope.workspaceId,
						platform: "whatsapp",
						platformAccountId: body.phone_number_id,
						displayName: "WhatsApp Business",
						metadata: { waba_id: body.waba_id },
					},
					update: {
						displayName: "WhatsApp Business",
						metadata: { waba_id: body.waba_id },
					},
					preserveExistingWorkspaceOnOmission: body.workspace_id === undefined,
					accessToken: body.access_token,
				}),
		}));
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[oauth][whatsapp] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save WhatsApp account. Please try again.",
				},
			} as never,
			500 as never,
		);
	}

	c.executionCtx.waitUntil(
		enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	if (
		c.env.WHATSAPP_APP_ID &&
		c.env.WHATSAPP_APP_SECRET &&
		c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN
	) {
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

interface FacebookPage {
	id: string;
	name: string;
	access_token: string;
	category?: string;
}

/**
 * Fetch ALL pages the user administers, following Graph API `paging.next` cursors.
 * Graph API returns 25 pages per call by default; an agency user can administer
 * far more, so a single un-paginated call truncates the list and makes pages
 * beyond #25 impossible to select. We request limit=100 and follow next links
 * (capped at 20 pages = up to 2000 Pages) to bound worst-case latency.
 */
async function fetchAllFacebookPages(
	accessToken: string,
): Promise<FacebookPage[]> {
	const pages: FacebookPage[] = [];
	let url: string | null =
		`${GRAPH_BASE.facebook}/me/accounts?fields=id,name,category,access_token&limit=100&access_token=${accessToken}`;
	let guard = 0;
	while (url && guard < 20) {
		guard++;
		const res: Response = await fetch(url);
		if (!res.ok) break;
		const json = (await res.json()) as {
			data?: FacebookPage[];
			paging?: { next?: string };
		};
		if (Array.isArray(json.data)) pages.push(...json.data);
		url = json.paging?.next ?? null;
	}
	return pages;
}

app.openapi(listFacebookPages, async (c) => {
	const orgId = c.get("orgId");
	const { connect_token } = c.req.valid("query");
	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			connection_operation_id: string;
			workspace_id_was_explicit?: boolean;
			access_token: string;
			profile_id?: string;
			expires_at?: string | null;
		}
	>(pendingSecondaryKey(orgId, "facebook", connect_token), "json");

	if (!pendingData?.access_token) {
		return c.json({ pages: [] } as never, 200 as never);
	}
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt token from KV
	const accessToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";

	try {
		// Facebook Pages API: List pages managed by the authenticated user.
		// Follows paging.next so users with more than 25 pages see all of them.
		// https://developers.facebook.com/docs/pages-api/overview
		const allPages = await fetchAllFacebookPages(accessToken);
		return c.json(
			{
				pages: allPages.map((p) => ({
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

	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			connection_operation_id: string;
			workspace_id_was_explicit?: boolean;
			access_token: string;
			profile_id?: string;
			expires_at?: string | null;
		}
	>(pendingSecondaryKey(orgId, "facebook", body.connect_token), "json");

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
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt token from KV
	const decryptedFbToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";
	const connectionOperationId = pendingData.connection_operation_id;

	// Fetch page access token
	try {
		// Facebook Pages API: List pages to find the selected page's access token.
		// Follows paging.next so a page beyond #25 can still be selected.
		// https://developers.facebook.com/docs/pages-api/overview
		const allPages = await fetchAllFacebookPages(decryptedFbToken);
		const page = allPages.find((p) => p.id === body.page_id);

		if (!page) {
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "Page not found in user's pages",
					},
				} as never,
				404 as never,
			);
		}

		// Fetch page avatar (picture)
		let pageAvatarUrl: string | null = null;
		try {
			const picRes = await fetch(
				`${GRAPH_BASE.facebook}/${page.id}/picture?redirect=false&type=small&access_token=${page.access_token}`,
			);
			if (picRes.ok) {
				const picJson = (await picRes.json()) as { data?: { url?: string } };
				pageAvatarUrl = picJson.data?.url ?? null;
			}
		} catch {
			// Avatar fetch failed — proceed without it
		}

		// Atomic upsert: update if page already connected, insert otherwise
		const facebookConfig = OAUTH_CONFIGS.facebook;
		if (!facebookConfig) {
			throw new Error("Facebook OAuth config is not registered");
		}
		let account: ConnectedSocialAccount;
		let persistedWebhook: PersistedWebhookEvent;
		try {
			({ account, webhook: persistedWebhook } = await persistConnectedAccount({
				db,
				orgId,
				connectionOperationId,
				upsert: async (tx) => {
					const saved = await upsertConnectedAccountWithCredentials(
						tx,
						c.env.ENCRYPTION_KEY,
						{
							apiKeyId: pendingData.initiator_key_id,
							authorizedWorkspaceScope: authorization.initialWorkspaceScope,
							insert: {
								organizationId: orgId,
								workspaceId: pendingData.workspace_id,
								platform: "facebook",
								platformAccountId: page.id,
								username: page.name,
								displayName: page.name,
								avatarUrl: pageAvatarUrl,
								scopes: facebookConfig.scopes,
							},
							update: {
								username: page.name,
								displayName: page.name,
								avatarUrl: pageAvatarUrl,
								scopes: facebookConfig.scopes,
							},
							preserveExistingWorkspaceOnOmission: !(
								pendingData.workspace_id_was_explicit ??
								pendingData.workspace_id !== null
							),
							accessToken: page.access_token,
						},
					);
					if (!saved) return undefined;
					const adsToken = await encryptAccountToken(
						decryptedFbToken,
						c.env.ENCRYPTION_KEY,
						saved.id,
						"meta_ads_user_access_token",
					);
					if (!adsToken) throw new Error("Facebook user token is unavailable");
					const metadata = withMetaAdsUserAccessToken(
						saved.metadata,
						adsToken,
						pendingData.profile_id,
						pendingData.expires_at ?? null,
					);
					const [updated] = await tx
						.update(socialAccounts)
						.set({ metadata, updatedAt: new Date() })
						.where(eq(socialAccounts.id, saved.id))
						.returning();
					return updated;
				},
			}));
		} catch (err) {
			const conflict = accountWorkspaceConflictResponse(c, err);
			if (conflict) return conflict as never;
			console.error(
				"[oauth][facebook] Account upsert failed:",
				err instanceof Error ? err.message : err,
			);
			return c.json(
				{
					error: {
						code: "ACCOUNT_SAVE_FAILED",
						message: "Failed to save Facebook page. Please try again.",
					},
				} as never,
				500 as never,
			);
		}

		if (account) {
			c.executionCtx.waitUntil(
				enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
			);
			// Re-host the avatar to R2 so the stored URL is durable (best-effort).
			if (pageAvatarUrl) {
				const stableAvatar = await rehostAvatar(
					c.env,
					account.id,
					pageAvatarUrl,
				);
				if (stableAvatar) {
					await db
						.update(socialAccounts)
						.set({ avatarUrl: stableAvatar, updatedAt: new Date() })
						.where(eq(socialAccounts.id, account.id));
					account.avatarUrl = stableAvatar;
				}
			}

			c.executionCtx.waitUntil(
				logConnectionEvent(c.env, orgId, {
					account_id: account.id,
					platform: account.platform,
					event: "connected",
					message: `Connected ${account.displayName || "facebook"} page`,
				}),
			);
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
						console.log(
							`[oauth][facebook] Auto-discovered ad accounts for ${account.id}`,
						);
					})
					.catch((err) => {
						console.error(
							"[oauth][facebook] Ad account discovery failed (non-critical):",
							err,
						);
					}),
			);
		}

		await c.env.KV.delete(
			pendingSecondaryKey(orgId, "facebook", body.connect_token),
		);

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
	const { connect_token } = c.req.valid("query");
	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			access_token: string;
		}
	>(pendingSecondaryKey(orgId, "linkedin", connect_token), "json");

	if (!pendingData?.access_token) {
		return c.json({ organizations: [] } as never, 200 as never);
	}
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt token from KV
	const decryptedLiToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";

	try {
		const organizations =
			await fetchLinkedInAccessibleOrganizations(decryptedLiToken);
		return c.json(
			{
				organizations: organizations.map((organization) => ({
					urn: organization.urn,
					name: organization.name,
					logo_url: organization.logo_url,
					vanity_name: organization.vanity_name,
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

	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			connection_operation_id: string;
			workspace_id_was_explicit?: boolean;
			access_token: string;
			refresh_token?: string | null;
			profile_id?: string;
			expires_at?: string | null;
		}
	>(pendingSecondaryKey(orgId, "linkedin", body.connect_token), "json");

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
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt the one-time KV payload; the account writer seals it to
	// the stable database id inside the transaction.
	const decryptedLiSetToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";
	const connectionOperationId = pendingData.connection_operation_id;
	// Carry through the refresh token + expiry so accounts with programmatic-refresh
	// approval can auto-refresh (LinkedIn access tokens expire in ~60 days).
	const decryptedLiRefreshToken = pendingData.refresh_token
		? await maybeDecrypt(pendingData.refresh_token, c.env.ENCRYPTION_KEY)
		: null;
	const liTokenExpiresAt = pendingData.expires_at
		? new Date(pendingData.expires_at)
		: null;
	// For org accounts, use the org URN. For personal accounts, use the stable profile ID from OAuth.
	const linkedinPlatformId =
		body.organization_urn ?? pendingData.profile_id ?? `linkedin_${Date.now()}`;
	const linkedinConfig = OAUTH_CONFIGS.linkedin;
	if (!linkedinConfig) {
		throw new Error("LinkedIn OAuth config is not registered");
	}
	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId,
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: pendingData.initiator_key_id,
					authorizedWorkspaceScope: authorization.initialWorkspaceScope,
					insert: {
						organizationId: orgId,
						workspaceId: pendingData.workspace_id,
						platform: "linkedin",
						platformAccountId: linkedinPlatformId,
						displayName: `LinkedIn Org ${body.organization_urn ?? "personal"}`,
						tokenExpiresAt: liTokenExpiresAt,
						metadata: {
							account_type: body.account_type ?? "organization",
							organization_urn: body.organization_urn,
						},
						scopes: linkedinConfig.scopes,
					},
					update: {
						displayName: `LinkedIn Org ${body.organization_urn ?? "personal"}`,
						tokenExpiresAt: liTokenExpiresAt,
						metadata: {
							account_type: body.account_type ?? "organization",
							organization_urn: body.organization_urn,
						},
						scopes: linkedinConfig.scopes,
					},
					preserveExistingWorkspaceOnOmission: !(
						pendingData.workspace_id_was_explicit ??
						pendingData.workspace_id !== null
					),
					accessToken: decryptedLiSetToken,
					refreshToken: decryptedLiRefreshToken,
				}),
		}));
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[oauth][linkedin] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save LinkedIn account. Please try again.",
				},
			} as never,
			500 as never,
		);
	}

	await c.env.KV.delete(
		pendingSecondaryKey(orgId, "linkedin", body.connect_token),
	);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	c.executionCtx.waitUntil(
		enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Pinterest Boards ---
app.openapi(listPinterestBoards, async (c) => {
	const orgId = c.get("orgId");
	const { connect_token } = c.req.valid("query");
	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			access_token: string;
		}
	>(pendingSecondaryKey(orgId, "pinterest", connect_token), "json");

	if (!pendingData?.access_token) {
		return c.json({ boards: [] } as never, 200 as never);
	}
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt token from KV
	const decryptedPinListToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";

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

	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			connection_operation_id: string;
			workspace_id_was_explicit?: boolean;
			access_token: string;
			refresh_token?: string | null;
			profile_id?: string;
			expires_at?: string | null;
		}
	>(pendingSecondaryKey(orgId, "pinterest", body.connect_token), "json");

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
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;

	// SECURITY: Decrypt token from KV, then re-encrypt for DB storage
	const decryptedPinSetToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";
	const connectionOperationId = pendingData.connection_operation_id;
	// Carry through the refresh token + expiry so the account can auto-refresh
	// (Pinterest access tokens expire in ~30 days).
	const decryptedPinRefreshToken = pendingData.refresh_token
		? await maybeDecrypt(pendingData.refresh_token, c.env.ENCRYPTION_KEY)
		: null;
	const pinTokenExpiresAt = pendingData.expires_at
		? new Date(pendingData.expires_at)
		: null;

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

	const pinterestConfig = OAUTH_CONFIGS.pinterest;
	if (!pinterestConfig) {
		throw new Error("Pinterest OAuth config is not registered");
	}
	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId,
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: pendingData.initiator_key_id,
					authorizedWorkspaceScope: authorization.initialWorkspaceScope,
					insert: {
						organizationId: orgId,
						workspaceId: pendingData.workspace_id,
						platform: "pinterest",
						platformAccountId: profileId,
						username,
						displayName: username,
						tokenExpiresAt: pinTokenExpiresAt,
						metadata: { default_board_id: body.board_id },
						scopes: pinterestConfig.scopes,
					},
					update: {
						username,
						displayName: username,
						tokenExpiresAt: pinTokenExpiresAt,
						metadata: { default_board_id: body.board_id },
						scopes: pinterestConfig.scopes,
					},
					preserveExistingWorkspaceOnOmission: !(
						pendingData.workspace_id_was_explicit ??
						pendingData.workspace_id !== null
					),
					accessToken: decryptedPinSetToken,
					refreshToken: decryptedPinRefreshToken,
				}),
		}));
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[oauth][pinterest] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save Pinterest account. Please try again.",
				},
			} as never,
			500 as never,
		);
	}

	await c.env.KV.delete(
		pendingSecondaryKey(orgId, "pinterest", body.connect_token),
	);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	c.executionCtx.waitUntil(
		enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Google Business Locations ---
app.openapi(listGBPLocations, async (c) => {
	const orgId = c.get("orgId");
	const { connect_token } = c.req.valid("query");
	// Note: refresh_token / expires_at are also present in this KV entry (written
	// by exchangeAndSaveAccount) and are preserved by the spread when we re-put
	// the entry below with google_account_name — required so the select handler
	// can persist them and the account can auto-refresh.
	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			access_token: string;
			refresh_token?: string | null;
			expires_at?: string | null;
		}
	>(pendingSecondaryKey(orgId, "googlebusiness", connect_token), "json");

	if (!pendingData?.access_token) {
		return c.json({ locations: [] } as never, 200 as never);
	}
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt token from KV
	const decryptedGbpToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";

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
			pendingSecondaryKey(orgId, "googlebusiness", connect_token),
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

	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			connection_operation_id: string;
			workspace_id_was_explicit?: boolean;
			access_token: string;
			refresh_token?: string | null;
			expires_at?: string | null;
			google_account_name?: string;
		}
	>(pendingSecondaryKey(orgId, "googlebusiness", body.connect_token), "json");

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
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;

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
	// SECURITY: Decrypt the one-time KV payload; the account writer seals it.
	const decryptedGbpSetToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";
	const connectionOperationId = pendingData.connection_operation_id;
	// Carry through the refresh token + expiry so the account can auto-refresh
	// (Google access tokens expire in ~1 hour — without the refresh token the
	// account dies almost immediately).
	const decryptedGbpRefreshToken = pendingData.refresh_token
		? await maybeDecrypt(pendingData.refresh_token, c.env.ENCRYPTION_KEY)
		: null;
	const gbpTokenExpiresAt = pendingData.expires_at
		? new Date(pendingData.expires_at)
		: null;
	const googleBusinessConfig = OAUTH_CONFIGS.googlebusiness;
	if (!googleBusinessConfig) {
		throw new Error("Google Business OAuth config is not registered");
	}
	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId,
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: pendingData.initiator_key_id,
					authorizedWorkspaceScope: authorization.initialWorkspaceScope,
					insert: {
						organizationId: orgId,
						workspaceId: pendingData.workspace_id,
						platform: "googlebusiness",
						platformAccountId: body.location_id,
						displayName: `Google Business ${body.location_id}`,
						tokenExpiresAt: gbpTokenExpiresAt,
						metadata: {
							location_id: body.location_id,
							google_account_name: pendingData.google_account_name,
						},
						scopes: googleBusinessConfig.scopes,
					},
					update: {
						displayName: `Google Business ${body.location_id}`,
						tokenExpiresAt: gbpTokenExpiresAt,
						metadata: {
							location_id: body.location_id,
							google_account_name: pendingData.google_account_name,
						},
						scopes: googleBusinessConfig.scopes,
					},
					preserveExistingWorkspaceOnOmission: !(
						pendingData.workspace_id_was_explicit ??
						pendingData.workspace_id !== null
					),
					accessToken: decryptedGbpSetToken,
					refreshToken: decryptedGbpRefreshToken,
				}),
		}));
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[oauth][googlebusiness] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save Google Business account. Please try again.",
				},
			} as never,
			500 as never,
		);
	}

	await c.env.KV.delete(
		pendingSecondaryKey(orgId, "googlebusiness", body.connect_token),
	);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	c.executionCtx.waitUntil(
		enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- Secondary selection: Snapchat Profiles ---
app.openapi(listSnapchatProfiles, async (c) => {
	const orgId = c.get("orgId");
	const { connect_token } = c.req.valid("query");
	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			access_token: string;
		}
	>(pendingSecondaryKey(orgId, "snapchat", connect_token), "json");

	if (!pendingData?.access_token) {
		return c.json({ profiles: [] } as never, 200 as never);
	}
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;
	// SECURITY: Decrypt token from KV
	const decryptedSnapListToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";

	try {
		// Snapchat Marketing API: List organizations the authenticated user belongs to
		// https://developers.snap.com/api/marketing-api/general/Myself
		const res = await fetch("https://adsapi.snapchat.com/v1/me/organizations", {
			headers: { Authorization: `Bearer ${decryptedSnapListToken}` },
		});
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

	const pendingData = await c.env.KV.get<
		PendingSecondaryScope & {
			connection_operation_id: string;
			workspace_id_was_explicit?: boolean;
			access_token: string;
			refresh_token?: string | null;
			expires_at?: string | null;
		}
	>(pendingSecondaryKey(orgId, "snapchat", body.connect_token), "json");

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
	const authorization = await authorizePendingSecondary(c, pendingData);
	if (!authorization.ok) return authorization.response as never;
	const denied = assertWorkspaceScope(c, pendingData.workspace_id);
	if (denied) return denied as never;

	// SECURITY: Decrypt the one-time KV payload; the account writer seals it.
	const decryptedSnapSetToken =
		(await maybeDecrypt(pendingData.access_token, c.env.ENCRYPTION_KEY)) ?? "";
	const connectionOperationId = pendingData.connection_operation_id;
	// Carry through the refresh token + expiry so the account can auto-refresh
	// (Snapchat access tokens expire in ~1 hour).
	const decryptedSnapRefreshToken = pendingData.refresh_token
		? await maybeDecrypt(pendingData.refresh_token, c.env.ENCRYPTION_KEY)
		: null;
	const snapTokenExpiresAt = pendingData.expires_at
		? new Date(pendingData.expires_at)
		: null;
	const snapchatConfig = OAUTH_CONFIGS.snapchat;
	if (!snapchatConfig) {
		throw new Error("Snapchat OAuth config is not registered");
	}
	let account: ConnectedSocialAccount;
	let persistedWebhook: PersistedWebhookEvent;
	try {
		({ account, webhook: persistedWebhook } = await persistConnectedAccount({
			db,
			orgId,
			connectionOperationId,
			upsert: async (tx) =>
				upsertConnectedAccountWithCredentials(tx, c.env.ENCRYPTION_KEY, {
					apiKeyId: pendingData.initiator_key_id,
					authorizedWorkspaceScope: authorization.initialWorkspaceScope,
					insert: {
						organizationId: orgId,
						workspaceId: pendingData.workspace_id,
						platform: "snapchat",
						platformAccountId: body.profile_id,
						displayName: `Snapchat ${body.profile_id}`,
						tokenExpiresAt: snapTokenExpiresAt,
						scopes: snapchatConfig.scopes,
					},
					update: {
						displayName: `Snapchat ${body.profile_id}`,
						tokenExpiresAt: snapTokenExpiresAt,
						scopes: snapchatConfig.scopes,
					},
					preserveExistingWorkspaceOnOmission: !(
						pendingData.workspace_id_was_explicit ??
						pendingData.workspace_id !== null
					),
					accessToken: decryptedSnapSetToken,
					refreshToken: decryptedSnapRefreshToken,
				}),
		}));
	} catch (err) {
		const conflict = accountWorkspaceConflictResponse(c, err);
		if (conflict) return conflict as never;
		console.error(
			"[oauth][snapchat] Account upsert failed:",
			err instanceof Error ? err.message : err,
		);
		return c.json(
			{
				error: {
					code: "ACCOUNT_SAVE_FAILED",
					message: "Failed to save Snapchat account. Please try again.",
				},
			} as never,
			500 as never,
		);
	}

	await c.env.KV.delete(
		pendingSecondaryKey(orgId, "snapchat", body.connect_token),
	);

	if (!account) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "Failed to save account" },
			} as never,
			500 as never,
		);
	}

	c.executionCtx.waitUntil(
		enqueuePersistedWebhookEvent(c.env, db, persistedWebhook),
	);
	c.executionCtx.waitUntil(
		logConnectionEvent(c.env, orgId, {
			account_id: account.id,
			platform: account.platform,
			event: "connected",
			message: `Connected ${account.displayName || account.username || account.platform} account`,
		}),
	);

	return c.json(formatAccountResponse(account) as never, 201 as never);
});

// --- OAuth catch-all (must be last due to /{platform} wildcard) ---
app.openapi(startOAuth, async (c) => {
	const orgId = c.get("orgId");
	const { platform } = c.req.valid("param");
	const query = c.req.valid("query");
	const scope = await resolveOperationalCreateScope(
		c,
		query.workspace_id,
		"connected account",
	);
	if (!scope.ok) return scope.response as never;
	const method = query.method ?? undefined;
	const headless = query.headless === "true";
	// Customer's redirect URL — where we redirect after the OAuth exchange completes.
	// Default to app.relayapi.dev (which is in the redirect allowlist); api.relayapi.dev
	// is intentionally NOT allowlisted, so it cannot be used as a fallback.
	const customerRedirectUrl =
		query.redirect_url ?? "https://app.relayapi.dev/connect/callback";

	// SECURITY: Validate redirect_url against allowed domains and protocols.
	if (!isAllowedCustomerRedirectUrl(customerRedirectUrl)) {
		return c.json(
			{
				error: {
					code: "INVALID_REDIRECT_URL",
					message: "Invalid redirect_url",
				},
			} as never,
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
	const connectionOperationId = crypto.randomUUID();
	let codeChallenge: string | undefined;
	let codeVerifier: string | undefined;

	if (oauthConfig.requiresPkce) {
		const pkce = await generatePkce();
		codeChallenge = pkce.codeChallenge;
		codeVerifier = pkce.codeVerifier;
	}

	// Store the customer's redirect state in SQL so it is globally visible and
	// atomically single-use. The PKCE verifier is encrypted by the capability
	// service and the raw state token is never persisted.
	// When `headless` is set, the callback instead writes the exchange result to
	// `pending-oauth:{state}` (polled via GET /connect/pending-data) and skips the redirect.
	await issueOneTimeCapability(c.get("db"), c.env.ENCRYPTION_KEY, {
		kind: "oauth_state",
		token: state,
		organizationId: orgId,
		payload: {
			org_id: orgId,
			initiator_key_id: c.get("keyId"),
			initial_workspace_scope: c.get("workspaceScope"),
			workspace_id: scope.workspaceId,
			workspace_id_was_explicit: query.workspace_id !== undefined,
			settings_revision: scope.settingsRevision,
			platform,
			connection_operation_id: connectionOperationId,
			method: method ?? null,
			redirect_url: customerRedirectUrl,
			code_verifier: codeVerifier ?? null,
			headless,
		},
		expiresAt: new Date(Date.now() + 10 * 60 * 1000),
	});

	// Build auth URL with RelayAPI's callback — NOT the customer's URL
	const authUrl = buildAuthUrl(
		oauthConfig,
		clientId,
		oauthRedirectUri,
		state,
		codeChallenge,
	);

	// In headless mode, also return the temp token the caller polls with after the
	// user finishes the provider authorization in a browser/webview.
	if (headless) {
		return c.json(
			{ auth_url: authUrl, temp_token: state } as never,
			200 as never,
		);
	}

	return c.json({ auth_url: authUrl } as never, 200 as never);
});

app.openapi(completeOAuth, async (c) => {
	const orgId = c.get("orgId");
	const { platform } = c.req.valid("param");
	const body = c.req.valid("json");

	// Default to app.relayapi.dev (allowlisted); api.relayapi.dev is intentionally
	// not in the redirect allowlist, so it cannot be used as a fallback.
	const customerRedirectUrl =
		body.redirect_url ?? "https://app.relayapi.dev/connect/callback";

	// SECURITY: Validate redirect_url against allowed domains and protocols.
	if (!isAllowedCustomerRedirectUrl(customerRedirectUrl)) {
		return c.json(
			{
				error: {
					code: "INVALID_REDIRECT_URL",
					message: "Invalid redirect_url",
				},
			} as never,
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
	let connectionOperationId: string | undefined;
	let workspaceId: string | null = null;
	let workspaceWasExplicit = false;
	let initiatorKeyId = c.get("keyId");
	let authorizedWorkspaceScope: "all" | string[] = c.get("workspaceScope");

	if (body.state) {
		const stateData = await claimOneTimeCapability<{
			org_id: string;
			initiator_key_id: string;
			initial_workspace_scope: "all" | string[];
			workspace_id: string | null;
			workspace_id_was_explicit?: boolean;
			settings_revision: number;
			platform: string;
			connection_operation_id: string;
			method?: string | null;
			redirect_url?: string;
			code_verifier: string | null;
		}>(c.get("db"), c.env.ENCRYPTION_KEY, "oauth_state", body.state);
		if (
			stateData?.org_id === orgId &&
			stateData?.platform === platform &&
			stateData.initiator_key_id === c.get("keyId")
		) {
			if (
				body.workspace_id !== undefined &&
				body.workspace_id !== stateData.workspace_id
			) {
				return c.json(
					{
						error: {
							code: "WORKSPACE_ID_MISMATCH",
							message:
								"workspace_id does not match the OAuth flow that was started.",
						},
					} as never,
					400 as never,
				);
			}
			const denied = assertWorkspaceScope(c, stateData.workspace_id);
			if (denied) return denied as never;
			const initialWorkspaceScope = parseApiKeyWorkspaceScope({
				workspace_scope: stateData.initial_workspace_scope,
			});
			if (initialWorkspaceScope === null) {
				return c.json(
					{
						error: {
							code: "INVALID_STATE",
							message: "OAuth state contains invalid authorization data.",
						},
					} as never,
					400 as never,
				);
			}
			const validation = await validatePersistedOperationalScope(c.get("db"), {
				apiKeyId: stateData.initiator_key_id,
				organizationId: orgId,
				workspaceId: stateData.workspace_id,
				resourceName: "connected account",
			});
			if (!validation.ok) {
				return c.json(
					{
						error: { code: validation.code, message: validation.message },
					} as never,
					validation.status as never,
				);
			}
			workspaceId = stateData.workspace_id;
			initiatorKeyId = stateData.initiator_key_id;
			authorizedWorkspaceScope = initialWorkspaceScope;
			workspaceWasExplicit =
				stateData.workspace_id_was_explicit ?? stateData.workspace_id !== null;
			if (
				stateData.redirect_url &&
				stateData.redirect_url !== customerRedirectUrl
			) {
				return c.json(
					{
						error: {
							code: "REDIRECT_URL_MISMATCH",
							message:
								"redirect_url does not match the OAuth flow that was started.",
						},
					} as never,
					400 as never,
				);
			}
			codeVerifier = stateData.code_verifier ?? undefined;
			method = stateData.method ?? undefined;
			connectionOperationId = stateData.connection_operation_id;
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

	if (!body.state) {
		const scope = await resolveOperationalCreateScope(
			c,
			body.workspace_id,
			"connected account",
		);
		if (!scope.ok) return scope.response as never;
		workspaceId = scope.workspaceId;
		workspaceWasExplicit = body.workspace_id !== undefined;
		initiatorKeyId = c.get("keyId");
		authorizedWorkspaceScope = c.get("workspaceScope");
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
			initiatorKeyId,
			authorizedWorkspaceScope,
			workspaceId,
			workspaceWasExplicit,
			platform,
			code: body.code,
			redirectUri: oauthRedirectUri,
			codeVerifier,
			method,
			connectionOperationId,
			waitUntil: (p) => c.executionCtx.waitUntil(p),
		});

		if (result.status === "error") {
			const statusCode =
				result.code === "INTERNAL_ERROR"
					? 500
					: result.code === "ACCOUNT_WORKSPACE_CONFLICT"
						? 409
						: result.code === "WORKSPACE_ACCESS_DENIED"
							? 403
							: 400;
			return c.json(
				{ error: { code: result.code, message: result.message } } as never,
				statusCode as never,
			);
		}

		if (result.status === "pending_selection") {
			return c.json(
				{
					status: "pending_selection",
					connect_token: result.connectToken,
					platform,
				} as never,
				200 as never,
			);
		}

		return c.json({ account: result.account } as never, 201 as never);
	} catch (err) {
		// SECURITY: Log full error server-side but return generic message to prevent leaking platform internals
		console.error(
			"[oauth] Token exchange failed:",
			err instanceof Error ? err.message : err,
		);
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
