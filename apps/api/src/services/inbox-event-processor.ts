import {
	automationRuns,
	createDb,
	inboxConversations,
	inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import { maybeDecrypt } from "../lib/crypto";
import { notifyRealtime } from "../lib/notify-post-update";
import type { InboxQueueMessage } from "../routes/platform-webhooks";
import type { Env } from "../types";
import { matchAndEnrollOrBinding } from "./automations/binding-router";
import { resumeWaitingRunOnInput } from "./automations/input-resume";
import type {
	InboundEvent,
	InboundEventKind,
} from "./automations/trigger-matcher";
import { ensureContactForAuthor } from "./contact-linker";
import { insertMessage, upsertConversation } from "./inbox-persistence";
import { dispatchWebhookEvent } from "./webhook-delivery";
import { subscribeYouTubeChannel } from "./webhook-subscription";

// ---------------------------------------------------------------------------
// Normalized event structure
// ---------------------------------------------------------------------------

interface NormalizedInboxEvent {
	type: "comment" | "message" | "follow" | "ad_click";
	platform: string;
	account_id: string;
	organization_id: string;
	platform_event_id: string;
	author?: { name: string; id: string; avatar_url?: string };
	/** Conversation partner (customer) — defaults to author for inbound, set explicitly for outbound echoes */
	participant?: { name: string; id: string; avatar_url?: string };
	text?: string;
	interactive_payload?: string;
	interactive_kind?: "postback" | "button_click" | "list_reply" | "flow_submit";
	/**
	 * Discriminator hints surfaced by the platform normalizer so
	 * `deriveInboundEventKind` can route the event to the correct entrypoint
	 * kind. Set by the Instagram / Facebook / WhatsApp / Telegram normalizers
	 * based on raw webhook payload markers.
	 */
	is_story_reply?: boolean;
	is_story_mention?: boolean;
	is_share_to_dm?: boolean;
	is_live_comment?: boolean;
	is_ad_click?: boolean;
	ad_id?: string;
	story_id?: string;
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
			.filter(
				(part): part is string => typeof part === "string" && part.length > 0,
			)
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
	if (
		message.type === "whatsapp_webhook" &&
		message.event_type === "statuses"
	) {
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
		let conversation: Awaited<ReturnType<typeof upsertConversation>> | null =
			null;
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
		// `follow` and `ad_click` events don't correspond to a message — they
		// describe a relationship change or ad engagement. We still route them
		// through the automation matcher (step 2) but skip inbox persistence.
		const isPersistedEvent =
			event.type === "comment" || event.type === "message";
		try {
			if (isPersistedEvent) {
				conversation = await upsertConversation(db, {
					organizationId: event.organization_id,
					workspaceId: sa?.workspaceId ?? null,
					accountId: event.account_id,
					platform: event.platform as any,
					type: event.type === "comment" ? "comment_thread" : "dm",
					platformConversationId:
						event.post_id ||
						event.conversation_id ||
						event.platform_event_id,
					participantName: conversationPartner?.name ?? null,
					participantPlatformId: conversationPartner?.id ?? null,
					participantAvatar:
						conversationPartner?.avatar_url ??
						event.author?.avatar_url ??
						null,
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
				}
			}
		} catch (err) {
			console.error("[inbox-processor] DB storage failed:", err);
		}

		// 1b. Meta participant profile enrichment — Instagram/Messenger webhooks
		// carry the participant's scoped ID, but not their display name/avatar.
		// Fetch and persist the profile data so the inbox shows the real person.
		const existingParticipantMetadata = asRecord(
			conversation?.participantMetadata,
		);
		const existingInstagramProfile = asRecord(
			existingParticipantMetadata?.instagramProfile,
		);
		const existingFacebookProfile = asRecord(
			existingParticipantMetadata?.facebookProfile,
		);
		const participantId = conversationPartner?.id ?? null;
		const needsIdentityRefresh =
			isMissingParticipantIdentity(
				conversation?.participantName,
				participantId,
			) || !conversation?.participantAvatar;

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
									? (existingInstagramProfile ?? {})
									: (existingFacebookProfile ?? {})),
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
			await dispatchAutomationMatch(event, db, env, {
				workspace_id: sa?.workspaceId ?? null,
				is_conversation_start:
					event.type === "message" && (conversation?.messageCount ?? 0) === 0,
			});
		}

		// `follow` / `ad_click` events don't produce inbox rows, so the outbound
		// webhook dispatch + realtime notify paths don't apply to them.
		if (!isPersistedEvent) {
			continue;
		}

		// 3. Dispatch outbound webhook
		const webhookEvent =
			event.type === "comment"
				? "comment.received"
				: direction === "outbound"
					? "message.sent"
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
		const realtimeEvent =
			event.type === "comment"
				? {
						type: "inbox.comment.received" as const,
						post_id: event.post_id,
						platform: event.platform,
					}
				: direction === "outbound"
					? {
							type: "inbox.message.sent" as const,
							conversation_id: conversation?.id ?? event.conversation_id,
							platform: event.platform,
						}
					: {
							type: "inbox.message.received" as const,
							conversation_id: conversation?.id ?? event.conversation_id,
							platform: event.platform,
						};
		await notifyRealtime(env, event.organization_id, realtimeEvent).catch(
			(err) => {
				console.error("[inbox-processor] notifyRealtime failed:", err);
			},
		);
	}
}

