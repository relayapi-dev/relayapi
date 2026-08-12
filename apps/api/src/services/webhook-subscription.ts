import { createDb, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { API_VERSIONS, GRAPH_BASE } from "../config/api-versions";
import { readResponseJson } from "../lib/fetch-public-url";
import { readProviderJson, readProviderText } from "../lib/provider-response";
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
			`${GRAPH_BASE.facebook}/${pageId}/subscribed_apps`,
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
			const err = await readProviderText(res);
			return {
				success: false,
				error: `Facebook subscribe failed: ${res.status} ${err}`,
			};
		}
		console.log(`[webhook-sub] Facebook page ${pageId} subscribed to webhooks`);
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
 * Section: "Subscribe to Push Notifications" steps 1-3
 * Hub: https://pubsubhubbub.appspot.com/subscribe
 * Request: POST application/x-www-form-urlencoded fields hub.callback,
 * hub.topic, hub.verify, hub.mode, hub.lease_seconds, and hub.secret.
 * Authenticated distribution: https://www.w3.org/TR/websub/#authenticated-content-distribution
 */
export async function subscribeYouTubeChannel(
	channelId: string,
	callbackUrl: string,
	hubSecret: string,
): Promise<{ success: boolean; error?: string }> {
	if (!hubSecret) {
		return {
			success: false,
			error: "YOUTUBE_HUB_SECRET is required for authenticated subscriptions",
		};
	}

	try {
		const topicUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
		const params: Record<string, string> = {
			"hub.callback": callbackUrl,
			"hub.topic": topicUrl,
			"hub.verify": "async",
			"hub.mode": "subscribe",
			"hub.lease_seconds": "864000", // 10 days
			"hub.secret": hubSecret,
		};
		const res = await fetch("https://pubsubhubbub.appspot.com/subscribe", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(params).toString(),
		});
		// PubSubHubbub returns 202 Accepted for async verification
		if (!res.ok && res.status !== 202) {
			const err = await readProviderText(res);
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
		const requiredFields = [
			"messages",
			"group_lifecycle_update",
			"group_participants_update",
			"group_settings_update",
			"group_status_update",
		] as const;

		// Check existing subscriptions
		const checkRes = await fetch(
			`${GRAPH_BASE.facebook}/${appId}/subscriptions?access_token=${encodeURIComponent(appAccessToken)}`,
		);

		if (checkRes.ok) {
			const checkJson = (await readProviderJson(checkRes)) as {
				data: Array<{
					object: string;
					callback_url: string;
					active: boolean;
					fields?: string[];
				}>;
			};
			const existing = checkJson.data?.find(
				(s) => s.object === "whatsapp_business_account",
			);
			if (
				existing?.active &&
				existing.callback_url === callbackUrl &&
				requiredFields.every((field) => existing.fields?.includes(field))
			) {
				console.log(
					"[webhook-sub] WhatsApp webhook subscription already active",
				);
				return { success: true };
			}
		}

		// Create/update subscription
		const res = await fetch(`${GRAPH_BASE.facebook}/${appId}/subscriptions`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				object: "whatsapp_business_account",
				callback_url: callbackUrl,
				verify_token: verifyToken,
				// Groups API metadata requires all four group webhook fields.
				// https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/webhooks
				fields: requiredFields.join(","),
				access_token: appAccessToken,
			}).toString(),
		});

		if (!res.ok) {
			const err = await readProviderText(res);
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

/**
 * Subscribe the configured Meta app to one WhatsApp Business Account.
 *
 * Official Meta collection:
 * https://www.postman.com/meta/whatsapp-business-platform/request/26gui66/subscribe-to-a-waba
 * Section "Subscribe to a WABA":
 * POST https://graph.facebook.com/{{Version}}/{{WABA-ID}}/subscribed_apps
 * Header: Authorization: Bearer {{User-Access-Token}}
 */
export async function subscribeWhatsAppBusinessAccount(
	wabaId: string,
	accessToken: string,
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(
			`${GRAPH_BASE.facebook}/${encodeURIComponent(wabaId)}/subscribed_apps`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}` },
			},
		);
		type SubscriptionResponse = {
			success?: boolean | string;
			error?: { message?: string; code?: number };
		};
		const payload = await readResponseJson<SubscriptionResponse>(
			response,
			256 * 1024,
		).catch((): SubscriptionResponse => ({}));
		if (
			!response.ok ||
			!(payload.success === true || payload.success === "true")
		) {
			return {
				success: false,
				error:
					payload.error?.message ??
					`WhatsApp WABA subscription failed (${response.status})`,
			};
		}
		return { success: true };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "WhatsApp WABA subscription failed",
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
			`https://${host}/${API_VERSIONS.meta_graph}/me/subscribed_apps`,
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					// `messaging_postbacks` delivers get-started, persistent-menu,
					// ice-breaker, and automation button payloads. `mentions` is
					// required for story-mention wait nodes and follower-growth flows.
					subscribed_fields: "comments,messages,messaging_postbacks,mentions",
					access_token: accessToken,
				}).toString(),
			},
		);
		if (!res.ok) {
			const err = await readProviderText(res);
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
			`${GRAPH_BASE.facebook}/${appId}/subscriptions?access_token=${encodeURIComponent(appAccessToken)}`,
		);

		if (checkRes.ok) {
			const checkJson = (await readProviderJson(checkRes)) as {
				data: Array<{
					object: string;
					callback_url: string;
					active: boolean;
				}>;
			};
			const existing = checkJson.data?.find((s) => s.object === "instagram");
			// Even when the callback is already active, POST the desired field set
			// below. Callback equality alone does not prove that newly required
			// fields (postbacks/mentions) are subscribed.
			void existing;
		}

		// Create/update subscription
		const res = await fetch(`${GRAPH_BASE.facebook}/${appId}/subscriptions`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				object: "instagram",
				callback_url: callbackUrl,
				verify_token: verifyToken,
				fields: "messages,comments,messaging_postbacks,mentions",
				access_token: appAccessToken,
			}).toString(),
		});

		if (!res.ok) {
			const err = await readProviderText(res);
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
export async function renewYouTubePubSubSubscriptions(env: Env): Promise<void> {
	const hubSecret = env.YOUTUBE_HUB_SECRET;
	if (!hubSecret) {
		throw new Error(
			"YouTube webhook subscriptions are disabled: YOUTUBE_HUB_SECRET is not configured",
		);
	}

	const db = createDb(env.HYPERDRIVE.connectionString);
	const youtubeAccounts = await db
		.selectDistinct({
			platformAccountId: socialAccounts.platformAccountId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.platform, "youtube"),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		);

	const apiBaseUrl = env.API_BASE_URL || "https://api.relayapi.dev";
	const callbackUrl = `${apiBaseUrl}/webhooks/platform/youtube`;
	// Dedupe channel IDs (same channel can appear in multiple workspaces) and
	// process them in bounded-concurrency chunks instead of one serial POST per
	// row, so a few hundred accounts don't take minutes or blow the Workers
	// subrequest budget.
	const channelIds = [
		...new Set(
			youtubeAccounts
				.map((a) => a.platformAccountId)
				.filter((id): id is string => Boolean(id)),
		),
	];

	const CHUNK_SIZE = 10;
	for (let i = 0; i < channelIds.length; i += CHUNK_SIZE) {
		const slice = channelIds.slice(i, i + CHUNK_SIZE);
		const results = await Promise.allSettled(
			slice.map((id) => subscribeYouTubeChannel(id, callbackUrl, hubSecret)),
		);
		results.forEach((result, idx) => {
			const id = slice[idx];
			if (result.status === "rejected") {
				console.error(
					`[webhook-sub] YouTube renewal threw for ${id}:`,
					result.reason,
				);
			} else if (!result.value.success) {
				console.error(
					`[webhook-sub] YouTube renewal failed for ${id}:`,
					result.value.error,
				);
			}
		});
	}
}
