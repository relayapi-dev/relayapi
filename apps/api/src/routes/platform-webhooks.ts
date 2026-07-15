import {
	createDb,
	inboxConversations,
	inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { decryptAccountToken } from "../lib/account-token-crypto";
import {
	ResponseTooLargeError,
	readRequestBytes,
	readRequestText,
} from "../lib/fetch-public-url";
import type { SyncPostsMessage } from "../services/external-post-sync/types";
import {
	acceptInboundWebhook,
	type RawInboxQueueMessage,
} from "../services/inbound-webhook-acceptance";
import { processTelegramConnectionChallenge } from "../services/telegram-connection";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();

/**
 * Platform webhook envelopes are small control-plane payloads. Keep the hard
 * ceiling at 256 KiB, rejecting oversized Content-Length values up front and
 * streamed overflow while reading. Signature work only receives a bounded body.
 */
export const MAX_PLATFORM_WEBHOOK_BYTES = 256 * 1024;

async function readPlatformWebhookBody(request: Request): Promise<ArrayBuffer> {
	return readRequestBytes(request, MAX_PLATFORM_WEBHOOK_BYTES);
}

function payloadTooLargeResponse(): Response {
	return Response.json({ error: "Payload too large" }, { status: 413 });
}

/** Constant-time string comparison via HMAC to prevent timing and length-oracle attacks */
async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode("relay-cmp"),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const [sigA, sigB] = await Promise.all([
		crypto.subtle.sign("HMAC", key, enc.encode(a)),
		crypto.subtle.sign("HMAC", key, enc.encode(b)),
	]);
	const a8 = new Uint8Array(sigA);
	const b8 = new Uint8Array(sigB);
	let mismatch = 0;
	for (let i = 0; i < a8.length; i++) {
		mismatch |= (a8[i] ?? 0) ^ (b8[i] ?? 0);
	}
	return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedInboxQueueMessage {
	type:
		| "facebook_webhook"
		| "instagram_webhook"
		| "youtube_pubsub"
		| "youtube_subscribe"
		| "whatsapp_webhook"
		| "telegram_webhook"
		| "sms_webhook"
		| "backfill";
	platform: string;
	platform_account_id: string;
	organization_id: string;
	account_id: string;
	event_type: string;
	payload: unknown;
	received_at: string;
}

export type InboxQueueMessage = NormalizedInboxQueueMessage;
export type AnyInboxQueueMessage = InboxQueueMessage | RawInboxQueueMessage;

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification (Workers-compatible)
// ---------------------------------------------------------------------------

async function verifyHmacSha256(
	body: ArrayBuffer,
	signature: string | undefined,
	secret: string,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) return false;
	const expected = signature.slice(7);
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, body);
	const computed = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	// Constant-length comparison to mitigate timing attacks
	if (computed.length !== expected.length) return false;
	let mismatch = 0;
	for (let i = 0; i < computed.length; i++) {
		mismatch |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return mismatch === 0;
}

// ---------------------------------------------------------------------------
// KV-cached account lookup: platformAccountId → { orgId, accountId }
// ---------------------------------------------------------------------------

interface AccountLookup {
	orgId: string;
	accountId: string;
	/** platformAccountId stored on the social_accounts row (used for echo detection) */
	platformAccountId?: string;
	/** webhookAccountId stored on the social_accounts row (used for echo detection) */
	webhookAccountId?: string;
}

// Sentinel value cached when a platform account ID resolves to no social account.
// Short TTL so newly connected accounts start resolving quickly.
const NEGATIVE_CACHE_VALUE = "miss";
const NEGATIVE_CACHE_TTL = 60;

/**
 * Resolve ALL social accounts connected to a given platform account ID.
 *
 * The unique index on social_accounts is (organizationId, platform,
 * platformAccountId), so the same Facebook Page / WhatsApp number / IG account
 * can legitimately be connected by multiple organizations (e.g. an agency and
 * its client). Returning only one of them would silently misroute every inbound
 * event to a single tenant, so this returns every matching account and callers
 * fan-out the event to each. Results are ordered deterministically by id so the
 * list is stable across cache expiries.
 */
