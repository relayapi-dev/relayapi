import { z } from "@hono/zod-openapi";
import { ErrorResponse, paginatedResponse } from "./common";

// ---------------------------------------------------------------------------
// Enums (kept in sync with packages/db/src/schema.ts pgEnums)
// ---------------------------------------------------------------------------

export const AUTOMATION_TRIGGER_TYPES = [
	// Tier 1: Instagram
	"instagram_dm",
	"instagram_comment",
	"instagram_story_reply",
	"instagram_story_mention",
	"instagram_mention",
	"instagram_reaction",
	"instagram_live_comment",
	"instagram_postback",
	"instagram_referral",
	// Tier 1: Facebook
	"facebook_dm",
	"facebook_comment",
	"facebook_mention",
	"facebook_postback",
	"facebook_reaction",
	"facebook_optin",
	"facebook_feed_post",
	// Tier 1: WhatsApp
	"whatsapp_message",
	"whatsapp_keyword",
	"whatsapp_button_click",
	"whatsapp_list_reply",
	"whatsapp_flow_submit",
	"whatsapp_reaction",
	"whatsapp_status_update",
	// Tier 1: Telegram
	"telegram_message",
	"telegram_command",
	"telegram_channel_post",
	"telegram_callback_query",
	"telegram_reaction",
	"telegram_member_joined",
	"telegram_chat_join_request",
	"telegram_business_message",
	"telegram_inline_query",
	// Tier 1: Discord
	"discord_message",
	"discord_dm",
	"discord_reaction",
	"discord_member_joined",
	"discord_thread_created",
	"discord_interaction",
	// Tier 1: SMS
	"sms_received",
	// Tier 1: X / Twitter
	"twitter_dm",
	"twitter_mention",
	"twitter_reply",
	"twitter_follow",
	"twitter_like",
	"twitter_retweet",
	"twitter_quote",
	// Tier 1: Bluesky
	"bluesky_dm",
	"bluesky_reply",
	"bluesky_mention",
	"bluesky_follow",
	"bluesky_like",
	// Tier 2: Threads
	"threads_reply",
	"threads_mention",
	"threads_publish",
	// Tier 2: YouTube
	"youtube_comment",
	"youtube_live_chat",
	"youtube_new_video",
	// Tier 2: LinkedIn
	"linkedin_comment",
	"linkedin_mention",
	"linkedin_reaction",
	// Tier 2: Mastodon
	"mastodon_mention",
	"mastodon_reply",
	"mastodon_boost",
	"mastodon_follow",
	"mastodon_favourite",
	// Tier 2: Reddit
	"reddit_comment",
	"reddit_mention",
	"reddit_new_post",
	"reddit_modmail",
	"reddit_dm",
	// Tier 2: Google Business Profile
	"googlebusiness_new_review",
	"googlebusiness_updated_review",
	"googlebusiness_new_customer_media",
	"googlebusiness_duplicate_location",
	"googlebusiness_voice_of_merchant_updated",
	"googlebusiness_google_update",
	// Tier 3: Newsletter subscriber triggers
	"beehiiv_subscription_created",
	"beehiiv_subscription_confirmed",
	"beehiiv_subscription_deleted",
	"kit_subscriber_activate",
	"kit_form_subscribe",
	"kit_tag_add",
	"mailchimp_subscribe",
	"mailchimp_unsubscribe",
	// Cross-platform / virtual
	"scheduled_time",
	"engagement_threshold",
	"tag_applied",
	"tag_removed",
	"field_changed",
	"external_api",
	"manual",
	"segment_entered",
	"segment_left",
] as const;

export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];
export const AutomationTriggerTypeEnum = z.enum(AUTOMATION_TRIGGER_TYPES);

export const AUTOMATION_NODE_TYPES = [
	"trigger",
	// Universal content
	"message_text",
	"message_media",
	"message_file",
	// Universal input
	"user_input_text",
	"user_input_email",
	"user_input_phone",
	"user_input_number",
	"user_input_date",
	"user_input_choice",
	"user_input_file",
	// Universal logic
	"condition",
	"smart_delay",
	"randomizer",
	"split_test",
	"goto",
	"end",
	"subflow_call",
	// Universal AI
	"ai_step",
	"ai_agent",
	"ai_intent_router",
	// Universal contact actions
	"tag_add",
	"tag_remove",
	"field_set",
	"field_clear",
	"subscription_add",
	"subscription_remove",
	"segment_add",
	"segment_remove",
	// Universal ops
	"notify_admin",
	"conversation_assign",
	"conversation_status",
	"http_request",
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
	// Facebook Messenger
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
	// X / Twitter
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
] as const;

export type AutomationNodeType = (typeof AUTOMATION_NODE_TYPES)[number];
export const AutomationNodeTypeEnum = z.enum(AUTOMATION_NODE_TYPES);

export const AUTOMATION_CHANNELS = [
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
	"discord",
	"sms",
	"twitter",
	"bluesky",
	"threads",
	"youtube",
	"linkedin",
	"mastodon",
	"reddit",
	"googlebusiness",
	"beehiiv",
	"kit",
	"mailchimp",
	"listmonk",
	"pinterest",
	"multi",
] as const;
export const AutomationChannelEnum = z.enum(AUTOMATION_CHANNELS);

export const AUTOMATION_STATUSES = [
	"draft",
	"active",
	"paused",
	"archived",
] as const;
export const AutomationStatusEnum = z.enum(AUTOMATION_STATUSES);

export const AUTOMATION_ENROLLMENT_STATUSES = [
	"active",
	"waiting",
	"completed",
	"exited",
	"failed",
] as const;
export const AutomationEnrollmentStatusEnum = z.enum(
	AUTOMATION_ENROLLMENT_STATUSES,
);

// ---------------------------------------------------------------------------
// Filter + condition primitives (reused across trigger filters and condition nodes)
// ---------------------------------------------------------------------------

