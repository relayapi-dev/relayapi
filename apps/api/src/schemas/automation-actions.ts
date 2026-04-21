import { z } from "@hono/zod-openapi";

const OnErrorSchema = z.enum(["abort", "continue"]).default("abort");

const BaseAction = z.object({
  id: z.string(),
  on_error: OnErrorSchema,
});

export const TagAddAction = BaseAction.extend({
  type: z.literal("tag_add"),
  tag: z.string(),                      // tag name
});
export const TagRemoveAction = BaseAction.extend({
  type: z.literal("tag_remove"),
  tag: z.string(),
});

export const FieldSetAction = BaseAction.extend({
  type: z.literal("field_set"),
  field: z.string(),                    // custom field key
  value: z.string(),                    // merge-tag supported
});
export const FieldClearAction = BaseAction.extend({
  type: z.literal("field_clear"),
  field: z.string(),
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
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
});
export const OptOutChannelAction = BaseAction.extend({
  type: z.literal("opt_out_channel"),
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
});

export const AssignConversationAction = BaseAction.extend({
  type: z.literal("assign_conversation"),
  user_id: z.string(),                  // or "round_robin" / "unassigned"
});
export const UnassignConversationAction = BaseAction.extend({
  type: z.literal("unassign_conversation"),
});
export const ConversationOpenAction = BaseAction.extend({ type: z.literal("conversation_open") });
export const ConversationCloseAction = BaseAction.extend({ type: z.literal("conversation_close") });
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
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  auth: z.object({
    mode: z.enum(["none", "bearer", "basic", "hmac"]).default("none"),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    secret: z.string().optional(),
  }).default({ mode: "none" }),
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
  confirm: z.literal(true),             // force operator to acknowledge
});

export const LogConversionEventAction = BaseAction.extend({
  type: z.literal("log_conversion_event"),
  event_name: z.string(),
  value: z.string().optional(),
  currency: z.string().optional(),
});

export const ChangeMainMenuAction = BaseAction.extend({
  type: z.literal("change_main_menu"),   // v1.1 stub
  menu_payload: z.any().optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  TagAddAction, TagRemoveAction,
  FieldSetAction, FieldClearAction,
  SegmentAddAction, SegmentRemoveAction,
  SubscribeListAction, UnsubscribeListAction,
  OptInChannelAction, OptOutChannelAction,
  AssignConversationAction, UnassignConversationAction,
  ConversationOpenAction, ConversationCloseAction, ConversationSnoozeAction,
  NotifyAdminAction,
  WebhookOutAction,
  PauseContactAutomationsAction, ResumeContactAutomationsAction,
  DeleteContactAction,
  LogConversionEventAction,
  ChangeMainMenuAction,
]);

export const ActionGroupConfigSchema = z.object({
  actions: z.array(ActionSchema).min(1),
});

export type Action = z.infer<typeof ActionSchema>;
export type ActionGroupConfig = z.infer<typeof ActionGroupConfigSchema>;