async function resolveAccounts(
	env: Env,
	platform: string,
	platformAccountId: string,
): Promise<AccountLookup[]> {
	const kvKey = `platform-account:${platform}:${platformAccountId}`;
	const cachedRaw = await env.KV.get(kvKey);
	if (cachedRaw === NEGATIVE_CACHE_VALUE) return [];
	if (cachedRaw) {
		try {
			const parsed = JSON.parse(cachedRaw);
			// Only trust the current cache shape. Malformed entries are treated as
			// cache misses and replaced from the database below.
			if (Array.isArray(parsed)) return parsed as AccountLookup[];
		} catch {
			// Fall through to a fresh lookup on malformed cache entries.
		}
	}

	const db = createDb(env.HYPERDRIVE.connectionString);
	const accounts = await db
		.select({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
			platformAccountId: socialAccounts.platformAccountId,
			webhookAccountId: socialAccounts.webhookAccountId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(
					socialAccounts.platform,
					platform as typeof socialAccounts.$inferSelect.platform,
				),
				eq(socialAccounts.lifecycleStatus, "active"),
				eq(socialAccounts.platformAccountId, platformAccountId),
			),
		)
		.orderBy(socialAccounts.id);

	let rows = accounts;

	// Instagram webhooks use the IGBA ID as entry.id, which differs from both
	// platformAccountId (user_id) and webhookAccountId (IGUID) stored during
	// connection. Fall back to webhookAccountId (uses social_accounts_webhook_id_idx).
	if (rows.length === 0 && platform === "instagram") {
		rows = await db
			.select({
				id: socialAccounts.id,
				organizationId: socialAccounts.organizationId,
				platformAccountId: socialAccounts.platformAccountId,
				webhookAccountId: socialAccounts.webhookAccountId,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.platform, "instagram"),
					eq(socialAccounts.lifecycleStatus, "active"),
					eq(socialAccounts.webhookAccountId, platformAccountId),
				),
			)
			.orderBy(socialAccounts.id);

		if (rows.length === 0) {
			console.warn(
				"[platform-webhooks] Instagram webhook account could not be resolved safely",
				{
					webhookEntryId: platformAccountId,
				},
			);
		}
	}

	if (rows.length === 0) {
		// Negative cache so repeated events for an unknown account don't hammer
		// Postgres. Short TTL so newly connected accounts resolve quickly.
		await env.KV.put(kvKey, NEGATIVE_CACHE_VALUE, {
			expirationTtl: NEGATIVE_CACHE_TTL,
		});
		return [];
	}

	const results: AccountLookup[] = rows.map((row) => ({
		orgId: row.organizationId,
		accountId: row.id,
		platformAccountId: row.platformAccountId ?? undefined,
		webhookAccountId: row.webhookAccountId ?? undefined,
	}));
	await env.KV.put(kvKey, JSON.stringify(results), { expirationTtl: 300 });
	return results;
}

// ---------------------------------------------------------------------------
// Facebook / Instagram Webhooks
// ---------------------------------------------------------------------------

// GET /facebook — Meta webhook verification challenge
app.get("/facebook", async (c) => {
	const mode = c.req.query("hub.mode");
	const token = c.req.query("hub.verify_token");
	const challenge = c.req.query("hub.challenge");

	if (
		mode === "subscribe" &&
		token &&
		c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN &&
		(await safeEqual(token, c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN))
	) {
		return c.text(challenge ?? "", 200);
	}
	return c.text("Forbidden", 403);
});

// POST /facebook — Facebook & Instagram event ingestion
app.post("/facebook", async (c) => {
	let bodyBytes: ArrayBuffer;
	try {
		bodyBytes = await readPlatformWebhookBody(c.req.raw);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return payloadTooLargeResponse();
		}
		throw error;
	}
	const signature = c.req.header("x-hub-signature-256");
	const appSecret = c.env.FACEBOOK_APP_SECRET;

	console.log("[platform-webhooks] Facebook/IG webhook received", {
		hasSignature: !!signature,
		contentLength: bodyBytes.byteLength,
	});

	let valid = appSecret
		? await verifyHmacSha256(bodyBytes, signature, appSecret)
		: false;
	let signedByFacebookApp = valid;

	// Instagram Login app may use a different secret than the main Facebook app
	if (!valid && c.env.INSTAGRAM_LOGIN_APP_SECRET) {
		valid = await verifyHmacSha256(
			bodyBytes,
			signature,
			c.env.INSTAGRAM_LOGIN_APP_SECRET,
		);
		signedByFacebookApp = false;
	}

	if (!valid) {
		console.warn("[platform-webhooks] Facebook/IG webhook signature invalid");
		return c.json({ error: "Invalid signature" }, 403);
	}

	const body = new TextDecoder().decode(bodyBytes);
	const parsed = JSON.parse(body) as MetaWebhookBody;

	// Skip Instagram webhooks from the Facebook app — they use different ISGIDs
	// and create duplicate conversations. Only process Instagram events from the
	// Instagram Login app to ensure consistent user IDs.
	if (
		signedByFacebookApp &&
		(parsed.object === "instagram" || parsed.object === "user")
	) {
		console.log("[platform-webhooks] Skipped Facebook-app Instagram webhook", {
			object: parsed.object,
			entryIds: parsed.entry?.map((e) => e.id),
		});
		return c.json({ received: true }, 200);
	}

	console.log("[platform-webhooks] Processing webhook", {
		object: parsed.object,
		entries: parsed.entry?.length ?? 0,
		signedByFacebookApp,
		entryIds: parsed.entry?.map((e) => e.id),
		hasMessaging: parsed.entry?.some((e) => e.messaging?.length),
	});
	try {
		await acceptInboundWebhook(c.env, {
			provider: "meta",
			payload: body,
			contentType: c.req.header("content-type"),
			signatureMetadata: { signed_by_facebook_app: signedByFacebookApp },
		});
	} catch (error) {
		console.error("[platform-webhooks] Meta durable acceptance failed", error);
		return c.json({ error: "Temporary acceptance failure" }, 503);
	}

	return c.json({ received: true }, 200);
});

interface MetaWebhookBody {
	object: "page" | "instagram" | "user";
	entry: Array<{
		id: string;
		time: number;
		changes?: Array<{ field: string; value: unknown }>;
		messaging?: Array<{
			sender: { id: string };
			recipient: { id: string };
			timestamp: number;
			message?: { mid: string; text?: string; attachments?: unknown[] };
			postback?: { title: string; payload: string };
		}>;
	}>;
}

