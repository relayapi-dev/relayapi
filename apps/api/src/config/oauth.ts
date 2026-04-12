// =============================================================================
// IMPORTANT: Before modifying ANY config in this file, you MUST:
//
// 1. Fetch and read the official docs for the platform (only official docs allowed).
// 2. Find the exact section covering the endpoint/parameter being changed.
// 3. Update the comment block above the platform config with:
//    - The doc page URL
//    - The section/heading name
//    - The exact endpoint URL, HTTP method, and field names as shown in docs
// 4. For Facebook/Instagram/Threads: check the current Graph API version at
//    https://developers.facebook.com/docs/graph-api/changelog/versions/
//    All graph.facebook.com and graph.instagram.com URLs must use a supported version.
// 5. Verify every platform config, not just the one being changed.
//
// See CLAUDE.md "OAuth System Rules" for full details.
// =============================================================================

import type { Platform } from "../schemas/common";
import type { Env } from "../types";

export interface OAuthConfig {
	authUrl: string;
	tokenUrl: string;
	profileUrl: string;
	scopes: string[];
	getClientId: (env: Env) => string | undefined;
	getClientSecret: (env: Env) => string | undefined;
	/** If true, use PKCE (code_challenge/code_verifier) — required by Twitter */
	requiresPkce?: boolean;
	/** If true, use HTTP Basic Auth for token exchange — required by Twitter, Reddit */
	tokenExchangeUsesBasicAuth?: boolean;
	/** Extra query parameters to include in the authorization URL */
	extraAuthParams?: Record<string, string>;
}