export const FilterPredicate: z.ZodType<{
	field: string;
	op:
		| "eq"
		| "neq"
		| "contains"
		| "not_contains"
		| "starts_with"
		| "ends_with"
		| "gt"
		| "gte"
		| "lt"
		| "lte"
		| "in"
		| "not_in"
		| "exists"
		| "not_exists";
	value?: unknown;
}> = z.object({
	field: z.string().describe("Dot-path (e.g. 'tags', 'fields.email')"),
	op: z.enum([
		"eq",
		"neq",
		"contains",
		"not_contains",
		"starts_with",
		"ends_with",
		"gt",
		"gte",
		"lt",
		"lte",
		"in",
		"not_in",
		"exists",
		"not_exists",
	]),
	value: z.any().optional(),
});

export const FilterGroup = z.object({
	all: z.array(FilterPredicate).optional(),
	any: z.array(FilterPredicate).optional(),
	none: z.array(FilterPredicate).optional(),
});

export const TriggerFilters = z.object({
	tags_any: z.array(z.string()).optional(),
	tags_all: z.array(z.string()).optional(),
	tags_none: z.array(z.string()).optional(),
	segment_id: z.string().optional(),
	predicates: FilterGroup.optional(),
});

// ---------------------------------------------------------------------------
// Trigger config (loose object keyed by trigger type — full per-trigger schemas
// added in Phase 8 per-platform)
// ---------------------------------------------------------------------------

export const TriggerSpec = z.object({
	type: AutomationTriggerTypeEnum,
	account_id: z
		.string()
		.optional()
		.describe("Social account to attach the trigger to"),
	config: z
		.record(z.string(), z.any())
		.optional()
		.describe("Trigger-specific config (keyword list, post_id, ref slug, cron, etc.)"),
	filters: TriggerFilters.optional(),
});

// ---------------------------------------------------------------------------
// Node config — discriminated union keyed by `type`
// Each node accepts a human-chosen `key` that edges reference.
// Field shapes are flat (no nested `config` wrapper) for AI-friendliness.
// ---------------------------------------------------------------------------

const baseNode = {
	key: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
		.describe("Human-chosen identifier used by edges"),
	notes: z.string().optional(),
	canvas_x: z.number().optional(),
	canvas_y: z.number().optional(),
};

const mergeTagString = z
	.string()
	.describe("Supports {{first_name}}, {{contact.email}}, {{state.captured_field}} merge tags");

// -- Universal content --

export const MessageTextNode = z.object({
	...baseNode,
	type: z.literal("message_text"),
	text: mergeTagString,
});

export const MessageMediaNode = z.object({
	...baseNode,
	type: z.literal("message_media"),
	media_id: z.string().optional(),
	url: z.string().url().optional(),
	caption: mergeTagString.optional(),
	media_type: z.enum(["image", "video", "audio"]).default("image"),
});

export const MessageFileNode = z.object({
	...baseNode,
	type: z.literal("message_file"),
	media_id: z.string().optional(),
	url: z.string().url().optional(),
	filename: z.string().optional(),
});

// -- Universal input --

const userInputBase = {
	...baseNode,
	prompt: mergeTagString,
	save_to_field: z.string().describe("Custom field key to persist captured value"),
	retry_prompt: mergeTagString.optional(),
	max_attempts: z.number().int().min(1).max(5).default(2),
	timeout_minutes: z.number().int().min(1).max(60 * 24 * 7).optional(),
};

export const UserInputTextNode = z.object({
	...userInputBase,
	type: z.literal("user_input_text"),
	min_length: z.number().int().optional(),
	max_length: z.number().int().optional(),
});

export const UserInputEmailNode = z.object({
	...userInputBase,
	type: z.literal("user_input_email"),
});

export const UserInputPhoneNode = z.object({
	...userInputBase,
	type: z.literal("user_input_phone"),
	country_code_hint: z.string().length(2).optional(),
});

export const UserInputNumberNode = z.object({
	...userInputBase,
	type: z.literal("user_input_number"),
	min: z.number().optional(),
	max: z.number().optional(),
});

export const UserInputDateNode = z.object({
	...userInputBase,
	type: z.literal("user_input_date"),
	format: z.string().default("YYYY-MM-DD"),
});

export const UserInputChoiceNode = z.object({
	...userInputBase,
	type: z.literal("user_input_choice"),
	choices: z
		.array(z.object({ label: z.string(), value: z.string() }))
		.min(1)
		.max(12),
});

export const UserInputFileNode = z.object({
	...userInputBase,
	type: z.literal("user_input_file"),
	accepted_mime_types: z.array(z.string()).optional(),
	max_size_mb: z.number().default(16),
});

// -- Universal logic --

export const ConditionNode = z.object({
	...baseNode,
	type: z.literal("condition"),
	if: FilterGroup.describe("Edges 'yes' taken if matches, 'no' otherwise"),
});

export const SmartDelayNode = z.object({
	...baseNode,
	type: z.literal("smart_delay"),
	duration_minutes: z.number().int().min(1),
	quiet_hours: z
		.object({
			start: z.string().regex(/^\d{2}:\d{2}$/),
			end: z.string().regex(/^\d{2}:\d{2}$/),
			timezone: z.string().default("UTC"),
		})
		.optional(),
});

export const RandomizerNode = z.object({
	...baseNode,
	type: z.literal("randomizer"),
	branches: z
		.array(
			z.object({
				label: z.string(),
				weight: z.number().int().min(1).default(1),
			}),
		)
		.min(2)
		.max(12),
});

export const SplitTestNode = z.object({
	...baseNode,
	type: z.literal("split_test"),
	variants: z
		.array(
			z.object({
				label: z.string(),
				weight: z.number().int().min(1).default(50),
			}),
		)
		.min(2),
	goal_field: z.string().optional().describe("Field to track as conversion goal"),
});

export const GotoNode = z.object({
	...baseNode,
	type: z.literal("goto"),
	target_node_key: z.string(),
});

export const EndNode = z.object({
	...baseNode,
	type: z.literal("end"),
	reason: z.string().optional(),
});

export const SubflowCallNode = z.object({
	...baseNode,
	type: z.literal("subflow_call"),
	automation_id: z.string(),
	pass_state: z.boolean().default(false),
});

// -- Universal AI --