export async function processFacebookWebhook(
	body: MetaWebhookBody,
	env: Env,
): Promise<void> {
	// "instagram" = Messenger Platform messaging, "user" = Instagram Login changes (comments, mentions)
	const platform =
		body.object === "instagram" || body.object === "user"
			? "instagram"
			: "facebook";
	const db = createDb(env.HYPERDRIVE.connectionString);

	for (const entry of body.entry ?? []) {
		const lookups = await resolveAccounts(env, platform, entry.id);
		if (lookups.length === 0) {
			console.warn(
				`[platform-webhooks] No account found for ${platform}:${entry.id}`,
			);
			continue;
		}

		// The same platform account can be connected by multiple orgs (agency +
		// client), so fan-out every event to each matching account/org.
		for (const lookup of lookups) {
			// Handle field changes (comments, feed updates)
			let syncTriggered = false;
			for (const change of entry.changes ?? []) {
				const eventType = change.field; // "feed", "comments", "messages", etc.
				// Skip DM events from changes[] — they're handled via messaging[] below.
				// Processing both creates duplicate conversations with different ISGIDs.
				if (eventType === "messages" || eventType === "messaging") continue;
				await env.INBOX_QUEUE.send({
					type: `${platform}_webhook` as InboxQueueMessage["type"],
					platform,
					platform_account_id: entry.id,
					organization_id: lookup.orgId,
					account_id: lookup.accountId,
					event_type: eventType,
					payload: change.value,
					received_at: new Date().toISOString(),
				} satisfies InboxQueueMessage);
				console.log("[platform-webhooks] Enqueued inbox event", {
					platform,
					eventType,
					platformAccountId: entry.id,
				});

				// Trigger external post sync on new feed/post events (deduplicated via KV)
				if (
					!syncTriggered &&
					(eventType === "feed" || eventType === "published_posts")
				) {
					const dedupeKey = `sync-dedup:${lookup.accountId}`;
					const recent = await env.KV.get(dedupeKey);
					if (!recent) {
						await env.KV.put(dedupeKey, "1", { expirationTtl: 60 });
						await env.SYNC_QUEUE.send({
							type: "sync_posts",
							social_account_id: lookup.accountId,
							organization_id: lookup.orgId,
							platform,
							webhook_triggered: true,
							hint: {
								event_type: eventType,
								platform_post_id:
									(change.value as { post_id?: string })?.post_id ?? undefined,
							},
						} satisfies SyncPostsMessage);
					}
					syncTriggered = true;
				}
			}

			// Build set of ALL known IDs for this business account to detect echoes.
			// Instagram has multiple ID formats: platformAccountId (user_id),
			// webhookAccountId (ISGID/IGUID), entry.id (IGBA ID), and the
			// messaging-scoped IGSID (only revealed in webhook sender/recipient).
			// platformAccountId/webhookAccountId come from the KV-cached lookup, so
			// no extra per-entry DB select is needed.
			const knownBusinessIds = new Set<string>([entry.id]);
			if (lookup.platformAccountId)
				knownBusinessIds.add(lookup.platformAccountId);
			if (lookup.webhookAccountId)
				knownBusinessIds.add(lookup.webhookAccountId);

			// Load the business's messaging IGSID from KV if previously discovered.
			// This ID differs from platformAccountId/webhookAccountId/entry.id and is
			// only revealed when processing webhook messaging events.
			const cachedIgsid = await env.KV.get(`ig-sender-id:${lookup.accountId}`);
			if (cachedIgsid) knownBusinessIds.add(cachedIgsid);

			// Pre-scan messaging[] to learn the business ISGID (Chatwoot pattern).
			// Instagram uses different IDs in webhook entry vs messaging sender/recipient.
			// - Inbound messages: sender = customer, recipient = business
			// - Echo messages (is_echo): sender = business, recipient = customer
			// Collect business IDs from both sides so echo detection catches all formats.
			for (const msg of entry.messaging ?? []) {
				if ((msg.message as { is_echo?: boolean })?.is_echo) {
					// Echo: sender IS the business account
					if (msg.sender?.id) knownBusinessIds.add(msg.sender.id);
				} else {
					// Inbound: recipient IS the business account
					if (msg.recipient?.id) knownBusinessIds.add(msg.recipient.id);
				}
			}

			console.log("[platform-webhooks] Echo detection IDs", {
				entryId: entry.id,
				knownBusinessIds: [...knownBusinessIds],
			});

			// Handle messaging events — ONLY actual messages (following Chatwoot's pattern)
			for (const msg of entry.messaging ?? []) {
				// Surface follow / referral events so the automation engine can fire
				// `follow` and `ad_click` entrypoints. Reactions / read receipts are
				// still dropped.
				const asAny = msg as Record<string, unknown>;
				const hasFollow = Boolean((asAny as { follow?: unknown }).follow);
				const hasReferral = Boolean((asAny as { referral?: unknown }).referral);
				if (!msg.message && !msg.postback) {
					if (hasFollow) {
						await env.INBOX_QUEUE.send({
							type: `${platform}_webhook` as InboxQueueMessage["type"],
							platform,
							platform_account_id: entry.id,
							organization_id: lookup.orgId,
							account_id: lookup.accountId,
							event_type: "follows",
							payload: msg,
							received_at: new Date().toISOString(),
						} satisfies InboxQueueMessage);
						continue;
					}
					if (hasReferral) {
						// Standalone referral — user opens an ad CTM flow before sending
						// any text. Meta may deliver this before the first message.
						await env.INBOX_QUEUE.send({
							type: `${platform}_webhook` as InboxQueueMessage["type"],
							platform,
							platform_account_id: entry.id,
							organization_id: lookup.orgId,
							account_id: lookup.accountId,
							event_type: "referral",
							payload: msg,
							received_at: new Date().toISOString(),
						} satisfies InboxQueueMessage);
						continue;
					}
					// Skip non-message events: reactions, seen, etc.
					continue;
				}

				const mid = msg.message?.mid;
				const isEcho = !!(msg.message as { is_echo?: boolean })?.is_echo;
				const senderIsKnown = knownBusinessIds.has(msg.sender.id);

				// --- Echo detection (4 layers) ---
				// When both Page and Instagram Login subscriptions are active, Meta
				// delivers the same outbound IG DM twice: once via Instagram Login
				// (with is_echo + IG IDs) and once via Page (no is_echo, Page-scoped
				// IDs, different mid). Meta docs: "Your server should handle
				// deduplication in these cases."

				// Layer 1: Explicit is_echo flag OR sender is a known business ID
				if (isEcho || senderIsKnown) {
					// Learn business messaging IGSID from confirmed echoes
					if (msg.sender?.id && !cachedIgsid) {
						await env.KV.put(
							`ig-sender-id:${lookup.accountId}`,
							msg.sender.id,
							{ expirationTtl: 86400 * 30 },
						);
					}

					if (mid) {
						// Check if this echo was sent by RelayAPI — already stored
						const isOurMessage = await env.KV.get(`outbound-mid:${mid}`);
						if (isOurMessage) {
							await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
								expirationTtl: 300,
							});
							continue;
						}

						// Check DB — RelayAPI stores outbound messages before the echo arrives
						const [existingMsg] = await db
							.select({ id: inboxMessages.id })
							.from(inboxMessages)
							.where(eq(inboxMessages.platformMessageId, mid))
							.limit(1);
						if (existingMsg) {
							await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
								expirationTtl: 300,
							});
							continue;
						}

						// Deduplicate — prevent processing same echo twice. The mark is
						// written AFTER a successful enqueue (below) so a transient
						// send failure does not permanently suppress a redelivery.
						if (await env.KV.get(`msg-dedup:${lookup.accountId}:${mid}`))
							continue;
					}

					// Echo NOT from RelayAPI — sent via another platform (e.g. Respond.io)
					// Enqueue as external echo to store as outbound message
					console.log(
						"[platform-webhooks] External echo detected, storing as outbound",
						{
							mid,
							senderId: msg.sender.id,
							platform,
						},
					);
					await env.INBOX_QUEUE.send({
						type: `${platform}_webhook` as InboxQueueMessage["type"],
						platform,
						platform_account_id: entry.id,
						organization_id: lookup.orgId,
						account_id: lookup.accountId,
						event_type: "echo_messages",
						payload: msg,
						received_at: new Date().toISOString(),
					} satisfies InboxQueueMessage);
					// Mark as processed only after the enqueue succeeded.
					if (mid) {
						await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
							expirationTtl: 300,
						});
					}
					continue;
				}

				if (mid) {
					// Layer 2: KV outbound-mid (fast, eventually consistent)
					if (await env.KV.get(`outbound-mid:${mid}`)) {
						await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
							expirationTtl: 300,
						});
						continue;
					}

					// Layer 3: DB mid match (strongly consistent, indexed)
					const [existingMsg] = await db
						.select({ id: inboxMessages.id })
						.from(inboxMessages)
						.where(eq(inboxMessages.platformMessageId, mid))
						.limit(1);
					if (existingMsg) {
						await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
							expirationTtl: 300,
						});
						continue;
					}

					// Layer 4: Recent outbound text match — catches the Page subscription
					// duplicate which arrives with a different mid and no is_echo.
					// Uses a tight 15s window to minimize false positives. Scoped to
					// the SAME conversation (the inbound sender's thread) so a genuine
					// inbound whose text merely matches an unrelated outbound to a
					// different customer is not dropped.
					const msgText = msg.message?.text;
					if (msgText) {
						const [recentOutbound] = await db
							.select({ id: inboxMessages.id })
							.from(inboxMessages)
							.innerJoin(
								inboxConversations,
								eq(inboxMessages.conversationId, inboxConversations.id),
							)
							.where(
								and(
									eq(inboxConversations.accountId, lookup.accountId),
									eq(inboxConversations.platformConversationId, msg.sender.id),
									eq(inboxMessages.direction, "outbound"),
									eq(inboxMessages.text, msgText),
									sql`${inboxMessages.createdAt} > NOW() - INTERVAL '15 seconds'`,
								),
							)
							.limit(1);
						if (recentOutbound) {
							console.log(
								"[platform-webhooks] Echo skipped (cross-subscription dedup)",
								{ mid, senderId: msg.sender.id },
							);
							await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
								expirationTtl: 300,
							});
							continue;
						}
					}

					// Deduplicate by message ID — prevents processing same DM twice.
					// Only the read-check happens here; the mark is written AFTER a
					// successful enqueue so a transient INBOX_QUEUE.send failure does
					// not permanently suppress a redelivery of the same mid.
					if (await env.KV.get(`msg-dedup:${lookup.accountId}:${mid}`))
						continue;
				}

				await env.INBOX_QUEUE.send({
					type: `${platform}_webhook` as InboxQueueMessage["type"],
					platform,
					platform_account_id: entry.id,
					organization_id: lookup.orgId,
					account_id: lookup.accountId,
					event_type: "messages",
					payload: msg,
					received_at: new Date().toISOString(),
				} satisfies InboxQueueMessage);

				// Mark as processed only after the enqueue succeeded.
				if (mid) {
					await env.KV.put(`msg-dedup:${lookup.accountId}:${mid}`, "1", {
						expirationTtl: 300,
					});
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// YouTube PubSubHubbub
// ---------------------------------------------------------------------------

// GET /youtube — PubSubHubbub verification challenge
app.get("/youtube", async (c) => {
	const mode = c.req.query("hub.mode");
	const challenge = c.req.query("hub.challenge");

	if (mode === "subscribe" && challenge) {
		return c.text(challenge, 200);
	}
	if (mode === "denied") {
		console.error(
			"[platform-webhooks] YouTube PubSub denied:",
			c.req.query("hub.reason"),
		);
		return c.text("Denied", 200);
	}
	return c.text("Missing challenge", 400);
});

// POST /youtube — Video upload / update notifications (Atom XML)
app.post("/youtube", async (c) => {
	const youtubeHubSecret = c.env.YOUTUBE_HUB_SECRET;
	if (!youtubeHubSecret) {
		console.error(
			"[platform-webhooks] YouTube webhook disabled: YOUTUBE_HUB_SECRET is not configured",
		);
		return c.text("Webhook not configured", 503);
	}

	const signature = c.req.header("x-hub-signature");
	if (!signature) {
		console.warn("[platform-webhooks] YouTube: missing X-Hub-Signature header");
		return c.text("Missing signature", 403);
	}

	// WebSub section 7.1 requires method=<hex> and HMAC over the exact body
	// whenever the subscription included hub.secret.
	// Ref: https://www.w3.org/TR/websub/#authenticated-content-distribution
	const signatureMatch = /^(sha1|sha256)=([0-9a-f]+)$/i.exec(signature);
	if (!signatureMatch) {
		return c.text("Invalid signature", 403);
	}

	let bodyBytes: ArrayBuffer;
	try {
		bodyBytes = await readPlatformWebhookBody(c.req.raw);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return payloadTooLargeResponse();
		}
		throw error;
	}
	const algorithm = signatureMatch[1]?.toLowerCase();
	const expectedHex = signatureMatch[2]?.toLowerCase() ?? "";
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(youtubeHubSecret),
		{ name: "HMAC", hash: algorithm === "sha256" ? "SHA-256" : "SHA-1" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, bodyBytes);
	const computed = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	if (
		computed.length !== expectedHex.length ||
		!(await safeEqual(computed, expectedHex))
	) {
		console.warn("[platform-webhooks] YouTube: invalid X-Hub-Signature");
		return c.text("Invalid signature", 403);
	}

	const body = new TextDecoder().decode(bodyBytes);
	try {
		await acceptInboundWebhook(c.env, {
			provider: "youtube",
			payload: body,
			contentType: c.req.header("content-type"),
		});
	} catch (error) {
		console.error(
			"[platform-webhooks] YouTube durable acceptance failed",
			error,
		);
		return c.text("Temporary acceptance failure", 503);
	}

	return c.text("OK", 200);
});