export const OAUTH_CONFIGS: Partial<Record<Platform, OAuthConfig>> = {
	// X / Twitter — OAuth 2.0 Authorization Code Flow with PKCE
	// https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code
	// Section: "How to connect to endpoints using OAuth 2.0 Authorization Code Flow with PKCE"
	// Auth: https://x.com/i/oauth2/authorize — Token: https://api.x.com/2/oauth2/token
	// Requires PKCE (code_challenge S256) and HTTP Basic Auth for token exchange.
	// offline.access scope required for refresh tokens (access tokens expire in 2h without it).
	twitter: {
		authUrl: "https://x.com/i/oauth2/authorize",
		tokenUrl: "https://api.x.com/2/oauth2/token",
		profileUrl: "https://api.x.com/2/users/me?user.fields=profile_image_url",
		scopes: [
			"tweet.read",
			"tweet.write",
			"users.read",
			"offline.access",
			"bookmark.write",
			"follows.write",
			"media.write",
			"dm.read",
			"dm.write",
		],
		getClientId: (env) => env.TWITTER_CLIENT_ID,
		getClientSecret: (env) => env.TWITTER_CLIENT_SECRET,
		requiresPkce: true,
		tokenExchangeUsesBasicAuth: true,
	},
	// Facebook — Manual Login Flow (OAuth 2.0)
	// https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
	// Section: "Manually Build a Login Flow"
	// Auth: https://www.facebook.com/v{version}/dialog/oauth — Token: https://graph.facebook.com/v{version}/oauth/access_token
	// Permissions reference: https://developers.facebook.com/docs/permissions
	// Graph API versions: https://developers.facebook.com/docs/graph-api/changelog/versions/ (latest: v25.0, Feb 2026)
	// Long-lived token exchange: https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
	// Uses fb_exchange_token grant type. Tokens last 60 days.
	// Note: read_insights requires App Review approval.
	// https://developers.facebook.com/docs/permissions/reference/read_insights
	// Ads permissions (Marketing API): https://developers.facebook.com/docs/marketing-api/get-started/authorization/
	// ads_management: create/manage campaigns, ad sets, ads, custom audiences, targeting
	// ads_read: read ad insights/metrics, Conversions API access
	// pages_manage_ads: page-level ad management, boosting posts as ads (requires App Review)
	// pages_messaging: page conversations in Messenger (requires App Review)
	// All three require App Review + Advanced Access for production use.
	facebook: {
		authUrl: "https://www.facebook.com/v25.0/dialog/oauth",
		tokenUrl: "https://graph.facebook.com/v25.0/oauth/access_token",
		profileUrl: "https://graph.facebook.com/v25.0/me?fields=id,name,picture",
		scopes: [
			"pages_manage_posts",
			"pages_read_engagement",
			"pages_show_list",
			"pages_read_user_content",
			"read_insights",
			"pages_messaging",
			"pages_manage_metadata",
			"ads_management",
			"ads_read",
			"pages_manage_ads",
		],
		getClientId: (env) => env.FACEBOOK_APP_ID,
		getClientSecret: (env) => env.FACEBOOK_APP_SECRET,
	},
	// Instagram (via Facebook Login) — Uses Facebook OAuth endpoints with Instagram permissions
	// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
	// Section: "Instagram API with Facebook Login"
	// Same auth/token endpoints as Facebook. Scopes are Instagram-specific but requested via Facebook dialog.
	// Permissions reference: https://developers.facebook.com/docs/permissions
	// Long-lived token exchange uses fb_exchange_token grant type (same as Facebook). Tokens last 60 days.
	// Ads: Instagram ads are managed via the same Marketing API as Facebook.
	// ads_management + ads_read cover Instagram ad operations when the IG account is linked in Business Manager.
	instagram: {
		authUrl: "https://www.facebook.com/v25.0/dialog/oauth",
		tokenUrl: "https://graph.facebook.com/v25.0/oauth/access_token",
		profileUrl: "https://graph.facebook.com/v25.0/me?fields=id,name",
		scopes: [
			"instagram_basic",
			"instagram_content_publish",
			"pages_show_list",
			"instagram_manage_comments",
			"instagram_manage_insights",
			"pages_manage_posts",
			"instagram_manage_messages",
			"ads_management",
			"ads_read",
		],
		getClientId: (env) => env.INSTAGRAM_APP_ID,
		getClientSecret: (env) => env.INSTAGRAM_APP_SECRET,
	},
	// LinkedIn — 3-Legged OAuth Authorization Code Flow
	// https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
	// Section: "Step 2: Request an Authorization Code" and "Step 3: Exchange Authorization Code for an Access Token"
	// Auth: GET https://www.linkedin.com/oauth/v2/authorization — Token: POST https://www.linkedin.com/oauth/v2/accessToken
	// Profile: GET https://api.linkedin.com/v2/userinfo (OpenID Connect) or GET https://api.linkedin.com/v2/me
	// Access tokens expire in 60 days. client_id/client_secret in POST body (not Basic Auth).
	linkedin: {
		authUrl: "https://www.linkedin.com/oauth/v2/authorization",
		tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
		profileUrl: "https://api.linkedin.com/v2/userinfo",
		scopes: [
			"openid",
			"profile",
			"w_member_social",
			"w_organization_social",
			"r_organization_admin",
		],
		getClientId: (env) => env.LINKEDIN_CLIENT_ID,
		getClientSecret: (env) => env.LINKEDIN_CLIENT_SECRET,
	},
	// TikTok — Login Kit OAuth v2
	// https://developers.tiktok.com/doc/oauth-user-access-token-management
	// Section: "Manage User Access Tokens"
	// Auth: https://www.tiktok.com/v2/auth/authorize/ — Token: POST https://open.tiktokapis.com/v2/oauth/token/
	// Uses client_key (not client_id) as the parameter name.
	// Scopes: https://developers.tiktok.com/doc/tiktok-api-scopes
	// video.publish = direct post; video.upload = draft upload. Access tokens expire in 24h, refresh in 365 days.
	tiktok: {
		authUrl: "https://www.tiktok.com/v2/auth/authorize",
		tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
		profileUrl: "https://open.tiktokapis.com/v2/user/info/",
		scopes: [
			"user.info.basic",
			"video.publish",
			"video.list",
			"user.info.stats",
		],
		getClientId: (env) => env.TIKTOK_CLIENT_KEY,
		getClientSecret: (env) => env.TIKTOK_CLIENT_SECRET,
	},
	// YouTube — Google OAuth 2.0 for Server-side Web Apps
	// https://developers.google.com/identity/protocols/oauth2/web-server
	// Section: "Step 1: Set authorization parameters" and "Step 5: Exchange authorization code for refresh and access tokens"
	// Auth: https://accounts.google.com/o/oauth2/v2/auth — Token: POST https://oauth2.googleapis.com/token
	// access_type=offline required for refresh tokens. prompt=consent forces consent screen.
	// YouTube scopes: https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps
	youtube: {
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		profileUrl:
			"https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
		scopes: [
			"https://www.googleapis.com/auth/youtube.upload",
			"https://www.googleapis.com/auth/youtube.readonly",
			"https://www.googleapis.com/auth/youtube.force-ssl",
			"https://www.googleapis.com/auth/yt-analytics.readonly",
		],
		getClientId: (env) => env.YOUTUBE_CLIENT_ID,
		getClientSecret: (env) => env.YOUTUBE_CLIENT_SECRET,
		extraAuthParams: { access_type: "offline", prompt: "consent" },
	},
	// Pinterest — OAuth 2.0 (API v5)
	// https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/
	// Section: "Set up authentication and authorization"
	// Auth: https://www.pinterest.com/oauth/ — Token: POST https://api.pinterest.com/v5/oauth/token
	// Token exchange requires HTTP Basic Auth: base64(client_id:client_secret) in Authorization header.
	// Scopes: https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/#pinterest-scopes
	// Available scopes: boards:read, boards:write, pins:read, pins:write, user_accounts:read, ads:read/write, etc.
	pinterest: {
		authUrl: "https://www.pinterest.com/oauth/",
		tokenUrl: "https://api.pinterest.com/v5/oauth/token",
		profileUrl: "https://api.pinterest.com/v5/user_account",
		scopes: ["boards:read", "pins:read", "pins:write", "user_accounts:read"],
		getClientId: (env) => env.PINTEREST_APP_ID,
		getClientSecret: (env) => env.PINTEREST_APP_SECRET,
		tokenExchangeUsesBasicAuth: true,
	},
	// Reddit — OAuth2 Authorization Code Flow
	// https://github.com/reddit-archive/reddit/wiki/OAuth2
	// Section: "Authorization" and "Retrieving the access token"
	// Auth: GET https://www.reddit.com/api/v1/authorize — Token: POST https://www.reddit.com/api/v1/access_token
	// Token exchange requires HTTP Basic Auth (username=client_id, password=client_secret).
	// duration=permanent for refresh tokens. Scopes: https://www.reddit.com/api/v1/scopes
	reddit: {
		authUrl: "https://www.reddit.com/api/v1/authorize",
		tokenUrl: "https://www.reddit.com/api/v1/access_token",
		profileUrl: "https://oauth.reddit.com/api/v1/me",
		scopes: ["identity", "submit", "read", "mysubreddits", "flair"],
		getClientId: (env) => env.REDDIT_CLIENT_ID,
		getClientSecret: (env) => env.REDDIT_CLIENT_SECRET,
		tokenExchangeUsesBasicAuth: true,
		extraAuthParams: { duration: "permanent" },
	},
	// Threads — Threads API OAuth
	// https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions
	// Section: "Get Access Tokens and Permissions" → "Authorization Window" and "Short-Lived Token Exchange"
	// Auth: https://threads.net/oauth/authorize — Token: POST https://graph.threads.net/oauth/access_token
	// Long-lived token exchange: https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
	// Uses th_exchange_token grant type at https://graph.threads.net/access_token. Tokens last 60 days.
	// Scopes: threads_basic (required), threads_content_publish, threads_read_replies, threads_manage_replies, threads_manage_insights
	threads: {
		authUrl: "https://threads.net/oauth/authorize",
		tokenUrl: "https://graph.threads.net/oauth/access_token",
		profileUrl:
			"https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url",
		scopes: [
			"threads_basic",
			"threads_content_publish",
			"threads_manage_insights",
		],
		getClientId: (env) => env.THREADS_APP_ID,
		getClientSecret: (env) => env.THREADS_APP_SECRET,
	},
	// Snapchat — Marketing API OAuth 2.0
	// https://developers.snap.com/api/marketing-api/Ads-API/authentication
	// Section: "Authentication"
	// Auth: GET https://accounts.snapchat.com/login/oauth2/authorize — Token: POST https://accounts.snapchat.com/login/oauth2/access_token
	// Access tokens expire in 3600s (60 min). Refresh tokens available.
	// Scopes: snapchat-marketing-api, snapchat-offline-conversions-api, snapchat-profile-api
	snapchat: {
		authUrl: "https://accounts.snapchat.com/login/oauth2/authorize",
		tokenUrl: "https://accounts.snapchat.com/login/oauth2/access_token",
		profileUrl: "https://adsapi.snapchat.com/v1/me",
		scopes: ["snapchat-marketing-api"],
		getClientId: (env) => env.SNAPCHAT_CLIENT_ID,
		getClientSecret: (env) => env.SNAPCHAT_CLIENT_SECRET,
	},
	// Google Business Profile — Google OAuth 2.0
	// https://developers.google.com/identity/protocols/oauth2/web-server
	// Section: "Step 1: Set authorization parameters" (same Google OAuth flow as YouTube)
	// Auth: https://accounts.google.com/o/oauth2/v2/auth — Token: POST https://oauth2.googleapis.com/token
	// Profile: https://developers.google.com/my-business/reference/accountmanagement/rest
	// Base URL: https://mybusinessaccountmanagement.googleapis.com
	googlebusiness: {
		authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		tokenUrl: "https://oauth2.googleapis.com/token",
		profileUrl:
			"https://mybusinessaccountmanagement.googleapis.com/v1/accounts",
		scopes: ["https://www.googleapis.com/auth/business.manage"],
		getClientId: (env) => env.GOOGLE_CLIENT_ID,
		getClientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
		extraAuthParams: { access_type: "offline", prompt: "consent" },
	},
	// Mastodon — Standard OAuth 2.0 (instance-specific endpoints)
	// https://docs.joinmastodon.org/client/authorized/
	// Section: "Logging in with an account" → "Authorize the user" and "Obtain the token"
	// Auth: GET {instance}/oauth/authorize — Token: POST {instance}/oauth/token
	// The URLs below use mastodon.social as the default; the connect flow
	// should replace the base URL with the user's chosen instance.
	// Scopes: https://docs.joinmastodon.org/api/oauth-scopes/
	// Granular scopes recommended: read:accounts, write:statuses, write:media, etc.
	mastodon: {
		authUrl: "https://mastodon.social/oauth/authorize",
		tokenUrl: "https://mastodon.social/oauth/token",
		profileUrl: "https://mastodon.social/api/v1/accounts/verify_credentials",
		scopes: ["read:accounts", "write:statuses", "write:media"],
		getClientId: (env) => env.MASTODON_CLIENT_ID,
		getClientSecret: (env) => env.MASTODON_CLIENT_SECRET,
	},
	// Discord: No OAuth needed — uses webhook URLs for posting.
	// Connection is done by the user providing their webhook URL directly.
};