export const AIStepNode = z.object({
	...baseNode,
	type: z.literal("ai_step"),
	model: z.string().default("claude-haiku-4-5"),
	system_prompt: z.string(),
	temperature: z.number().min(0).max(2).default(0.7),
	max_tokens: z.number().int().default(1024),
	save_to_field: z.string().optional(),
});

export const AIAgentNode = z.object({
	...baseNode,
	type: z.literal("ai_agent"),
	agent_id: z.string(),
	max_turns: z.number().int().min(1).max(10).default(5),
	handoff_labels: z
		.array(z.string())
		.optional()
		.describe("Edge labels possible: 'handoff', 'complete', 'escalate'"),
});

export const AIIntentRouterNode = z.object({
	...baseNode,
	type: z.literal("ai_intent_router"),
	model: z.string().default("claude-haiku-4-5"),
	intents: z
		.array(z.object({ label: z.string(), description: z.string() }))
		.min(2)
		.max(10),
});

// -- Universal contact actions --

export const TagAddNode = z.object({
	...baseNode,
	type: z.literal("tag_add"),
	tag: z.string(),
});

export const TagRemoveNode = z.object({
	...baseNode,
	type: z.literal("tag_remove"),
	tag: z.string(),
});

export const FieldSetNode = z.object({
	...baseNode,
	type: z.literal("field_set"),
	field: z.string(),
	value: z.any(),
});

export const FieldClearNode = z.object({
	...baseNode,
	type: z.literal("field_clear"),
	field: z.string(),
});

export const SubscriptionAddNode = z.object({
	...baseNode,
	type: z.literal("subscription_add"),
	list_id: z.string(),
});

export const SubscriptionRemoveNode = z.object({
	...baseNode,
	type: z.literal("subscription_remove"),
	list_id: z.string(),
});

export const SegmentAddNode = z.object({
	...baseNode,
	type: z.literal("segment_add"),
	segment_id: z.string(),
});

export const SegmentRemoveNode = z.object({
	...baseNode,
	type: z.literal("segment_remove"),
	segment_id: z.string(),
});

// -- Universal ops --

export const NotifyAdminNode = z.object({
	...baseNode,
	type: z.literal("notify_admin"),
	channel: z.enum(["email", "in_app", "webhook"]).default("in_app"),
	recipients: z.array(z.string()).optional(),
	title: z.string(),
	body: mergeTagString,
});

export const ConversationAssignNode = z.object({
	...baseNode,
	type: z.literal("conversation_assign"),
	assignee_user_id: z.string().optional(),
	assignee_team_id: z.string().optional(),
});

export const ConversationStatusNode = z.object({
	...baseNode,
	type: z.literal("conversation_status"),
	status: z.enum(["open", "pending", "resolved", "closed"]),
});

export const HttpRequestNode = z.object({
	...baseNode,
	type: z.literal("http_request"),
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
	url: z.string().url(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.any().optional(),
	timeout_ms: z.number().int().default(10000),
	save_response_to_field: z.string().optional(),
	json_path: z
		.string()
		.optional()
		.describe("JSONPath expression to extract value from response"),
});

export const WebhookOutNode = z.object({
	...baseNode,
	type: z.literal("webhook_out"),
	endpoint_id: z.string().describe("RelayAPI webhook endpoint ID"),
	event: z.string(),
	payload: z.any().optional(),
});

// -- Platform-specific sends --
//
// Every platform node type below is a proper Zod object that mirrors the
// handler expectations in apps/api/src/services/automations/nodes/platforms/.
// Breaking changes to a handler should include an update here so create-time
// validation stays aligned with runtime behaviour.

// -- Instagram --

const ButtonSpec = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("postback"),
		title: z.string(),
		payload: z.string().optional(),
	}),
	z.object({
		type: z.literal("web_url"),
		title: z.string(),
		url: z.string().url(),
	}),
]);

const QuickReplySpec = z.object({
	title: z.string(),
	payload: z.string().optional(),
});

export const InstagramSendTextNode = z.object({
	...baseNode,
	type: z.literal("instagram_send_text"),
	text: mergeTagString,
});

export const InstagramSendMediaNode = z.object({
	...baseNode,
	type: z.literal("instagram_send_media"),
	url: z.string().url(),
	media_type: z.enum(["image", "video", "audio"]).default("image"),
});

export const InstagramSendButtonsNode = z.object({
	...baseNode,
	type: z.literal("instagram_send_buttons"),
	text: mergeTagString,
	buttons: z.array(ButtonSpec).min(1).max(3),
});

export const InstagramSendQuickRepliesNode = z.object({
	...baseNode,
	type: z.literal("instagram_send_quick_replies"),
	text: mergeTagString,
	quick_replies: z.array(QuickReplySpec).min(1).max(13),
});

export const InstagramSendGenericTemplateNode = z.object({
	...baseNode,
	type: z.literal("instagram_send_generic_template"),
	elements: z
		.array(
			z.object({
				title: z.string(),
				subtitle: z.string().optional(),
				image_url: z.string().url().optional(),
				buttons: z.array(ButtonSpec).optional(),
			}),
		)
		.min(1)
		.max(10),
});

export const InstagramTypingNode = z.object({
	...baseNode,
	type: z.literal("instagram_typing"),
	off: z.boolean().default(false),
});

export const InstagramMarkSeenNode = z.object({
	...baseNode,
	type: z.literal("instagram_mark_seen"),
});

export const InstagramReplyToCommentNode = z.object({
	...baseNode,
	type: z.literal("instagram_reply_to_comment"),
	text: mergeTagString,
	comment_id: z
		.string()
		.optional()
		.describe("Defaults to enrollment state.comment_id from the trigger payload"),
});

export const InstagramHideCommentNode = z.object({
	...baseNode,
	type: z.literal("instagram_hide_comment"),
	comment_id: z.string().optional(),
});

// -- Facebook Messenger --

export const FacebookSendTextNode = z.object({
	...baseNode,
	type: z.literal("facebook_send_text"),
	text: mergeTagString,
});

