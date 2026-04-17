import {
	createDb,
	inboxConversations,
	inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import type { Env } from "../types";
import { upsertConversation, insertMessage } from "./inbox-persistence";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { notifyRealtime } from "../lib/notify-post-update";
import { subscribeYouTubeChannel } from "./webhook-subscription";
import { findMatchingContact } from "./contact-linker";
import {
	findWaitingEnrollment,
	matchAndEnroll,
} from "./automations/trigger-matcher";
import { resumeFromInput } from "./automations/runner";

// ---------------------------------------------------------------------------
// Normalized event structure
// ---------------------------------------------------------------------------

interface NormalizedInboxEvent {
	type: "comment" | "message";
	platform: string;
	account_id: string;
	organization_id: string;
	platform_event_id: string;
	author?: { name: string; id: string; avatar_url?: string };
	/** Conversation partner (customer) — defaults to author for inbound, set explicitly for outbound echoes */
	participant?: { name: string; id: string };
	text?: string;
	parent_id?: string;
	post_id?: string;
	conversation_id?: string;
	created_at: string;
	direction?: "inbound" | "outbound";
	raw: unknown;
}

// ---------------------------------------------------------------------------
// Main processor — called by queue consumer
// ---------------------------------------------------------------------------

export async function processInboxEvent(
	message: InboxQueueMessage,
	env: Env,
	sharedDb?: ReturnType<typeof createDb>,
): Promise<void> {
	// Handle YouTube subscription requests (not a webhook event)
	if (message.type === "youtube_subscribe") {
		const payload = message.payload as {
			callback_url: string;
		};
		const result = await subscribeYouTubeChannel(
			message.platform_account_id,
			payload.callback_url,
		);
		if (!result.success) {
			console.error(
				`[inbox-processor] YouTube subscribe failed for ${message.platform_account_id}:`,
				result.error,
			);
		}
		return;
	}

	// Handle backfill requests — dynamic import to avoid loading for every webhook event
	if (message.type === "backfill") {
		const { processBackfill } = await import("./inbox-backfill");
		await processBackfill(message, env);
		return;
	}

	// Handle WhatsApp status updates separately
	if (message.type === "whatsapp_webhook" && message.event_type === "statuses") {
		const db = sharedDb ?? createDb(env.HYPERDRIVE.connectionString);
		await processWhatsAppStatuses(message, env, db);
		return;
	}

	const events = normalizeEvent(message);

	if (events.length === 0) {
		return;
	}

	const db = sharedDb ?? createDb(env.HYPERDRIVE.connectionString);

	for (const event of events) {
		// 1. Store in DB (best-effort — webhook dispatch still happens if DB fails)
		let conversation: Awaited<ReturnType<typeof upsertConversation>> | null = null;
		let messageId: string | null = null;
		const direction = event.direction ?? "inbound";
		// Look up social account (workspace + token for enrichment)
		const [sa] = await db
			.select({
				workspaceId: socialAccounts.workspaceId,
				accessToken: socialAccounts.accessToken,
			})
			.from(socialAccounts)
			.where(eq(socialAccounts.id, event.account_id))
			.limit(1);
		try {
			// For outbound echoes (external platforms), use the participant field for the customer
			const conversationPartner = event.participant ?? event.author;

			conversation = await upsertConversation(db, {
				organizationId: event.organization_id,
				workspaceId: sa?.workspaceId ?? null,
				accountId: event.account_id,
				platform: event.platform as any,
				type: event.type === "comment" ? "comment_thread" : "dm",
				platformConversationId:
					event.post_id || event.conversation_id || event.platform_event_id,
				participantName: conversationPartner?.name ?? null,
				participantPlatformId: conversationPartner?.id ?? null,
				participantAvatar: event.author?.avatar_url ?? null,
				postPlatformId: event.post_id ?? null,
			});
			if (conversation) {
				const message = await insertMessage(db, {
					conversationId: conversation.id,
					organizationId: event.organization_id,
					platformMessageId: event.platform_event_id,
					authorName: event.author?.name ?? null,
					authorPlatformId: event.author?.id ?? null,
					authorAvatarUrl: event.author?.avatar_url ?? null,
					text: event.text ?? null,
					direction,
					createdAt: new Date(event.created_at),
				});
				messageId = message?.id ?? null;
			}
		} catch (err) {
			console.error("[inbox-processor] DB storage failed:", err);
		}

		// 1b. Instagram profile enrichment — fetch profile data for new DM conversations.
		// Note: the returned conversation row reflects the pre-insert message count, so
		// brand-new conversations have messageCount === 0 here, not 1.
		const existingParticipantMetadata =
			conversation?.participantMetadata &&
			typeof conversation.participantMetadata === "object"
				? (conversation.participantMetadata as Record<string, unknown>)
				: null;
		const existingInstagramProfile =
			existingParticipantMetadata?.instagramProfile &&
			typeof existingParticipantMetadata.instagramProfile === "object"
				? (existingParticipantMetadata.instagramProfile as Record<string, unknown>)
				: null;

		if (
			direction === "inbound" &&
			conversation &&
			conversation.messageCount <= 1 &&
			!existingInstagramProfile?.username &&
			event.platform === "instagram" &&
			event.type === "message" &&
			event.author?.id
		) {
			try {
				if (sa?.accessToken) {
					const token = await maybeDecrypt(sa.accessToken, env.ENCRYPTION_KEY);
					if (!token) throw new Error("Failed to decrypt access token");
					// Docs: https://developers.facebook.com/docs/instagram-api/reference/ig-user
						const profileHost = token.startsWith("IGAA") ? "graph.instagram.com" : "graph.facebook.com";
						const profileAbort = new AbortController();
						const profileTimer = setTimeout(() => profileAbort.abort(), 5_000);
						const profileRes = await fetch(
							`https://${profileHost}/v25.0/${event.author.id}?fields=username,followers_count,media_count&access_token=${encodeURIComponent(token)}`,
							{ signal: profileAbort.signal },
						);
						clearTimeout(profileTimer);
						if (profileRes.ok) {
							const profile = (await profileRes.json()) as {
								username?: string;
								followers_count?: number;
								media_count?: number;
							};
							await db
								.update(inboxConversations)
								.set({
									participantName:
										profile.username ?? conversation.participantName,
									participantMetadata: {
										...(existingParticipantMetadata ?? {}),
										instagramProfile: {
											...(existingInstagramProfile ?? {}),
											scopedId: event.author.id,
											username: profile.username ?? null,
											followersCount: profile.followers_count ?? null,
											mediaCount: profile.media_count ?? null,
											fetchedAt: new Date().toISOString(),
										},
									},
								})
								.where(
									and(
										eq(inboxConversations.id, conversation.id),
										eq(inboxConversations.organizationId, event.organization_id),
									),
								);
						}
					}
				} catch (err) {
					console.error("[inbox-processor] IG profile enrichment failed:", err);
				}
		}

		// 2. Hand off inbound events to the unified automations engine. Outbound
		// echoes never trigger automations. Contact resolution mirrors the inbox
		// participant auto-linker so conditions / merge-tags see a real contact.
		if (direction === "inbound") {
			await dispatchAutomationMatch(event, db, env);
		}

		// 3. Dispatch outbound webhook
		const webhookEvent =
			event.type === "comment" ? "comment.received"
			: direction === "outbound" ? "message.sent"
			: "message.received";
		await dispatchWebhookEvent(env, db, event.organization_id, webhookEvent, {
			id: event.platform_event_id,
			type: event.type,
			platform: event.platform,
			account_id: event.account_id,
			author: event.author,
			text: event.text,
			post_id: event.post_id,
			conversation_id: event.conversation_id,
			parent_id: event.parent_id,
			created_at: event.created_at,
		});

		// 4. Push real-time update to connected dashboard clients
		const realtimeEvent = event.type === "comment"
			? { type: "inbox.comment.received" as const, post_id: event.post_id, platform: event.platform }
			: direction === "outbound"
			? { type: "inbox.message.sent" as const, conversation_id: conversation?.id ?? event.conversation_id, platform: event.platform }
			: { type: "inbox.message.received" as const, conversation_id: conversation?.id ?? event.conversation_id, platform: event.platform };
		await notifyRealtime(env, event.organization_id, realtimeEvent).catch((err) => {
			console.error("[inbox-processor] notifyRealtime failed:", err);
		});
	}
}

// ---------------------------------------------------------------------------
// Automations bridge
// ---------------------------------------------------------------------------

/**
 * Derives the automation trigger_type from the inbox event. Returns null if
 * the platform doesn't surface inbound-event triggers today (e.g. YouTube
 * PubSub events that don't map to message/comment semantics).
 *
 * The inbox normalizer currently produces only `"comment" | "message"`. Richer
 * trigger types (mention, story_reply, reaction, button_click, command) require
 * expanding the normalizer first; those paths stay on the stub for now.
 */
function deriveTriggerType(
	platform: string,
	type: NormalizedInboxEvent["type"],
): string | null {
	if (type === "comment") {
		// instagram_comment, facebook_comment, youtube_comment, reddit_comment,
		// linkedin_comment all follow `<platform>_comment`.
		return `${platform}_comment`;
	}
	switch (platform) {
		case "instagram":
		case "facebook":
		case "discord":
		case "twitter":
		case "bluesky":
			return `${platform}_dm`;
		case "whatsapp":
		case "telegram":
			return `${platform}_message`;
		case "sms":
			return "sms_received";
		case "reddit":
			return "reddit_dm";
		case "mastodon":
			// Mastodon "DMs" are mentions with direct visibility.
			return "mastodon_mention";
		case "threads":
			return "threads_reply";
		default:
			return null;
	}
}

/**
 * Matches the inbound event against active automations and enrols candidates.
 * Waiting enrollments (`user_input` nodes pending) take precedence — inbound
 * text is fed back into the paused flow instead of starting a fresh one.
 *
 * Best-effort: automation failures never block inbox processing.
 */
async function dispatchAutomationMatch(
	event: NormalizedInboxEvent,
	db: ReturnType<typeof createDb>,
	env: Env,
): Promise<void> {
	try {
		const triggerType = deriveTriggerType(event.platform, event.type);
		if (!triggerType) return;

		const authorId = event.author?.id ?? event.participant?.id ?? null;
		let contactId: string | null = null;
		if (authorId) {
			const match = await findMatchingContact(
				db,
				event.organization_id,
				event.account_id,
				authorId,
				event.author?.name ?? null,
			);
			// Only act on exact / phone / email matches. Name-only suggestions
			// are too loose to trigger automation enrollments silently.
			if (match && match.confidence !== "name_suggestion") {
				contactId = match.contactId;
			}
		}

		// Resume a waiting user_input flow before firing new triggers.
		//
		// Only inbound MESSAGES should satisfy a user_input wait — a comment
		// on a post must never be captured as input to a DM flow. The waiting
		// enrollment's recorded channel / conversation also has to match, so
		// a message on platform B doesn't resume a flow paused on platform A
		// for the same contact.
		if (contactId && event.type === "message") {
			const pending = await findWaitingEnrollment(env, {
				organization_id: event.organization_id,
				contact_id: contactId,
				channel: event.platform,
				conversation_id: event.conversation_id ?? null,
			});
			if (pending) {
				await resumeFromInput(env, pending, event.text ?? "");
				return;
			}
		}

		await matchAndEnroll(env, {
			organization_id: event.organization_id,
			platform: event.platform,
			trigger_type: triggerType,
			account_id: event.account_id,
			contact_id: contactId,
			conversation_id: event.conversation_id ?? null,
			payload: {
				text: event.text ?? "",
				post_id: event.post_id,
				parent_id: event.parent_id,
				comment_id: event.type === "comment" ? event.platform_event_id : undefined,
				message_id:
					event.type === "message" ? event.platform_event_id : undefined,
				author: event.author,
				created_at: event.created_at,
			},
		});
	} catch (err) {
		console.error("[inbox-processor] automation dispatch failed:", err);
	}
}

// ---------------------------------------------------------------------------
// Platform-specific normalizers
// ---------------------------------------------------------------------------

function normalizeEvent(message: InboxQueueMessage): NormalizedInboxEvent[] {
	switch (message.type) {
		case "facebook_webhook":
			return normalizeFacebookEvent(message);
		case "instagram_webhook":
			return normalizeInstagramEvent(message);
		case "youtube_pubsub":
			return normalizeYouTubeEvent(message);
		case "whatsapp_webhook":
			return normalizeWhatsAppEvent(message);
		case "telegram_webhook":
			return normalizeTelegramEvent(message);
		case "sms_webhook":
			return normalizeSmsEvent(message);
		default:
			return [];
	}
}

// --- Facebook ---

interface FacebookFeedValue {
	item: string; // "comment", "post", "photo", etc.
	verb: string; // "add", "edited", "remove"
	comment_id?: string;
	post_id?: string;
	parent_id?: string;
	message?: string;
	from?: { id: string; name: string };
	created_time?: number;
}

interface FacebookMessagingPayload {
	sender: { id: string };
	recipient: { id: string };
	timestamp: number;
	message?: { mid: string; text?: string };
	postback?: { title: string; payload: string };
}

function normalizeFacebookEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	const { event_type, payload } = message;
	const now = new Date().toISOString();

	// Feed changes (comments on posts)
	if (event_type === "feed") {
		const value = payload as FacebookFeedValue;
		if (value.item === "comment" && value.verb === "add" && value.comment_id) {
			return [
				{
					type: "comment",
					platform: "facebook",
					account_id: message.account_id,
					organization_id: message.organization_id,
					platform_event_id: value.comment_id,
					author: value.from
						? { name: value.from.name, id: value.from.id }
						: undefined,
					text: value.message,
					post_id: value.post_id,
					parent_id: value.parent_id,
					created_at: value.created_time
						? new Date(value.created_time * 1000).toISOString()
						: now,
					raw: payload,
				},
			];
		}
		return [];
	}

	// Messenger events (DMs) — same echo handling as Instagram
	if (event_type === "messages") {
		const msg = payload as FacebookMessagingPayload;
		const isEcho = !!(msg.message as any)?.is_echo || msg.sender.id === message.platform_account_id;
		if (isEcho) return [];
		const text = msg.message?.text ?? msg.postback?.title;
		const eventId = msg.message?.mid ?? `postback_${msg.timestamp}`;
		const customerId = msg.sender.id;

		return [
			{
				type: "message",
				platform: "facebook",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: eventId,
				conversation_id: customerId,
				author: { name: customerId, id: customerId },
				text,
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
			},
		];
	}

	// External echo — message sent via another platform (e.g. Respond.io), not RelayAPI
	if (event_type === "echo_messages") {
		const msg = payload as FacebookMessagingPayload;
		const text = msg.message?.text ?? msg.postback?.title;
		const eventId = msg.message?.mid ?? `postback_${msg.timestamp}`;
		const customerId = msg.recipient.id;

		return [
			{
				type: "message",
				platform: "facebook",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: eventId,
				conversation_id: customerId,
				author: { name: "You", id: msg.sender.id },
				participant: { name: customerId, id: customerId },
				text,
				created_at: new Date(msg.timestamp).toISOString(),
				direction: "outbound",
				raw: payload,
			},
		];
	}

	return [];
}

