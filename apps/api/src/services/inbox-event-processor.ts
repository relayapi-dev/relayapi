import {
	createDb,
	inboxConversations,
	inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import { maybeDecrypt } from "../lib/crypto";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import type { Env } from "../types";
import { upsertConversation, insertMessage } from "./inbox-persistence";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { notifyRealtime } from "../lib/notify-post-update";
import { subscribeYouTubeChannel } from "./webhook-subscription";
import { ensureContactForAuthor } from "./contact-linker";
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
	participant?: { name: string; id: string; avatar_url?: string };
	text?: string;
	/**
	 * Structured file payload for inbound media messages (WhatsApp image/video/
	 * document/audio, Telegram photo/document, Twilio MMS, etc.). Used by the
	 * automation bridge to satisfy `user_input_file` waits — the validator reads
	 * mime_type/size_bytes to enforce `accepted_mime_types` / `max_size_mb`, and
	 * the value that lands in `state.<save_to_field>` is this attachment object.
	 * `id` is a platform-native media reference (e.g. WhatsApp media id,
	 * Telegram file_id). `url` is populated when the platform returns a direct
	 * download URL (e.g. Twilio MMS `MediaUrlN`).
	 */
	attachment?: {
		id?: string;
		url?: string;
		filename?: string;
		mime_type?: string;
		size_bytes?: number;
	};
	parent_id?: string;
	post_id?: string;
	conversation_id?: string;
	created_at: string;
	direction?: "inbound" | "outbound";
	raw: unknown;
}

type ParticipantMetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): ParticipantMetadataRecord | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as ParticipantMetadataRecord)
		: null;
}

function isMissingParticipantIdentity(
	name: string | null | undefined,
	participantId: string | null | undefined,
): boolean {
	if (!name) return true;
	if (!participantId) return false;
	const trimmed = name.trim();
	return trimmed.length === 0 || trimmed === participantId;
}

function isStaleProfile(fetchedAt: unknown, maxAgeMs: number): boolean {
	if (typeof fetchedAt !== "string" || fetchedAt.length === 0) return true;
	const timestamp = Date.parse(fetchedAt);
	if (Number.isNaN(timestamp)) return true;
	return Date.now() - timestamp > maxAgeMs;
}

function instagramGraphBase(token: string): string {
	return token.startsWith("IGAA") ? GRAPH_BASE.instagram : GRAPH_BASE.facebook;
}

async function fetchInstagramParticipantProfile(
	participantId: string,
	token: string,
): Promise<{
	displayName: string | null;
	avatarUrl: string | null;
	metadata: ParticipantMetadataRecord;
} | null> {
	const profileAbort = new AbortController();
	const profileTimer = setTimeout(() => profileAbort.abort(), 5_000);

	try {
		const profileRes = await fetch(
			`${instagramGraphBase(token)}/${participantId}?fields=name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user&access_token=${encodeURIComponent(token)}`,
			{ signal: profileAbort.signal },
		);

		if (!profileRes.ok) {
			const errorText = await profileRes.text().catch(() => "");
			console.error(
				`[inbox-processor] Instagram participant profile lookup failed (${profileRes.status}): ${errorText.slice(0, 200)}`,
			);
			return null;
		}

		const profile = (await profileRes.json()) as {
			name?: string | null;
			username?: string | null;
			profile_pic?: string | null;
			follower_count?: number | null;
			is_user_follow_business?: boolean | null;
			is_business_follow_user?: boolean | null;
		};
		const displayName = profile.name ?? profile.username ?? null;

		if (!displayName && !profile.profile_pic) {
			return null;
		}

		return {
			displayName,
			avatarUrl: profile.profile_pic ?? null,
			metadata: {
				scopedId: participantId,
				name: profile.name ?? null,
				username: profile.username ?? null,
				profilePic: profile.profile_pic ?? null,
				followerCount: profile.follower_count ?? null,
				isUserFollowBusiness: profile.is_user_follow_business ?? null,
				isBusinessFollowUser: profile.is_business_follow_user ?? null,
				fetchedAt: new Date().toISOString(),
			},
		};
	} finally {
		clearTimeout(profileTimer);
	}
}

