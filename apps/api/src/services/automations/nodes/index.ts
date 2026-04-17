/**
 * Node handler registry.
 *
 * Universal handlers implemented in Phase 2.
 * Platform-specific handlers are stubbed — filled in Phase 8 per-platform.
 */

import type { NodeHandler } from "../types";
import { endHandler } from "./end";
import { gotoHandler } from "./goto";
import { httpRequestHandler } from "./http-request";
import { messageMediaHandler } from "./message-media";
import { messageTextHandler } from "./message-text";
import { conditionHandler } from "./condition";
import { smartDelayHandler } from "./smart-delay";
import { randomizerHandler } from "./randomizer";
import { tagAddHandler, tagRemoveHandler } from "./tag-actions";
import { fieldSetHandler, fieldClearHandler } from "./field-actions";
import { userInputHandler } from "./user-input";
import { triggerHandler } from "./trigger";

const universal: Record<string, NodeHandler> = {
	trigger: triggerHandler,
	message_text: messageTextHandler,
	message_media: messageMediaHandler,
	message_file: messageMediaHandler, // same handler, distinguished by config
	condition: conditionHandler,
	smart_delay: smartDelayHandler,
	randomizer: randomizerHandler,
	goto: gotoHandler,
	end: endHandler,
	tag_add: tagAddHandler,
	tag_remove: tagRemoveHandler,
	field_set: fieldSetHandler,
	field_clear: fieldClearHandler,
	http_request: httpRequestHandler,
	user_input_text: userInputHandler,
	user_input_email: userInputHandler,
	user_input_phone: userInputHandler,
	user_input_number: userInputHandler,
	user_input_date: userInputHandler,
	user_input_choice: userInputHandler,
	user_input_file: userInputHandler,
};

/**
 * Stub handler for node types not yet implemented. Returns a failing result
 * so the enrollment records the gap, rather than silently skipping.
 */
const notImplemented = (type: string): NodeHandler =>
	async () => ({
		kind: "fail" as const,
		error: `Node type '${type}' is not yet implemented (Phase 8 — per-platform rollout).`,
	});

const platformSpecificTypes = [
	// AI
	"ai_step",
	"ai_agent",
	"ai_intent_router",
	// Logic extras
	"split_test",
	"subflow_call",
	// Contact/subscription extras
	"subscription_add",
	"subscription_remove",
	"segment_add",
	"segment_remove",
	"notify_admin",
	"conversation_assign",
	"conversation_status",
	"webhook_out",
	// Instagram
	"instagram_send_text",
	"instagram_send_media",
	"instagram_send_buttons",
	"instagram_send_quick_replies",
	"instagram_send_generic_template",
	"instagram_typing",
	"instagram_mark_seen",
	"instagram_reply_to_comment",
	"instagram_hide_comment",
	// Facebook
	"facebook_send_text",
	"facebook_send_media",
	"facebook_send_template",
	"facebook_send_quick_replies",
	"facebook_send_button_template",
	"facebook_reply_to_comment",
	"facebook_private_reply",
	"facebook_hide_comment",
	"facebook_sender_action",
	// WhatsApp
	"whatsapp_send_text",
	"whatsapp_send_media",
	"whatsapp_send_template",
	"whatsapp_send_interactive",
	"whatsapp_send_flow",
	"whatsapp_send_location",
	"whatsapp_send_contacts",
	"whatsapp_react",
	"whatsapp_mark_read",
	// Telegram
	"telegram_send_text",
	"telegram_send_media",
	"telegram_send_media_group",
	"telegram_send_poll",
	"telegram_send_location",
	"telegram_send_keyboard",
	"telegram_edit_message",
	"telegram_pin_message",
	"telegram_react",
	"telegram_set_chat_action",
	// Discord
	"discord_send_message",
	"discord_send_embed",
	"discord_send_components",
	"discord_send_attachment",
	"discord_react",
	"discord_edit_message",
	"discord_start_thread",
	// SMS
	"sms_send",
	"sms_send_mms",
	// Twitter/X
	"twitter_send_dm",
	"twitter_send_dm_media",
	"twitter_reply_to_tweet",
	"twitter_like_tweet",
	"twitter_retweet",
	// Bluesky
	"bluesky_reply",
	"bluesky_like",
	"bluesky_repost",
	"bluesky_send_dm",
	// Threads
	"threads_reply_to_post",
	"threads_hide_reply",
	// YouTube
	"youtube_reply_to_comment",
	"youtube_send_live_chat",
	"youtube_moderate_comment",
	// LinkedIn
	"linkedin_reply_to_comment",
	"linkedin_react_to_post",
	// Mastodon
	"mastodon_reply",
	"mastodon_favourite",
	"mastodon_boost",
	"mastodon_send_dm",
	// Reddit
	"reddit_reply_to_comment",
	"reddit_send_pm",
	"reddit_reply_modmail",
	"reddit_submit_post",
	// Google Business
	"googlebusiness_reply_to_review",
	"googlebusiness_post_update",
	// Beehiiv
	"beehiiv_add_subscriber",
	"beehiiv_publish_post",
	"beehiiv_enroll_automation",
	// Kit
	"kit_add_subscriber",
	"kit_add_tag",
	"kit_send_broadcast",
	// Mailchimp
	"mailchimp_add_member",
	"mailchimp_add_tag",
	"mailchimp_send_campaign",
	// Listmonk
	"listmonk_add_subscriber",
	"listmonk_send_campaign",
	// Pinterest
	"pinterest_create_pin",
];

const platformStubs = Object.fromEntries(
	platformSpecificTypes.map((t) => [t, notImplemented(t)]),
);

export const nodeHandlers: Record<string, NodeHandler> = {
	...universal,
	...platformStubs,
};

export function getNodeHandler(type: string): NodeHandler {
	const handler = nodeHandlers[type];
	if (!handler)
		return async () => ({
			kind: "fail" as const,
			error: `Unknown node type '${type}'`,
		});
	return handler;
}