export async function processYouTubeWebhook(
	body: string,
	env: Env,
): Promise<void> {
	// YouTube PubSub sends Atom XML — parse with regex (no DOMParser on Workers)
	const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
	const channelIdMatch = body.match(/<yt:channelId>([^<]+)<\/yt:channelId>/);

	if (!channelIdMatch?.[1]) {
		console.warn("[platform-webhooks] YouTube: no channelId in payload");
		return;
	}

	const channelId = channelIdMatch[1];
	const videoId = videoIdMatch?.[1] ?? null;

	const lookups = await resolveAccounts(env, "youtube", channelId);
	if (lookups.length === 0) {
		console.warn(
			`[platform-webhooks] No account found for youtube:${channelId}`,
		);
		return;
	}

	// The same channel can be connected by multiple orgs — fan-out to each.
	for (const lookup of lookups) {
		await env.INBOX_QUEUE.send({
			type: "youtube_pubsub",
			platform: "youtube",
			platform_account_id: channelId,
			organization_id: lookup.orgId,
			account_id: lookup.accountId,
			event_type: "video_update",
			payload: { video_id: videoId, raw_xml: body },
			received_at: new Date().toISOString(),
		} satisfies InboxQueueMessage);

		// Also trigger external post sync for newly published videos
		const dedupeKey = `sync-dedup:${lookup.accountId}`;
		const recent = await env.KV.get(dedupeKey);
		if (!recent) {
			await env.KV.put(dedupeKey, "1", { expirationTtl: 60 });
			await env.SYNC_QUEUE.send({
				type: "sync_posts",
				social_account_id: lookup.accountId,
				organization_id: lookup.orgId,
				platform: "youtube",
				webhook_triggered: true,
				hint: {
					event_type: "video_update",
					platform_post_id: videoId ?? undefined,
				},
			} satisfies SyncPostsMessage);
		}
	}
}

