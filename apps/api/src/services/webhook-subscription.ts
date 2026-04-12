import { createDb, socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Env } from "../types";

// ---------------------------------------------------------------------------
// Facebook Page webhook subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe a Facebook Page to receive webhook events (feed, messages).
 * Must be called with a **Page Access Token** (not a User Access Token).
 *
 * Docs: https://developers.facebook.com/docs/messenger-platform/webhooks#subscribe-to-webhooks
 * Endpoint: POST /{page-id}/subscribed_apps
 */
export async function subscribeFacebookPage(
	pageId: string,
	pageAccessToken: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const res = await fetch(
			`https://graph.facebook.com/v25.0/${pageId}/subscribed_apps`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					subscribed_fields:
						"feed,messages,messaging_postbacks,message_deliveries",
					access_token: pageAccessToken,
				}).toString(),
			},
		);
		if (!res.ok) {
			const err = await res.text();
			return {
				success: false,
				error: `Facebook subscribe failed: ${res.status} ${err}`,
			};
		}
		console.log(
			`[webhook-sub] Facebook page ${pageId} subscribed to webhooks`,
		);
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: `Facebook subscribe error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// YouTube PubSubHubbub subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe to YouTube video upload/update notifications via PubSubHubbub.
 * Subscriptions expire after `lease_seconds` and must be renewed.
 *
 * Docs: https://developers.google.com/youtube/v3/guides/push_notifications
 * Hub: https://pubsubhubbub.appspot.com/subscribe
 */
export async function subscribeYouTubeChannel(
	channelId: string,
	callbackUrl: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const topicUrl = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
		const res = await fetch(
			"https://pubsubhubbub.appspot.com/subscribe",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					"hub.callback": callbackUrl,
					"hub.topic": topicUrl,
					"hub.verify": "async",
					"hub.mode": "subscribe",
					"hub.lease_seconds": "864000", // 10 days
				}).toString(),
			},
		);
		// PubSubHubbub returns 202 Accepted for async verification
		if (!res.ok && res.status !== 202) {
			const err = await res.text();
			return {
				success: false,
				error: `PubSubHubbub subscribe failed: ${res.status} ${err}`,
			};
		}
		console.log(
			`[webhook-sub] YouTube channel ${channelId} subscribed to PubSubHubbub`,
		);
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: `PubSubHubbub subscribe error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// WhatsApp app-level webhook subscription
// ---------------------------------------------------------------------------

/**
 * Verify (and create if needed) the app-level WhatsApp webhook subscription.
 * Unlike Facebook Pages or YouTube channels, WhatsApp uses a single app-level
 * subscription for all connected phone numbers.
 *
 * Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * Endpoint: POST /{app-id}/subscriptions
 */
