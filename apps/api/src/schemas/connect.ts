import { z } from "@hono/zod-openapi";
import { buildMailchimpApiUrl, getMailchimpDatacenter } from "../lib/mailchimp";
import { AccountResponse } from "./accounts";
import { PlatformEnum } from "./common";

// ---------------------------------------------------------------------------
// OAuth platforms (platforms that use OAuth flows)
// ---------------------------------------------------------------------------

export const OAUTH_PLATFORMS = [
	"twitter",
	"instagram",
	"facebook",
	"linkedin",
	"tiktok",
	"youtube",
	"pinterest",
	"reddit",
	"threads",
	"snapchat",
	"googlebusiness",
	"mastodon",
] as const;

export const OAuthPlatformEnum = z.enum(OAUTH_PLATFORMS);

const ConnectionWorkspaceId = z
	.string()
	.min(1)
	.optional()
	.describe(
		"Workspace for the connected account. Required only when the organization has Require Workspace ID enabled. In optional mode, omission creates a new organization-scoped identity or preserves an existing identity's current scope on reconnect.",
	);

// ---------------------------------------------------------------------------
// Start OAuth
// ---------------------------------------------------------------------------

export const StartOAuthParams = z.object({
	platform: OAuthPlatformEnum.describe("OAuth platform to connect"),
});

export const StartOAuthQuery = z.object({
	workspace_id: ConnectionWorkspaceId,
	redirect_url: z
		.string()
		.url()
		.optional()
		.describe("URL to redirect after OAuth completes"),
	method: z
		.string()
		.optional()
		.describe(
			'Auth method variant (e.g. "direct" for Instagram Login instead of Facebook Login)',
		),
	headless: z
		.string()
		.optional()
		.describe(
			'Set to "true" for headless mode (returns data instead of redirecting)',
		),
	instance_url: z
		.string()
		.url()
		.optional()
		.describe(
			"Required for Mastodon. Public HTTPS origin of the account's home instance (for example, https://mastodon.social). Paths, credentials, queries, fragments, and private network destinations are rejected.",
		),
});

export const StartOAuthResponse = z.object({
	auth_url: z
		.string()
		.url()
		.describe("URL to redirect the user for OAuth authorization"),
	temp_token: z
		.string()
		.optional()
		.describe(
			"Headless mode only: one-time token to poll GET /connect/pending-data for the OAuth result once the user finishes provider authorization",
		),
});

// ---------------------------------------------------------------------------
// Complete OAuth
// ---------------------------------------------------------------------------

export const CompleteOAuthParams = z.object({
	platform: OAuthPlatformEnum.describe("OAuth platform to complete"),
});

export const CompleteOAuthBody = z.object({
	code: z.string().describe("OAuth authorization code"),
	workspace_id: ConnectionWorkspaceId,
	redirect_url: z
		.string()
		.url()
		.optional()
		.describe("Redirect URL used during the OAuth flow (must match)"),
	state: z
		.string()
		.optional()
		.describe("OAuth state token for direct KV lookup"),
});

export const CompleteOAuthResponse = z.object({
	account: AccountResponse,
});

export const PendingSelectionResponse = z.object({
	status: z.literal("pending_selection"),
	platform: OAuthPlatformEnum,
	connect_token: z
		.string()
		.describe("Operation-scoped token required by the list/select endpoints"),
});

// ---------------------------------------------------------------------------
// Bluesky (credential-based)
// ---------------------------------------------------------------------------

export const ConnectBlueskyBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	handle: z.string().describe("Bluesky handle (e.g. user.bsky.social)"),
	app_password: z.string().describe("Bluesky app password"),
});

// ---------------------------------------------------------------------------
// Discord and SMS (credential-based)
// ---------------------------------------------------------------------------

export const ConnectDiscordBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	webhook_url: z
		.string()
		.url()
		.describe(
			"Discord incoming webhook URL in the exact https://discord.com/api/webhooks/{id}/{token} form",
		),
});

export const ConnectSmsBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	account_sid: z
		.string()
		.regex(/^AC[0-9a-fA-F]{32}$/)
		.describe("Twilio Account SID"),
	auth_token: z.string().min(1).describe("Twilio Auth Token"),
	from_number: z
		.string()
		.regex(/^\+[1-9]\d{6,14}$/)
		.describe("Twilio-owned SMS-capable sender in E.164 format"),
});

export const ConnectSlackBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	webhook_url: z
		.string()
		.url()
		.describe(
			"Slack incoming webhook URL in the exact /services/{team}/{service}/{secret} form",
		),
});

// ---------------------------------------------------------------------------
// Newsletter platforms (API-key-based)
// ---------------------------------------------------------------------------

export const ConnectBeehiivBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	api_key: z.string().describe("Beehiiv API key"),
	publication_id: z.string().describe("Beehiiv publication ID"),
});

