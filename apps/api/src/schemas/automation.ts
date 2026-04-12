import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// ---------------------------------------------------------------------------
// Condition & Action sub-schemas (stored as JSONB)
// ---------------------------------------------------------------------------

const ConditionLeafSchema = z.object({
	field: z.string().describe("Field path to evaluate (e.g. 'type', 'platform', 'text', 'author.name')"),
	op: z.enum(["eq", "in", "contains", "not_contains", "regex", "starts_with", "gt", "lt"]).describe("Comparison operator"),
	value: z.unknown().describe("Value to compare against"),
});

// Recursive schema for runtime validation — z.lazy() self-reference.
// We annotate with .openapi() so zod-to-openapi uses a static definition
// instead of trying to resolve the infinite recursion.
const ConditionNodeSchema: z.ZodType = z.lazy(() =>
	z.object({
		operator: z.enum(["AND", "OR", "NOT"]).describe("Logical operator"),
		rules: z.array(z.union([ConditionNodeSchema, ConditionLeafSchema])).describe("Child conditions"),
	}),
).openapi({
	type: "object",
	properties: {
		operator: { type: "string", enum: ["AND", "OR", "NOT"], description: "Logical operator" },
		rules: {
			type: "array",
			description: "Child conditions (leaf comparisons or nested nodes)",
			items: {
				oneOf: [
					{
						type: "object",
						properties: {
							field: { type: "string", description: "Field path to evaluate" },
							op: { type: "string", enum: ["eq", "in", "contains", "not_contains", "regex", "starts_with", "gt", "lt"] },
							value: { description: "Value to compare against" },
						},
						required: ["field", "op", "value"],
					},
					{
						type: "object",
						description: "Nested condition node (recursive — same shape as parent)",
						properties: {
							operator: { type: "string", enum: ["AND", "OR", "NOT"] },
							rules: { type: "array", items: {} },
						},
						required: ["operator", "rules"],
					},
				],
			},
		},
	},
	required: ["operator", "rules"],
});

const ConditionsSchema = z.union([ConditionNodeSchema, ConditionLeafSchema]).describe(
	"Condition tree — nested AND/OR/NOT nodes with leaf comparisons",
);

const ActionSchema = z.object({
	type: z.enum(["label", "archive", "set_priority", "hide", "reply", "escalate", "notify"]).describe("Action type"),
	params: z.record(z.string(), z.unknown()).optional().describe("Action parameters"),
});

// ---------------------------------------------------------------------------
// Create / Update bodies
// ---------------------------------------------------------------------------

export const CreateRuleBody = z.object({
	name: z.string().min(1).max(255).describe("Rule name"),
	conditions: ConditionsSchema,
	actions: z.array(ActionSchema).min(1).describe("Actions to execute on match"),
	priority: z.number().int().min(0).max(1000).default(0).describe("Higher priority rules run first"),
	max_per_hour: z.number().int().min(1).max(10000).default(100).describe("Maximum executions per hour"),
	cooldown_per_author_min: z.number().int().min(0).max(1440).default(60).describe("Cooldown per author in minutes"),
	stop_after_match: z.boolean().default(false).describe("Stop processing lower-priority rules after match"),
	enabled: z.boolean().default(true).describe("Whether the rule is active"),
	workspace_id: z.string().optional().describe("Workspace ID to scope this rule to"),
});

export const UpdateRuleBody = z.object({
	name: z.string().min(1).max(255).optional().describe("Rule name"),
	conditions: ConditionsSchema.optional(),
	actions: z.array(ActionSchema).min(1).optional().describe("Actions to execute on match"),
	priority: z.number().int().min(0).max(1000).optional().describe("Higher priority rules run first"),
	max_per_hour: z.number().int().min(1).max(10000).optional().describe("Maximum executions per hour"),
	cooldown_per_author_min: z.number().int().min(0).max(1440).optional().describe("Cooldown per author in minutes"),
	stop_after_match: z.boolean().optional().describe("Stop processing lower-priority rules after match"),
	enabled: z.boolean().optional().describe("Whether the rule is active"),
});

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const RuleResponse = z.object({
	id: z.string().describe("Rule ID"),
	name: z.string().describe("Rule name"),
	enabled: z.boolean().describe("Whether the rule is active"),
	priority: z.number().int().describe("Priority (higher = runs first)"),
	conditions: z.unknown().describe("Condition tree"),
	actions: z.unknown().describe("Action definitions"),
	max_per_hour: z.number().int().nullable().describe("Max executions per hour"),
	cooldown_per_author_min: z.number().int().nullable().describe("Cooldown per author in minutes"),
	stop_after_match: z.boolean().nullable().describe("Stop after match flag"),
	total_executions: z.number().int().nullable().describe("Total times this rule has fired"),
	last_executed_at: z.string().datetime().nullable().describe("Last execution timestamp"),
	created_at: z.string().datetime().describe("Creation timestamp"),
	updated_at: z.string().datetime().describe("Last update timestamp"),
});

export const RuleListResponse = paginatedResponse(RuleResponse);

export const RuleLogEntry = z.object({
	id: z.string().describe("Log entry ID"),
	rule_id: z.string().describe("Rule ID"),
	message_id: z.string().nullable().describe("Message that triggered the rule"),
	matched: z.boolean().describe("Whether the conditions matched"),
	actions_executed: z.unknown().nullable().describe("Results of executed actions"),
	error: z.string().nullable().describe("Error message if execution failed"),
	created_at: z.string().datetime().describe("Log timestamp"),
});

export const RuleLogListResponse = paginatedResponse(RuleLogEntry);