// ---------------------------------------------------------------------------
// Automations bridge
// ---------------------------------------------------------------------------

/**
 * Channels supported by the Manychat-parity automation engine. Inbound events
 * from SMS, YouTube, Reddit, LinkedIn, etc. are stored + webhook-dispatched
 * but do not flow into automations in v1.
 */
const AUTOMATION_CHANNELS = new Set([
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
	"tiktok",
]);

/**
 * Maps a normalized inbox event to an InboundEventKind understood by the
 * entrypoint matcher. The order matters: specificity beats catch-all, so
 * story replies / mentions / share-to-DM / live comments are picked up
 * BEFORE falling through to the generic `dm_received` / `comment_created`
 * kinds. The matcher then performs the final keyword / post / ad id
 * filtering per-kind.
 *
 * Returns null for event shapes the new engine doesn't route (outbound
 * echoes, pure reaction/seen updates, etc.).
 */
function deriveInboundEventKind(
	event: NormalizedInboxEvent,
): InboundEventKind | null {
	if (event.type === "follow") return "follow";
	if (event.type === "ad_click") return "ad_click";
	if (event.type === "comment") {
		if (event.is_live_comment) return "live_comment";
		return "comment_created";
	}
	if (event.type === "message") {
		if (event.is_story_reply) return "story_reply";
		if (event.is_story_mention) return "story_mention";
		if (event.is_share_to_dm) return "share_to_dm";
		if (event.is_ad_click) return "ad_click";
		return "dm_received";
	}
	return null;
}

/**
 * Matches the inbound event against active automations and enrolls candidates.
 * Waiting runs (a `user_input` node pending input) take precedence — inbound
 * text is fed into the paused run instead of starting a fresh one.
 *
 * Best-effort: automation failures never block inbox processing.
 */
async function dispatchAutomationMatch(
	event: NormalizedInboxEvent,
	db: ReturnType<typeof createDb>,
	env: Env,
	_meta?: {
		workspace_id?: string | null;
		is_conversation_start?: boolean;
	},
): Promise<void> {
	try {
		if (!AUTOMATION_CHANNELS.has(event.platform)) return;
		const kind = deriveInboundEventKind(event);
		if (!kind) return;

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
		if (!contactId) return;

		const envAsRecord = env as unknown as Record<string, unknown>;

		// Resume a waiting user_input run before firing new triggers.
		//
		// Only inbound MESSAGES should satisfy a user_input wait — a comment
		// on a post must never be captured as input to a DM flow. The waiting
		// run's conversation also has to match, so a message on conversation B
		// doesn't resume a flow paused on conversation A for the same contact.
		if (event.type === "message") {
			const resumed = await resumeWaitingRunForInput(
				db,
				env,
				envAsRecord,
				contactId,
				event,
			);
			if (resumed) return;
		}

		const inboundEvent: InboundEvent = {
			kind,
			channel: event.platform as InboundEvent["channel"],
			organizationId: event.organization_id,
			socialAccountId: event.account_id,
			contactId,
			conversationId: event.conversation_id ?? null,
			text: event.text,
			// story_reply/story_mention match on story_id (falls back to post_id
			// for platforms that don't distinguish the two surfaces).
			postId:
				event.story_id ?? event.post_id ?? undefined,
			adId: event.ad_id,
			payload: {
				post_id: event.post_id,
				parent_id: event.parent_id,
				story_id: event.story_id,
				ad_id: event.ad_id,
				comment_id:
					event.type === "comment" ? event.platform_event_id : undefined,
				message_id:
					event.type === "message" ? event.platform_event_id : undefined,
				interactive_payload: event.interactive_payload,
				interactive_kind: event.interactive_kind,
				attachment: event.attachment,
				author: event.author,
				created_at: event.created_at,
				is_story_reply: event.is_story_reply,
				is_story_mention: event.is_story_mention,
				is_share_to_dm: event.is_share_to_dm,
				is_live_comment: event.is_live_comment,
				is_ad_click: event.is_ad_click,
			},
		};

		await matchAndEnrollOrBinding(db, inboundEvent, envAsRecord);
	} catch (err) {
		console.error("[inbox-processor] automation dispatch failed:", err);
	}
}

