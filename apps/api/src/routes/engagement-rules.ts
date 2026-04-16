import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	engagementRules,
	engagementRuleLogs,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateEngagementRuleBody,
	EngagementRuleListResponse,
	EngagementRuleLogListResponse,
	EngagementRuleResponse,
	UpdateEngagementRuleBody,
} from "../schemas/engagement-rules";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serializeRule(r: typeof engagementRules.$inferSelect) {
	return {
		id: r.id,
		name: r.name,
		account_id: r.accountId,
		trigger_metric: r.triggerMetric as "likes" | "comments" | "shares" | "views",
		trigger_threshold: r.triggerThreshold,
		action_type: r.actionType as "repost" | "reply" | "repost_from_account",
		action_account_id: r.actionAccountId ?? null,
		action_content: r.actionContent ?? null,
		check_interval_minutes: r.checkIntervalMinutes,
		max_checks: r.maxChecks,
		status: r.status as "active" | "paused",
		workspace_id: r.workspaceId ?? null,
		created_at: r.createdAt.toISOString(),
		updated_at: r.updatedAt.toISOString(),
	};
}

function serializeLog(l: typeof engagementRuleLogs.$inferSelect) {
	return {
		id: l.id,
		rule_id: l.ruleId,
		post_target_id: l.postTargetId,
		check_number: l.checkNumber,
		metric_value: l.metricValue ?? null,
		threshold_met: l.thresholdMet,
		action_taken: l.actionTaken,
		result_post_id: l.resultPostId ?? null,
		error: l.error ?? null,
		executed_at: l.executedAt.toISOString(),
	};
}

// --- Route definitions ---

const EngagementRuleListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce.number().int().min(1).max(100).default(20).describe("Items per page"),
});

const createRule = createRoute({
	operationId: "createEngagementRule",
	method: "post",
	path: "/",
	tags: ["Engagement Rules"],
	summary: "Create an engagement rule",
	description: "Create a rule that automatically takes action when posts on a social account reach a metric threshold.",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateEngagementRuleBody } },
		},
	},
	responses: {
		201: {
			description: "Rule created",
			content: { "application/json": { schema: EngagementRuleResponse } },
		},
	},
});

const listRules = createRoute({
	operationId: "listEngagementRules",
	method: "get",
	path: "/",
	tags: ["Engagement Rules"],
	summary: "List engagement rules",
	security: [{ Bearer: [] }],
	request: { query: EngagementRuleListQuery },
	responses: {
		200: {
			description: "List of rules",
			content: { "application/json": { schema: EngagementRuleListResponse } },
		},
	},
});

