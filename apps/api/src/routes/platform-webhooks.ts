import { createDb, socialAccounts, inboxMessages, inboxConversations } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Env } from "../types";
import type { SyncPostsMessage } from "../services/external-post-sync/types";

const app = new Hono<{ Bindings: Env }>();

/** Constant-time string comparison via HMAC to prevent timing and length-oracle attacks */
async function safeEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw", enc.encode("relay-cmp"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const [sigA, sigB] = await Promise.all([
		crypto.subtle.sign("HMAC", key, enc.encode(a)),
		crypto.subtle.sign("HMAC", key, enc.encode(b)),
	]);
	const a8 = new Uint8Array(sigA);
	const b8 = new Uint8Array(sigB);
	let mismatch = 0;
	for (let i = 0; i < a8.length; i++) {
		mismatch |= a8[i]! ^ b8[i]!;
	}
	return mismatch === 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboxQueueMessage {
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

// ---------------------------------------------------------------------------
// HMAC-SHA256 signature verification (Workers-compatible)
// ---------------------------------------------------------------------------

async function verifyHmacSha256(
	body: string,
	signature: string | undefined,
	secret: string,
): Promise<boolean> {
	if (!signature || !signature.startsWith("sha256=")) return false;
	const expected = signature.slice(7);
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
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
}

async function resolveAccount(
	env: Env,
	platform: string,
	platformAccountId: string,
): Promise<AccountLookup | null> {
	const kvKey = `platform-account:${platform}:${platformAccountId}`;
	const cached = await env.KV.get<AccountLookup>(kvKey, "json");
	if (cached) return cached;

	const db = createDb(env.HYPERDRIVE.connectionString);
	const [account] = await db
		.select({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.platform, platform as any),
				eq(socialAccounts.platformAccountId, platformAccountId),
			),
		)
		.limit(1);

	// Instagram webhooks use the IGBA ID as entry.id, which differs from both
	// platformAccountId (user_id) and webhookAccountId (IGUID) stored during
	// connection. Try webhookAccountId first, then auto-link if unambiguous.
	if (!account && platform === "instagram") {
		// 1. Check webhookAccountId (uses social_accounts_webhook_id_idx index)
		const [byWebhook] = await db
			.select({
				id: socialAccounts.id,
				organizationId: socialAccounts.organizationId,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.platform, "instagram"),
					eq(socialAccounts.webhookAccountId, platformAccountId),
				),
			)
			.limit(1);

		if (byWebhook) {
			const result: AccountLookup = {
				orgId: byWebhook.organizationId,
				accountId: byWebhook.id,
			};
			await env.KV.put(kvKey, JSON.stringify(result), { expirationTtl: 300 });
			return result;
		}

		console.warn("[platform-webhooks] Instagram webhook account could not be resolved safely", {
			webhookEntryId: platformAccountId,
		});
	}

	if (!account) return null;

	const result: AccountLookup = {
		orgId: account.organizationId,
		accountId: account.id,
	};
	await env.KV.put(kvKey, JSON.stringify(result), { expirationTtl: 300 });
	return result;
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
		c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN && await safeEqual(token, c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN)
	) {
		return c.text(challenge ?? "", 200);
	}
	return c.text("Forbidden", 403);
});

