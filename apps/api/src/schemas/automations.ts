import { z } from "@hono/zod-openapi";
import { GraphSchema } from "./automation-graph";

export const AutomationChannelSchema = z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]);
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

export const AutomationEnrollSchema = z.object({
  contact_id: z.string(),
  entrypoint_id: z.string().optional(),
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
  op: z.string(),
  value: z.any().optional(),
});

export const FilterGroup = z.object({
  all: z.array(PredicateSchema).optional(),
  any: z.array(PredicateSchema).optional(),
  none: z.array(PredicateSchema).optional(),
});

export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;
export type AutomationValidation = z.infer<typeof AutomationValidationSchema>;