export const FacebookSendMediaNode = z.object({
	...baseNode,
	type: z.literal("facebook_send_media"),
	url: z.string().url(),
	media_type: z.enum(["image", "video", "audio", "file"]).default("image"),
});

export const FacebookSendTemplateNode = z.object({
	...baseNode,
	type: z.literal("facebook_send_template"),
	payload: z.record(z.string(), z.any()),
});

export const FacebookSendQuickRepliesNode = z.object({
	...baseNode,
	type: z.literal("facebook_send_quick_replies"),
	text: mergeTagString,
	quick_replies: z.array(QuickReplySpec).min(1).max(13),
});

export const FacebookSendButtonTemplateNode = z.object({
	...baseNode,
	type: z.literal("facebook_send_button_template"),
	text: mergeTagString,
	buttons: z.array(ButtonSpec).min(1).max(3),
});

export const FacebookReplyToCommentNode = z.object({
	...baseNode,
	type: z.literal("facebook_reply_to_comment"),
	message: mergeTagString,
	comment_id: z.string().optional(),
});

export const FacebookPrivateReplyNode = z.object({
	...baseNode,
	type: z.literal("facebook_private_reply"),
	text: mergeTagString,
	comment_id: z.string().optional(),
});

export const FacebookHideCommentNode = z.object({
	...baseNode,
	type: z.literal("facebook_hide_comment"),
	comment_id: z.string().optional(),
});

export const FacebookSenderActionNode = z.object({
	...baseNode,
	type: z.literal("facebook_sender_action"),
	action: z.enum(["typing_on", "typing_off", "mark_seen"]).default("typing_on"),
});

// -- WhatsApp Cloud API --

const WhatsAppButtonSpec = z.object({
	id: z.string(),
	title: z.string(),
});

const WhatsAppListSpec = z.object({
	button: z.string(),
	sections: z
		.array(
			z.object({
				title: z.string().optional(),
				rows: z
					.array(
						z.object({
							id: z.string(),
							title: z.string(),
							description: z.string().optional(),
						}),
					)
					.min(1),
			}),
		)
		.min(1),
});

export const WhatsAppSendTextNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_send_text"),
	text: mergeTagString,
	preview_url: z.boolean().default(false),
});

export const WhatsAppSendMediaNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_send_media"),
	url: z.string().url(),
	caption: mergeTagString.optional(),
	media_type: z
		.enum(["image", "video", "audio", "document", "sticker"])
		.default("image"),
});

export const WhatsAppSendTemplateNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_send_template"),
	template_name: z.string(),
	language: z.string().default("en_US"),
	components: z.array(z.any()).optional(),
});

export const WhatsAppSendInteractiveNode = z
	.object({
		...baseNode,
		type: z.literal("whatsapp_send_interactive"),
		text: mergeTagString,
		buttons: z.array(WhatsAppButtonSpec).max(3).optional(),
		list: WhatsAppListSpec.optional(),
	})
	.refine((v) => v.buttons?.length || v.list, {
		message: "whatsapp_send_interactive needs either 'buttons' or 'list'",
	});

export const WhatsAppSendFlowNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_send_flow"),
	flow_id: z.string(),
	flow_token: z.string(),
	cta: z.string().default("Open"),
	text: mergeTagString,
	flow_action: z.string().optional(),
});

export const WhatsAppSendLocationNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_send_location"),
	latitude: z.number(),
	longitude: z.number(),
	name: z.string().optional(),
	address: z.string().optional(),
});

export const WhatsAppSendContactsNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_send_contacts"),
	contacts: z.array(z.any()).min(1),
});

export const WhatsAppReactNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_react"),
	emoji: z.string(),
	message_id: z.string().optional(),
});

export const WhatsAppMarkReadNode = z.object({
	...baseNode,
	type: z.literal("whatsapp_mark_read"),
	message_id: z.string().optional(),
});

// -- Telegram --

const TelegramKeyboardButton = z.object({
	text: z.string(),
	callback_data: z.string().optional(),
	url: z.string().url().optional(),
});

export const TelegramSendTextNode = z.object({
	...baseNode,
	type: z.literal("telegram_send_text"),
	text: mergeTagString,
	parse_mode: z.enum(["MarkdownV2", "Markdown", "HTML"]).optional(),
	disable_web_page_preview: z.boolean().optional(),
});

export const TelegramSendMediaNode = z.object({
	...baseNode,
	type: z.literal("telegram_send_media"),
	url: z.string().url(),
	caption: mergeTagString.optional(),
	media_type: z
		.enum(["image", "video", "audio", "document"])
		.default("image"),
});

export const TelegramSendMediaGroupNode = z.object({
	...baseNode,
	type: z.literal("telegram_send_media_group"),
	media: z
		.array(
			z.object({
				type: z.enum(["photo", "video", "audio", "document"]),
				url: z.string().url(),
				caption: mergeTagString.optional(),
			}),
		)
		.min(2)
		.max(10),
});

export const TelegramSendPollNode = z.object({
	...baseNode,
	type: z.literal("telegram_send_poll"),
	question: z.string(),
	options: z.array(z.string()).min(2).max(10),
	is_anonymous: z.boolean().default(true),
	allows_multiple_answers: z.boolean().default(false),
});

export const TelegramSendLocationNode = z.object({
	...baseNode,
	type: z.literal("telegram_send_location"),
	latitude: z.number(),
	longitude: z.number(),
});

export const TelegramSendKeyboardNode = z.object({
	...baseNode,
	type: z.literal("telegram_send_keyboard"),
	text: mergeTagString,
	buttons: z.array(z.array(TelegramKeyboardButton).min(1)).min(1),
});

export const TelegramEditMessageNode = z.object({
	...baseNode,
	type: z.literal("telegram_edit_message"),
	text: mergeTagString,
	message_id: z.string().optional(),
});

export const TelegramPinMessageNode = z.object({
	...baseNode,
	type: z.literal("telegram_pin_message"),
	message_id: z.string().optional(),
	disable_notification: z.boolean().default(true),
});

export const TelegramReactNode = z.object({
	...baseNode,
	type: z.literal("telegram_react"),
	emoji: z.string(),
	message_id: z.string().optional(),
});

