// apps/api/src/routes/automation-runs.ts
//
// Runs + step-run inspection routes for the Manychat-parity automation engine
// (spec §9.5). Runs are scoped to an automation; step-runs are scoped to a run.
//
// - GET /v1/automations/{id}/runs       — list runs under an automation
// - GET /v1/automation-runs/{id}        — run detail (includes context JSON)
// - GET /v1/automation-runs/{id}/steps  — append-only step log
// - POST /v1/automation-runs/{id}/stop  — force-exit an active/waiting run

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationRuns,
	automationStepRuns,
	automations,
} from "@relayapi/db";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RunRow = typeof automationRuns.$inferSelect;
type StepRow = typeof automationStepRuns.$inferSelect;

const RunResponseSchema = z.object({
	id: z.string(),
	automation_id: z.string(),
	organization_id: z.string(),
	entrypoint_id: z.string().nullable(),
	binding_id: z.string().nullable(),
	contact_id: z.string(),
	conversation_id: z.string().nullable(),
	status: z.string(),
	current_node_key: z.string().nullable(),
	current_port_key: z.string().nullable(),
	context: z.record(z.string(), z.any()).nullable(),
	waiting_until: z.string().nullable(),
	waiting_for: z.string().nullable(),
	exit_reason: z.string().nullable(),
	started_at: z.string(),
	completed_at: z.string().nullable(),
	updated_at: z.string(),
});

const StepResponseSchema = z.object({
	id: z.string(),
	run_id: z.string(),
	automation_id: z.string(),
	node_key: z.string(),
	node_kind: z.string(),
	entered_via_port_key: z.string().nullable(),
	exited_via_port_key: z.string().nullable(),
	outcome: z.string(),
	duration_ms: z.number(),
	payload: z.any().nullable(),
	error: z.any().nullable(),
	executed_at: z.string(),
});

function serializeRun(row: RunRow): z.infer<typeof RunResponseSchema> {
	return {
		id: row.id,
		automation_id: row.automationId,
		organization_id: row.organizationId,
		entrypoint_id: row.entrypointId ?? null,
		binding_id: row.bindingId ?? null,
		contact_id: row.contactId,
		conversation_id: row.conversationId ?? null,
		status: row.status,
		current_node_key: row.currentNodeKey ?? null,
		current_port_key: row.currentPortKey ?? null,
		context: (row.context as Record<string, unknown> | null) ?? null,
		waiting_until: row.waitingUntil?.toISOString() ?? null,
		waiting_for: row.waitingFor ?? null,
		exit_reason: row.exitReason ?? null,
		started_at: row.startedAt.toISOString(),
		completed_at: row.completedAt?.toISOString() ?? null,
		updated_at: row.updatedAt.toISOString(),
	};
}

function serializeStep(row: StepRow): z.infer<typeof StepResponseSchema> {
	return {
		id: String(row.id),
		run_id: row.runId,
		automation_id: row.automationId,
		node_key: row.nodeKey,
		node_kind: row.nodeKind,
		entered_via_port_key: row.enteredViaPortKey ?? null,
		exited_via_port_key: row.exitedViaPortKey ?? null,
		outcome: row.outcome,
		duration_ms: row.durationMs,
		payload: row.payload ?? null,
		error: row.error ?? null,
		executed_at: row.executedAt.toISOString(),
	};
}

function notFound(c: any, label = "Run") {
	return c.json(
		{ error: { code: "NOT_FOUND", message: `${label} not found` } },
		404,
	);
}

async function loadScopedAutomation(c: any, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [row] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1);
	if (!row) return null;
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return { denied };
	return { row };
}

async function loadScopedRun(c: any, id: string) {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [result] = await db
		.select({ run: automationRuns, automation: automations })
		.from(automationRuns)
		.innerJoin(automations, eq(automationRuns.automationId, automations.id))
		.where(
			and(
				eq(automationRuns.id, id),
				eq(automationRuns.organizationId, orgId),
			),
		)
		.limit(1);
	if (!result) return null;
	const denied = assertWorkspaceScope(c, result.automation.workspaceId);
	if (denied) return { denied };
	return { run: result.run, automation: result.automation };
}

// ---------------------------------------------------------------------------
// Automation-scoped list (mounted under /v1/automations)
// ---------------------------------------------------------------------------

export const automationScopedRuns = new OpenAPIHono<{
	Bindings: Env;
	Variables: Variables;
}>();

const AutomationIdParams = z.object({ id: z.string() });

const ListRunsQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	status: z.string().optional(),
	contact_id: z.string().optional(),
	started_after: z.string().datetime({ offset: true }).optional(),
	started_before: z.string().datetime({ offset: true }).optional(),
});

