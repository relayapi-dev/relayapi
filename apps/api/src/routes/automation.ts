import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { automationRules, automationLogs } from "@relayapi/db";
import { and, desc, eq, lte } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateRuleBody,
	UpdateRuleBody,
	RuleResponse,
	RuleListResponse,
	RuleLogListResponse,
} from "../schemas/automation";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helper: serialize a rule row to the API response shape
// ---------------------------------------------------------------------------

function serializeRule(rule: typeof automationRules.$inferSelect) {
	return {
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		priority: rule.priority,
		conditions: rule.conditions,
		actions: rule.actions,
		max_per_hour: rule.maxPerHour,
		cooldown_per_author_min: rule.cooldownPerAuthorMin,
		stop_after_match: rule.stopAfterMatch,
		total_executions: rule.totalExecutions,
		last_executed_at: rule.lastExecutedAt?.toISOString() ?? null,
		created_at: rule.createdAt.toISOString(),
		updated_at: rule.updatedAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

const createRuleRoute = createRoute({
	operationId: "createAutomationRule",
	method: "post",
	path: "/",
	tags: ["Automation"],
	summary: "Create an automation rule",
	description: "Create a new automation rule with conditions and actions.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateRuleBody } },
		},
	},
	responses: {
		201: {
			description: "Rule created",
			content: { "application/json": { schema: RuleResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const AutomationListQuery = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
});

const listRulesRoute = createRoute({
	operationId: "listAutomationRules",
	method: "get",
	path: "/",
	tags: ["Automation"],
	summary: "List automation rules",
	security: [{ Bearer: [] }],
	request: { query: AutomationListQuery },
	responses: {
		200: {
			description: "List of rules",
			content: { "application/json": { schema: RuleListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getRuleRoute = createRoute({
	operationId: "getAutomationRule",
	method: "get",
	path: "/{id}",
	tags: ["Automation"],
	summary: "Get an automation rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Rule details",
			content: { "application/json": { schema: RuleResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateRuleRoute = createRoute({
	operationId: "updateAutomationRule",
	method: "patch",
	path: "/{id}",
	tags: ["Automation"],
	summary: "Update an automation rule",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateRuleBody } },
		},
	},
	responses: {
		200: {
			description: "Rule updated",
			content: { "application/json": { schema: RuleResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteRuleRoute = createRoute({
	operationId: "deleteAutomationRule",
	method: "delete",
	path: "/{id}",
	tags: ["Automation"],
	summary: "Delete an automation rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Rule deleted" },
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getRuleLogsRoute = createRoute({
	operationId: "getAutomationRuleLogs",
	method: "get",
	path: "/{id}/logs",
	tags: ["Automation"],
	summary: "Get execution logs for a rule",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: PaginationParams,
	},
	responses: {
		200: {
			description: "Rule execution logs",
			content: { "application/json": { schema: RuleLogListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

app.openapi(createRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [rule] = await db
		.insert(automationRules)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			enabled: body.enabled,
			priority: body.priority,
			conditions: body.conditions as Record<string, unknown>,
			actions: body.actions as unknown as Record<string, unknown>,
			maxPerHour: body.max_per_hour,
			cooldownPerAuthorMin: body.cooldown_per_author_min,
			stopAfterMatch: body.stop_after_match,
		})
		.returning();

	if (!rule) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create rule",
				},
			} as never,
			500 as never,
		);
	}

	return c.json(serializeRule(rule) as never, 201);
});

app.openapi(listRulesRoute, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(automationRules.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, automationRules.workspaceId);
	if (workspace_id) {
		conditions.push(eq(automationRules.workspaceId, workspace_id));
	}

	if (cursor) {
		conditions.push(lte(automationRules.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(automationRules)
		.where(and(...conditions))
		.orderBy(desc(automationRules.priority), desc(automationRules.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor =
		hasMore && lastRow ? lastRow.createdAt.toISOString() : null;

	return c.json(
		{
			data: data.map(serializeRule),
			next_cursor: nextCursor,
			has_more: hasMore,
		} as never,
		200,
	);
});

app.openapi(getRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [rule] = await db
		.select()
		.from(automationRules)
		.where(
			and(
				eq(automationRules.id, id),
				eq(automationRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!rule) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	return c.json(serializeRule(rule) as never, 200);
});

app.openapi(updateRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Verify rule exists and belongs to the org
	const [existing] = await db
		.select()
		.from(automationRules)
		.where(
			and(
				eq(automationRules.id, id),
				eq(automationRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.enabled !== undefined) updates.enabled = body.enabled;
	if (body.priority !== undefined) updates.priority = body.priority;
	if (body.conditions !== undefined) updates.conditions = body.conditions;
	if (body.actions !== undefined) updates.actions = body.actions;
	if (body.max_per_hour !== undefined) updates.maxPerHour = body.max_per_hour;
	if (body.cooldown_per_author_min !== undefined)
		updates.cooldownPerAuthorMin = body.cooldown_per_author_min;
	if (body.stop_after_match !== undefined)
		updates.stopAfterMatch = body.stop_after_match;

	const [updated] = await db
		.update(automationRules)
		.set(updates)
		.where(eq(automationRules.id, id))
		.returning();

	const rule = updated ?? existing;

	return c.json(serializeRule(rule) as never, 200);
});

app.openapi(deleteRuleRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: automationRules.id, workspaceId: automationRules.workspaceId })
		.from(automationRules)
		.where(
			and(
				eq(automationRules.id, id),
				eq(automationRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(automationRules).where(eq(automationRules.id, id));

	return c.body(null, 204);
});

app.openapi(getRuleLogsRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { limit, cursor } = c.req.valid("query");
	const db = c.get("db");

	// Verify rule exists and belongs to org
	const [rule] = await db
		.select()
		.from(automationRules)
		.where(
			and(
				eq(automationRules.id, id),
				eq(automationRules.organizationId, orgId),
			),
		)
		.limit(1);

	if (!rule) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Rule not found" } },
			404,
		);
	}

	const conditions = [eq(automationLogs.ruleId, id)];

	if (cursor) {
		conditions.push(lte(automationLogs.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(automationLogs)
		.where(and(...conditions))
		.orderBy(desc(automationLogs.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = hasMore ? rows.slice(0, limit) : rows;
	const lastRow = data[data.length - 1];
	const nextCursor =
		hasMore && lastRow ? lastRow.createdAt.toISOString() : null;

	return c.json(
		{
			data: data.map((log) => ({
				id: log.id,
				rule_id: log.ruleId,
				message_id: log.messageId,
				matched: log.matched,
				actions_executed: log.actionsExecuted,
				error: log.error,
				created_at: log.createdAt.toISOString(),
			})),
			next_cursor: nextCursor,
			has_more: hasMore,
		} as never,
		200,
	);
});

export default app;
