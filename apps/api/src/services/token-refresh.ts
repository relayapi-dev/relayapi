import { createDb, socialAccounts, member } from "@relayapi/db";
import { eq, and, isNotNull, lt, notInArray, gt, sql } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import { OAUTH_CONFIGS } from "../config/oauth";
import { decryptAccountTokens, maybeDecrypt, maybeEncrypt } from "../lib/crypto";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Platform } from "../schemas/common";
import { sendNotification } from "./notification-manager";
import { logConnectionEvent } from "../routes/connections";
import type { Env } from "../types";

// Platforms whose tokens never expire — skip these in the refresh cron
const NO_EXPIRY_PLATFORMS: Platform[] = [
	"facebook",
	"mastodon",
	"bluesky",
	"discord",
	"telegram",
	"whatsapp",
	"sms",
];

/**
 * Cron handler: find all accounts with tokens expiring within 7 days
 * and enqueue them to the REFRESH_QUEUE for processing.
 */
export async function enqueueExpiringTokenRefresh(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

	let cursor: string | null = null;
	let totalEnqueued = 0;
	const BATCH_SIZE = 1000;
	const QUEUE_BATCH = 100; // CF queue sendBatch limit

	while (true) {
		const conditions = [
			isNotNull(socialAccounts.tokenExpiresAt),
			lt(socialAccounts.tokenExpiresAt, sevenDaysFromNow),
			notInArray(socialAccounts.platform, NO_EXPIRY_PLATFORMS),
		];
		if (cursor) {
			conditions.push(gt(socialAccounts.id, cursor));
		}

		const accounts = await db
			.select({ id: socialAccounts.id })
			.from(socialAccounts)
			.where(and(...conditions))
			.orderBy(socialAccounts.id)
			.limit(BATCH_SIZE);

		if (accounts.length === 0) break;

		// Enqueue in batches of 100 (CF queue limit)
		for (let i = 0; i < accounts.length; i += QUEUE_BATCH) {
			const batch = accounts.slice(i, i + QUEUE_BATCH);
			await env.REFRESH_QUEUE.sendBatch(
				batch.map((acc) => ({
					body: { type: "refresh_token", account_id: acc.id },
				})),
			);
		}

		totalEnqueued += accounts.length;
		cursor = accounts[accounts.length - 1]!.id;

		if (accounts.length < BATCH_SIZE) break;
	}

	if (totalEnqueued > 0) {
		console.log(`[Token Refresh] Enqueued ${totalEnqueued} accounts for refresh`);
	}
}

/**
 * Queue consumer: refresh a single account's token by ID.
 */
export async function refreshAccountToken(env: Env, accountId: string): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(eq(socialAccounts.id, accountId))
		.limit(1);

	if (!account) {
		console.warn(`[Token Refresh] Account ${accountId} not found, skipping`);
		return;
	}

	if (!account.tokenExpiresAt) return;

	// Decrypt tokens before passing to refresh logic
	const decrypted = await decryptAccountTokens(account, env.ENCRYPTION_KEY);

	// Call the existing refresh logic (bypasses the 5-minute check by calling refreshToken directly)
	const result = await refreshTokenDirect(env, account.platform as Platform, {
		accessToken: decrypted.accessToken,
		refreshToken: decrypted.refreshToken,
	});

	if (!result) {
		console.warn(`[Token Refresh] No refresh available for ${account.platform} account ${accountId}`);

		await logConnectionEvent(env, account.organizationId, {
			account_id: account.id,
			platform: account.platform,
			event: "error",
			message: `Token refresh failed for ${account.displayName || account.username || account.platform} — reconnection needed`,
		});

		// Notify org members that an account token could not be refreshed
		const orgMembers = await db
			.select({ userId: member.userId })
			.from(member)
			.where(eq(member.organizationId, account.organizationId));

		for (const m of orgMembers) {
			sendNotification(env, {
				type: "account_disconnected",
				userId: m.userId,
				orgId: account.organizationId,
				title: "Account token expired",
				body: `Your ${account.platform} account ${account.username || account.platformAccountId} needs to be reconnected`,
				data: {
					platform: account.platform,
					accountId: account.id,
					accountName: account.username || account.displayName || "",
				},
			}).catch((err) =>
				console.error("[Notification] Failed to send disconnect notification:", err),
			);
		}
		return;
	}

	const updateData: Record<string, unknown> = {
		accessToken: await maybeEncrypt(result.access_token, env.ENCRYPTION_KEY),
		updatedAt: new Date(),
	};
	if (result.refresh_token) {
		updateData.refreshToken = await maybeEncrypt(result.refresh_token, env.ENCRYPTION_KEY);
	}
	if (result.expires_in) {
		updateData.tokenExpiresAt = new Date(Date.now() + result.expires_in * 1000);
	}

	// Re-fetch avatar URL with the fresh token (CDN URLs expire over time)
	const newAvatarUrl = await fetchAvatarUrl(
		account.platform as Platform,
		result.access_token,
		account.platformAccountId,
	);
	if (newAvatarUrl) {
		updateData.avatarUrl = newAvatarUrl;
	}

	await db
		.update(socialAccounts)
		.set(updateData)
		.where(eq(socialAccounts.id, accountId));

	console.log(`[Token Refresh] Refreshed ${account.platform} account ${accountId}`);

	await logConnectionEvent(env, account.organizationId, {
		account_id: account.id,
		platform: account.platform,
		event: "token_refreshed",
		message: `Token refreshed for ${account.displayName || account.username || account.platform} account`,
	});
}