export const TelegramSetChatActionNode = z.object({
	...baseNode,
	type: z.literal("telegram_set_chat_action"),
	action: z
		.enum([
			"typing",
			"upload_photo",
			"record_video",
			"upload_video",
			"record_voice",
			"upload_voice",
			"upload_document",
			"choose_sticker",
			"find_location",
			"record_video_note",
			"upload_video_note",
		])
		.default("typing"),
});

// -- Discord --

export const DiscordSendMessageNode = z.object({
	...baseNode,
	type: z.literal("discord_send_message"),
	content: mergeTagString,
	channel_id: z.string().optional(),
});

export const DiscordSendEmbedNode = z.object({
	...baseNode,
	type: z.literal("discord_send_embed"),
	embeds: z.array(z.any()).min(1).max(10),
	channel_id: z.string().optional(),
});

export const DiscordSendComponentsNode = z.object({
	...baseNode,
	type: z.literal("discord_send_components"),
	content: mergeTagString.optional(),
	components: z.array(z.any()).min(1),
	channel_id: z.string().optional(),
});

export const DiscordSendAttachmentNode = z.object({
	...baseNode,
	type: z.literal("discord_send_attachment"),
	url: z.string().url(),
	content: mergeTagString.optional(),
	channel_id: z.string().optional(),
});

export const DiscordReactNode = z.object({
	...baseNode,
	type: z.literal("discord_react"),
	emoji: z.string(),
	message_id: z.string().optional(),
	channel_id: z.string().optional(),
});

export const DiscordEditMessageNode = z.object({
	...baseNode,
	type: z.literal("discord_edit_message"),
	content: mergeTagString,
	message_id: z.string().optional(),
	channel_id: z.string().optional(),
});

export const DiscordStartThreadNode = z.object({
	...baseNode,
	type: z.literal("discord_start_thread"),
	name: z.string().min(1).max(100),
	auto_archive_duration: z.number().int().default(60),
	message_id: z.string().optional(),
	channel_id: z.string().optional(),
});

// -- SMS (Twilio / Telnyx provider-abstracted) --

export const SmsSendNode = z.object({
	...baseNode,
	type: z.literal("sms_send"),
	text: mergeTagString,
});

export const SmsSendMmsNode = z.object({
	...baseNode,
	type: z.literal("sms_send_mms"),
	text: mergeTagString.optional(),
	media_url: z.string().url(),
});

// -- X / Twitter --

export const TwitterSendDmNode = z.object({
	...baseNode,
	type: z.literal("twitter_send_dm"),
	text: mergeTagString,
});

export const TwitterSendDmMediaNode = z.object({
	...baseNode,
	type: z.literal("twitter_send_dm_media"),
	text: mergeTagString.optional(),
	media_id: z.string(),
});

export const TwitterReplyToTweetNode = z.object({
	...baseNode,
	type: z.literal("twitter_reply_to_tweet"),
	text: mergeTagString,
	tweet_id: z.string().optional(),
});

export const TwitterLikeTweetNode = z.object({
	...baseNode,
	type: z.literal("twitter_like_tweet"),
	tweet_id: z.string().optional(),
});

export const TwitterRetweetNode = z.object({
	...baseNode,
	type: z.literal("twitter_retweet"),
	tweet_id: z.string().optional(),
});

// -- Bluesky (AT Protocol) --

export const BlueskyReplyNode = z.object({
	...baseNode,
	type: z.literal("bluesky_reply"),
	text: mergeTagString,
	parent_uri: z.string().optional(),
	parent_cid: z.string().optional(),
});

export const BlueskyLikeNode = z.object({
	...baseNode,
	type: z.literal("bluesky_like"),
	subject_uri: z.string().optional(),
	subject_cid: z.string().optional(),
});

export const BlueskyRepostNode = z.object({
	...baseNode,
	type: z.literal("bluesky_repost"),
	subject_uri: z.string().optional(),
	subject_cid: z.string().optional(),
});

export const BlueskySendDmNode = z.object({
	...baseNode,
	type: z.literal("bluesky_send_dm"),
	text: mergeTagString,
});

// -- Threads --

export const ThreadsReplyToPostNode = z.object({
	...baseNode,
	type: z.literal("threads_reply_to_post"),
	text: mergeTagString,
	reply_to_id: z.string().optional(),
});

export const ThreadsHideReplyNode = z.object({
	...baseNode,
	type: z.literal("threads_hide_reply"),
	reply_id: z.string().optional(),
});

// -- YouTube --

export const YoutubeReplyToCommentNode = z.object({
	...baseNode,
	type: z.literal("youtube_reply_to_comment"),
	text: mergeTagString,
	parent_id: z.string().optional(),
});

export const YoutubeSendLiveChatNode = z.object({
	...baseNode,
	type: z.literal("youtube_send_live_chat"),
	text: mergeTagString,
	live_chat_id: z.string().optional(),
});

export const YoutubeModerateCommentNode = z.object({
	...baseNode,
	type: z.literal("youtube_moderate_comment"),
	comment_id: z.string().optional(),
	moderation_status: z
		.enum(["heldForReview", "published", "rejected"])
		.default("heldForReview"),
});

// -- LinkedIn --

export const LinkedinReplyToCommentNode = z.object({
	...baseNode,
	type: z.literal("linkedin_reply_to_comment"),
	text: mergeTagString,
	share_urn: z.string().optional(),
});

export const LinkedinReactToPostNode = z.object({
	...baseNode,
	type: z.literal("linkedin_react_to_post"),
	reaction: z
		.enum([
			"LIKE",
			"PRAISE",
			"MAYBE",
			"EMPATHY",
			"INTEREST",
			"APPRECIATION",
			"ENTERTAINMENT",
		])
		.default("LIKE"),
	share_urn: z.string().optional(),
});

// -- Mastodon --

export const MastodonReplyNode = z.object({
	...baseNode,
	type: z.literal("mastodon_reply"),
	text: mergeTagString,
	in_reply_to_id: z.string().optional(),
	visibility: z
		.enum(["public", "unlisted", "private", "direct"])
		.default("public"),
});