export async function verifyWhatsAppWebhookSubscription(
	appId: string,
	appSecret: string,
	callbackUrl: string,
	verifyToken: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const appAccessToken = `${appId}|${appSecret}`;

		// Check existing subscriptions
		const checkRes = await fetch(
			`https://graph.facebook.com/v25.0/${appId}/subscriptions?access_token=${encodeURIComponent(appAccessToken)}`,
		);

		if (checkRes.ok) {
			const checkJson = (await checkRes.json()) as {
				data: Array<{
					object: string;
					callback_url: string;
					active: boolean;
				}>;
			};
			const existing = checkJson.data?.find(
				(s) => s.object === "whatsapp_business_account",
			);
			if (existing?.active && existing.callback_url === callbackUrl) {
				console.log("[webhook-sub] WhatsApp webhook subscription already active");
				return { success: true };
			}
		}

		// Create/update subscription
		const res = await fetch(
			`https://graph.facebook.com/v25.0/${appId}/subscriptions`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					object: "whatsapp_business_account",
					callback_url: callbackUrl,
					verify_token: verifyToken,
					fields: "messages",
					access_token: appAccessToken,
				}).toString(),
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return {
				success: false,
				error: `WhatsApp webhook subscription failed: ${res.status} ${err}`,
			};
		}

		console.log("[webhook-sub] WhatsApp webhook subscription created/updated");
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: `WhatsApp webhook subscription error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Instagram per-user webhook subscription
// ---------------------------------------------------------------------------

/**
 * Subscribe an individual Instagram account to receive webhook events.
 * Must be called with the user's **Instagram User access token** (not an app token).
 *
 * This is required IN ADDITION to the app-level subscription — Meta only delivers
 * webhooks for accounts that have explicitly subscribed via this endpoint.
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/webhooks
 * Endpoint: POST /me/subscribed_apps
 */
export async function subscribeInstagramAccount(
	igUserId: string,
	accessToken: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		// Instagram Login tokens (IGAA prefix) use graph.instagram.com
		const host = accessToken.startsWith("IGAA")
			? "graph.instagram.com"
			: "graph.facebook.com";

		const res = await fetch(
			`https://${host}/v25.0/me/subscribed_apps`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					subscribed_fields: "comments,messages",
					access_token: accessToken,
				}).toString(),
			},
		);
		if (!res.ok) {
			const err = await res.text();
			return {
				success: false,
				error: `Instagram user subscribe failed: ${res.status} ${err}`,
			};
		}
		console.log(
			`[webhook-sub] Instagram account ${igUserId} subscribed to webhooks`,
		);
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: `Instagram user subscribe error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Instagram app-level webhook subscription
// ---------------------------------------------------------------------------

/**
 * Verify (and create if needed) the app-level Instagram webhook subscription.
 * Like WhatsApp, Instagram (via Instagram Login / IGAA) uses a single app-level
 * subscription for all authorized users.
 *
 * Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 * Endpoint: POST /{app-id}/subscriptions
 */
export async function verifyInstagramWebhookSubscription(
	appId: string,
	appSecret: string,
	callbackUrl: string,
	verifyToken: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const appAccessToken = `${appId}|${appSecret}`;

		// Check existing subscriptions
		const checkRes = await fetch(
			`https://graph.facebook.com/v25.0/${appId}/subscriptions?access_token=${encodeURIComponent(appAccessToken)}`,
		);

		if (checkRes.ok) {
			const checkJson = (await checkRes.json()) as {
				data: Array<{
					object: string;
					callback_url: string;
					active: boolean;
				}>;
			};
			const existing = checkJson.data?.find(
				(s) => s.object === "instagram",
			);
			if (existing?.active && existing.callback_url === callbackUrl) {
				console.log("[webhook-sub] Instagram webhook subscription already active");
				return { success: true };
			}
		}

		// Create/update subscription
		const res = await fetch(
			`https://graph.facebook.com/v25.0/${appId}/subscriptions`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					object: "instagram",
					callback_url: callbackUrl,
					verify_token: verifyToken,
					fields: "messages,comments",
					access_token: appAccessToken,
				}).toString(),
			},
		);

		if (!res.ok) {
			const err = await res.text();
			return {
				success: false,
				error: `Instagram webhook subscription failed: ${res.status} ${err}`,
			};
		}

		console.log("[webhook-sub] Instagram webhook subscription created/updated");
		return { success: true };
	} catch (err) {
		return {
			success: false,
			error: `Instagram webhook subscription error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

// ---------------------------------------------------------------------------
// YouTube PubSub renewal (called from daily cron)
// ---------------------------------------------------------------------------

/**
 * Renew PubSubHubbub subscriptions for all connected YouTube accounts.
 * Should be called daily since leases are set to 10 days.
 */
export async function renewYouTubePubSubSubscriptions(
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const youtubeAccounts = await db
		.select({
			platformAccountId: socialAccounts.platformAccountId,
		})
		.from(socialAccounts)
		.where(eq(socialAccounts.platform, "youtube"));

	const apiBaseUrl = env.API_BASE_URL || "https://api.relayapi.dev";
	const callbackUrl = `${apiBaseUrl}/webhooks/platform/youtube`;

	for (const account of youtubeAccounts) {
		if (!account.platformAccountId) continue;
		const result = await subscribeYouTubeChannel(
			account.platformAccountId,
			callbackUrl,
		);
		if (!result.success) {
			console.error(
				`[webhook-sub] YouTube renewal failed for ${account.platformAccountId}:`,
				result.error,
			);
		}
	}
}
