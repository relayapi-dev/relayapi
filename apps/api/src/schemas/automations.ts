import { z } from "@hono/zod-openapi";
import {
	GraphSchema,
	MessageBlockSchema,
	TextBlockSchema,
} from "./automation-graph";

export const AutomationChannelSchema = z.enum([
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
]);
export const AutomationStatusSchema = z.enum([
	"draft",
	"active",
	"paused",
	"archived",
]);
export const AutomationTemplateKindSchema = z.enum([
	"blank",
	"welcome_flow",
	"faq_bot",
	"lead_capture",
	"comment_to_dm",
	"story_leads",
	"follower_growth",
	"follow_to_dm",
]);

function hasBranchButton(block: z.infer<typeof MessageBlockSchema>): boolean {
	if (block.type === "text" || block.type === "card") {
		return block.buttons?.some((button) => button.type === "branch") ?? false;
	}
	if (block.type === "gallery") {
		return block.cards.some(
			(card) =>
				card.buttons?.some((button) => button.type === "branch") ?? false,
		);
	}
	return false;
}

const PassiveTemplateBlockSchema = MessageBlockSchema.refine(
	(block) => !hasBranchButton(block),
	"Preset messages cannot contain unwired branch buttons",
);
const TemplateMessageSchema = z
	.object({
		// Presets wire a deterministic next step. Interactive branch controls
		// would park the run without a generated branch edge, so reject them.
		blocks: z.array(PassiveTemplateBlockSchema).min(1).max(20),
	})
	.strict();
const PrivateReplyTextBlockSchema = TextBlockSchema.refine(
	(block) => !block.buttons || block.buttons.length === 0,
	"Private replies do not support buttons",
);
const TemplatePrivateReplySchema = z
	.object({ blocks: z.tuple([PrivateReplyTextBlockSchema]) })
	.strict();
const SocialAccountConfig = { social_account_id: z.string().min(1).optional() };
const TemplateDailyCapSchema = z.number().int().positive().max(1_000_000);

export const AutomationTemplateInputSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("blank"),
		config: z.object({}).strict().default({}),
	}),
	z.object({
		kind: z.literal("welcome_flow"),
		config: z.object({}).strict().default({}),
	}),
	z.object({
		kind: z.literal("faq_bot"),
		config: z
			.object({
				keywords: z
					.array(
						z
							.object({
								label: z.string().min(1).max(40),
								keyword: z.string().min(1).max(256),
								reply: z.string().min(1).max(2_000),
							})
							.strict(),
					)
					.min(1)
					.max(20)
					.optional(),
				fallback_reply: z.string().min(1).max(2_000).optional(),
			})
			.strict()
			.default({}),
	}),
	z.object({
		kind: z.literal("lead_capture"),
		config: z
			.object({
				tag: z.string().min(1).max(100).optional(),
				capture_field: z.enum(["email", "phone"]).optional(),
			})
			.strict()
			.default({}),
	}),
	z.object({
		kind: z.literal("comment_to_dm"),
		config: z
			.object({
				...SocialAccountConfig,
				post_ids: z.array(z.string().min(1)).max(100).optional(),
				keyword_filter: z.array(z.string().min(1).max(256)).max(50).optional(),
				public_reply: z.string().min(1).max(2_000).optional(),
				dm_message: TemplatePrivateReplySchema.optional(),
				once_per_user: z.boolean().optional(),
				fallback_message: z.string().min(1).max(2_000).optional(),
				daily_cap: TemplateDailyCapSchema.optional(),
			})
			.strict()
			.default({}),
	}),
	z.object({
		kind: z.literal("story_leads"),
		config: z
			.object({
				...SocialAccountConfig,
				story_ids: z.array(z.string().min(1)).max(100).nullable().optional(),
				keyword_filter: z.array(z.string().min(1).max(256)).max(50).optional(),
				dm_message: TemplateMessageSchema.optional(),
				capture_field: z.enum(["email", "phone"]).optional(),
				success_tag: z.string().min(1).max(100).optional(),
				daily_cap: TemplateDailyCapSchema.optional(),
			})
			.strict()
			.default({}),
	}),
	z.object({
		kind: z.literal("follower_growth"),
		config: z
			.object({
				...SocialAccountConfig,
				post_ids: z.array(z.string().min(1)).max(100).optional(),
				trigger_keyword: z.string().min(1).max(256).optional(),
				public_reply: z.string().min(1).max(2_000).optional(),
				dm_message: TemplatePrivateReplySchema.optional(),
				entry_requirements: z
					.object({
						must_tag_friends: z.number().int().min(0).max(20).optional(),
						must_share_story: z.boolean().optional(),
					})
					.strict()
					.optional(),
				winner_tag: z.string().min(1).max(100).optional(),
				daily_cap: TemplateDailyCapSchema.optional(),
			})
			.strict()
			.default({}),
	}),
	z.object({
		kind: z.literal("follow_to_dm"),
		config: z
			.object({
				...SocialAccountConfig,
				dm_message: TemplateMessageSchema.optional(),
				daily_cap: TemplateDailyCapSchema.optional(),
				cooldown_hours: z
					.number()
					.min(0)
					.max(24 * 365)
					.optional(),
			})
			.strict()
			.default({}),
	}),
]);