// Instagram API with Instagram Login — Direct Instagram OAuth (no Facebook required)
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
// Section: "Instagram API with Instagram Login" → Overview
// Auth: https://developers.facebook.com/docs/instagram-platform/reference/oauth-authorize
//   GET https://www.instagram.com/oauth/authorize
// Token: POST https://api.instagram.com/oauth/access_token
//   Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
//   Returns: { access_token, user_id, permissions }
// Long-lived token exchange: GET https://graph.instagram.com/access_token
//   Docs: https://developers.facebook.com/docs/instagram-platform/reference/access_token
//   Uses ig_exchange_token grant type. Tokens last 60 days.
// Profile: GET https://graph.instagram.com/{api-version}/me?fields=user_id,username,...
//   Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
//   IMPORTANT: graph.instagram.com endpoints require a version prefix (e.g. /v25.0/).
//   Unversioned endpoints return: {"error":{"message":"Unsupported request - method type: get"}}.
//   Available fields: user_id, username, name, profile_picture_url, account_type, followers_count, etc.
//   Note: "user_id" is the IG professional account ID; "id" is the app-scoped user ID.
// Scopes: instagram_business_basic, instagram_business_content_publish,
//   instagram_business_manage_comments, instagram_business_manage_messages
export const INSTAGRAM_DIRECT_CONFIG: OAuthConfig = {
	authUrl: "https://www.instagram.com/oauth/authorize",
	tokenUrl: "https://api.instagram.com/oauth/access_token",
	// Version prefix required — see comment block above.
	// id (app-scoped IGUID) is needed for webhook entry.id matching
	profileUrl:
		"https://graph.instagram.com/v25.0/me?fields=id,user_id,username,name,profile_picture_url",
	scopes: [
		"instagram_business_basic",
		"instagram_business_content_publish",
		"instagram_business_manage_comments",
		"instagram_business_manage_insights",
		"instagram_business_manage_messages",
	],
	// Instagram Login uses its own app credentials (different from the Facebook Login app ID).
	// See "API setup with Instagram login" in the Meta App Dashboard for the Instagram app ID/secret.
	getClientId: (env) => env.INSTAGRAM_LOGIN_APP_ID,
	getClientSecret: (env) => env.INSTAGRAM_LOGIN_APP_SECRET,
};