export const MastodonFavouriteNode = z.object({
	...baseNode,
	type: z.literal("mastodon_favourite"),
	status_id: z.string().optional(),
});

export const MastodonBoostNode = z.object({
	...baseNode,
	type: z.literal("mastodon_boost"),
	status_id: z.string().optional(),
});

export const MastodonSendDmNode = z.object({
	...baseNode,
	type: z.literal("mastodon_send_dm"),
	text: mergeTagString,
});

// -- Reddit --

export const RedditReplyToCommentNode = z.object({
	...baseNode,
	type: z.literal("reddit_reply_to_comment"),
	text: mergeTagString,
	thing_id: z
		.string()
		.optional()
		.describe("Reddit fullname prefix (e.g. t1_... for comments, t3_... for posts)"),
});

export const RedditSendPmNode = z.object({
	...baseNode,
	type: z.literal("reddit_send_pm"),
	to: z.string(),
	subject: z.string().default("Hi"),
	text: mergeTagString,
});

export const RedditReplyModmailNode = z.object({
	...baseNode,
	type: z.literal("reddit_reply_modmail"),
	body: mergeTagString,
	conversation_id: z.string().optional(),
	is_author_hidden: z.boolean().default(false),
	is_internal: z.boolean().default(false),
});

export const RedditSubmitPostNode = z
	.object({
		...baseNode,
		type: z.literal("reddit_submit_post"),
		subreddit: z.string(),
		title: z.string().max(300),
		text: mergeTagString.optional(),
		url: z.string().url().optional(),
	})
	.refine((v) => v.text || v.url, {
		message: "reddit_submit_post needs either text (self post) or url (link post)",
	});

// -- Google Business Profile --

export const GoogleBusinessReplyToReviewNode = z.object({
	...baseNode,
	type: z.literal("googlebusiness_reply_to_review"),
	comment: mergeTagString,
	review_name: z.string().optional(),
});

export const GoogleBusinessPostUpdateNode = z.object({
	...baseNode,
	type: z.literal("googlebusiness_post_update"),
	summary: mergeTagString,
	language_code: z.string().default("en"),
	topic_type: z.enum(["STANDARD", "EVENT", "OFFER", "ALERT"]).default("STANDARD"),
	media_url: z.string().url().optional(),
	call_to_action: z
		.object({
			actionType: z.enum([
				"BOOK",
				"ORDER",
				"SHOP",
				"LEARN_MORE",
				"SIGN_UP",
				"CALL",
			]),
			url: z.string().url().optional(),
		})
		.optional(),
});

// -- Beehiiv --

export const BeehiivAddSubscriberNode = z.object({
	...baseNode,
	type: z.literal("beehiiv_add_subscriber"),
	email: z.string().email(),
	reactivate_existing: z.boolean().default(true),
	send_welcome_email: z.boolean().default(false),
	utm_source: z.string().default("automation"),
	utm_campaign: z.string().optional(),
	referring_site: z.string().optional(),
});

export const BeehiivPublishPostNode = z.object({
	...baseNode,
	type: z.literal("beehiiv_publish_post"),
	post_id: z.string(),
});

export const BeehiivEnrollAutomationNode = z.object({
	...baseNode,
	type: z.literal("beehiiv_enroll_automation"),
	email: z.string().email(),
	automation_id: z.string(),
});

// -- Kit (ConvertKit v4) --

export const KitAddSubscriberNode = z.object({
	...baseNode,
	type: z.literal("kit_add_subscriber"),
	email: z.string().email(),
	first_name: z.string().optional(),
});

export const KitAddTagNode = z.object({
	...baseNode,
	type: z.literal("kit_add_tag"),
	tag_id: z.string(),
	email: z.string().email(),
});

export const KitSendBroadcastNode = z.object({
	...baseNode,
	type: z.literal("kit_send_broadcast"),
	broadcast_id: z.string(),
});

// -- Mailchimp --

export const MailchimpAddMemberNode = z.object({
	...baseNode,
	type: z.literal("mailchimp_add_member"),
	email: z.string().email(),
	double_optin: z.boolean().default(false),
	merge_fields: z.record(z.string(), z.any()).optional(),
});

export const MailchimpAddTagNode = z.object({
	...baseNode,
	type: z.literal("mailchimp_add_tag"),
	email: z.string().email(),
	tag: z.string(),
});

export const MailchimpSendCampaignNode = z.object({
	...baseNode,
	type: z.literal("mailchimp_send_campaign"),
	campaign_id: z.string(),
});

// -- Listmonk (self-hosted) --

export const ListmonkAddSubscriberNode = z.object({
	...baseNode,
	type: z.literal("listmonk_add_subscriber"),
	email: z.string().email(),
	name: z.string().optional(),
	list_ids: z.array(z.number().int()).optional(),
	attribs: z.record(z.string(), z.any()).optional(),
});

export const ListmonkSendCampaignNode = z.object({
	...baseNode,
	type: z.literal("listmonk_send_campaign"),
	campaign_id: z.union([z.string(), z.number().int()]),
});

// -- Pinterest --

export const PinterestCreatePinNode = z.object({
	...baseNode,
	type: z.literal("pinterest_create_pin"),
	board_id: z.string(),
	image_url: z.string().url(),
	title: mergeTagString,
	description: mergeTagString.optional(),
	link: z.string().url().optional(),
});

// ---------------------------------------------------------------------------
// Discriminated union of all node types
// ---------------------------------------------------------------------------

