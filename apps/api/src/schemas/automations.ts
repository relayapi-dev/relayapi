import { z } from "@hono/zod-openapi";
import { GraphSchema } from "./automation-graph";

export const AutomationChannelSchema = z.enum(["instagram", "facebook", "whatsapp", "telegram"]);
export const AutomationStatusSchema = z.enum(["draft", "active", "paused", "archived"]);

export const AutomationCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  channel: AutomationChannelSchema,
  workspace_id: z.string().optional(),
  template: z.object({
    kind: z.string(),
    config: z.record(z.string(), z.any()).default({}),
  }).optional(),
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
});

export const FilterGroup = z.object({
  all: z.array(PredicateSchema).optional(),
  any: z.array(PredicateSchema).optional(),
  none: z.array(PredicateSchema).optional(),
});

export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;
export type AutomationListItem = z.infer<typeof AutomationListItemSchema>;
export type AutomationValidation = z.infer<typeof AutomationValidationSchema>;
