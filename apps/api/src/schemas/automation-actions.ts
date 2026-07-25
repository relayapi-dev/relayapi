import { z } from "@hono/zod-openapi";
import { MainMenuConfig } from "./automation-bindings";

const OnErrorSchema = z.enum(["abort", "continue"]).default("abort");

const BaseAction = z.object({
	id: z.string(),
	on_error: OnErrorSchema,
});

export const TagAddAction = BaseAction.extend({
	type: z.literal("tag_add"),
	tag: z.string(), // tag name
});
export const TagRemoveAction = BaseAction.extend({
	type: z.literal("tag_remove"),
	tag: z.string(),
});

export const FieldSetAction = BaseAction.extend({
	type: z.literal("field_set"),
	field: z.string(), // custom field key
	value: z.string(), // merge-tag supported
});
export const FieldClearAction = BaseAction.extend({
	type: z.literal("field_clear"),
	field: z.string(),
});

export const ContactFieldSetAction = BaseAction.extend({
	type: z.literal("contact_field_set"),
	field: z.enum(["name", "email", "phone"]),
	value: z.string(),
});

export const SegmentAddAction = BaseAction.extend({
	type: z.literal("segment_add"),
	segment_id: z.string(),
});
export const SegmentRemoveAction = BaseAction.extend({
	type: z.literal("segment_remove"),
	segment_id: z.string(),
});

export const SubscribeListAction = BaseAction.extend({
	type: z.literal("subscribe_list"),
	list_id: z.string(),
});
export const UnsubscribeListAction = BaseAction.extend({
	type: z.literal("unsubscribe_list"),
	list_id: z.string(),
});

export const OptInChannelAction = BaseAction.extend({
	type: z.literal("opt_in_channel"),
	channel: z.enum(["instagram", "facebook", "whatsapp", "telegram"]),
});
export const OptOutChannelAction = BaseAction.extend({
	type: z.literal("opt_out_channel"),
	channel: z.enum(["instagram", "facebook", "whatsapp", "telegram"]),
});

export const AssignConversationAction = BaseAction.extend({
	type: z.literal("assign_conversation"),
	user_id: z.string(), // or "round_robin" / "unassigned"
});
export const UnassignConversationAction = BaseAction.extend({
	type: z.literal("unassign_conversation"),
});
export const ConversationOpenAction = BaseAction.extend({
	type: z.literal("conversation_open"),
});
export const ConversationCloseAction = BaseAction.extend({
	type: z.literal("conversation_close"),
});
export const ReplyToCommentAction = BaseAction.extend({
	type: z.literal("reply_to_comment"),
	text: z.string(),
});
export const ConversationSnoozeAction = BaseAction.extend({
	type: z.literal("conversation_snooze"),
	snooze_minutes: z.number().min(1),
});

export const NotifyAdminAction = BaseAction.extend({
	type: z.literal("notify_admin"),
	title: z.string(),
	body: z.string(),
	link: z.string().optional(),
	recipient_user_ids: z.array(z.string()).optional(),
});

export const WebhookOutAction = BaseAction.extend({
	type: z.literal("webhook_out"),
	url: z.string().max(8192).url(),
	method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
	headers: z.record(z.string().max(256), z.string().max(8192)).default({}),
	// Send an empty list with empty `headers` to explicitly clear stored headers.
	configured_headers: z.array(z.string().max(256)).max(64).optional(),
	body: z
		.string()
		.max(256 * 1024)
		.optional(),
	// Send false without `body` to explicitly clear the stored body.
	body_configured: z.boolean().optional(),
	/** Opaque server-owned reference returned after write-only credentials are sealed. */
	secret_ref: z.string().optional(),
	credentials_configured: z.boolean().optional(),
	clear_credentials: z.boolean().optional(),
	auth: z
		.object({
			mode: z.enum(["none", "bearer", "basic", "hmac"]).default("none"),
			token: z.string().max(8192).optional(),
			username: z.string().max(1024).optional(),
			password: z.string().max(8192).optional(),
			secret: z.string().max(8192).optional(),
		})
		.default({ mode: "none" }),
});

export const PauseContactAutomationsAction = BaseAction.extend({
	type: z.literal("pause_automations_for_contact"),
	scope: z.enum(["current", "global"]).default("current"),
	duration_min: z.number().optional(),
	reason: z.string().optional(),
});
export const ResumeContactAutomationsAction = BaseAction.extend({
	type: z.literal("resume_automations_for_contact"),
	scope: z.enum(["current", "global"]).default("current"),
});

export const DeleteContactAction = BaseAction.extend({
	type: z.literal("delete_contact"),
	confirm: z.literal(true), // force operator to acknowledge
});

export const LogConversionEventAction = BaseAction.extend({
	type: z.literal("log_conversion_event"),
	event_name: z.string(),
	value: z.string().optional(),
	currency: z.string().optional(),
});

export const ChangeMainMenuAction = BaseAction.extend({
	type: z.literal("change_main_menu"),
	// Messenger supports a per-PSID persistent-menu override. Reusing the
	// binding config keeps account-level and contact-level menus identical.
	menu_payload: MainMenuConfig,
});

export const ActionSchema = z.discriminatedUnion("type", [
	TagAddAction,
	TagRemoveAction,
	FieldSetAction,
	FieldClearAction,
	ContactFieldSetAction,
	SegmentAddAction,
	SegmentRemoveAction,
	SubscribeListAction,
	UnsubscribeListAction,
	OptInChannelAction,
	OptOutChannelAction,
	AssignConversationAction,
	UnassignConversationAction,
	ConversationOpenAction,
	ConversationCloseAction,
	ReplyToCommentAction,
	ConversationSnoozeAction,
	NotifyAdminAction,
	WebhookOutAction,
	PauseContactAutomationsAction,
	ResumeContactAutomationsAction,
	DeleteContactAction,
	LogConversionEventAction,
	ChangeMainMenuAction,
]);

export const ActionGroupConfigSchema = z.object({
	actions: z.array(ActionSchema).min(1),
});

export type Action = z.infer<typeof ActionSchema>;
export type ActionGroupConfig = z.infer<typeof ActionGroupConfigSchema>;
