import { z } from "@hono/zod-openapi";
import { compileSafeAutomationRegex } from "../services/automations/safe-regex";
import {
	isValidAutomationTimezone,
	parseAutomationCron,
} from "../services/automations/schedule-expression";

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
const KeywordMatchFields = {
	keywords: z.array(z.string().min(1).max(256)).max(50).optional(),
	match_mode: z.enum(["exact", "contains", "regex"]).default("contains"),
	case_sensitive: z.boolean().default(false),
};

function validateKeywordPatterns(
	config: {
		keywords?: string[];
		match_mode?: "exact" | "contains" | "regex";
		case_sensitive?: boolean;
	},
	ctx: {
		addIssue(issue: {
			code: "custom";
			path: Array<string | number>;
			message: string;
		}): void;
	},
) {
	if (config.match_mode !== "regex") return;
	for (const [index, pattern] of (config.keywords ?? []).entries()) {
		if (compileSafeAutomationRegex(pattern, config.case_sensitive ? "" : "i")) {
			continue;
		}
		ctx.addIssue({
			code: "custom",
			path: ["keywords", index],
			message: "Unsupported or unsafe regular expression",
		});
	}
}

export const DmReceivedEntrypointConfig = z
	.object({
		...KeywordMatchFields,
		first_message_only: z.boolean().default(false),
	})
	.strict()
	.superRefine(validateKeywordPatterns);

export const CommentCreatedEntrypointConfig = z
	.object({
		...KeywordMatchFields,
		post_ids: z
			.array(z.string().min(1).max(256))
			.max(100)
			.nullable()
			.default(null),
		// Matcher reads config.keywords (trigger-matcher.ts:190). Old key
		// `keyword_filter` was dropped as part of the entrypoint key-drift fix.
		include_replies: z.boolean().default(true),
	})
	.strict()
	.superRefine(validateKeywordPatterns);

export const StoryReplyEntrypointConfig = z
	.object({
		...KeywordMatchFields,
		story_ids: z
			.array(z.string().min(1).max(256))
			.max(100)
			.nullable()
			.default(null),
		// Matcher reads config.keywords (trigger-matcher.ts:201).
	})
	.strict()
	.superRefine(validateKeywordPatterns);

export const LiveCommentEntrypointConfig = z
	.object({ ...KeywordMatchFields })
	.strict()
	.superRefine(validateKeywordPatterns);

export const ScheduleEntrypointConfig = z
	.object({
		cron: z
			.string()
			.min(1)
			.max(100)
			.refine((cron) => parseAutomationCron(cron) !== null, {
				message:
					"Unsupported cron expression; use a daily time, hourly, or */N minutes",
			}),
		timezone: z
			.string()
			.min(1)
			.max(100)
			.default("UTC")
			.refine(isValidAutomationTimezone, {
				message: "Unknown IANA timezone",
			}),
	})
	.strict();

export const FieldChangedEntrypointConfig = z
	.object({
		// Matcher reads config.field_keys (trigger-matcher.ts:235).
		field_keys: z.array(z.string().min(1).max(256)).min(1).max(50),
		from: z.any().optional(),
		to: z.any().optional(),
	})
	.strict();

// Note: the contacts schema stores tags as string NAMES in a text[] column on
// `contacts.tags` (no separate tag table). The matcher reads `config.tag_ids`
// (trigger-matcher.ts:228) and compares against `event.tagId`, which in our
// data model is a tag NAME. The field name is kept as `tag_ids` to match the
// matcher (the source of truth) but semantically holds tag names.
export const TagEntrypointConfig = z
	.object({
		tag_ids: z.array(z.string().min(1).max(256)).min(1).max(100),
	})
	.strict();

export const RefLinkEntrypointConfig = z
	.object({
		// Matcher reads config.ref_url_ids (trigger-matcher.ts:220).
		ref_url_ids: z.array(z.string().min(1).max(256)).min(1).max(100),
	})
	.strict();

export const WebhookInboundEntrypointConfig = z
	.object({
		webhook_slug: z.string().min(1).max(200),
		webhook_secret: z.string().min(1).max(2_000),
		contact_lookup: z
			.object({
				by: z.enum([
					"email",
					"phone",
					"platform_id",
					"custom_field",
					"contact_id",
				]),
				field_path: z.string().min(1).max(500),
				custom_field_key: z.string().min(1).max(256).optional(),
				auto_create_contact: z.boolean().default(false),
			})
			.strict(),
		payload_mapping: z
			.record(z.string().min(1).max(500), z.string().max(500))
			.optional(),
	})
	.strict()
	.superRefine((config, ctx) => {
		if (
			config.contact_lookup.by === "custom_field" &&
			!config.contact_lookup.custom_field_key
		) {
			ctx.addIssue({
				code: "custom",
				path: ["contact_lookup", "custom_field_key"],
				message: "custom_field_key is required for custom_field lookup",
			});
		}
	});

export const AdClickEntrypointConfig = z
	.object({
		ad_ids: z
			.array(z.string().min(1).max(256))
			.max(100)
			.nullable()
			.default(null),
	})
	.strict();