async function fetchFacebookParticipantProfile(
	participantId: string,
	token: string,
): Promise<{
	displayName: string | null;
	avatarUrl: string | null;
	metadata: ParticipantMetadataRecord;
} | null> {
	const profileAbort = new AbortController();
	const profileTimer = setTimeout(() => profileAbort.abort(), 5_000);

	try {
		const profileRes = await fetch(
			`${GRAPH_BASE.facebook}/${participantId}?fields=name,first_name,last_name,profile_pic&access_token=${encodeURIComponent(token)}`,
			{ signal: profileAbort.signal },
		);

		if (!profileRes.ok) {
			const errorText = await profileRes.text().catch(() => "");
			console.error(
				`[inbox-processor] Facebook participant profile lookup failed (${profileRes.status}): ${errorText.slice(0, 200)}`,
			);
			return null;
		}

		const profile = (await profileRes.json()) as {
			name?: string | null;
			first_name?: string | null;
			last_name?: string | null;
			profile_pic?: string | null;
		};
		const fallbackName = [profile.first_name, profile.last_name]
			.filter((part): part is string => typeof part === "string" && part.length > 0)
			.join(" ");
		const displayName = profile.name ?? (fallbackName || null);

		if (!displayName && !profile.profile_pic) {
			return null;
		}

		return {
			displayName,
			avatarUrl: profile.profile_pic ?? null,
			metadata: {
				psid: participantId,
				name: displayName,
				firstName: profile.first_name ?? null,
				lastName: profile.last_name ?? null,
				profilePic: profile.profile_pic ?? null,
				fetchedAt: new Date().toISOString(),
			},
		};
	} finally {
		clearTimeout(profileTimer);
	}
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
		const conversationPartner = event.participant ?? event.author;
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
				participantAvatar:
					conversationPartner?.avatar_url ?? event.author?.avatar_url ?? null,
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

		// 1b. Meta participant profile enrichment — Instagram/Messenger webhooks
		// carry the participant's scoped ID, but not their display name/avatar.
		// Fetch and persist the profile data so the inbox shows the real person.
		const existingParticipantMetadata = asRecord(conversation?.participantMetadata);
		const existingInstagramProfile = asRecord(
			existingParticipantMetadata?.instagramProfile,
		);
		const existingFacebookProfile = asRecord(
			existingParticipantMetadata?.facebookProfile,
		);
		const participantId = conversationPartner?.id ?? null;
		const needsIdentityRefresh =
			isMissingParticipantIdentity(conversation?.participantName, participantId) ||
			!conversation?.participantAvatar;

		if (
			conversation &&
			event.type === "message" &&
			participantId &&
			sa?.accessToken &&
			((event.platform === "instagram" &&
				(needsIdentityRefresh ||
					isStaleProfile(
						existingInstagramProfile?.fetchedAt,
						1000 * 60 * 60 * 24,
					))) ||
				(event.platform === "facebook" &&
					(needsIdentityRefresh ||
						isStaleProfile(
							existingFacebookProfile?.fetchedAt,
							1000 * 60 * 60 * 24,
						))))
		) {
			try {
				const token = await maybeDecrypt(sa.accessToken, env.ENCRYPTION_KEY);
				if (!token) throw new Error("Failed to decrypt access token");

				const profile =
					event.platform === "instagram"
						? await fetchInstagramParticipantProfile(participantId, token)
						: await fetchFacebookParticipantProfile(participantId, token);
				if (profile) {
					const conversationPatch: Partial<
						typeof inboxConversations.$inferInsert
					> = {
						participantMetadata: {
							...(existingParticipantMetadata ?? {}),
							[event.platform === "instagram"
								? "instagramProfile"
								: "facebookProfile"]: {
								...(event.platform === "instagram"
									? existingInstagramProfile ?? {}
									: existingFacebookProfile ?? {}),
								...profile.metadata,
							},
						},
					};

					if (profile.displayName) {
						conversationPatch.participantName = profile.displayName;
					}
					if (profile.avatarUrl) {
						conversationPatch.participantAvatar = profile.avatarUrl;
					}

					await db
						.update(inboxConversations)
						.set(conversationPatch)
						.where(
							and(
								eq(inboxConversations.id, conversation.id),
								eq(inboxConversations.organizationId, event.organization_id),
							),
						);

					const messagePatch: Partial<typeof inboxMessages.$inferInsert> = {};
					if (profile.displayName) {
						messagePatch.authorName = profile.displayName;
					}
					if (profile.avatarUrl) {
						messagePatch.authorAvatarUrl = profile.avatarUrl;
					}

					if (messagePatch.authorName || messagePatch.authorAvatarUrl) {
						await db
							.update(inboxMessages)
							.set(messagePatch)
							.where(
								and(
									eq(inboxMessages.conversationId, conversation.id),
									eq(inboxMessages.organizationId, event.organization_id),
									eq(inboxMessages.authorPlatformId, participantId),
									eq(inboxMessages.direction, "inbound"),
								),
							);
					}
				}
			} catch (err) {
				console.error(
					`[inbox-processor] ${event.platform} participant profile enrichment failed:`,
					err,
				);
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
			// ensureContactForAuthor returns an existing contact when one matches
			// the (platform, account, identifier) tuple or has a matching
			// phone/email. When nothing matches, it creates a minimal contact +
			// channel so downstream automation nodes (message_text, user_input,
			// tag_add) have something to write to. Without this, "reply to new
			// DM" flows fail on the first node because the author is unknown.
			contactId = await ensureContactForAuthor(
				db,
				event.organization_id,
				event.account_id,
				event.platform,
				authorId,
				event.author?.name ?? null,
			);
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
				// If the inbound event carries a structured attachment (image,
				// document, audio), pass it as the captured value along with the
				// {mime_type, size_bytes} meta so `user_input_file` can enforce
				// its accepted_mime_types / max_size_mb. Text-only inputs still
				// go through as a plain string.
				if (event.attachment) {
					await resumeFromInput(env, pending, event.attachment, {
						mime_type: event.attachment.mime_type,
						size_bytes: event.attachment.size_bytes,
					});
				} else {
					await resumeFromInput(env, pending, event.text ?? "");
				}
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

/**
 * Structured media payload for inbound WhatsApp messages. WhatsApp webhooks
 * deliver a media `id` (fetch via `GET /{id}`) + `mime_type`; size is not
 * surfaced by the webhook, so the `user_input_file` size cap is a no-op for
 * WhatsApp uploads unless a downstream handler fetches the media and checks.
 */
function extractWhatsAppAttachment(
	msg: WhatsAppMessage,
): NormalizedInboxEvent["attachment"] | undefined {
	switch (msg.type) {
		case "image":
			return msg.image
				? { id: msg.image.id, mime_type: msg.image.mime_type }
				: undefined;
		case "video":
			return msg.video
				? { id: msg.video.id, mime_type: msg.video.mime_type }
				: undefined;
		case "document":
			return msg.document
				? {
						id: msg.document.id,
						filename: msg.document.filename,
						mime_type: msg.document.mime_type,
					}
				: undefined;
		case "audio":
			return msg.audio
				? { id: msg.audio.id, mime_type: msg.audio.mime_type }
				: undefined;
		case "sticker":
			return msg.sticker
				? { id: msg.sticker.id, mime_type: msg.sticker.mime_type }
				: undefined;
		default:
			return undefined;
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
			attachment: extractWhatsAppAttachment(msg),
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
		caption?: string;
		photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
		document?: {
			file_id: string;
			file_name?: string;
			mime_type?: string;
			file_size?: number;
		};
		audio?: { file_id: string; mime_type?: string; file_size?: number };
		voice?: { file_id: string; mime_type?: string; file_size?: number };
		video?: { file_id: string; mime_type?: string; file_size?: number };
	};
}

function extractTelegramAttachment(
	tgMsg: NonNullable<TelegramUpdatePayload["message"]>,
): NormalizedInboxEvent["attachment"] | undefined {
	// Telegram photos come as a sized array; take the largest variant.
	if (tgMsg.photo?.length) {
		const largest = tgMsg.photo[tgMsg.photo.length - 1];
		if (largest) {
			return {
				id: largest.file_id,
				mime_type: "image/jpeg",
				size_bytes: largest.file_size,
			};
		}
	}
	if (tgMsg.document) {
		return {
			id: tgMsg.document.file_id,
			filename: tgMsg.document.file_name,
			mime_type: tgMsg.document.mime_type,
			size_bytes: tgMsg.document.file_size,
		};
	}
	if (tgMsg.video) {
		return {
			id: tgMsg.video.file_id,
			mime_type: tgMsg.video.mime_type,
			size_bytes: tgMsg.video.file_size,
		};
	}
	if (tgMsg.audio) {
		return {
			id: tgMsg.audio.file_id,
			mime_type: tgMsg.audio.mime_type,
			size_bytes: tgMsg.audio.file_size,
		};
	}
	if (tgMsg.voice) {
		return {
			id: tgMsg.voice.file_id,
			mime_type: tgMsg.voice.mime_type ?? "audio/ogg",
			size_bytes: tgMsg.voice.file_size,
		};
	}
	return undefined;
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
			text: tgMsg.text ?? tgMsg.caption,
			attachment: extractTelegramAttachment(tgMsg),
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

function extractTwilioMmsAttachment(
	payload: TwilioSmsPayload,
): NormalizedInboxEvent["attachment"] | undefined {
	const count = Number(payload.NumMedia ?? 0);
	if (!count) return undefined;
	// Twilio MMS uses MediaUrl0/MediaContentType0 for the first attachment. We
	// surface only the first — automations wanting all attachments should use
	// platform-specific nodes.
	const url = payload.MediaUrl0;
	if (!url) return undefined;
	return {
		url,
		mime_type: payload.MediaContentType0,
	};
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
			attachment: extractTwilioMmsAttachment(payload),
			conversation_id: payload.From,
			created_at: new Date().toISOString(),
			raw: message.payload,
		},
	];
}