export const AutomationCreateSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
	channel: AutomationChannelSchema,
	workspace_id: z.string().optional(),
	template: AutomationTemplateInputSchema.optional(),
});

export const AutomationUpdateSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).optional(),
});

export const AutomationGraphUpdateSchema = z.object({
	graph: GraphSchema,
});

export const ValidationErrorSchema = z.object({
	node_key: z.string().optional(),
	port_key: z.string().optional(),
	edge_index: z.number().optional(),
	code: z.string(),
	message: z.string(),
});

export const AutomationValidationSchema = z.object({
	valid: z.boolean(),
	errors: z.array(ValidationErrorSchema).default([]),
	warnings: z.array(ValidationErrorSchema).default([]),
});

export const AutomationResponseSchema = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	channel: AutomationChannelSchema,
	status: AutomationStatusSchema,
	graph: GraphSchema,
	created_from_template: z.string().nullable(),
	template_config: z.record(z.string(), z.any()).nullable(),
	total_enrolled: z.number(),
	total_completed: z.number(),
	total_exited: z.number(),
	total_failed: z.number(),
	last_validated_at: z.string().nullable(),
	validation_errors: z.array(ValidationErrorSchema).nullable(),
	created_by: z.string().nullable(),
	created_at: z.string(),
	updated_at: z.string(),
});

/**
 * List-item shape for GET /v1/automations. Deliberately OMITS the heavy
 * `graph`, `template_config`, and `validation_errors` JSONB blobs — a 100-row
 * page of full graphs can move multi-MB payloads through Hyperdrive and Worker
 * memory when only name/status metadata is needed for listing. Fetch the full
 * graph via GET /v1/automations/{id} (AutomationResponseSchema).
 */
export const AutomationListItemSchema = AutomationResponseSchema.omit({
	graph: true,
	template_config: true,
	validation_errors: true,
});

export const AutomationEnrollSchema = z.object({
	contact_id: z.string(),
	entrypoint_id: z.string().optional(),
	/**
	 * Pin the triggering social account for this manual enrollment.
	 * Without this, a contact with `contact_channels` rows across
	 * multiple accounts on the same channel gets an unscoped run and
	 * the handler's default lookup picks the newest row (which may be
	 * the wrong account in multi-account workspaces).
	 */
	social_account_id: z.string().optional(),
	context_overrides: z.record(z.string(), z.any()).optional(),
});

export const AutomationSimulateSchema = z.object({
	start_node_key: z.string().optional(),
	test_context: z.record(z.string(), z.any()).optional(),
	branch_choices: z.record(z.string(), z.string()).optional(),
	execute_side_effects: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Legacy compat: FilterGroup
//
// Segments (apps/api/src/schemas/segments.ts) and several preserved runtime
// services (notably services/automations/filter-eval.ts) still reference the
// old FilterGroup shape. Re-exporting it here preserves the import path while
// the rest of the automation schema is rebuilt.
// ---------------------------------------------------------------------------

const PredicateSchema = z.object({
	field: z.string(),
	// Constrain to the ops the evaluator actually handles
	// (services/automations/filter-eval.ts). A free string silently evaluated to
	// false (default branch), producing permanently-empty segments / always-false
	// conditions with no feedback to the user on creation.
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
});

export const FilterGroup = z.object({
	all: z.array(PredicateSchema).optional(),
	any: z.array(PredicateSchema).optional(),
	none: z.array(PredicateSchema).optional(),
});

export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;
export type AutomationListItem = z.infer<typeof AutomationListItemSchema>;
export type AutomationValidation = z.infer<typeof AutomationValidationSchema>;