/**
 * Look for `waiting-for-input` runs on this (contact, conversation) and hand
 * the inbound message off to `resumeWaitingRunOnInput`, which validates it
 * against each run's input node config and routes through the correct port
 * (`captured` / `invalid` / `skip`) or re-prompts when retries remain.
 *
 * Returns true iff the inbound was consumed by (at least) one waiting run.
 * When true, the caller must NOT also fire entrypoint matching — a reply to
 * a pending input should never also enroll the contact in a new flow.
 */
async function resumeWaitingRunForInput(
	db: ReturnType<typeof createDb>,
	_env: Env,
	envAsRecord: Record<string, unknown>,
	contactId: string,
	event: NormalizedInboxEvent,
): Promise<boolean> {
	const conversationId = event.conversation_id ?? null;
	const waitingRuns = await db
		.select({
			id: automationRuns.id,
			updatedAt: automationRuns.updatedAt,
		})
		.from(automationRuns)
		.where(
			and(
				eq(automationRuns.organizationId, event.organization_id),
				eq(automationRuns.contactId, contactId),
				eq(automationRuns.status, "waiting"),
				eq(automationRuns.waitingFor, "input"),
				or(
					conversationId
						? eq(automationRuns.conversationId, conversationId)
						: undefined,
					// If the run was enrolled without a conversation (e.g. follow event),
					// still allow the first inbound DM to resume it.
					sql`${automationRuns.conversationId} IS NULL`,
				),
			),
		)
		.orderBy(desc(automationRuns.updatedAt));

	if (waitingRuns.length === 0) return false;

	const hasAttachment = Boolean(event.attachment);
	const inboundText = event.text ?? "";
	let consumed = false;

	for (const waiting of waitingRuns) {
		const outcome = await resumeWaitingRunOnInput(
			db,
			waiting.id,
			inboundText,
			hasAttachment,
			envAsRecord,
		);
		// Anything other than "race" means the inbound was consumed by this run
		// — whether it advanced, retried, or completed. Suppress entrypoint
		// matching in all those cases.
		if (outcome !== "race") consumed = true;
	}

	return consumed;
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
	/**
	 * Raw Meta messaging payload. Optional fields mirror the subset the
	 * normalizer inspects to derive story_reply / story_mention / share_to_dm /
	 * ad_click — see Meta Messenger Platform docs for `reply_to`, `attachments`,
	 * and `referral`.
	 */
	message?: {
		mid: string;
		text?: string;
		reply_to?: { story?: { id?: string; url?: string }; mid?: string };
		attachments?: Array<{
			type?: string;
			payload?: Record<string, unknown>;
		}>;
	};
	postback?: { title: string; payload: string };
	referral?: {
		source?: string;
		type?: string;
		ref?: string;
		ad_id?: string;
	};
	follow?: { is_following?: boolean };
}

/**
 * Maps a raw Meta attachment[]/reply_to/referral payload to the flags the
 * automation engine uses to distinguish story replies, story mentions, and
 * share-to-DM events from ordinary DMs. Returns a partial
 * `NormalizedInboxEvent` the caller can spread into the normalized record.
 */