/**
 * Generate a cryptographic state token for OAuth CSRF protection.
 */
export function generateStateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Generate PKCE code verifier and challenge (for Twitter OAuth 2.0).
 */
export async function generatePkce(): Promise<{
	codeVerifier: string;
	codeChallenge: string;
}> {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const codeVerifier = base64UrlEncode(bytes);

	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(codeVerifier),
	);
	const codeChallenge = base64UrlEncode(new Uint8Array(digest));

	return { codeVerifier, codeChallenge };
}

function base64UrlEncode(buffer: Uint8Array): string {
	const str = btoa(String.fromCharCode(...buffer));
	return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the full OAuth authorization URL for a platform.
 */
export function buildAuthUrl(
	config: OAuthConfig,
	clientId: string,
	redirectUrl: string,
	state: string,
	codeChallenge?: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUrl,
		response_type: "code",
		scope: config.scopes.join(" "),
		state,
	});

	// PKCE support (required by Twitter)
	if (config.requiresPkce && codeChallenge) {
		params.set("code_challenge", codeChallenge);
		params.set("code_challenge_method", "S256");
	}

	if (config.extraAuthParams) {
		for (const [key, value] of Object.entries(config.extraAuthParams)) {
			params.set(key, value);
		}
	}

	return `${config.authUrl}?${params.toString()}`;
}