// --- Instagram ---

interface InstagramCommentValue {
	id?: string;
	text?: string;
	from?: { id: string; username?: string };
	media?: { id: string };
}

function normalizeInstagramEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	const { event_type, payload } = message;
	const now = new Date().toISOString();

	// Comment on media
	if (event_type === "comments") {
		const value = payload as InstagramCommentValue;
		if (!value.id) return [];
		return [
			{
				type: "comment",
				platform: "instagram",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: value.id,
				author: value.from
					? {
							name: value.from.username ?? value.from.id,
							id: value.from.id,
						}
					: undefined,
				text: value.text,
				post_id: value.media?.id,
				created_at: now,
				raw: payload,
			},
		];
	}

	// Instagram DMs (arrives via messaging[] array)
	// Pattern from Chatwoot: echo messages have sender/recipient swapped.
	// For echoes: sender = business, recipient = customer.
	// For inbound: sender = customer, recipient = business.
	// Always use the CUSTOMER's ID as conversation_id.
	if (event_type === "messages") {
		const msg = payload as FacebookMessagingPayload;
		const isEcho = !!(msg.message as any)?.is_echo || msg.sender.id === message.platform_account_id;
		// Skip echoes — outbound messages are already stored by the sendMessage handler
		if (isEcho) return [];
		const text = msg.message?.text ?? msg.postback?.title;
		const eventId = msg.message?.mid ?? `postback_${msg.timestamp}`;
		// Conversation partner is always the customer (sender for inbound)
		const customerId = msg.sender.id;

		return [
			{
				type: "message",
				platform: "instagram",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: eventId,
				conversation_id: customerId,
				author: { name: customerId, id: customerId },
				text,
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
			},
		];
	}

	// External echo — message sent via another platform (e.g. Respond.io), not RelayAPI
	// For echoes: sender = business, recipient = customer
	if (event_type === "echo_messages") {
		const msg = payload as FacebookMessagingPayload;
		const text = msg.message?.text ?? msg.postback?.title;
		const eventId = msg.message?.mid ?? `postback_${msg.timestamp}`;
		const customerId = msg.recipient.id;

		return [
			{
				type: "message",
				platform: "instagram",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: eventId,
				conversation_id: customerId,
				author: { name: "You", id: msg.sender.id },
				participant: { name: customerId, id: customerId },
				text,
				created_at: new Date(msg.timestamp).toISOString(),
				direction: "outbound",
				raw: payload,
			},
		];
	}

	return [];
}