interface TokenResult {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

/**
 * Attempt to refresh an expired or near-expiry token for a social account.
 * Returns the new access token, or the existing one if refresh is not needed/possible.
 *
 * Tokens are refreshed when they expire within the next 5 minutes.
 */
export async function refreshTokenIfNeeded(
	env: Env,
	account: {
		id: string;
		platform: Platform;
		accessToken: string | null;
		refreshToken: string | null;
		tokenExpiresAt: Date | null;
	},
): Promise<string> {
	// Decrypt tokens (handles both encrypted and legacy plaintext)
	const decrypted = await decryptAccountTokens(account, env.ENCRYPTION_KEY);
	const token = decrypted.accessToken ?? "";

	// No expiry tracked — assume valid (Mastodon, Discord, Bluesky use non-expiring tokens)
	if (!account.tokenExpiresAt) return token;

	// Token still valid for > 5 minutes — no refresh needed
	const fiveMinutes = 5 * 60 * 1000;
	if (account.tokenExpiresAt.getTime() > Date.now() + fiveMinutes) return token;

	// Distributed lock: prevent thundering herd when multiple concurrent requests
	// try to refresh the same account's token simultaneously
	const lockKey = `token-refresh-lock:${account.id}`;
	const existingLock = await env.KV.get(lockKey);
	if (existingLock) {
		// Another request is already refreshing — wait briefly, then read the fresh token from DB
		await new Promise((r) => setTimeout(r, 2000));
		const db = createDb(env.HYPERDRIVE.connectionString);
		const [fresh] = await db
			.select({ accessToken: socialAccounts.accessToken })
			.from(socialAccounts)
			.where(eq(socialAccounts.id, account.id))
			.limit(1);
		if (fresh?.accessToken) {
			return (await maybeDecrypt(fresh.accessToken, env.ENCRYPTION_KEY)) ?? token;
		}
		return token;
	}

	// Acquire lock (30s TTL — auto-releases if worker crashes)
	await env.KV.put(lockKey, "1", { expirationTtl: 30 });

	try {
		// Platform-specific refresh logic
		const refreshed = await refreshToken(env, account.platform, decrypted);
		if (!refreshed) return token;

		// Persist new tokens to DB (encrypted)
		const db = createDb(env.HYPERDRIVE.connectionString);
		const updateData: Record<string, unknown> = {
			accessToken: await maybeEncrypt(refreshed.access_token, env.ENCRYPTION_KEY),
			updatedAt: new Date(),
		};
		if (refreshed.refresh_token) {
			updateData.refreshToken = await maybeEncrypt(refreshed.refresh_token, env.ENCRYPTION_KEY);
		}
		if (refreshed.expires_in) {
			updateData.tokenExpiresAt = new Date(
				Date.now() + refreshed.expires_in * 1000,
			);
		}

		await db
			.update(socialAccounts)
			.set(updateData)
			.where(eq(socialAccounts.id, account.id));

		return refreshed.access_token;
	} finally {
		await env.KV.delete(lockKey).catch(() => {});
	}
}

/** Exposed for the queue consumer to call directly (bypasses the 5-min check) */
export const refreshTokenDirect = refreshToken;

async function refreshToken(
	env: Env,
	platform: Platform,
	account: {
		accessToken: string | null;
		refreshToken: string | null;
	},
): Promise<TokenResult | null> {
	switch (platform) {
		case "twitter":
			// X OAuth 2.0 — Refresh an access token using Basic Auth
			// https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
			return refreshStandard({
				tokenUrl: "https://api.x.com/2/oauth2/token",
				clientId: env.TWITTER_CLIENT_ID,
				clientSecret: env.TWITTER_CLIENT_SECRET,
				refreshToken: account.refreshToken,
				useBasicAuth: true,
			});

		case "facebook":
			// Facebook long-lived tokens can't be refreshed with a refresh_token.
			// Page tokens obtained from a long-lived user token are permanent.
			// Exchange requires user interaction — return null to use existing token.
			return null;

		case "instagram":
			// Instagram Platform API — refresh a long-lived token directly
			// https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
			if (!account.accessToken) return null;
			return refreshInstagram(account.accessToken);

		case "linkedin":
			// LinkedIn OAuth 2.0 — Refresh an access token
			// https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
			return refreshStandard({
				tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
				clientId: env.LINKEDIN_CLIENT_ID,
				clientSecret: env.LINKEDIN_CLIENT_SECRET,
				refreshToken: account.refreshToken,
				useBody: true,
			});

		case "tiktok":
			return refreshTikTok(env, account.refreshToken);

		case "youtube":
		case "googlebusiness":
			// Google OAuth 2.0 — Refresh an access token
			// https://developers.google.com/identity/protocols/oauth2/web-server#httprest_7
			return refreshStandard({
				tokenUrl: "https://oauth2.googleapis.com/token",
				clientId:
					platform === "youtube"
						? env.YOUTUBE_CLIENT_ID
						: env.GOOGLE_CLIENT_ID,
				clientSecret:
					platform === "youtube"
						? env.YOUTUBE_CLIENT_SECRET
						: env.GOOGLE_CLIENT_SECRET,
				refreshToken: account.refreshToken,
				useBody: true,
			});

		case "pinterest":
			// Pinterest OAuth — Refresh an access token
			// https://developers.pinterest.com/docs/api/v5/oauth-token/
			return refreshStandard({
				tokenUrl: "https://api.pinterest.com/v5/oauth/token",
				clientId: env.PINTEREST_APP_ID,
				clientSecret: env.PINTEREST_APP_SECRET,
				refreshToken: account.refreshToken,
				useBasicAuth: true,
			});

		case "threads":
			// Threads uses direct token refresh like Instagram
			// https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
			if (!account.accessToken) return null;
			return refreshThreads(account.accessToken);

		case "snapchat":
			// Snapchat Marketing API token endpoint (not Login Kit)
			// https://developers.snap.com/api/marketing-api/Ads-API/authentication
			return refreshStandard({
				tokenUrl: "https://accounts.snapchat.com/login/oauth2/access_token",
				clientId: env.SNAPCHAT_CLIENT_ID,
				clientSecret: env.SNAPCHAT_CLIENT_SECRET,
				refreshToken: account.refreshToken,
				useBody: true,
			});

		case "reddit":
			// Reddit OAuth 2.0 — Refresh an access token
			// https://github.com/reddit-archive/reddit/wiki/oauth2#refreshing-the-token
			return refreshStandard({
				tokenUrl: "https://www.reddit.com/api/v1/access_token",
				clientId: env.REDDIT_CLIENT_ID,
				clientSecret: env.REDDIT_CLIENT_SECRET,
				refreshToken: account.refreshToken,
				useBasicAuth: true,
			});

		// Platforms that don't need refresh:
		// - mastodon: tokens don't expire
		// - bluesky: uses app passwords, session created per-request
		// - discord: uses webhook URLs, no OAuth tokens
		// - telegram: bot tokens don't expire
		// - sms: Twilio credentials don't expire
		// - whatsapp: system user tokens are permanent
		default:
			return null;
	}
}

/**
 * Standard OAuth 2.0 refresh_token grant.
 * Covers Twitter, LinkedIn, Google (YouTube + GBP), Pinterest, Snapchat, Reddit.
 */
async function refreshStandard(params: {
	tokenUrl: string;
	clientId?: string;
	clientSecret?: string;
	refreshToken: string | null;
	useBasicAuth?: boolean;
	useBody?: boolean;
}): Promise<TokenResult | null> {
	if (!params.refreshToken) return null;
	if (!params.clientId) return null;

	const bodyParams: Record<string, string> = {
		grant_type: "refresh_token",
		refresh_token: params.refreshToken,
	};

	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
	};