// POST /facebook — Facebook & Instagram event ingestion
app.post("/facebook", async (c) => {
	const body = await c.req.text();
	const signature = c.req.header("x-hub-signature-256");
	const appSecret = c.env.FACEBOOK_APP_SECRET;

	console.log("[platform-webhooks] Facebook/IG webhook received", {
		hasSignature: !!signature,
		contentLength: body.length,
	});

	let valid = appSecret
		? await verifyHmacSha256(body, signature, appSecret)
		: false;
	let signedByFacebookApp = valid;

	// Instagram Login app may use a different secret than the main Facebook app
	if (!valid && c.env.INSTAGRAM_LOGIN_APP_SECRET) {
		valid = await verifyHmacSha256(body, signature, c.env.INSTAGRAM_LOGIN_APP_SECRET);
		signedByFacebookApp = false;
	}

	if (!valid) {
		console.warn("[platform-webhooks] Facebook/IG webhook signature invalid");
		return c.json({ error: "Invalid signature" }, 403);
	}

	// Respond immediately — Meta requires a response within 5 seconds
	const ctx = c.executionCtx;
	const parsed = JSON.parse(body) as MetaWebhookBody;

	// Skip Instagram webhooks from the Facebook app — they use different ISGIDs
	// and create duplicate conversations. Only process Instagram events from the
	// Instagram Login app to ensure consistent user IDs.
	if (signedByFacebookApp && (parsed.object === "instagram" || parsed.object === "user")) {
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
	ctx.waitUntil(processFacebookWebhook(parsed, c.env));

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

async function processFacebookWebhook(
	body: MetaWebhookBody,
	env: Env,
): Promise<void> {
	// "instagram" = Messenger Platform messaging, "user" = Instagram Login changes (comments, mentions)
	const platform = body.object === "instagram" || body.object === "user" ? "instagram" : "facebook";
	const db = createDb(env.HYPERDRIVE.connectionString);

	for (const entry of body.entry ?? []) {
		const lookup = await resolveAccount(env, platform, entry.id);
		if (!lookup) {
			console.warn(
				`[platform-webhooks] No account found for ${platform}:${entry.id}`,
			);
			continue;
		}

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
								(change.value as any)?.post_id ?? undefined,
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
		const knownBusinessIds = new Set<string>([entry.id]);
		{
			const [acct] = await db
				.select({ pid: socialAccounts.platformAccountId, wid: socialAccounts.webhookAccountId })
				.from(socialAccounts)
				.where(eq(socialAccounts.id, lookup.accountId))
				.limit(1);
			if (acct?.pid) knownBusinessIds.add(acct.pid);
			if (acct?.wid) knownBusinessIds.add(acct.wid);
		}

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
			if ((msg.message as any)?.is_echo) {
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
			const hasReferral = Boolean(
				(asAny as { referral?: unknown }).referral,
			);
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
			const isEcho = !!(msg.message as any)?.is_echo;
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
					await env.KV.put(`ig-sender-id:${lookup.accountId}`, msg.sender.id, { expirationTtl: 86400 * 30 });
				}

				if (mid) {
					// Check if this echo was sent by RelayAPI — already stored
					const isOurMessage = await env.KV.get(`outbound-mid:${mid}`);
					if (isOurMessage) {
						await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
						continue;
					}

					// Check DB — RelayAPI stores outbound messages before the echo arrives
					const [existingMsg] = await db
						.select({ id: inboxMessages.id })
						.from(inboxMessages)
						.where(eq(inboxMessages.platformMessageId, mid))
						.limit(1);
					if (existingMsg) {
						await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
						continue;
					}

					// Deduplicate — prevent processing same echo twice
					if (await env.KV.get(`msg-dedup:${mid}`)) continue;
					await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
				}

				// Echo NOT from RelayAPI — sent via another platform (e.g. Respond.io)
				// Enqueue as external echo to store as outbound message
				console.log("[platform-webhooks] External echo detected, storing as outbound", {
					mid,
					senderId: msg.sender.id,
					platform,
				});
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
				continue;
			}

			if (mid) {
				// Layer 2: KV outbound-mid (fast, eventually consistent)
				if (await env.KV.get(`outbound-mid:${mid}`)) {
					await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
					continue;
				}

				// Layer 3: DB mid match (strongly consistent, indexed)
				const [existingMsg] = await db
					.select({ id: inboxMessages.id })
					.from(inboxMessages)
					.where(eq(inboxMessages.platformMessageId, mid))
					.limit(1);
				if (existingMsg) {
					await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
					continue;
				}

				// Layer 4: Recent outbound text match — catches the Page subscription
				// duplicate which arrives with a different mid and no is_echo.
				// Uses a tight 15s window to minimize false positives.
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
								eq(inboxMessages.direction, "outbound"),
								eq(inboxMessages.text, msgText),
								sql`${inboxMessages.createdAt} > NOW() - INTERVAL '15 seconds'`,
							),
						)
						.limit(1);
					if (recentOutbound) {
						console.log("[platform-webhooks] Echo skipped (cross-subscription dedup)", { mid, senderId: msg.sender.id });
						await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
						continue;
					}
				}

				// Deduplicate by message ID — prevents processing same DM twice
				if (await env.KV.get(`msg-dedup:${mid}`)) continue;
				await env.KV.put(`msg-dedup:${mid}`, "1", { expirationTtl: 300 });
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
	const body = await c.req.text();
	const signature = c.req.header("x-hub-signature");

	// Verify HMAC signature if a hub secret is configured
	// PubSubHubbub sends X-Hub-Signature: sha1=<hex> when subscribed with a hub.secret
	// Ref: https://www.w3.org/TR/websub/#x-hub-signature
	const youtubeHubSecret = c.env.YOUTUBE_HUB_SECRET;
	if (youtubeHubSecret) {
		if (!signature) {
			console.warn("[platform-webhooks] YouTube: missing X-Hub-Signature header");
			return c.text("Missing signature", 403);
		}
		const algo = signature.startsWith("sha256=") ? "SHA-256" : "SHA-1";
		const expectedHex = signature.includes("=") ? signature.split("=").slice(1).join("=") : "";
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(youtubeHubSecret),
			{ name: "HMAC", hash: algo },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
		const computed = Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		if (computed.length !== expectedHex.length || !(await safeEqual(computed, expectedHex))) {
			console.warn("[platform-webhooks] YouTube: invalid X-Hub-Signature");
			return c.text("Invalid signature", 403);
		}
	}

	// Respond immediately
	const ctx = c.executionCtx;
	ctx.waitUntil(processYouTubeWebhook(body, c.env));

	return c.text("OK", 200);
});