// --- YouTube ---

function normalizeYouTubeEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	// YouTube PubSub only delivers video upload/update notifications,
	// not comments. Log for now — Phase 2 will use this to trigger
	// comment backfill for new videos.
	console.log(
		`[inbox-processor] YouTube event for ${message.platform_account_id}:`,
		JSON.stringify(message.payload).slice(0, 200),
	);
	return [];
}

// --- WhatsApp ---

interface WhatsAppWebhookValue {
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
		image?: { id: string; mime_type: string; sha256: string; caption?: string };
		video?: { id: string; mime_type: string; sha256: string; caption?: string };
		document?: { id: string; filename: string; mime_type: string; sha256: string; caption?: string };
		audio?: { id: string; mime_type: string; sha256: string };
		sticker?: { id: string; mime_type: string; sha256: string };
		location?: { latitude: number; longitude: number; name?: string; address?: string };
		contacts?: Array<{ name: { formatted_name: string }; phones?: Array<{ phone: string }> }>;
		interactive?: { type: string; [key: string]: unknown };
		button?: { text: string; payload: string };
		reaction?: { message_id: string; emoji: string };
	}>;
	statuses?: Array<{
		id: string;
		status: "sent" | "delivered" | "read" | "failed";
		timestamp: string;
		recipient_id: string;
		errors?: Array<{ code: number; title: string }>;
	}>;
}

