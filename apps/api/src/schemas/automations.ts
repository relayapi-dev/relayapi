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
// Some nodes below have been tightened into proper Zod objects (Instagram as
// the reference implementation). Others still use the loose `PlatformSendNode`
// wrapper while the per-platform Zod schemas catch up. Tightening a platform
// is mechanical — copy the Instagram block and adapt the fields to the node
// handler's expectations in apps/api/src/services/automations/nodes/platforms/.

const PlatformSendNode = <T extends AutomationNodeType>(type: T) =>
	z.object({
		...baseNode,
		type: z.literal(type as string),
		config: z
			.record(z.string(), z.any())
			.describe(`Platform-specific payload for ${type}`),
	});

// -- Instagram (reference tightened set) --

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
	// Instagram — tightened (reference impl; see InstagramSendTextNode etc. above).
	InstagramSendTextNode,
	InstagramSendMediaNode,
	InstagramSendButtonsNode,
	InstagramSendQuickRepliesNode,
	InstagramSendGenericTemplateNode,
	InstagramTypingNode,
	InstagramMarkSeenNode,
	InstagramReplyToCommentNode,
	InstagramHideCommentNode,
	PlatformSendNode("facebook_send_text"),
	PlatformSendNode("facebook_send_media"),
	PlatformSendNode("facebook_send_template"),
	PlatformSendNode("facebook_send_quick_replies"),
	PlatformSendNode("facebook_send_button_template"),
	PlatformSendNode("facebook_reply_to_comment"),
	PlatformSendNode("facebook_private_reply"),
	PlatformSendNode("facebook_hide_comment"),
	PlatformSendNode("facebook_sender_action"),
	PlatformSendNode("whatsapp_send_text"),
	PlatformSendNode("whatsapp_send_media"),
	PlatformSendNode("whatsapp_send_template"),
	PlatformSendNode("whatsapp_send_interactive"),
	PlatformSendNode("whatsapp_send_flow"),
	PlatformSendNode("whatsapp_send_location"),
	PlatformSendNode("whatsapp_send_contacts"),
	PlatformSendNode("whatsapp_react"),
	PlatformSendNode("whatsapp_mark_read"),
	PlatformSendNode("telegram_send_text"),
	PlatformSendNode("telegram_send_media"),
	PlatformSendNode("telegram_send_media_group"),
	PlatformSendNode("telegram_send_poll"),
	PlatformSendNode("telegram_send_location"),
	PlatformSendNode("telegram_send_keyboard"),
	PlatformSendNode("telegram_edit_message"),
	PlatformSendNode("telegram_pin_message"),
	PlatformSendNode("telegram_react"),
	PlatformSendNode("telegram_set_chat_action"),
	PlatformSendNode("discord_send_message"),
	PlatformSendNode("discord_send_embed"),
	PlatformSendNode("discord_send_components"),
	PlatformSendNode("discord_send_attachment"),
	PlatformSendNode("discord_react"),
	PlatformSendNode("discord_edit_message"),
	PlatformSendNode("discord_start_thread"),
	PlatformSendNode("sms_send"),
	PlatformSendNode("sms_send_mms"),
	PlatformSendNode("twitter_send_dm"),
	PlatformSendNode("twitter_send_dm_media"),
	PlatformSendNode("twitter_reply_to_tweet"),
	PlatformSendNode("twitter_like_tweet"),
	PlatformSendNode("twitter_retweet"),
	PlatformSendNode("bluesky_reply"),
	PlatformSendNode("bluesky_like"),
	PlatformSendNode("bluesky_repost"),
	PlatformSendNode("bluesky_send_dm"),
	PlatformSendNode("threads_reply_to_post"),
	PlatformSendNode("threads_hide_reply"),
	PlatformSendNode("youtube_reply_to_comment"),
	PlatformSendNode("youtube_send_live_chat"),
	PlatformSendNode("youtube_moderate_comment"),
	PlatformSendNode("linkedin_reply_to_comment"),
	PlatformSendNode("linkedin_react_to_post"),
	PlatformSendNode("mastodon_reply"),
	PlatformSendNode("mastodon_favourite"),
	PlatformSendNode("mastodon_boost"),
	PlatformSendNode("mastodon_send_dm"),
	PlatformSendNode("reddit_reply_to_comment"),
	PlatformSendNode("reddit_send_pm"),
	PlatformSendNode("reddit_reply_modmail"),
	PlatformSendNode("reddit_submit_post"),
	PlatformSendNode("googlebusiness_reply_to_review"),
	PlatformSendNode("googlebusiness_post_update"),
	PlatformSendNode("beehiiv_add_subscriber"),
	PlatformSendNode("beehiiv_publish_post"),
	PlatformSendNode("beehiiv_enroll_automation"),
	PlatformSendNode("kit_add_subscriber"),
	PlatformSendNode("kit_add_tag"),
	PlatformSendNode("kit_send_broadcast"),
	PlatformSendNode("mailchimp_add_member"),
	PlatformSendNode("mailchimp_add_tag"),
	PlatformSendNode("mailchimp_send_campaign"),
	PlatformSendNode("listmonk_add_subscriber"),
	PlatformSendNode("listmonk_send_campaign"),
	PlatformSendNode("pinterest_create_pin"),
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