export const ConnectConvertKitBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	api_key: z.string().describe("Kit API v4 key"),
});

export const ConnectMailchimpBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	api_key: z
		.string()
		.superRefine((apiKey, ctx) => {
			const datacenter = getMailchimpDatacenter(apiKey);
			if (!datacenter) {
				ctx.addIssue({
					code: "custom",
					message:
						"Mailchimp API key must end with a valid datacenter suffix (for example, -us21)",
				});
				return;
			}

			// Resolve the same API root used by the connector and assert its final
			// hostname before the request handler can receive this API key.
			buildMailchimpApiUrl(datacenter);
		})
		.describe("Mailchimp API key (includes datacenter suffix, e.g. xxx-us21)"),
});

export const ConnectListMonkBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	instance_url: z
		.string()
		.url()
		.describe("ListMonk instance URL (e.g. https://listmonk.example.com)"),
	username: z.string().describe("ListMonk admin username"),
	password: z.string().describe("ListMonk admin password"),
});

// ---------------------------------------------------------------------------
// Telegram — initiate
// ---------------------------------------------------------------------------

export const InitTelegramQuery = z.object({
	workspace_id: ConnectionWorkspaceId,
});

export const InitTelegramResponse = z.object({
	code: z
		.string()
		.describe(
			"Organization-bound challenge code in the form RLAY-XXXXXXXXXXXX (12 uppercase hexadecimal characters)",
		),
	expires_at: z.string().datetime().describe("ISO 8601 expiry timestamp"),
	expires_in: z.number().int().describe("Seconds until code expires"),
	bot_username: z.string().describe("Telegram bot username to message"),
	instructions: z
		.array(z.string())
		.describe("Step-by-step instructions for the user"),
});

// ---------------------------------------------------------------------------
// Telegram — poll status
// ---------------------------------------------------------------------------

export const TelegramStatusQuery = z.object({
	code: z
		.string()
		.describe(
			"Organization-bound challenge code to check (RLAY- followed by 12 uppercase hexadecimal characters)",
		),
});

export const TelegramStatusResponse = z.object({
	status: z
		.enum(["pending", "connected", "expired"])
		.describe("Current connection status"),
	chat_id: z.string().optional().describe("Telegram chat ID once connected"),
	chat_title: z.string().optional().describe("Chat or channel title"),
	chat_type: z
		.string()
		.optional()
		.describe("Chat type (private, group, supergroup, channel)"),
	account: AccountResponse.optional().describe("Connected account details"),
	expires_at: z
		.string()
		.datetime()
		.optional()
		.describe("Code expiry timestamp"),
});

// ---------------------------------------------------------------------------
// Pending data (headless OAuth)
// ---------------------------------------------------------------------------

export const PendingDataQuery = z.object({
	token: z.string().describe("Temporary token from headless OAuth flow"),
});

// Headless OAuth result, polled with the temp_token returned by GET /connect/{platform}?headless=true.
// The server-side callback stores the outcome of the token exchange under this key.
export const PendingDataResponse = z.object({
	platform: PlatformEnum,
	workspace_id: z
		.string()
		.nullable()
		.describe("Authoritative workspace selected when the OAuth flow started"),
	status: z
		.enum(["success", "pending_selection", "error"])
		.describe(
			"Outcome of the headless OAuth exchange. 'pending_selection' means a secondary selection step (e.g. Facebook page) is required.",
		),
	account: AccountResponse.optional().describe(
		"Connected account — present when status is 'success'",
	),
	error: z.string().optional().describe("Provider error code (status 'error')"),
	error_description: z
		.string()
		.nullable()
		.optional()
		.describe("Provider error description (status 'error')"),
	error_code: z
		.string()
		.optional()
		.describe("RelayAPI error code (status 'error')"),
	error_message: z
		.string()
		.optional()
		.describe("RelayAPI error message (status 'error')"),
	connect_token: z
		.string()
		.optional()
		.describe(
			"Operation-scoped token required for a pending secondary account selection",
		),
});

export const SecondarySelectionQuery = z.object({
	connect_token: z
		.string()
		.min(1)
		.describe("Operation-scoped token returned by the OAuth callback"),
});

// ---------------------------------------------------------------------------
// Facebook pages (secondary selection)
// ---------------------------------------------------------------------------

export const FacebookPageItem = z.object({
	id: z.string().describe("Facebook page ID"),
	name: z.string().describe("Page name"),
	picture_url: z
		.string()
		.nullable()
		.optional()
		.describe("Page profile picture URL"),
	category: z.string().nullable().optional().describe("Page category"),
});

export const FacebookPagesResponse = z.object({
	pages: z.array(FacebookPageItem),
});