type WhatsAppMessage = NonNullable<WhatsAppWebhookValue["messages"]>[number];

function extractWhatsAppMessageText(msg: WhatsAppMessage): string | undefined {
	switch (msg.type) {
		case "text":
			return msg.text?.body;
		case "image":
			return msg.image?.caption || "[Image]";
		case "video":
			return msg.video?.caption || "[Video]";
		case "document":
			return msg.document?.caption || `[Document: ${msg.document?.filename ?? "file"}]`;
		case "audio":
			return "[Audio message]";
		case "sticker":
			return "[Sticker]";
		case "location":
			return msg.location?.name
				? `[Location: ${msg.location.name}]`
				: `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
		case "contacts":
			return `[Contact: ${msg.contacts?.[0]?.name?.formatted_name ?? "Unknown"}]`;
		case "interactive":
			return `[Interactive: ${msg.interactive?.type ?? "message"}]`;
		case "button":
			return msg.button?.text ?? "[Button response]";
		case "reaction":
			return msg.reaction?.emoji ? `Reacted with ${msg.reaction.emoji}` : "[Reaction]";
		default:
			return `[${msg.type}]`;
	}
}

function normalizeWhatsAppEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	const value = message.payload as WhatsAppWebhookValue;
	const events: NormalizedInboxEvent[] = [];

	if (!value.messages?.length) return events;

	const contact = value.contacts?.[0];

	for (const msg of value.messages) {
		events.push({
			type: "message",
			platform: "whatsapp",
			account_id: message.account_id,
			organization_id: message.organization_id,
			platform_event_id: msg.id,
			author: {
				name: contact?.profile?.name ?? msg.from,
				id: msg.from,
			},
			text: extractWhatsAppMessageText(msg),
			conversation_id: msg.from,
			created_at: new Date(Number(msg.timestamp) * 1000).toISOString(),
			raw: message.payload,
		});
	}

	return events;
}

async function processWhatsAppStatuses(
	message: InboxQueueMessage,
	env: Env,
	db: ReturnType<typeof createDb>,
): Promise<void> {
	const value = message.payload as WhatsAppWebhookValue;
	if (!value.statuses?.length) return;

	for (const status of value.statuses) {
		// Update the outbound message's platformData with the latest status
		const [updated] = await db
			.update(inboxMessages)
			.set({
				platformData: sql`jsonb_set(
					COALESCE(${inboxMessages.platformData}, '{}'::jsonb),
					'{wa_status}',
					${JSON.stringify({ status: status.status, timestamp: status.timestamp })}::jsonb
				)`,
			})
			.where(eq(inboxMessages.platformMessageId, status.id))
			.returning({ id: inboxMessages.id, conversationId: inboxMessages.conversationId });

		if (updated) {
			// Dispatch webhook event
			await dispatchWebhookEvent(
				env,
				db,
				message.organization_id,
				"message.status_updated",
				{
					message_id: status.id,
					status: status.status,
					recipient: status.recipient_id,
					timestamp: status.timestamp,
					errors: status.errors,
				},
			);
		}
	}
}

// --- Telegram ---

interface TelegramUpdatePayload {
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

function normalizeTelegramEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	const payload = message.payload as TelegramUpdatePayload;

	if (!payload.message) return [];

	const tgMsg = payload.message;
	const authorName = [tgMsg.from.first_name, tgMsg.from.last_name]
		.filter(Boolean)
		.join(" ");

	return [
		{
			type: "message",
			platform: "telegram",
			account_id: message.account_id,
			organization_id: message.organization_id,
			platform_event_id: String(tgMsg.message_id),
			author: {
				name: authorName,
				id: String(tgMsg.from.id),
			},
			text: tgMsg.text,
			conversation_id: String(tgMsg.chat.id),
			created_at: new Date(tgMsg.date * 1000).toISOString(),
			raw: message.payload,
		},
	];
}

// --- SMS (Twilio) ---

interface TwilioSmsPayload {
	From: string;
	To: string;
	Body: string;
	MessageSid: string;
	NumMedia?: string;
	[key: string]: string | undefined;
}

function normalizeSmsEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	const payload = message.payload as TwilioSmsPayload;

	if (!payload.MessageSid) return [];

	return [
		{
			type: "message",
			platform: "sms",
			account_id: message.account_id,
			organization_id: message.organization_id,
			platform_event_id: payload.MessageSid,
			author: {
				name: payload.From,
				id: payload.From,
			},
			text: payload.Body,
			conversation_id: payload.From,
			created_at: new Date().toISOString(),
			raw: message.payload,
		},
	];
}