/**
 * Exchange an OAuth authorization code for tokens.
 * Handles platform-specific auth methods (Basic Auth for Twitter/Reddit).
 */
export async function exchangeCode(
	config: OAuthConfig,
	clientId: string,
	clientSecret: string,
	code: string,
	redirectUrl: string,
	codeVerifier?: string,
): Promise<{
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	user_id?: string | number;
	[key: string]: unknown;
}> {
	const bodyParams: Record<string, string> = {
		code,
		redirect_uri: redirectUrl,
		grant_type: "authorization_code",
	};

	// PKCE: include code_verifier
	if (config.requiresPkce && codeVerifier) {
		bodyParams.code_verifier = codeVerifier;
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
	};

	if (config.tokenExchangeUsesBasicAuth) {
		// Twitter and Reddit require HTTP Basic Auth for token exchange
		const credentials = btoa(`${clientId}:${clientSecret}`);
		headers.Authorization = `Basic ${credentials}`;
	} else {
		// Most platforms accept client_id/client_secret in the body
		bodyParams.client_id = clientId;
		bodyParams.client_secret = clientSecret;
	}

	const body = new URLSearchParams(bodyParams);

	// OAuth 2.0 Token Exchange: Exchange authorization code for access/refresh tokens
	// Each platform's token endpoint is defined in OAUTH_CONFIGS above
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers,
		body: body.toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
	}

	return response.json() as Promise<{
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
		user_id?: string | number;
		[key: string]: unknown;
	}>;
}
