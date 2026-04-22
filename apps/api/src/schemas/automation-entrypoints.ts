import { z } from "@hono/zod-openapi";

// NOTE: the dedicated `keyword` entrypoint kind was removed (spec §B3 fix).
// The matcher filters candidate entrypoints by `eq(kind, event.kind)` and
// `deriveInboundEventKind` never emits `"keyword"` — inbound DMs always map
// to `dm_received`. Keyword filtering is still supported and now lives on
// the `dm_received` config via its `keywords`/`match_mode` fields (see the
// DmReceivedEntrypointConfig below and trigger-matcher.ts:191-198).

// Per-kind configs
// `dm_received` accepts optional keyword filtering — the matcher treats an
// empty `keywords` array as a catch-all inbound-DM entrypoint, and a non-empty
// one as a keyword match (respecting `match_mode` / `case_sensitive`).
export const DmReceivedEntrypointConfig = z.object({
  keywords: z.array(z.string()).optional(),
  match_mode: z.enum(["exact", "contains", "regex"]).default("contains"),
  case_sensitive: z.boolean().default(false),
});

export const CommentCreatedEntrypointConfig = z.object({
  post_ids: z.array(z.string()).nullable().default(null),
  // Matcher reads config.keywords (trigger-matcher.ts:190). Old key
  // `keyword_filter` was dropped as part of the entrypoint key-drift fix.
  keywords: z.array(z.string()).optional(),
  include_replies: z.boolean().default(true),
});

export const StoryReplyEntrypointConfig = z.object({
  story_ids: z.array(z.string()).nullable().default(null),
  // Matcher reads config.keywords (trigger-matcher.ts:201).
  keywords: z.array(z.string()).optional(),
});

export const ScheduleEntrypointConfig = z.object({
  cron: z.string(),
  timezone: z.string().default("UTC"),
});

export const FieldChangedEntrypointConfig = z.object({
  // Matcher reads config.field_keys (trigger-matcher.ts:235).
  field_keys: z.array(z.string()).min(1),
  from: z.any().optional(),
  to: z.any().optional(),
});

// Note: the contacts schema stores tags as string NAMES in a text[] column on
// `contacts.tags` (no separate tag table). The matcher reads `config.tag_ids`
// (trigger-matcher.ts:228) and compares against `event.tagId`, which in our
// data model is a tag NAME. The field name is kept as `tag_ids` to match the
// matcher (the source of truth) but semantically holds tag names.
export const TagEntrypointConfig = z.object({
  tag_ids: z.array(z.string()).min(1),
});

export const RefLinkEntrypointConfig = z.object({
  // Matcher reads config.ref_url_ids (trigger-matcher.ts:220).
  ref_url_ids: z.array(z.string()).min(1),
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
  // Matcher reads config.event_names (trigger-matcher.ts:242).
  event_names: z.array(z.string()).min(1),
});

// Empty config kinds
export const EmptyEntrypointConfig = z.object({}).passthrough();

// Registry
export const EntrypointConfigByKind: Record<string, z.ZodSchema> = {
  dm_received: DmReceivedEntrypointConfig,
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
  "dm_received", "comment_created", "story_reply", "story_mention",
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
