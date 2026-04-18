/**
 * Node handler registry.
 *
 * Universal handlers implemented in Phase 2.
 * Platform-specific handlers live in ./platforms/*.ts (one file per platform).
 *
 * Still stubbed (Phase 8 follow-ups or awaiting external approvals):
 *   - ai_step / ai_agent / ai_intent_router (needs AI infra)
 *   - subflow_call (logic extras)
 *   - segment_add / notify_admin / conversation_assign (ops)
 */

import type { NodeHandler } from "../types";
import { conversationStatusHandler } from "./conversation-status";
import { conditionHandler } from "./condition";
import { endHandler } from "./end";
import { fieldClearHandler, fieldSetHandler } from "./field-actions";
import { gotoHandler } from "./goto";
import { httpRequestHandler } from "./http-request";
import { messageMediaHandler } from "./message-media";
import { messageTextHandler } from "./message-text";
import { randomizerHandler } from "./randomizer";
import { splitTestHandler } from "./split-test";
import { smartDelayHandler } from "./smart-delay";
import {
	subscriptionAddHandler,
	subscriptionRemoveHandler,
} from "./subscription-actions";
import { tagAddHandler, tagRemoveHandler } from "./tag-actions";
import { triggerHandler } from "./trigger";
import { userInputHandler } from "./user-input";
import { webhookOutHandler } from "./webhook-out";

import {
	beehiivAddSubscriberHandler,
	beehiivEnrollAutomationHandler,
	beehiivPublishPostHandler,
} from "./platforms/beehiiv";
import {
	blueskyLikeHandler,
	blueskyReplyHandler,
	blueskyRepostHandler,
	blueskySendDmHandler,
} from "./platforms/bluesky";
import {
	discordEditMessageHandler,
	discordReactHandler,
	discordSendAttachmentHandler,
	discordSendComponentsHandler,
	discordSendEmbedHandler,
	discordSendMessageHandler,
	discordStartThreadHandler,
} from "./platforms/discord";
import {
	facebookHideCommentHandler,
	facebookPrivateReplyHandler,
	facebookReplyToCommentHandler,
	facebookSendButtonTemplateHandler,
	facebookSendMediaHandler,
	facebookSendQuickRepliesHandler,
	facebookSendTemplateHandler,
	facebookSendTextHandler,
	facebookSenderActionHandler,
} from "./platforms/facebook";
import {
	googlebusinessPostUpdateHandler,
	googlebusinessReplyToReviewHandler,
} from "./platforms/googlebusiness";
import {
	instagramHideCommentHandler,
	instagramMarkSeenHandler,
	instagramReplyToCommentHandler,
	instagramSendButtonsHandler,
	instagramSendGenericTemplateHandler,
	instagramSendMediaHandler,
	instagramSendQuickRepliesHandler,
	instagramSendTextHandler,
	instagramTypingHandler,
} from "./platforms/instagram";
import {
	kitAddSubscriberHandler,
	kitAddTagHandler,
	kitSendBroadcastHandler,
} from "./platforms/kit";
import {
	linkedinReactToPostHandler,
	linkedinReplyToCommentHandler,
} from "./platforms/linkedin";
import {
	listmonkAddSubscriberHandler,
	listmonkSendCampaignHandler,
} from "./platforms/listmonk";
import {
	mailchimpAddMemberHandler,
	mailchimpAddTagHandler,
	mailchimpSendCampaignHandler,
} from "./platforms/mailchimp";
import {
	mastodonBoostHandler,
	mastodonFavouriteHandler,
	mastodonReplyHandler,
	mastodonSendDmHandler,
} from "./platforms/mastodon";
import { pinterestCreatePinHandler } from "./platforms/pinterest";
import {
	redditReplyModmailHandler,
	redditReplyToCommentHandler,
	redditSendPmHandler,
	redditSubmitPostHandler,
} from "./platforms/reddit";
import { smsSendHandler, smsSendMmsHandler } from "./platforms/sms";
import {
	telegramEditMessageHandler,
	telegramPinMessageHandler,
	telegramReactHandler,
	telegramSendKeyboardHandler,
	telegramSendLocationHandler,
	telegramSendMediaGroupHandler,
	telegramSendMediaHandler,
	telegramSendPollHandler,
	telegramSendTextHandler,
	telegramSetChatActionHandler,
} from "./platforms/telegram";
import {
	threadsHideReplyHandler,
	threadsReplyToPostHandler,
} from "./platforms/threads";
import {
	twitterLikeTweetHandler,
	twitterReplyToTweetHandler,
	twitterRetweetHandler,
	twitterSendDmHandler,
	twitterSendDmMediaHandler,
} from "./platforms/twitter";
import {
	whatsappMarkReadHandler,
	whatsappReactHandler,
	whatsappSendContactsHandler,
	whatsappSendFlowHandler,
	whatsappSendInteractiveHandler,
	whatsappSendLocationHandler,
	whatsappSendMediaHandler,
	whatsappSendTemplateHandler,
	whatsappSendTextHandler,
} from "./platforms/whatsapp";
import {
	youtubeModerateCommentHandler,
	youtubeReplyToCommentHandler,
	youtubeSendLiveChatHandler,
} from "./platforms/youtube";