// ---------------------------------------------------------------------------
// WhatsApp Cloud API Webhooks
// ---------------------------------------------------------------------------

// GET /whatsapp — Meta webhook verification challenge (same as Facebook)
app.get("/whatsapp", async (c) => {
	const mode = c.req.query("hub.mode");
	const token = c.req.query("hub.verify_token");
	const challenge = c.req.query("hub.challenge");

	if (
		mode === "subscribe" &&
		token &&
		c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN &&
		(await safeEqual(token, c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN))
	) {
		return c.text(challenge ?? "", 200);
	}
	return c.text("Forbidden", 403);
});

// POST /whatsapp — Incoming WhatsApp message events
app.post("/whatsapp", async (c) => {
	let bodyBytes: ArrayBuffer;
	try {
		bodyBytes = await readPlatformWebhookBody(c.req.raw);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return payloadTooLargeResponse();
		}
		throw error;
	}
	const signature = c.req.header("x-hub-signature-256");
	const appSecret = c.env.FACEBOOK_APP_SECRET;

	if (
		!appSecret ||
		!(await verifyHmacSha256(bodyBytes, signature, appSecret))
	) {
		return c.json({ error: "Invalid signature" }, 403);
	}

	const body = new TextDecoder().decode(bodyBytes);
	try {
		await acceptInboundWebhook(c.env, {
			provider: "whatsapp",
			payload: body,
			contentType: c.req.header("content-type"),
		});
	} catch (error) {
		console.error(
			"[platform-webhooks] WhatsApp durable acceptance failed",
			error,
		);
		return c.json({ error: "Temporary acceptance failure" }, 503);
	}

	return c.json({ received: true }, 200);
});