function extractMetaMessageMarkers(msg: FacebookMessagingPayload): {
	is_story_reply?: boolean;
	is_story_mention?: boolean;
	is_share_to_dm?: boolean;
	is_ad_click?: boolean;
	story_id?: string;
	ad_id?: string;
} {
	const markers: {
		is_story_reply?: boolean;
		is_story_mention?: boolean;
		is_share_to_dm?: boolean;
		is_ad_click?: boolean;
		story_id?: string;
		ad_id?: string;
	} = {};

	// Story reply — Meta sends `message.reply_to.story` with the story id/url.
	const replyStory = msg.message?.reply_to?.story;
	if (replyStory && (replyStory.id || replyStory.url)) {
		markers.is_story_reply = true;
		if (replyStory.id) markers.story_id = replyStory.id;
	}

	// Attachment-driven markers: share_to_dm (type=share), story_mention
	// (type=story_mention).
	for (const att of msg.message?.attachments ?? []) {
		if (att.type === "share") markers.is_share_to_dm = true;
		if (att.type === "story_mention") {
			markers.is_story_mention = true;
			const storyId = (att.payload as { story_id?: string; id?: string })
				?.story_id ?? (att.payload as { id?: string })?.id;
			if (storyId) markers.story_id = String(storyId);
		}
	}

	// Ad click (Click-to-Messenger referral). Docs:
	// https://developers.facebook.com/docs/messenger-platform/discovery/ads/click-to-messenger-ads/
	if (
		msg.referral &&
		(msg.referral.source === "ADS" || msg.referral.type === "OPEN_THREAD")
	) {
		markers.is_ad_click = true;
		if (msg.referral.ad_id) markers.ad_id = msg.referral.ad_id;
	}

	return markers;
}

function normalizeFacebookEvent(
	message: InboxQueueMessage,
): NormalizedInboxEvent[] {
	const { event_type, payload } = message;
	const now = new Date().toISOString();

	// Follow event — Messenger "follows" webhook field on a Page.
	if (event_type === "follows") {
		const msg = payload as FacebookMessagingPayload;
		return [
			{
				type: "follow",
				platform: "facebook",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: `follow_${msg.sender.id}_${msg.timestamp}`,
				conversation_id: msg.sender.id,
				author: { name: msg.sender.id, id: msg.sender.id },
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
			},
		];
	}

	// Standalone referral — user clicked a CTM ad before sending a DM.
	if (event_type === "referral") {
		const msg = payload as FacebookMessagingPayload;
		return [
			{
				type: "ad_click",
				platform: "facebook",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: `ref_${msg.sender.id}_${msg.timestamp}`,
				conversation_id: msg.sender.id,
				author: { name: msg.sender.id, id: msg.sender.id },
				ad_id: msg.referral?.ad_id,
				is_ad_click: true,
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
			},
		];
	}

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
		const isEcho =
			!!(msg.message as any)?.is_echo ||
			msg.sender.id === message.platform_account_id;
		if (isEcho) return [];
		const text = msg.message?.text ?? msg.postback?.title;
		const eventId = msg.message?.mid ?? `postback_${msg.timestamp}`;
		const customerId = msg.sender.id;
		const markers = extractMetaMessageMarkers(msg);

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
				interactive_payload: msg.postback?.payload,
				interactive_kind: msg.postback?.payload ? "postback" : undefined,
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
				...markers,
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
				interactive_payload: msg.postback?.payload,
				interactive_kind: msg.postback?.payload ? "postback" : undefined,
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

	// Follow on Instagram — Meta delivers a `follows` webhook field.
	if (event_type === "follows") {
		const msg = payload as FacebookMessagingPayload;
		return [
			{
				type: "follow",
				platform: "instagram",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: `follow_${msg.sender.id}_${msg.timestamp}`,
				conversation_id: msg.sender.id,
				author: { name: msg.sender.id, id: msg.sender.id },
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
			},
		];
	}

	// Standalone ad-click referral (Instagram CTM).
	if (event_type === "referral") {
		const msg = payload as FacebookMessagingPayload;
		return [
			{
				type: "ad_click",
				platform: "instagram",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: `ref_${msg.sender.id}_${msg.timestamp}`,
				conversation_id: msg.sender.id,
				author: { name: msg.sender.id, id: msg.sender.id },
				ad_id: msg.referral?.ad_id,
				is_ad_click: true,
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
			},
		];
	}

	// "live_comments" webhook field — Instagram Live comment.
	if (event_type === "live_comments") {
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
					? { name: value.from.username ?? value.from.id, id: value.from.id }
					: undefined,
				text: value.text,
				post_id: value.media?.id,
				is_live_comment: true,
				created_at: now,
				raw: payload,
			},
		];
	}

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
		const isEcho =
			!!(msg.message as any)?.is_echo ||
			msg.sender.id === message.platform_account_id;
		// Skip echoes — outbound messages are already stored by the sendMessage handler
		if (isEcho) return [];
		const text = msg.message?.text ?? msg.postback?.title;
		const eventId = msg.message?.mid ?? `postback_${msg.timestamp}`;
		// Conversation partner is always the customer (sender for inbound)
		const customerId = msg.sender.id;
		const markers = extractMetaMessageMarkers(msg);

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
				interactive_payload: msg.postback?.payload,
				interactive_kind: msg.postback?.payload ? "postback" : undefined,
				created_at: new Date(msg.timestamp).toISOString(),
				raw: payload,
				...markers,
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
				interactive_payload: msg.postback?.payload,
				interactive_kind: msg.postback?.payload ? "postback" : undefined,
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
		document?: {
			id: string;
			filename: string;
			mime_type: string;
			sha256: string;
			caption?: string;
		};
		audio?: { id: string; mime_type: string; sha256: string };
		sticker?: { id: string; mime_type: string; sha256: string };
		location?: {
			latitude: number;
			longitude: number;
			name?: string;
			address?: string;
		};
		contacts?: Array<{
			name: { formatted_name: string };
			phones?: Array<{ phone: string }>;
		}>;
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
			return (
				msg.document?.caption ||
				`[Document: ${msg.document?.filename ?? "file"}]`
			);
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
			return msg.reaction?.emoji
				? `Reacted with ${msg.reaction.emoji}`
				: "[Reaction]";
		default:
			return `[${msg.type}]`;
	}
}