const getRule = createRoute({
	operationId: "getEngagementRule",
	method: "get",
	path: "/{id}",
	tags: ["Engagement Rules"],
	summary: "Get rule details",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Rule details",
			content: { "application/json": { schema: EngagementRuleResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateRule = createRoute({
	operationId: "updateEngagementRule",
	method: "patch",
	path: "/{id}",
	tags: ["Engagement Rules"],
	summary: "Update an engagement rule",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateEngagementRuleBody } },
		},
	},
	responses: {
		200: {
			description: "Updated rule",
			content: { "application/json": { schema: EngagementRuleResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteRule = createRoute({
	operationId: "deleteEngagementRule",
	method: "delete",
	path: "/{id}",
	tags: ["Engagement Rules"],
	summary: "Delete an engagement rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const activateRule = createRoute({
	operationId: "activateEngagementRule",
	method: "post",
	path: "/{id}/activate",
	tags: ["Engagement Rules"],
	summary: "Activate a paused rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Activated rule",
			content: { "application/json": { schema: EngagementRuleResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const pauseRule = createRoute({
	operationId: "pauseEngagementRule",
	method: "post",
	path: "/{id}/pause",
	tags: ["Engagement Rules"],
	summary: "Pause an active rule",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Paused rule",
			content: { "application/json": { schema: EngagementRuleResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const listLogs = createRoute({
	operationId: "listEngagementRuleLogs",
	method: "get",
	path: "/{id}/logs",
	tags: ["Engagement Rules"],
	summary: "List execution logs for a rule",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		query: PaginationParams,
	},
	responses: {
		200: {
			description: "Execution logs",
			content: { "application/json": { schema: EngagementRuleLogListResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Handlers ---

app.openapi(createRule, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	// Verify account belongs to org
	const [account] = await db
		.select({ id: socialAccounts.id, workspaceId: socialAccounts.workspaceId })
		.from(socialAccounts)
		.where(and(eq(socialAccounts.id, body.account_id), eq(socialAccounts.organizationId, orgId)))
		.limit(1);
	if (!account) {
		return c.json({ error: { code: "NOT_FOUND", message: "Social account not found" } }, 404 as any);
	}

	const workspaceId = body.workspace_id ?? account.workspaceId ?? null;
	const denied = assertWorkspaceScope(c, workspaceId);
	if (denied) return denied as any;

	// Validate action_account_id if repost_from_account
	if (body.action_type === "repost_from_account" && !body.action_account_id) {
		return c.json({ error: { code: "VALIDATION_ERROR", message: "action_account_id is required for repost_from_account action type" } }, 400 as any);
	}
	if (body.action_type === "reply" && !body.action_content) {
		return c.json({ error: { code: "VALIDATION_ERROR", message: "action_content is required for reply action type" } }, 400 as any);
	}

	const [created] = await db
		.insert(engagementRules)
		.values({
			organizationId: orgId,
			workspaceId,
			name: body.name,
			accountId: body.account_id,
			triggerMetric: body.trigger_metric,
			triggerThreshold: body.trigger_threshold,
			actionType: body.action_type,
			actionAccountId: body.action_account_id ?? null,
			actionContent: body.action_content ?? null,
			checkIntervalMinutes: body.check_interval_minutes,
			maxChecks: body.max_checks,
		})
		.returning();

	return c.json(serializeRule(created!), 201);
});

app.openapi(listRules, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(engagementRules.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, engagementRules.workspaceId);
	if (workspace_id) {
		conditions.push(eq(engagementRules.workspaceId, workspace_id));
	}

	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: engagementRules.createdAt })
			.from(engagementRules)
			.where(and(eq(engagementRules.id, cursor), eq(engagementRules.organizationId, orgId)))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${engagementRules.createdAt} < ${cursorRow.createdAt} OR (${engagementRules.createdAt} = ${cursorRow.createdAt} AND ${engagementRules.id} < ${cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(engagementRules)
		.where(and(...conditions))
		.orderBy(desc(engagementRules.createdAt), desc(engagementRules.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeRule);

	return c.json(
		{ data, next_cursor: hasMore ? data[data.length - 1]!.id : null, has_more: hasMore },
		200,
	);
});

app.openapi(getRule, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [rule] = await db
		.select()
		.from(engagementRules)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.limit(1);
	if (!rule) {
		return c.json({ error: { code: "NOT_FOUND", message: "Engagement rule not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, rule.workspaceId);
	if (denied) return denied as any;

	return c.json(serializeRule(rule), 200);
});

app.openapi(updateRule, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(engagementRules)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.limit(1);
	if (!existing) {
		return c.json({ error: { code: "NOT_FOUND", message: "Engagement rule not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as any;

	const updateSet: Partial<typeof engagementRules.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.name !== undefined) updateSet.name = body.name;
	if (body.trigger_metric !== undefined) updateSet.triggerMetric = body.trigger_metric;
	if (body.trigger_threshold !== undefined) updateSet.triggerThreshold = body.trigger_threshold;
	if (body.action_type !== undefined) updateSet.actionType = body.action_type;
	if (body.action_account_id !== undefined) updateSet.actionAccountId = body.action_account_id;
	if (body.action_content !== undefined) updateSet.actionContent = body.action_content;
	if (body.check_interval_minutes !== undefined) updateSet.checkIntervalMinutes = body.check_interval_minutes;
	if (body.max_checks !== undefined) updateSet.maxChecks = body.max_checks;

	const [updated] = await db
		.update(engagementRules)
		.set(updateSet)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.returning();

	return c.json(serializeRule(updated!), 200);
});

app.openapi(deleteRule, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: engagementRules.id, workspaceId: engagementRules.workspaceId })
		.from(engagementRules)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.limit(1);
	if (!existing) {
		return c.json({ error: { code: "NOT_FOUND", message: "Engagement rule not found" } }, 404 as any);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as any;

	await db.delete(engagementRules).where(eq(engagementRules.id, id));
	return c.body(null, 204);
});

app.openapi(activateRule, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [rule] = await db
		.select()
		.from(engagementRules)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.limit(1);
	if (!rule) {
		return c.json({ error: { code: "NOT_FOUND", message: "Engagement rule not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, rule.workspaceId);
	if (denied) return denied as any;

	const [updated] = await db
		.update(engagementRules)
		.set({ status: "active", updatedAt: new Date() })
		.where(eq(engagementRules.id, id))
		.returning();

	return c.json(serializeRule(updated!), 200);
});

app.openapi(pauseRule, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [rule] = await db
		.select()
		.from(engagementRules)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.limit(1);
	if (!rule) {
		return c.json({ error: { code: "NOT_FOUND", message: "Engagement rule not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, rule.workspaceId);
	if (denied) return denied as any;

	const [updated] = await db
		.update(engagementRules)
		.set({ status: "paused", updatedAt: new Date() })
		.where(eq(engagementRules.id, id))
		.returning();

	return c.json(serializeRule(updated!), 200);
});

app.openapi(listLogs, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	// Verify rule exists and belongs to org
	const [rule] = await db
		.select({ id: engagementRules.id, workspaceId: engagementRules.workspaceId })
		.from(engagementRules)
		.where(and(eq(engagementRules.id, id), eq(engagementRules.organizationId, orgId)))
		.limit(1);
	if (!rule) {
		return c.json({ error: { code: "NOT_FOUND", message: "Engagement rule not found" } }, 404);
	}

	const denied = assertWorkspaceScope(c, rule.workspaceId);
	if (denied) return denied as any;

	const conditions = [eq(engagementRuleLogs.ruleId, id)];

	if (cursor) {
		const [cursorRow] = await db
			.select({ executedAt: engagementRuleLogs.executedAt })
			.from(engagementRuleLogs)
			.where(eq(engagementRuleLogs.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${engagementRuleLogs.executedAt} < ${cursorRow.executedAt} OR (${engagementRuleLogs.executedAt} = ${cursorRow.executedAt} AND ${engagementRuleLogs.id} < ${cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(engagementRuleLogs)
		.where(and(...conditions))
		.orderBy(desc(engagementRuleLogs.executedAt), desc(engagementRuleLogs.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeLog);

	return c.json(
		{ data, next_cursor: hasMore ? data[data.length - 1]!.id : null, has_more: hasMore },
		200,
	);
});

export default app;