	if (params.useBasicAuth && params.clientSecret) {
		const credentials = btoa(`${params.clientId}:${params.clientSecret}`);
		headers.Authorization = `Basic ${credentials}`;
	} else if (params.useBody) {
		bodyParams.client_id = params.clientId;
		if (params.clientSecret) {
			bodyParams.client_secret = params.clientSecret;
		}
	}

	const res = await fetchWithTimeout(params.tokenUrl, {
		method: "POST",
		headers,
		body: new URLSearchParams(bodyParams).toString(),
		timeout: 15_000,
	});

	if (!res.ok) {
		const errorBody = await res.text().catch(() => "");
		console.error(
			`Token refresh failed for ${params.tokenUrl}: ${res.status} ${errorBody.slice(0, 200)}`,
		);
		return null;
	}

	const data = (await res.json()) as TokenResult;
	return data;
}

/** Instagram: refresh the long-lived token directly */
async function refreshInstagram(
	accessToken: string,
): Promise<TokenResult | null> {
	// Instagram Platform API — Refresh a long-lived token
	// https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
	const params = new URLSearchParams({
		grant_type: "ig_refresh_token",
		access_token: accessToken,
	});

	const res = await fetchWithTimeout(
		// Docs: https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
		// Docs show no version prefix, but unversioned graph.instagram.com endpoints
		// return "Unsupported request - method type: get" as of March 2026.
		`${GRAPH_BASE.instagram}/refresh_access_token?${params}`,
		{ timeout: 15_000 },
	);
	if (!res.ok) return null;

	const data = (await res.json()) as {
		access_token: string;
		token_type: string;
		expires_in: number;
	};

	return {
		access_token: data.access_token,
		expires_in: data.expires_in,
	};
}