export const SelectFacebookPageBody = z.object({
	page_id: z.string().describe("Selected Facebook page ID"),
	connect_token: z.string().describe("Token from pending data or OAuth flow"),
});

// ---------------------------------------------------------------------------
// LinkedIn organizations (secondary selection)
// ---------------------------------------------------------------------------

export const LinkedInOrgItem = z.object({
	urn: z.string().describe("LinkedIn organization URN"),
	name: z.string().describe("Organization name"),
	logo_url: z.string().nullable().optional().describe("Organization logo URL"),
	vanity_name: z
		.string()
		.nullable()
		.optional()
		.describe("Organization vanity name"),
});

export const LinkedInOrgsResponse = z.object({
	organizations: z.array(LinkedInOrgItem),
	personal_profile: z
		.object({
			urn: z.string(),
			name: z.string(),
		})
		.optional()
		.describe("User's personal LinkedIn profile"),
});

export const SelectLinkedInOrgBody = z.object({
	organization_urn: z
		.string()
		.optional()
		.describe(
			"LinkedIn organization URN (required if account_type is organization)",
		),
	account_type: z
		.enum(["personal", "organization"])
		.describe("Whether to connect as a personal profile or organization"),
	connect_token: z.string().describe("Token from pending data or OAuth flow"),
});

// ---------------------------------------------------------------------------
// Pinterest boards (secondary selection)
// ---------------------------------------------------------------------------

export const PinterestBoardItem = z.object({
	id: z.string().describe("Pinterest board ID"),
	name: z.string().describe("Board name"),
	description: z.string().nullable().optional().describe("Board description"),
	pin_count: z
		.number()
		.int()
		.optional()
		.describe("Number of pins on the board"),
});

export const PinterestBoardsResponse = z.object({
	boards: z.array(PinterestBoardItem),
});

export const SelectPinterestBoardBody = z.object({
	board_id: z.string().describe("Selected Pinterest board ID"),
	connect_token: z.string().describe("Token from pending data or OAuth flow"),
});

// ---------------------------------------------------------------------------
// Google Business Profile locations (secondary selection)
// ---------------------------------------------------------------------------

export const GBPLocationItem = z.object({
	id: z.string().describe("Google Business location ID"),
	name: z.string().describe("Business name"),
	address: z.string().nullable().optional().describe("Business address"),
	phone: z.string().nullable().optional().describe("Business phone number"),
});

export const GBPLocationsResponse = z.object({
	locations: z.array(GBPLocationItem),
});

export const SelectGBPLocationBody = z.object({
	location_id: z.string().describe("Selected Google Business location ID"),
	connect_token: z.string().describe("Token from pending data or OAuth flow"),
});

// ---------------------------------------------------------------------------
// Snapchat profiles (secondary selection)
// ---------------------------------------------------------------------------

export const SnapchatProfileItem = z.object({
	id: z.string().describe("Snapchat profile ID"),
	display_name: z.string().describe("Display name"),
	username: z.string().describe("Snapchat username"),
	profile_image_url: z
		.string()
		.nullable()
		.optional()
		.describe("Profile image URL"),
	subscriber_count: z
		.number()
		.int()
		.optional()
		.describe("Number of subscribers"),
});

export const SnapchatProfilesResponse = z.object({
	profiles: z.array(SnapchatProfileItem),
});

export const SelectSnapchatProfileBody = z.object({
	profile_id: z.string().describe("Selected Snapchat profile ID"),
	connect_token: z.string().describe("Token from pending data or OAuth flow"),
});

// ---------------------------------------------------------------------------
// WhatsApp — SDK config
// ---------------------------------------------------------------------------

export const WhatsAppSDKConfigResponse = z.object({
	app_id: z.string().describe("Facebook App ID for WhatsApp embedded signup"),
	config_id: z.string().describe("WhatsApp configuration ID"),
});

// ---------------------------------------------------------------------------
// WhatsApp — embedded signup
// ---------------------------------------------------------------------------

export const WhatsAppEmbeddedSignupBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	code: z.string().describe("Code from WhatsApp embedded signup flow"),
	waba_id: z
		.string()
		.optional()
		.describe(
			"WABA selected by the Embedded Signup completion event. Required to disambiguate when the token grants multiple WABAs.",
		),
	phone_number_id: z
		.string()
		.optional()
		.describe(
			"Phone number selected by the Embedded Signup completion event. Required to disambiguate a WABA with multiple numbers.",
		),
});

// ---------------------------------------------------------------------------
// WhatsApp — credentials (direct)
// ---------------------------------------------------------------------------

export const WhatsAppCredentialsBody = z.object({
	workspace_id: ConnectionWorkspaceId,
	access_token: z.string().describe("WhatsApp Business API access token"),
	waba_id: z.string().describe("WhatsApp Business Account ID"),
	phone_number_id: z.string().describe("WhatsApp phone number ID"),
});