interface WhatsAppWebhookBody {
	object: "whatsapp_business_account";
	entry: Array<{
		id: string;
		changes: Array<{
			field: string;
			value: {
				messaging_product: string;
				metadata: { phone_number_id: string };
				contacts?: Array<{
					profile: { name: string };
					wa_id: string;
				}>;
				messages?: Array<{
					id: string;
					from: string;
					timestamp: string;
					type: string;
					text?: { body: string };
				}>;
				statuses?: Array<{
					id: string;
					status: "sent" | "delivered" | "read" | "failed";
					timestamp: string;
					recipient_id: string;
					errors?: Array<{ code: number; title: string }>;
				}>;
			};
		}>;
	}>;
}

export async function processWhatsAppWebhook(
	body: WhatsAppWebhookBody,
	env: Env,
): Promise<void> {
	for (const entry of body.entry ?? []) {
		for (const change of entry.changes ?? []) {
			const phoneNumberId = change.value.metadata?.phone_number_id;
			if (!phoneNumberId) continue;

			const lookups = await resolveAccounts(env, "whatsapp", phoneNumberId);
			if (lookups.length === 0) {
				console.warn(
					`[platform-webhooks] No account found for whatsapp:${phoneNumberId}`,
				);
				continue;
			}

			// The same WhatsApp number can be connected by multiple orgs — fan-out.
			for (const lookup of lookups) {
				// Incoming messages
				if (change.value.messages?.length) {
					await env.INBOX_QUEUE.send({
						type: "whatsapp_webhook",
						platform: "whatsapp",
						platform_account_id: phoneNumberId,
						organization_id: lookup.orgId,
						account_id: lookup.accountId,
						event_type: "messages",
						payload: change.value,
						received_at: new Date().toISOString(),
					} satisfies InboxQueueMessage);
				}

				// Delivery/read status updates
				if (change.value.statuses?.length) {
					await env.INBOX_QUEUE.send({
						type: "whatsapp_webhook",
						platform: "whatsapp",
						platform_account_id: phoneNumberId,
						organization_id: lookup.orgId,
						account_id: lookup.accountId,
						event_type: "statuses",
						payload: change.value,
						received_at: new Date().toISOString(),
					} satisfies InboxQueueMessage);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Telegram Bot API Webhooks
// ---------------------------------------------------------------------------

// POST /telegram/:secret — Incoming Telegram updates
app.post("/telegram/:secret", async (c) => {
	const expectedSecret = c.env.TELEGRAM_WEBHOOK_SECRET;
	if (!expectedSecret) {
		console.error(
			"[platform-webhooks] Telegram webhook disabled: TELEGRAM_WEBHOOK_SECRET is not configured",
		);
		return c.json({ error: "Webhook not configured" }, 503);
	}

	// Telegram Bot API setWebhook returns the server-configured secret_token in
	// X-Telegram-Bot-Api-Secret-Token. Never compare two caller-controlled values.
	// Ref: https://core.telegram.org/bots/api#setwebhook
	const headerSecret = c.req.header("x-telegram-bot-api-secret-token");
	if (!headerSecret) {
		return c.json({ error: "Missing secret" }, 403);
	}

	const validSecret = await safeEqual(
		`${headerSecret}\0${c.req.param("secret")}`,
		`${expectedSecret}\0${expectedSecret}`,
	);
	if (!validSecret) {
		return c.json({ error: "Invalid secret" }, 403);
	}

	let bodyBytes: ArrayBuffer;
	try {
		bodyBytes = await readPlatformWebhookBody(c.req.raw);
	} catch (error) {
		if (error instanceof ResponseTooLargeError) {
			return payloadTooLargeResponse();
		}
		throw error;
	}
	const body = new TextDecoder().decode(bodyBytes);

	try {
		const update = JSON.parse(body) as TelegramUpdate;
		await acceptInboundWebhook(c.env, {
			provider: "telegram",
			payload: body,
			contentType: c.req.header("content-type"),
			deliveryId: String(update.update_id),
		});
	} catch (error) {
		console.error(
			"[platform-webhooks] Telegram durable acceptance failed",
			error,
		);
		return c.json({ error: "Temporary acceptance failure" }, 503);
	}

	return c.json({ ok: true }, 200);
});

interface TelegramUpdate {
	update_id: number;
	message?: {
		message_id: number;
		from: {
			id: number;
			first_name: string;
			last_name?: string;
			username?: string;
		};
		chat: { id: number; type: string };
		date: number;
		text?: string;
	};
	// Inline-keyboard button taps arrive as callback_query updates with NO
	// top-level `message`; the originating message is nested under
	// callback_query.message. The downstream normalizer turns these into
	// button_click events used to resume parked automations.
	callback_query?: {
		id: string;
		from: {
			id: number;
			first_name: string;
			last_name?: string;
			username?: string;
		};
		data?: string;
		message?: {
			message_id: number;
			chat: { id: number; type: string };
			date?: number;
			text?: string;
		};
	};
}

export async function processTelegramWebhook(
	body: TelegramUpdate,
	_secret: string,
	env: Env,
): Promise<void> {
	if (
		body.message &&
		(await processTelegramConnectionChallenge(env, body.message))
	) {
		return;
	}
	// Resolve the chat id from a normal message OR an inline-button callback.
	const chatId = body.message
		? String(body.message.chat.id)
		: body.callback_query?.message
			? String(body.callback_query.message.chat.id)
			: undefined;

	if (!chatId) return;

	const lookups = await resolveAccounts(env, "telegram", chatId);
	if (lookups.length === 0) {
		console.warn(`[platform-webhooks] No account found for telegram:${chatId}`);
		return;
	}

	const eventType = body.callback_query ? "callback_query" : "message";

	// The same chat can be connected by multiple orgs — fan-out to each.
	for (const lookup of lookups) {
		await env.INBOX_QUEUE.send({
			type: "telegram_webhook",
			platform: "telegram",
			platform_account_id: chatId,
			organization_id: lookup.orgId,
			account_id: lookup.accountId,
			event_type: eventType,
			payload: body,
			received_at: new Date().toISOString(),
		} satisfies InboxQueueMessage);
	}
}

// ---------------------------------------------------------------------------
// Twilio SMS/MMS Webhooks
// ---------------------------------------------------------------------------

const TWILIO_ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const MAX_TWILIO_WEBHOOK_BYTES = 256 * 1024;
const TWILIO_ROUTE_PAGE_SIZE = 100;

type TwilioWebhookAccount = {
	id: string;
	accessToken: string | null;
};

async function* findTwilioWebhookAccountPages(
	env: Env,
	accountSid: string,
): AsyncGenerator<TwilioWebhookAccount[]> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	let cursor: string | null = null;
	for (;;) {
		const accounts = await db
			.select({
				id: socialAccounts.id,
				accessToken: socialAccounts.accessToken,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.platform, "sms"),
					eq(socialAccounts.platformAccountId, accountSid),
					eq(socialAccounts.lifecycleStatus, "active"),
					...(cursor ? [gt(socialAccounts.id, cursor)] : []),
				),
			)
			.orderBy(asc(socialAccounts.id))
			.limit(TWILIO_ROUTE_PAGE_SIZE);
		if (accounts.length === 0) return;
		yield accounts;
		if (accounts.length < TWILIO_ROUTE_PAGE_SIZE) return;
		cursor = accounts.at(-1)?.id ?? null;
		if (!cursor) return;
	}
}

function parseTwilioFormBody(rawBody: string): Record<string, string> | null {
	const params: Record<string, string> = {};
	for (const [key, value] of new URLSearchParams(rawBody)) {
		// Twilio's documented validator input is a name/value map. Reject an
		// ambiguous duplicate instead of silently dropping a signed value.
		if (Object.hasOwn(params, key)) return null;
		params[key] = value;
	}
	return params;
}

async function validateTwilioFormSignature(
	authToken: string,
	signature: string,
	requestUrl: string,
	params: Record<string, string>,
): Promise<boolean> {
	let data = requestUrl;
	for (const key of Object.keys(params).sort()) data += key + params[key];

	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(authToken),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		encoder.encode(data),
	);
	const computed = btoa(String.fromCharCode(...new Uint8Array(digest)));
	return computed.length === signature.length && safeEqual(computed, signature);
}

// POST /sms — Incoming SMS/MMS from Twilio (form-encoded)
app.post("/sms", async (c) => {
	const twilioSignature = c.req.header("x-twilio-signature");
	if (!twilioSignature) {
		console.warn("[platform-webhooks] SMS: missing X-Twilio-Signature header");
		return c.text("<Response></Response>", 403, {
			"Content-Type": "text/xml",
		});
	}

	const contentType = c.req
		.header("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	if (contentType !== "application/x-www-form-urlencoded") {
		return c.text("<Response></Response>", 415, {
			"Content-Type": "text/xml",
		});
	}
	let rawBody: string;
	try {
		rawBody = await readRequestText(c.req.raw, MAX_TWILIO_WEBHOOK_BYTES);
	} catch (error) {
		const status = error instanceof ResponseTooLargeError ? 413 : 400;
		if (status === 400) {
			console.warn("[platform-webhooks] SMS: request body read failed", error);
		}
		return c.text("<Response></Response>", status, {
			"Content-Type": "text/xml",
		});
	}
	const params = parseTwilioFormBody(rawBody);
	if (!params) {
		return c.text("<Response></Response>", 400, {
			"Content-Type": "text/xml",
		});
	}
	const accountSid = params.AccountSid;
	if (!accountSid || !TWILIO_ACCOUNT_SID.test(accountSid)) {
		console.warn("[platform-webhooks] SMS: invalid or missing AccountSid");
		return c.text("<Response></Response>", 403, {
			"Content-Type": "text/xml",
		});
	}

	// Twilio signs every inbound request using HMAC-SHA1 over the exact public
	// URL plus all form parameters and the Auth Token for the AccountSid carried
	// in that signed form. In BYOC mode there is deliberately no global fallback.
	// Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
	let credentialFailure = false;
	let candidateFound = false;
	const verifiedAccountIds: string[] = [];
	try {
		for await (const candidates of findTwilioWebhookAccountPages(
			c.env,
			accountSid,
		)) {
			candidateFound = true;
			const verified = await Promise.all(
				candidates.map(async (account) => {
					try {
						const authToken = await decryptAccountToken(
							account.accessToken,
							c.env.ENCRYPTION_KEY,
							account.id,
							"access_token",
						);
						if (!authToken) {
							credentialFailure = true;
							return null;
						}
						return (await validateTwilioFormSignature(
							authToken,
							twilioSignature,
							c.req.url,
							params,
						))
							? account.id
							: null;
					} catch {
						credentialFailure = true;
						return null;
					}
				}),
			);
			verifiedAccountIds.push(
				...verified.filter((id): id is string => id !== null),
			);
		}
	} catch (error) {
		console.error("[platform-webhooks] SMS account lookup failed", error);
		return c.text("<Response></Response>", 503, {
			"Content-Type": "text/xml",
		});
	}
	if (!candidateFound) {
		console.warn("[platform-webhooks] SMS: unknown Twilio AccountSid");
		return c.text("<Response></Response>", 403, {
			"Content-Type": "text/xml",
		});
	}

	if (verifiedAccountIds.length === 0) {
		if (credentialFailure) {
			console.error(
				"[platform-webhooks] SMS: matching BYOC credential could not be loaded",
			);
			return c.text("<Response></Response>", 503, {
				"Content-Type": "text/xml",
			});
		}
		console.warn("[platform-webhooks] SMS: invalid Twilio signature");
		return c.text("<Response></Response>", 403, {
			"Content-Type": "text/xml",
		});
	}
	try {
		await acceptInboundWebhook(c.env, {
			provider: "sms",
			payload: JSON.stringify(params),
			contentType: "application/json",
			deliveryId: params.MessageSid,
			signatureMetadata: {
				twilio_account_sid: accountSid,
				verified_account_ids: verifiedAccountIds,
			},
		});
	} catch (error) {
		console.error("[platform-webhooks] SMS durable acceptance failed", error);
		return c.text("<Response></Response>", 503, { "Content-Type": "text/xml" });
	}

	// Twilio expects a TwiML response — empty response means "do nothing"
	return c.text("<Response></Response>", 200, {
		"Content-Type": "text/xml",
	});
});

export async function processSmsWebhook(
	body: Record<string, string>,
	env: Env,
	verifiedAccountIds: readonly string[],
): Promise<void> {
	const to = body.To;
	const accountSid = body.AccountSid;
	if (!to || !accountSid || verifiedAccountIds.length === 0) {
		console.warn(
			"[platform-webhooks] SMS receipt lacks an authenticated route",
		);
		return;
	}

	const db = createDb(env.HYPERDRIVE.connectionString);
	const accounts = await db
		.select({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
		})
		.from(socialAccounts)
		.where(
			and(
				inArray(socialAccounts.id, [...verifiedAccountIds]),
				eq(socialAccounts.platform, "sms"),
				eq(socialAccounts.platformAccountId, accountSid),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		);

	if (accounts.length === 0) {
		console.warn(
			"[platform-webhooks] SMS authenticated accounts are unavailable",
		);
		return;
	}

	// Fan out only to accounts whose own encrypted Auth Token verified the raw
	// request. A matching AccountSid alone is never sufficient tenant authority.
	for (const account of accounts) {
		await env.INBOX_QUEUE.send({
			type: "sms_webhook",
			platform: "sms",
			platform_account_id: accountSid,
			organization_id: account.organizationId,
			account_id: account.id,
			event_type: "message",
			payload: body,
			received_at: new Date().toISOString(),
		} satisfies InboxQueueMessage);
	}
}

/** Queue-side raw receipt dispatcher. Signature verification already happened
 * before the durable receipt was accepted; account lookup and normalization run
 * here, outside the provider acknowledgement path. */
export async function processRawPlatformWebhook(
	provider: string,
	payload: string,
	env: Env,
	signatureMetadata?: unknown,
): Promise<void> {
	switch (provider) {
		case "meta":
			return processFacebookWebhook(
				JSON.parse(payload) as MetaWebhookBody,
				env,
			);
		case "youtube":
			return processYouTubeWebhook(payload, env);
		case "whatsapp":
			return processWhatsAppWebhook(
				JSON.parse(payload) as WhatsAppWebhookBody,
				env,
			);
		case "telegram":
			return processTelegramWebhook(
				JSON.parse(payload) as TelegramUpdate,
				"",
				env,
			);
		case "sms": {
			if (
				!signatureMetadata ||
				typeof signatureMetadata !== "object" ||
				Array.isArray(signatureMetadata)
			) {
				throw new Error("SMS receipt lacks verified account routing metadata");
			}
			const verifiedAccountIds = (
				signatureMetadata as { verified_account_ids?: unknown }
			).verified_account_ids;
			if (
				!Array.isArray(verifiedAccountIds) ||
				verifiedAccountIds.length === 0 ||
				verifiedAccountIds.some(
					(accountId) =>
						typeof accountId !== "string" || accountId.length === 0,
				)
			) {
				throw new Error("SMS receipt has invalid account routing metadata");
			}
			return processSmsWebhook(
				JSON.parse(payload) as Record<string, string>,
				env,
				verifiedAccountIds as string[],
			);
		}
		default:
			throw new Error(`Unsupported raw webhook provider: ${provider}`);
	}
}

export default app;