/** Threads: refresh the long-lived token directly */
async function refreshThreads(
	accessToken: string,
): Promise<TokenResult | null> {
	// Threads API — Refresh a long-lived token
	// https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
	const params = new URLSearchParams({
		grant_type: "th_refresh_token",
		access_token: accessToken,
	});

	const res = await fetchWithTimeout(
		`https://graph.threads.net/refresh_access_token?${params}`,
		{ timeout: 15_000 },
	);
	if (!res.ok) return null;

	const data = (await res.json()) as {
		access_token: string;
		token_type: string;
		expires_in: number;
	};

	return {
		access_token: data.access_token,
		expires_in: data.expires_in,
	};
}

/**
 * Re-fetch the avatar URL for a social account using a fresh access token.
 * Social media CDN URLs expire over time, so we refresh them alongside tokens.
 * Best-effort: returns null on any failure (the old avatar stays in the DB).
 */
export async function fetchAvatarUrl(
	platform: Platform,
	accessToken: string,
	platformAccountId: string | null,
): Promise<string | null> {
	try {
		switch (platform) {
			case "twitter": {
				const res = await fetchWithTimeout(
					"https://api.x.com/2/users/me?user.fields=profile_image_url",
					{ headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as { data?: { profile_image_url?: string } };
				return data.data?.profile_image_url ?? null;
			}
			case "linkedin": {
				const res = await fetchWithTimeout(
					"https://api.linkedin.com/v2/userinfo",
					{ headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as { picture?: string };
				return data.picture ?? null;
			}
			case "instagram": {
				const res = await fetchWithTimeout(
					`${GRAPH_BASE.instagram}/me?fields=profile_picture_url&access_token=${accessToken}`,
					{ timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as { profile_picture_url?: string };
				return data.profile_picture_url ?? null;
			}
			case "threads": {
				const res = await fetchWithTimeout(
					`${GRAPH_BASE.threads}/me?fields=threads_profile_picture_url&access_token=${accessToken}`,
					{ timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as { threads_profile_picture_url?: string };
				return data.threads_profile_picture_url ?? null;
			}
			case "youtube": {
				const res = await fetchWithTimeout(
					"https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
					{ headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as {
					items?: Array<{ snippet?: { thumbnails?: { default?: { url?: string } } } }>;
				};
				return data.items?.[0]?.snippet?.thumbnails?.default?.url ?? null;
			}
			case "facebook": {
				if (!platformAccountId) return null;
				const res = await fetchWithTimeout(
					`${GRAPH_BASE.facebook}/${platformAccountId}/picture?type=large&redirect=false&access_token=${accessToken}`,
					{ timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as { data?: { url?: string } };
				return data.data?.url ?? null;
			}
			case "tiktok": {
				const res = await fetchWithTimeout(
					"https://open.tiktokapis.com/v2/user/info/?fields=avatar_url",
					{ headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10_000 },
				);
				if (!res.ok) return null;
				const data = (await res.json()) as { data?: { user?: { avatar_url?: string } } };
				return data.data?.user?.avatar_url ?? null;
			}
			default:
				return null;
		}
	} catch (err) {
		console.warn(`[Token Refresh] Avatar fetch failed for ${platform}:`, err);
		return null;
	}
}

/** TikTok: uses a different body format with client_key instead of client_id */
async function refreshTikTok(
	env: Env,
	refreshToken: string | null,
): Promise<TokenResult | null> {
	if (!refreshToken || !env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
		return null;
	}

	// TikTok Content Posting API — Refresh an access token
	// https://developers.tiktok.com/doc/oauth-user-access-token-management/
	const res = await fetchWithTimeout("https://open.tiktokapis.com/v2/oauth/token/", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_key: env.TIKTOK_CLIENT_KEY,
			client_secret: env.TIKTOK_CLIENT_SECRET,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}).toString(),
		timeout: 15_000,
	});

	if (!res.ok) return null;

	const data = (await res.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};

	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in,
	};
}
