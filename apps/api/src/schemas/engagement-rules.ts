import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// --- Engagement Rules ---

export const TriggerMetricEnum = z.enum(["likes", "comments", "shares", "views"]);

export const ActionTypeEnum = z.enum(["repost", "reply", "repost_from_account"]);

export const RuleStatusEnum = z.enum(["active", "paused"]);

export const CreateEngagementRuleBody = z.object({
	name: z.string().min(1).max(255).describe("Rule name"),
	account_id: z.string().describe("Social account to monitor"),
	trigger_metric: TriggerMetricEnum.describe("Metric to watch"),
	trigger_threshold: z.number().int().min(1).describe("Threshold value to trigger the action"),
	action_type: ActionTypeEnum.describe("Action to take when threshold is met"),
	action_account_id: z.string().optional().describe("Account to perform action from (for repost_from_account)"),
	action_content: z.string().optional().describe("Text content for reply actions"),
	check_interval_minutes: z.number().int().min(60).max(1440).default(360).describe("How often to check metrics (minutes)"),
	max_checks: z.number().int().min(1).max(10).default(3).describe("Maximum number of checks per post"),
	workspace_id: z.string().optional().describe("Workspace ID"),
});

export const UpdateEngagementRuleBody = z.object({
	name: z.string().min(1).max(255).optional(),
	trigger_metric: TriggerMetricEnum.optional(),
	trigger_threshold: z.number().int().min(1).optional(),
	action_type: ActionTypeEnum.optional(),
	action_account_id: z.string().nullable().optional(),
	action_content: z.string().nullable().optional(),
	check_interval_minutes: z.number().int().min(60).max(1440).optional(),
	max_checks: z.number().int().min(1).max(10).optional(),
});

export const EngagementRuleResponse = z.object({
	id: z.string().describe("Rule ID"),
	name: z.string(),
	account_id: z.string(),
	trigger_metric: TriggerMetricEnum,
	trigger_threshold: z.number(),
	action_type: ActionTypeEnum,
	action_account_id: z.string().nullable(),
	action_content: z.string().nullable(),
	check_interval_minutes: z.number(),
	max_checks: z.number(),
	status: RuleStatusEnum,
	workspace_id: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const EngagementRuleListResponse = paginatedResponse(EngagementRuleResponse);

// --- Engagement Rule Logs ---

export const EngagementRuleLogResponse = z.object({
	id: z.string(),
	rule_id: z.string(),
	post_target_id: z.string(),
	check_number: z.number(),
	metric_value: z.number().nullable(),
	threshold_met: z.boolean(),
	action_taken: z.boolean(),
	result_post_id: z.string().nullable(),
	error: z.string().nullable(),
	executed_at: z.string().datetime(),
});

export const EngagementRuleLogListResponse = paginatedResponse(EngagementRuleLogResponse);
