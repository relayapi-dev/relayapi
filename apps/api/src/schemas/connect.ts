import { z } from "@hono/zod-openapi";
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

// ---------------------------------------------------------------------------
// Start OAuth
// ---------------------------------------------------------------------------

export const StartOAuthParams = z.object({
	platform: OAuthPlatformEnum.describe("OAuth platform to connect"),
});

export const StartOAuthQuery = z.object({
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
});

export const StartOAuthResponse = z.object({
	auth_url: z
		.string()
		.url()
		.describe("URL to redirect the user for OAuth authorization"),
});

// ---------------------------------------------------------------------------
// Complete OAuth
// ---------------------------------------------------------------------------

export const CompleteOAuthParams = z.object({
	platform: OAuthPlatformEnum.describe("OAuth platform to complete"),
});

export const CompleteOAuthBody = z.object({
	code: z.string().describe("OAuth authorization code"),
	redirect_url: z
		.string()
		.url()
		.optional()
		.describe("Redirect URL used during the OAuth flow (must match)"),
	state: z.string().optional().describe("OAuth state token for direct KV lookup"),
});

export const CompleteOAuthResponse = z.object({
	account: AccountResponse,
});

// ---------------------------------------------------------------------------
// Bluesky (credential-based)
// ---------------------------------------------------------------------------

export const ConnectBlueskyBody = z.object({
	handle: z.string().describe("Bluesky handle (e.g. user.bsky.social)"),
	app_password: z.string().describe("Bluesky app password"),
});

// ---------------------------------------------------------------------------
// Newsletter platforms (API-key-based)
// ---------------------------------------------------------------------------

export const ConnectBeehiivBody = z.object({
	api_key: z.string().describe("Beehiiv API key"),
	publication_id: z.string().describe("Beehiiv publication ID"),
});

export const ConnectConvertKitBody = z.object({
	api_key: z.string().describe("ConvertKit API key"),
	api_secret: z.string().describe("ConvertKit API secret"),
});

export const ConnectMailchimpBody = z.object({
	api_key: z.string().describe("Mailchimp API key (includes datacenter suffix, e.g. xxx-us21)"),
});

export const ConnectListMonkBody = z.object({
	instance_url: z.string().url().describe("ListMonk instance URL (e.g. https://listmonk.example.com)"),
	username: z.string().describe("ListMonk admin username"),
	password: z.string().describe("ListMonk admin password"),
});

// ---------------------------------------------------------------------------
// Telegram — initiate
// ---------------------------------------------------------------------------

export const InitTelegramResponse = z.object({
	code: z.string().describe("6-character access code"),
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
	code: z.string().describe("The 6-character access code to check"),
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
// Telegram — direct connect
// ---------------------------------------------------------------------------

export const ConnectTelegramDirectBody = z.object({
	chat_id: z.string().describe("Telegram chat or channel ID"),
});

// ---------------------------------------------------------------------------
// Pending data (headless OAuth)
// ---------------------------------------------------------------------------

export const PendingDataQuery = z.object({
	token: z.string().describe("Temporary token from headless OAuth flow"),
});

export const PendingDataResponse = z.object({
	platform: PlatformEnum,
	temp_token: z.string().describe("Token to use for secondary selection"),
	user_profile: z
		.object({
			id: z.string(),
			name: z.string().nullable(),
			username: z.string().nullable(),
			avatar_url: z.string().nullable(),
		})
		.describe("Basic user profile from the platform"),
	pages: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Facebook pages available"),
	profiles: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Snapchat profiles available"),
	boards: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Pinterest boards available"),
	locations: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("Google Business locations available"),
	organizations: z
		.array(z.record(z.string(), z.any()))
		.optional()
		.describe("LinkedIn organizations available"),
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
	code: z.string().describe("Code from WhatsApp embedded signup flow"),
});

// ---------------------------------------------------------------------------
// WhatsApp — credentials (direct)
// ---------------------------------------------------------------------------

export const WhatsAppCredentialsBody = z.object({
	access_token: z.string().describe("WhatsApp Business API access token"),
	waba_id: z.string().describe("WhatsApp Business Account ID"),
	phone_number_id: z.string().describe("WhatsApp phone number ID"),
});