function extractWhatsAppInteractivePayload(msg: WhatsAppMessage): {
	payload?: string;
	kind?: NormalizedInboxEvent["interactive_kind"];
} {
	if (msg.button?.payload) {
		return {
			payload: msg.button.payload,
			kind: "button_click",
		};
	}
	if (msg.interactive?.type === "button_reply") {
		const reply = (
			msg.interactive as { button_reply?: { id?: string; title?: string } }
		).button_reply;
		return {
			payload: reply?.id ?? reply?.title,
			kind: "button_click",
		};
	}
	if (msg.interactive?.type === "list_reply") {
		const reply = (
			msg.interactive as { list_reply?: { id?: string; title?: string } }
		).list_reply;
		return {
			payload: reply?.id ?? reply?.title,
			kind: "list_reply",
		};
	}
	if (msg.interactive?.type === "nfm_reply") {
		const reply = (
			msg.interactive as {
				nfm_reply?: { response_json?: unknown };
			}
		).nfm_reply;
		return {
			payload: reply?.response_json
				? JSON.stringify(reply.response_json)
				: undefined,
			kind: "flow_submit",
		};
	}
	return {};
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
		const interactive = extractWhatsAppInteractivePayload(msg);
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
			interactive_payload: interactive.payload,
			interactive_kind: interactive.kind,
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
			.returning({
				id: inboxMessages.id,
				conversationId: inboxMessages.conversationId,
			});

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
		photo?: Array<{
			file_id: string;
			file_size?: number;
			width: number;
			height: number;
		}>;
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
	callback_query?: {
		id: string;
		from: {
			id: number;
			first_name: string;
			last_name?: string;
			username?: string;
		};
		message?: {
			message_id: number;
			chat: { id: number; type: string };
			date?: number;
			text?: string;
			caption?: string;
		};
		data?: string;
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

	if (payload.callback_query) {
		const query = payload.callback_query;
		const authorName = [query.from.first_name, query.from.last_name]
			.filter(Boolean)
			.join(" ");
		return [
			{
				type: "message",
				platform: "telegram",
				account_id: message.account_id,
				organization_id: message.organization_id,
				platform_event_id: `callback_${query.id}`,
				author: {
					name: authorName,
					id: String(query.from.id),
				},
				text: query.data ?? query.message?.text ?? query.message?.caption,
				interactive_payload: query.data,
				interactive_kind: query.data ? "button_click" : undefined,
				conversation_id: String(query.message?.chat.id ?? query.from.id),
				created_at: new Date(
					(query.message?.date ?? Math.floor(Date.now() / 1000)) * 1000,
				).toISOString(),
				raw: message.payload,
			},
		];
	}

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

function normalizeSmsEvent(message: InboxQueueMessage): NormalizedInboxEvent[] {
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