async function processYouTubeWebhook(
	body: string,
	env: Env,
): Promise<void> {
	// YouTube PubSub sends Atom XML — parse with regex (no DOMParser on Workers)
	const videoIdMatch = body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
	const channelIdMatch = body.match(
		/<yt:channelId>([^<]+)<\/yt:channelId>/,
	);

	if (!channelIdMatch?.[1]) {
		console.warn("[platform-webhooks] YouTube: no channelId in payload");
		return;
	}

	const channelId = channelIdMatch[1];
	const videoId = videoIdMatch?.[1] ?? null;

	const lookup = await resolveAccount(env, "youtube", channelId);
	if (!lookup) {
		console.warn(
			`[platform-webhooks] No account found for youtube:${channelId}`,
		);
		return;
	}

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
		c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN && await safeEqual(token, c.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN)
	) {
		return c.text(challenge ?? "", 200);
	}
	return c.text("Forbidden", 403);
});

// POST /whatsapp — Incoming WhatsApp message events
app.post("/whatsapp", async (c) => {
	const body = await c.req.text();
	const signature = c.req.header("x-hub-signature-256");
	const appSecret = c.env.FACEBOOK_APP_SECRET;

	if (
		!appSecret ||
		!(await verifyHmacSha256(body, signature, appSecret))
	) {
		return c.json({ error: "Invalid signature" }, 403);
	}

	// Respond immediately — Meta requires a response within 5 seconds
	const ctx = c.executionCtx;
	ctx.waitUntil(processWhatsAppWebhook(JSON.parse(body), c.env));

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

async function processWhatsAppWebhook(
	body: WhatsAppWebhookBody,
	env: Env,
): Promise<void> {
	for (const entry of body.entry ?? []) {
		for (const change of entry.changes ?? []) {
			const phoneNumberId = change.value.metadata?.phone_number_id;
			if (!phoneNumberId) continue;

			const lookup = await resolveAccount(env, "whatsapp", phoneNumberId);
			if (!lookup) {
				console.warn(
					`[platform-webhooks] No account found for whatsapp:${phoneNumberId}`,
				);
				continue;
			}

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

// ---------------------------------------------------------------------------
// Telegram Bot API Webhooks
// ---------------------------------------------------------------------------

// POST /telegram/:secret — Incoming Telegram updates
app.post("/telegram/:secret", async (c) => {
	const secret = c.req.param("secret");

	// Verify the secret_token header matches the URL secret (Telegram Bot API sends this
	// when webhooks are registered with a secret_token parameter)
	const headerSecret = c.req.header("x-telegram-bot-api-secret-token");
	if (headerSecret) {
		if (!(await safeEqual(headerSecret, secret))) {
			return c.json({ error: "Invalid secret" }, 403);
		}
	} else if (!c.env.TELEGRAM_BOT_TOKEN) {
		// No header and no bot token to verify against — reject unverified requests
		return c.json({ error: "Webhook verification not configured" }, 403);
	} else {
		// Verify the URL secret matches a hash derived from the bot token
		// This ensures only Telegram (which knows the registered URL) can call this endpoint
		const encoder = new TextEncoder();
		const tokenHash = await crypto.subtle.digest("SHA-256", encoder.encode(c.env.TELEGRAM_BOT_TOKEN));
		const expectedSecret = Array.from(new Uint8Array(tokenHash).slice(0, 16))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		if (!(await safeEqual(secret, expectedSecret))) {
			return c.json({ error: "Invalid secret" }, 403);
		}
	}

	const body = await c.req.text();

	// Respond immediately
	const ctx = c.executionCtx;
	ctx.waitUntil(processTelegramWebhook(JSON.parse(body), secret, c.env));

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
}

async function processTelegramWebhook(
	body: TelegramUpdate,
	secret: string,
	env: Env,
): Promise<void> {
	if (!body.message) return;

	const chatId = String(body.message.chat.id);
	const lookup = await resolveAccount(env, "telegram", chatId);
	if (!lookup) {
		console.warn(
			`[platform-webhooks] No account found for telegram:${chatId}`,
		);
		return;
	}

	await env.INBOX_QUEUE.send({
		type: "telegram_webhook",
		platform: "telegram",
		platform_account_id: chatId,
		organization_id: lookup.orgId,
		account_id: lookup.accountId,
		event_type: "message",
		payload: body,
		received_at: new Date().toISOString(),
	} satisfies InboxQueueMessage);
}

// ---------------------------------------------------------------------------
// Twilio SMS/MMS Webhooks
// ---------------------------------------------------------------------------

// POST /sms — Incoming SMS/MMS from Twilio (form-encoded)
app.post("/sms", async (c) => {
	const body = await c.req.parseBody();
	const params = Object.fromEntries(
		Object.entries(body).filter((e): e is [string, string] => typeof e[1] === "string"),
	);

	// Verify Twilio HMAC-SHA1 signature when auth token is configured
	// Docs: https://www.twilio.com/docs/usage/webhooks/webhooks-security
	if (c.env.TWILIO_AUTH_TOKEN) {
		const twilioSignature = c.req.header("x-twilio-signature");
		if (!twilioSignature) {
			console.warn("[platform-webhooks] SMS: missing X-Twilio-Signature header");
			return c.text("<Response></Response>", 403, { "Content-Type": "text/xml" });
		}

		// Build the data string: URL + sorted POST params (key+value concatenated)
		// Use the public-facing URL (force https) since Twilio calls the public endpoint
		const requestUrl = c.req.url.replace(/^http:/, "https:");
		let data = requestUrl;
		for (const key of Object.keys(params).sort()) {
			data += key + params[key];
		}

		// HMAC-SHA1 with Twilio Auth Token, then base64-encode
		const encoder = new TextEncoder();
		const cryptoKey = await crypto.subtle.importKey(
			"raw",
			encoder.encode(c.env.TWILIO_AUTH_TOKEN),
			{ name: "HMAC", hash: "SHA-1" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
		const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));

		// Constant-time comparison
		if (computed.length !== twilioSignature.length || !(await safeEqual(computed, twilioSignature))) {
			console.warn("[platform-webhooks] SMS: invalid Twilio signature");
			return c.text("<Response></Response>", 403, { "Content-Type": "text/xml" });
		}
	}

	// Respond immediately
	const ctx = c.executionCtx;
	ctx.waitUntil(processSmsWebhook(params, c.env));

	// Twilio expects a TwiML response — empty response means "do nothing"
	return c.text("<Response></Response>", 200, {
		"Content-Type": "text/xml",
	});
});

async function processSmsWebhook(
	body: Record<string, string>,
	env: Env,
): Promise<void> {
	const to = body.To;
	if (!to) {
		console.warn("[platform-webhooks] SMS webhook missing To field");
		return;
	}

	// Normalize phone number — strip leading '+' for lookup consistency
	const normalizedTo = to.startsWith("+") ? to.slice(1) : to;
	const lookup =
		(await resolveAccount(env, "sms", to)) ??
		(await resolveAccount(env, "sms", normalizedTo));

	if (!lookup) {
		console.warn(
			`[platform-webhooks] No account found for sms:${to}`,
		);
		return;
	}

	await env.INBOX_QUEUE.send({
		type: "sms_webhook",
		platform: "sms",
		platform_account_id: to,
		organization_id: lookup.orgId,
		account_id: lookup.accountId,
		event_type: "message",
		payload: body,
		received_at: new Date().toISOString(),
	} satisfies InboxQueueMessage);
}

export default app;