export const AutomationNodeSpec = z.discriminatedUnion("type", [
	z.object({ ...baseNode, type: z.literal("trigger") }),
	MessageTextNode,
	MessageMediaNode,
	MessageFileNode,
	UserInputTextNode,
	UserInputEmailNode,
	UserInputPhoneNode,
	UserInputNumberNode,
	UserInputDateNode,
	UserInputChoiceNode,
	UserInputFileNode,
	ConditionNode,
	SmartDelayNode,
	RandomizerNode,
	SplitTestNode,
	GotoNode,
	EndNode,
	SubflowCallNode,
	AIStepNode,
	AIAgentNode,
	AIIntentRouterNode,
	TagAddNode,
	TagRemoveNode,
	FieldSetNode,
	FieldClearNode,
	SubscriptionAddNode,
	SubscriptionRemoveNode,
	SegmentAddNode,
	SegmentRemoveNode,
	NotifyAdminNode,
	ConversationAssignNode,
	ConversationStatusNode,
	HttpRequestNode,
	WebhookOutNode,
	// Instagram (9)
	InstagramSendTextNode,
	InstagramSendMediaNode,
	InstagramSendButtonsNode,
	InstagramSendQuickRepliesNode,
	InstagramSendGenericTemplateNode,
	InstagramTypingNode,
	InstagramMarkSeenNode,
	InstagramReplyToCommentNode,
	InstagramHideCommentNode,
	// Facebook (9)
	FacebookSendTextNode,
	FacebookSendMediaNode,
	FacebookSendTemplateNode,
	FacebookSendQuickRepliesNode,
	FacebookSendButtonTemplateNode,
	FacebookReplyToCommentNode,
	FacebookPrivateReplyNode,
	FacebookHideCommentNode,
	FacebookSenderActionNode,
	// WhatsApp (9)
	WhatsAppSendTextNode,
	WhatsAppSendMediaNode,
	WhatsAppSendTemplateNode,
	WhatsAppSendInteractiveNode,
	WhatsAppSendFlowNode,
	WhatsAppSendLocationNode,
	WhatsAppSendContactsNode,
	WhatsAppReactNode,
	WhatsAppMarkReadNode,
	// Telegram (10)
	TelegramSendTextNode,
	TelegramSendMediaNode,
	TelegramSendMediaGroupNode,
	TelegramSendPollNode,
	TelegramSendLocationNode,
	TelegramSendKeyboardNode,
	TelegramEditMessageNode,
	TelegramPinMessageNode,
	TelegramReactNode,
	TelegramSetChatActionNode,
	// Discord (7)
	DiscordSendMessageNode,
	DiscordSendEmbedNode,
	DiscordSendComponentsNode,
	DiscordSendAttachmentNode,
	DiscordReactNode,
	DiscordEditMessageNode,
	DiscordStartThreadNode,
	// SMS (2)
	SmsSendNode,
	SmsSendMmsNode,
	// X / Twitter (5)
	TwitterSendDmNode,
	TwitterSendDmMediaNode,
	TwitterReplyToTweetNode,
	TwitterLikeTweetNode,
	TwitterRetweetNode,
	// Bluesky (4)
	BlueskyReplyNode,
	BlueskyLikeNode,
	BlueskyRepostNode,
	BlueskySendDmNode,
	// Threads (2)
	ThreadsReplyToPostNode,
	ThreadsHideReplyNode,
	// YouTube (3)
	YoutubeReplyToCommentNode,
	YoutubeSendLiveChatNode,
	YoutubeModerateCommentNode,
	// LinkedIn (2)
	LinkedinReplyToCommentNode,
	LinkedinReactToPostNode,
	// Mastodon (4)
	MastodonReplyNode,
	MastodonFavouriteNode,
	MastodonBoostNode,
	MastodonSendDmNode,
	// Reddit (4)
	RedditReplyToCommentNode,
	RedditSendPmNode,
	RedditReplyModmailNode,
	RedditSubmitPostNode,
	// Google Business Profile (2)
	GoogleBusinessReplyToReviewNode,
	GoogleBusinessPostUpdateNode,
	// Beehiiv (3)
	BeehiivAddSubscriberNode,
	BeehiivPublishPostNode,
	BeehiivEnrollAutomationNode,
	// Kit (3)
	KitAddSubscriberNode,
	KitAddTagNode,
	KitSendBroadcastNode,
	// Mailchimp (3)
	MailchimpAddMemberNode,
	MailchimpAddTagNode,
	MailchimpSendCampaignNode,
	// Listmonk (2)
	ListmonkAddSubscriberNode,
	ListmonkSendCampaignNode,
	// Pinterest (1)
	PinterestCreatePinNode,
]);

export type AutomationNodeSpec = z.infer<typeof AutomationNodeSpec>;

// ---------------------------------------------------------------------------
// Edge spec — references nodes by `key`, not id
// ---------------------------------------------------------------------------

export const AutomationEdgeSpec = z.object({
	from: z
		.string()
		.describe("Source node key. Use 'trigger' to reference the virtual entry node"),
	to: z.string().describe("Target node key"),
	label: z
		.string()
		.default("next")
		.describe("'next' | 'yes' | 'no' | 'branch_N' | 'captured' | 'no_match' | 'timeout' | 'handoff'"),
	order: z.number().int().default(0),
	condition_expr: z.any().optional(),
});

export type AutomationEdgeSpec = z.infer<typeof AutomationEdgeSpec>;

// ---------------------------------------------------------------------------
// Full automation create/update spec — the single-blob payload
// ---------------------------------------------------------------------------

export const AutomationCreateSpec = z.object({
	name: z.string().min(1).max(200),
	description: z.string().optional(),
	workspace_id: z.string().optional(),
	channel: AutomationChannelEnum,
	status: AutomationStatusEnum.default("draft"),
	trigger: TriggerSpec,
	nodes: z.array(AutomationNodeSpec).min(1),
	edges: z.array(AutomationEdgeSpec).default([]),
	exit_on_reply: z.boolean().default(true),
	allow_reentry: z.boolean().default(false),
	reentry_cooldown_min: z.number().int().optional(),
});

export type AutomationCreateSpec = z.infer<typeof AutomationCreateSpec>;