export const ConversionEventEntrypointConfig = z
	.object({
		event_names: z.array(z.string().min(1).max(200)).min(1).max(50),
	})
	.strict();

// Empty config kinds
export const EmptyEntrypointConfig = z.object({}).strict();

// Registry
export const EntrypointConfigByKind: Record<string, z.ZodSchema> = {
	dm_received: DmReceivedEntrypointConfig,
	comment_created: CommentCreatedEntrypointConfig,
	story_reply: StoryReplyEntrypointConfig,
	story_mention: StoryReplyEntrypointConfig,
	live_comment: LiveCommentEntrypointConfig,
	ad_click: AdClickEntrypointConfig,
	ref_link_click: RefLinkEntrypointConfig,
	share_to_dm: EmptyEntrypointConfig,
	schedule: ScheduleEntrypointConfig,
	field_changed: FieldChangedEntrypointConfig,
	tag_applied: TagEntrypointConfig,
	tag_removed: TagEntrypointConfig,
	conversion_event: ConversionEventEntrypointConfig,
	webhook_inbound: WebhookInboundEntrypointConfig,
};

export const EntrypointKindSchema = z.enum([
	"dm_received",
	"comment_created",
	"story_reply",
	"story_mention",
	"live_comment",
	"ad_click",
	"ref_link_click",
	"share_to_dm",
	"schedule",
	"field_changed",
	"tag_applied",
	"tag_removed",
	"conversion_event",
	"webhook_inbound",
]);

export type EntrypointKind = z.infer<typeof EntrypointKindSchema>;

export const AutomationChannelSchema = z.enum([
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
]);
export type AutomationChannel = z.infer<typeof AutomationChannelSchema>;

export const AUTOMATION_ENTRYPOINT_CHANNELS: Record<
	EntrypointKind,
	readonly AutomationChannel[]
> = {
	dm_received: ["instagram", "facebook", "whatsapp", "telegram"],
	comment_created: ["instagram", "facebook"],
	story_reply: ["instagram", "facebook"],
	story_mention: ["instagram", "facebook"],
	live_comment: ["instagram", "facebook"],
	ad_click: ["instagram", "facebook"],
	ref_link_click: ["instagram", "facebook", "whatsapp", "telegram"],
	share_to_dm: ["instagram"],
	schedule: ["instagram", "facebook", "whatsapp", "telegram"],
	field_changed: ["instagram", "facebook", "whatsapp", "telegram"],
	tag_applied: ["instagram", "facebook", "whatsapp", "telegram"],
	tag_removed: ["instagram", "facebook", "whatsapp", "telegram"],
	conversion_event: ["instagram", "facebook", "whatsapp", "telegram"],
	webhook_inbound: ["instagram", "facebook", "whatsapp", "telegram"],
};

export function isEntrypointKindSupportedOnChannel(
	kind: string,
	channel: string,
): boolean {
	const supported = AUTOMATION_ENTRYPOINT_CHANNELS[kind as EntrypointKind];
	return supported?.includes(channel as AutomationChannel) ?? false;
}

const FilterPredicateSchema = z
	.object({
		field: z.string().min(1).max(500),
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
		case_sensitive: z.boolean().optional(),
	})
	.strict();

export const EntrypointFilterGroupSchema = z
	.object({
		all: z.array(FilterPredicateSchema).max(100).optional(),
		any: z.array(FilterPredicateSchema).max(100).optional(),
		none: z.array(FilterPredicateSchema).max(100).optional(),
	})
	.strict();

const EntrypointWriteSchema = z
	.object({
		channel: AutomationChannelSchema,
		kind: EntrypointKindSchema,
		social_account_id: z.string().min(1).optional(),
		config: z.record(z.string(), z.any()).default({}),
		filters: EntrypointFilterGroupSchema.nullable().optional(),
		allow_reentry: z.boolean().default(true),
		reentry_cooldown_min: z.number().int().min(0).max(525_600).default(60),
		daily_cap: z.number().int().positive().max(1_000_000).nullable().optional(),
		priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
		status: z.enum(["active", "paused"]).optional(),
	})
	.strict();

export const EntrypointCreateSchema = EntrypointWriteSchema.superRefine(
	(value, ctx) => {
		if (!isEntrypointKindSupportedOnChannel(value.kind, value.channel)) {
			ctx.addIssue({
				code: "custom",
				path: ["kind"],
				message: `${value.kind} is not supported on ${value.channel}`,
			});
		}
	},
);

// PATCH only carries changed fields. The route validates the resolved
// kind/channel pair against the existing row after parsing this partial body.
export const EntrypointUpdateSchema = EntrypointWriteSchema.partial().strict();

export function validateEntrypointConfig(kind: string, config: unknown) {
	const schema = EntrypointConfigByKind[kind];
	if (!schema)
		return {
			success: false,
			error: new z.ZodError([
				{
					code: "custom",
					path: ["kind"],
					message: `unknown kind ${kind}`,
					input: kind,
				},
			]),
		} as const;
	return schema.safeParse(config);
}