const ListRunsResponse = z.object({
	data: z.array(RunResponseSchema),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

const listRuns = createRoute({
	operationId: "listAutomationRuns",
	method: "get",
	path: "/{id}/runs",
	tags: ["Automation Runs"],
	summary: "List runs for an automation",
	security: [{ Bearer: [] }],
	request: { params: AutomationIdParams, query: ListRunsQuery },
	responses: {
		200: {
			description: "Runs list",
			content: { "application/json": { schema: ListRunsResponse } },
		},
		404: {
			description: "Automation not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

automationScopedRuns.openapi(listRuns, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedAutomation(c, id);
	if (!scoped) return notFound(c, "Automation");
	if ("denied" in scoped) return scoped.denied as never;

	const query = c.req.valid("query");
	const db = c.get("db");

	const conditions: SQL[] = [
		eq(automationRuns.automationId, id),
		eq(automationRuns.organizationId, c.get("orgId")),
	];
	if (query.status) {
		conditions.push(
			eq(
				automationRuns.status,
				query.status as typeof automationRuns.$inferSelect.status,
			),
		);
	}
	if (query.contact_id) {
		conditions.push(eq(automationRuns.contactId, query.contact_id));
	}
	if (query.started_after) {
		conditions.push(
			sql`${automationRuns.startedAt} >= ${query.started_after}`,
		);
	}
	if (query.started_before) {
		conditions.push(
			sql`${automationRuns.startedAt} <= ${query.started_before}`,
		);
	}
	if (query.cursor) {
		const [cursorRow] = await db
			.select({ startedAt: automationRuns.startedAt })
			.from(automationRuns)
			.where(eq(automationRuns.id, query.cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${automationRuns.startedAt} < ${cursorRow.startedAt} OR (${automationRuns.startedAt} = ${cursorRow.startedAt} AND ${automationRuns.id} < ${query.cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(automationRuns)
		.where(and(...conditions))
		.orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
		.limit(query.limit + 1);

	const hasMore = rows.length > query.limit;
	const data = rows.slice(0, query.limit);

	return c.json(
		{
			data: data.map(serializeRun),
			next_cursor:
				hasMore && data.length > 0
					? (data[data.length - 1]?.id ?? null)
					: null,
			has_more: hasMore,
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Id-addressed run routes (mounted under /v1/automation-runs)
// ---------------------------------------------------------------------------

const IdParams = z.object({ id: z.string() });

const getRun = createRoute({
	operationId: "getAutomationRun",
	method: "get",
	path: "/{id}",
	tags: ["Automation Runs"],
	summary: "Get a run (includes context JSON)",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Run",
			content: { "application/json": { schema: RunResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getRun, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedRun(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	return c.json(serializeRun(scoped.run), 200);
});

const ListStepsQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ListStepsResponse = z.object({
	data: z.array(StepResponseSchema),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

const listSteps = createRoute({
	operationId: "listAutomationRunSteps",
	method: "get",
	path: "/{id}/steps",
	tags: ["Automation Runs"],
	summary: "List the step log for a run (oldest first)",
	security: [{ Bearer: [] }],
	request: { params: IdParams, query: ListStepsQuery },
	responses: {
		200: {
			description: "Steps list",
			content: { "application/json": { schema: ListStepsResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listSteps, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedRun(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;

	const query = c.req.valid("query");
	const db = c.get("db");

	const conditions: SQL[] = [eq(automationStepRuns.runId, id)];
	if (query.cursor) {
		// cursor is the serialized bigint id. Use id > cursor for ASC ordering.
		conditions.push(sql`${automationStepRuns.id} > ${query.cursor}`);
	}

	const rows = await db
		.select()
		.from(automationStepRuns)
		.where(and(...conditions))
		.orderBy(asc(automationStepRuns.executedAt), asc(automationStepRuns.id))
		.limit(query.limit + 1);

	const hasMore = rows.length > query.limit;
	const data = rows.slice(0, query.limit);

	return c.json(
		{
			data: data.map(serializeStep),
			next_cursor:
				hasMore && data.length > 0
					? String(data[data.length - 1]?.id ?? "")
					: null,
			has_more: hasMore,
		},
		200,
	);
});

const stopRun = createRoute({
	operationId: "stopAutomationRun",
	method: "post",
	path: "/{id}/stop",
	tags: ["Automation Runs"],
	summary: "Force-exit an active or waiting run",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Stopped",
			content: { "application/json": { schema: RunResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Run is not active or waiting",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(stopRun, async (c) => {
	const { id } = c.req.valid("param");
	const scoped = await loadScopedRun(c, id);
	if (!scoped) return notFound(c);
	if ("denied" in scoped) return scoped.denied as never;
	const { run } = scoped;

	if (run.status !== "active" && run.status !== "waiting") {
		return c.json(
			{
				error: {
					code: "INVALID_STATE",
					message: `Cannot stop a run in status ${run.status}`,
				},
			},
			422,
		);
	}

	const db = c.get("db");
	const [updated] = await db
		.update(automationRuns)
		.set({
			status: "exited",
			exitReason: "admin_stopped",
			completedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(automationRuns.id, id))
		.returning();
	if (!updated) return notFound(c);
	return c.json(serializeRun(updated), 200);
});

export default app;