export const AutomationUpdateSpec = AutomationCreateSpec.partial();

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export const AutomationResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	status: AutomationStatusEnum,
	channel: AutomationChannelEnum,
	trigger_type: AutomationTriggerTypeEnum,
	trigger_config: z.any(),
	trigger_filters: z.any(),
	social_account_id: z.string().nullable(),
	entry_node_id: z.string().nullable(),
	version: z.number().int(),
	published_version: z.number().int().nullable(),
	exit_on_reply: z.boolean(),
	allow_reentry: z.boolean(),
	reentry_cooldown_min: z.number().int().nullable(),
	total_enrolled: z.number().int(),
	total_completed: z.number().int(),
	total_exited: z.number().int(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const AutomationWithGraphResponse = AutomationResponse.extend({
	nodes: z.array(
		z.object({
			id: z.string(),
			key: z.string(),
			type: AutomationNodeTypeEnum,
			config: z.any(),
			canvas_x: z.number().nullable(),
			canvas_y: z.number().nullable(),
			notes: z.string().nullable(),
		}),
	),
	edges: z.array(
		z.object({
			id: z.string(),
			from_node_key: z.string(),
			to_node_key: z.string(),
			label: z.string(),
			order: z.number().int(),
			condition_expr: z.any().nullable(),
		}),
	),
});

export const AutomationListResponse = paginatedResponse(AutomationResponse);

export const AutomationRunLogResponse = z.object({
	id: z.string(),
	enrollment_id: z.string(),
	node_id: z.string().nullable(),
	node_type: AutomationNodeTypeEnum.nullable(),
	executed_at: z.string().datetime(),
	outcome: z.string(),
	branch_label: z.string().nullable(),
	duration_ms: z.number().int().nullable(),
	error: z.string().nullable(),
	payload: z.any().nullable(),
});

export const AutomationEnrollmentResponse = z.object({
	id: z.string(),
	automation_id: z.string(),
	automation_version: z.number().int(),
	contact_id: z.string().nullable(),
	conversation_id: z.string().nullable(),
	current_node_id: z.string().nullable(),
	state: z.any(),
	status: AutomationEnrollmentStatusEnum,
	next_run_at: z.string().datetime().nullable(),
	enrolled_at: z.string().datetime(),
	completed_at: z.string().datetime().nullable(),
	exited_at: z.string().datetime().nullable(),
	exit_reason: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Template quick-create payloads (Phase 3 — shorthand APIs for common flows)
// ---------------------------------------------------------------------------

export const CommentToDmTemplateInput = z.object({
	name: z.string().min(1).max(200),
	workspace_id: z.string().optional(),
	account_id: z.string(),
	post_id: z
		.string()
		.nullable()
		.optional()
		.describe("null = match all posts on the account"),
	keywords: z.array(z.string()).min(1).max(50),
	match_mode: z.enum(["contains", "exact"]).default("contains"),
	dm_message: z.string(),
	public_reply: z.string().optional(),
	once_per_user: z.boolean().default(true),
});

export const WelcomeDmTemplateInput = z.object({
	name: z.string().min(1).max(200),
	workspace_id: z.string().optional(),
	account_id: z.string(),
	channel: z.enum(["instagram", "facebook", "whatsapp"]),
	welcome_message: z.string(),
});

export const KeywordReplyTemplateInput = z.object({
	name: z.string().min(1).max(200),
	workspace_id: z.string().optional(),
	account_id: z.string(),
	channel: AutomationChannelEnum,
	keywords: z.array(z.string()).min(1),
	match_mode: z.enum(["contains", "exact"]).default("contains"),
	reply_message: z.string(),
});

export const FollowToDmTemplateInput = z.object({
	name: z.string().min(1).max(200),
	workspace_id: z.string().optional(),
	account_id: z.string(),
	welcome_message: z.string(),
});

export const StoryReplyTemplateInput = z.object({
	name: z.string().min(1).max(200),
	workspace_id: z.string().optional(),
	account_id: z.string(),
	dm_message: z.string(),
});

export const GiveawayTemplateInput = z.object({
	name: z.string().min(1).max(200),
	workspace_id: z.string().optional(),
	account_id: z.string(),
	channel: z.enum(["instagram", "facebook"]),
	post_id: z.string().optional(),
	entry_keywords: z.array(z.string()).min(1),
	entry_tag: z.string().default("giveaway_entry"),
	confirmation_dm: z.string(),
});

// ---------------------------------------------------------------------------
// Schema introspection response (GET /v1/automations/schema)
// Self-describing catalog for MCP / AI agents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Simulate — static graph traversal for the dashboard Playground / agents.
// No handlers execute; no side effects.
// ---------------------------------------------------------------------------

export const AutomationSimulateRequest = z.object({
	version: z
		.number()
		.int()
		.optional()
		.describe(
			"Version to simulate. Defaults to the current draft (falls back to published).",
		),
	branch_choices: z
		.record(z.string(), z.string())
		.optional()
		.describe("Map of node_key → branch label to force on branching nodes"),
	max_steps: z.number().int().min(1).max(200).default(50),
});

export const AutomationSimulateResponse = z.object({
	automation_id: z.string(),
	version: z.number().int(),
	path: z.array(
		z.object({
			node_id: z.string(),
			node_key: z.string(),
			node_type: z.string(),
			branch_label: z.string().nullable(),
			note: z.string().nullable(),
		}),
	),
	terminated: z.object({
		kind: z.enum([
			"complete",
			"exit",
			"step_cap",
			"dead_end",
			"cycle",
			"unknown_node",
		]),
		reason: z.string().optional(),
		node_key: z.string().optional(),
	}),
});

export const AutomationSchemaResponse = z.object({
	triggers: z.array(
		z.object({
			type: AutomationTriggerTypeEnum,
			description: z.string(),
			channel: AutomationChannelEnum,
			tier: z.number().int(),
			transport: z.enum(["webhook", "polling", "streaming"]),
			config_schema: z.any(),
			output_labels: z.array(z.string()).default(["next"]),
		}),
	),
	nodes: z.array(
		z.object({
			type: AutomationNodeTypeEnum,
			description: z.string(),
			category: z.enum([
				"content",
				"input",
				"logic",
				"ai",
				"action",
				"ops",
				"platform_send",
			]),
			fields_schema: z.any(),
			output_labels: z.array(z.string()).default(["next"]),
		}),
	),
	templates: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			description: z.string(),
			input_schema: z.any(),
		}),
	),
	merge_tags: z.array(z.string()),
});

export { ErrorResponse };