const universal: Record<string, NodeHandler> = {
	trigger: triggerHandler,
	message_text: messageTextHandler,
	message_media: messageMediaHandler,
	message_file: messageMediaHandler,
	condition: conditionHandler,
	smart_delay: smartDelayHandler,
	randomizer: randomizerHandler,
	split_test: splitTestHandler,
	goto: gotoHandler,
	end: endHandler,
	tag_add: tagAddHandler,
	tag_remove: tagRemoveHandler,
	field_set: fieldSetHandler,
	field_clear: fieldClearHandler,
	subscription_add: subscriptionAddHandler,
	subscription_remove: subscriptionRemoveHandler,
	http_request: httpRequestHandler,
	webhook_out: webhookOutHandler,
	conversation_status: conversationStatusHandler,
	user_input_text: userInputHandler,
	user_input_email: userInputHandler,
	user_input_phone: userInputHandler,
	user_input_number: userInputHandler,
	user_input_date: userInputHandler,
	user_input_choice: userInputHandler,
	user_input_file: userInputHandler,
};

const platformHandlers: Record<string, NodeHandler> = {
	// Instagram
	instagram_send_text: instagramSendTextHandler,
	instagram_send_media: instagramSendMediaHandler,
	instagram_send_buttons: instagramSendButtonsHandler,
	instagram_send_quick_replies: instagramSendQuickRepliesHandler,
	instagram_send_generic_template: instagramSendGenericTemplateHandler,
	instagram_typing: instagramTypingHandler,
	instagram_mark_seen: instagramMarkSeenHandler,
	instagram_reply_to_comment: instagramReplyToCommentHandler,
	instagram_hide_comment: instagramHideCommentHandler,
	// Facebook Messenger
	facebook_send_text: facebookSendTextHandler,
	facebook_send_media: facebookSendMediaHandler,
	facebook_send_template: facebookSendTemplateHandler,
	facebook_send_quick_replies: facebookSendQuickRepliesHandler,
	facebook_send_button_template: facebookSendButtonTemplateHandler,
	facebook_reply_to_comment: facebookReplyToCommentHandler,
	facebook_private_reply: facebookPrivateReplyHandler,
	facebook_hide_comment: facebookHideCommentHandler,
	facebook_sender_action: facebookSenderActionHandler,
	// WhatsApp Cloud API
	whatsapp_send_text: whatsappSendTextHandler,
	whatsapp_send_media: whatsappSendMediaHandler,
	whatsapp_send_template: whatsappSendTemplateHandler,
	whatsapp_send_interactive: whatsappSendInteractiveHandler,
	whatsapp_send_flow: whatsappSendFlowHandler,
	whatsapp_send_location: whatsappSendLocationHandler,
	whatsapp_send_contacts: whatsappSendContactsHandler,
	whatsapp_react: whatsappReactHandler,
	whatsapp_mark_read: whatsappMarkReadHandler,
	// Telegram
	telegram_send_text: telegramSendTextHandler,
	telegram_send_media: telegramSendMediaHandler,
	telegram_send_media_group: telegramSendMediaGroupHandler,
	telegram_send_poll: telegramSendPollHandler,
	telegram_send_location: telegramSendLocationHandler,
	telegram_send_keyboard: telegramSendKeyboardHandler,
	telegram_edit_message: telegramEditMessageHandler,
	telegram_pin_message: telegramPinMessageHandler,
	telegram_react: telegramReactHandler,
	telegram_set_chat_action: telegramSetChatActionHandler,
	// Discord
	discord_send_message: discordSendMessageHandler,
	discord_send_embed: discordSendEmbedHandler,
	discord_send_components: discordSendComponentsHandler,
	discord_send_attachment: discordSendAttachmentHandler,
	discord_react: discordReactHandler,
	discord_edit_message: discordEditMessageHandler,
	discord_start_thread: discordStartThreadHandler,
	// SMS (Twilio / Telnyx)
	sms_send: smsSendHandler,
	sms_send_mms: smsSendMmsHandler,
	// X / Twitter
	twitter_send_dm: twitterSendDmHandler,
	twitter_send_dm_media: twitterSendDmMediaHandler,
	twitter_reply_to_tweet: twitterReplyToTweetHandler,
	twitter_like_tweet: twitterLikeTweetHandler,
	twitter_retweet: twitterRetweetHandler,
	// Bluesky
	bluesky_reply: blueskyReplyHandler,
	bluesky_like: blueskyLikeHandler,
	bluesky_repost: blueskyRepostHandler,
	bluesky_send_dm: blueskySendDmHandler,
	// Threads
	threads_reply_to_post: threadsReplyToPostHandler,
	threads_hide_reply: threadsHideReplyHandler,
	// YouTube
	youtube_reply_to_comment: youtubeReplyToCommentHandler,
	youtube_send_live_chat: youtubeSendLiveChatHandler,
	youtube_moderate_comment: youtubeModerateCommentHandler,
	// LinkedIn
	linkedin_reply_to_comment: linkedinReplyToCommentHandler,
	linkedin_react_to_post: linkedinReactToPostHandler,
	// Mastodon
	mastodon_reply: mastodonReplyHandler,
	mastodon_favourite: mastodonFavouriteHandler,
	mastodon_boost: mastodonBoostHandler,
	mastodon_send_dm: mastodonSendDmHandler,
	// Reddit
	reddit_reply_to_comment: redditReplyToCommentHandler,
	reddit_send_pm: redditSendPmHandler,
	reddit_reply_modmail: redditReplyModmailHandler,
	reddit_submit_post: redditSubmitPostHandler,
	// Google Business Profile
	googlebusiness_reply_to_review: googlebusinessReplyToReviewHandler,
	googlebusiness_post_update: googlebusinessPostUpdateHandler,
	// Beehiiv
	beehiiv_add_subscriber: beehiivAddSubscriberHandler,
	beehiiv_publish_post: beehiivPublishPostHandler,
	beehiiv_enroll_automation: beehiivEnrollAutomationHandler,
	// Kit (ConvertKit v4)
	kit_add_subscriber: kitAddSubscriberHandler,
	kit_add_tag: kitAddTagHandler,
	kit_send_broadcast: kitSendBroadcastHandler,
	// Mailchimp
	mailchimp_add_member: mailchimpAddMemberHandler,
	mailchimp_add_tag: mailchimpAddTagHandler,
	mailchimp_send_campaign: mailchimpSendCampaignHandler,
	// Listmonk
	listmonk_add_subscriber: listmonkAddSubscriberHandler,
	listmonk_send_campaign: listmonkSendCampaignHandler,
	// Pinterest
	pinterest_create_pin: pinterestCreatePinHandler,
};

const notImplemented = (type: string): NodeHandler =>
	async () => ({
		kind: "fail" as const,
		error: `Node type '${type}' is not yet implemented.`,
	});

// Types still waiting on AI infra / logic extras / ops work. These remain as
// stubs so the runner surfaces a clear error rather than silently skipping.
const remainingStubTypes = [
	"ai_step",
	"ai_agent",
	"ai_intent_router",
	"subflow_call",
	"segment_add",
	"segment_remove",
	"notify_admin",
	"conversation_assign",
];

const remainingStubs = Object.fromEntries(
	remainingStubTypes.map((t) => [t, notImplemented(t)]),
);

export const nodeHandlers: Record<string, NodeHandler> = {
	...universal,
	...platformHandlers,
	...remainingStubs,
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
