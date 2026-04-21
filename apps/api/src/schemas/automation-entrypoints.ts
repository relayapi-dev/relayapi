import { z } from "@hono/zod-openapi";

// Per-kind configs
export const KeywordEntrypointConfig = z.object({
  keywords: z.array(z.string()).min(1),
  match_mode: z.enum(["exact", "contains", "regex"]).default("contains"),
  case_sensitive: z.boolean().default(false),
});

export const CommentCreatedEntrypointConfig = z.object({
  post_ids: z.array(z.string()).nullable().default(null),
  keyword_filter: z.array(z.string()).optional(),
  include_replies: z.boolean().default(true),
});

export const StoryReplyEntrypointConfig = z.object({
  story_ids: z.array(z.string()).nullable().default(null),
  keyword_filter: z.array(z.string()).optional(),
});

export const ScheduleEntrypointConfig = z.object({
  cron: z.string(),
  timezone: z.string().default("UTC"),
});

export const FieldChangedEntrypointConfig = z.object({
  field: z.string(),
  from: z.any().optional(),
  to: z.any().optional(),
});

export const TagEntrypointConfig = z.object({
  tag: z.string(),
});

export const RefLinkEntrypointConfig = z.object({
  ref_url_id: z.string(),
});

export const WebhookInboundEntrypointConfig = z.object({
  webhook_slug: z.string(),
  webhook_secret: z.string(),
  contact_lookup: z.object({
    by: z.enum(["email", "phone", "platform_id", "custom_field", "contact_id"]),
    field_path: z.string(),
    custom_field_key: z.string().optional(),
    auto_create_contact: z.boolean().default(false),
  }),
  payload_mapping: z.record(z.string(), z.string()).optional(),
});

export const AdClickEntrypointConfig = z.object({
  ad_ids: z.array(z.string()).nullable().default(null),
});

export const ConversionEventEntrypointConfig = z.object({
  event_name: z.string(),
});

// Empty config kinds
export const EmptyEntrypointConfig = z.object({}).passthrough();

// Registry
export const EntrypointConfigByKind: Record<string, z.ZodSchema> = {
  dm_received: EmptyEntrypointConfig,
  keyword: KeywordEntrypointConfig,
  comment_created: CommentCreatedEntrypointConfig,
  story_reply: StoryReplyEntrypointConfig,
  story_mention: EmptyEntrypointConfig,
  live_comment: EmptyEntrypointConfig,
  ad_click: AdClickEntrypointConfig,
  ref_link_click: RefLinkEntrypointConfig,
  share_to_dm: EmptyEntrypointConfig,
  follow: EmptyEntrypointConfig,
  schedule: ScheduleEntrypointConfig,
  field_changed: FieldChangedEntrypointConfig,
  tag_applied: TagEntrypointConfig,
  tag_removed: TagEntrypointConfig,
  conversion_event: ConversionEventEntrypointConfig,
  webhook_inbound: WebhookInboundEntrypointConfig,
};

export const EntrypointKindSchema = z.enum([
  "dm_received", "keyword", "comment_created", "story_reply", "story_mention",
  "live_comment", "ad_click", "ref_link_click", "share_to_dm", "follow",
  "schedule", "field_changed", "tag_applied", "tag_removed", "conversion_event",
  "webhook_inbound",
]);

export type EntrypointKind = z.infer<typeof EntrypointKindSchema>;

export const EntrypointCreateSchema = z.object({
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
  kind: EntrypointKindSchema,
  social_account_id: z.string().optional(),
  config: z.record(z.string(), z.any()).default({}),
  filters: z.record(z.string(), z.any()).optional(),
  allow_reentry: z.boolean().default(true),
  reentry_cooldown_min: z.number().min(0).default(60),
  priority: z.number().default(100),
});

export const EntrypointUpdateSchema = EntrypointCreateSchema.partial().extend({
  status: z.enum(["active", "paused"]).optional(),
});

export function validateEntrypointConfig(kind: string, config: unknown) {
  const schema = EntrypointConfigByKind[kind];
  if (!schema) return { success: false, error: new z.ZodError([{ code: "custom", path: ["kind"], message: `unknown kind ${kind}`, input: kind }]) } as const;
  return schema.safeParse(config);
}
