// apps/api/src/routes/automations.ts
//
// Automation CRUD + lifecycle + graph + enroll + simulate routes for the
// Manychat-parity engine. See spec §9.1 + §7 for the endpoint surface.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationEntrypoints,
	automationRuns,
	automations,
} from "@relayapi/db";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
} from "../lib/workspace-scope";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import { GraphSchema } from "../schemas/automation-graph";
import {
	AutomationChannelSchema,
	AutomationCreateSchema,
	AutomationEnrollSchema,
	AutomationGraphUpdateSchema,
	AutomationResponseSchema,
	AutomationSimulateSchema,
	AutomationStatusSchema,
	AutomationUpdateSchema,
	AutomationValidationSchema,
} from "../schemas/automations";
import { enrollContact } from "../services/automations/runner";
import { armAllScheduleEntrypointsForAutomation } from "../services/automations/scheduler";
import { simulate } from "../services/automations/simulator";
import {
	buildGraphFromTemplate,
	type TemplateKind,
} from "../services/automations/templates";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import { validateGraph } from "../services/automations/validator";
import type { Env, Variables } from "../types";
import {
	AUTOMATION_CATALOG,
	AUTOMATION_CATALOG_ETAG,
	AUTOMATION_CATALOG_JSON,
} from "./_automation-catalog";
import {
	aggregateInsights,
	AutomationInsightsQuery,
	GlobalInsightsQuery,
	InsightsResponseSchema,
} from "./_automation-insights";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AutomationRow = typeof automations.$inferSelect;
type AutomationResponse = z.infer<typeof AutomationResponseSchema>;

function serializeAutomation(row: AutomationRow): AutomationResponse {
	return {
		id: row.id,
		organization_id: row.organizationId,
		workspace_id: row.workspaceId,
		name: row.name,
		description: row.description,
		channel: row.channel as AutomationResponse["channel"],
		status: row.status as AutomationResponse["status"],
		graph: (row.graph ?? {
			schema_version: 1,
			root_node_key: null,
			nodes: [],
			edges: [],
		}) as AutomationResponse["graph"],
		created_from_template: row.createdFromTemplate,
		template_config:
			(row.templateConfig as Record<string, unknown> | null) ?? null,
		total_enrolled: row.totalEnrolled,
		total_completed: row.totalCompleted,
		total_exited: row.totalExited,
		total_failed: row.totalFailed,
		last_validated_at: row.lastValidatedAt?.toISOString() ?? null,
		validation_errors:
			(row.validationErrors as AutomationResponse["validation_errors"]) ?? null,
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

function notFound(c: any) {
	return c.json(
		{ error: { code: "NOT_FOUND", message: "Automation not found" } },
		404,
	);
}

// ---------------------------------------------------------------------------
// Route schemas
// ---------------------------------------------------------------------------

const IdParams = z.object({ id: z.string() });

const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
	status: AutomationStatusSchema.optional(),
	channel: AutomationChannelSchema.optional(),
	created_from_template: z.string().optional(),
	q: z.string().optional().describe("Name substring match"),
});

const ListResponse = z.object({
	data: z.array(AutomationResponseSchema),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

const GraphUpdateResponse = z.object({
	graph: GraphSchema,
	validation: AutomationValidationSchema,
	automation: z.object({
		status: AutomationStatusSchema,
		validation_errors: z
			.array(z.any())
			.nullable()
			.describe("Fatal validation errors that forced the automation to pause."),
	}),
});

const EnrollResponse = z.object({ run_id: z.string() });

const SimulateResponseSchema = z.object({
	steps: z.array(
		z.object({
			node_key: z.string(),
			node_kind: z.string(),
			entered_via_port_key: z.string().nullable(),
			exited_via_port_key: z.string().nullable(),
			outcome: z.enum(["advance", "wait_input", "wait_delay", "end", "fail"]),
			payload: z.any().optional(),
		}),
	),
	ended_at_node: z.string().nullable(),
	exit_reason: z.string(),
});

// ---------------------------------------------------------------------------
// G1 — CRUD
// ---------------------------------------------------------------------------

const listAutomations = createRoute({
	operationId: "listAutomations",
	method: "get",
	path: "/",
	tags: ["Automations"],
	summary: "List automations",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "Automation list",
			content: { "application/json": { schema: ListResponse } },
		},
	},
});

app.openapi(listAutomations, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const query = c.req.valid("query");

	const conditions = [eq(automations.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, automations.workspaceId);

	if (query.workspace_id) {
		conditions.push(eq(automations.workspaceId, query.workspace_id));
	}
	if (query.status) {
		conditions.push(eq(automations.status, query.status));
	}
	if (query.channel) {
		conditions.push(eq(automations.channel, query.channel));
	}
	if (query.created_from_template) {
		conditions.push(
			eq(automations.createdFromTemplate, query.created_from_template),
		);
	}
	if (query.q) {
		const escaped = query.q.replace(/[%_\\]/g, "\\$&");
		conditions.push(ilike(automations.name, `%${escaped}%`));
	}

	if (query.cursor) {
		const [cursorRow] = await db
			.select({ createdAt: automations.createdAt })
			.from(automations)
			.where(eq(automations.id, query.cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${automations.createdAt} < ${cursorRow.createdAt} OR (${automations.createdAt} = ${cursorRow.createdAt} AND ${automations.id} < ${query.cursor}))`,
			);
		}
	}

	const rows = await db
		.select()
		.from(automations)
		.where(and(...conditions))
		.orderBy(desc(automations.createdAt), desc(automations.id))
		.limit(query.limit + 1);

	const hasMore = rows.length > query.limit;
	const data = rows.slice(0, query.limit);

	return c.json(
		{
			data: data.map(serializeAutomation),
			next_cursor:
				hasMore && data.length > 0 ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

const createAutomation = createRoute({
	operationId: "createAutomation",
	method: "post",
	path: "/",
	tags: ["Automations"],
	summary: "Create an automation (optionally expanding a template)",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: AutomationCreateSchema } },
		},
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createAutomation, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const body = c.req.valid("json");

	let name = body.name;
	const description = body.description ?? null;
	let graph: any = {
		schema_version: 1,
		root_node_key: null,
		nodes: [],
		edges: [],
	};
	let createdFromTemplate: string | null = null;
	let templateConfig: Record<string, unknown> | null = null;
	type EntrypointRow = {
		kind: string;
		config: Record<string, unknown>;
		socialAccountId?: string | null;
		filters?: Record<string, unknown> | null;
		allowReentry?: boolean;
		reentryCooldownMin?: number;
		priority?: number;
	};
	let entrypoints: EntrypointRow[] = [];

	if (body.template) {
		let built;
		try {
			built = buildGraphFromTemplate({
				kind: body.template.kind as TemplateKind,
				channel: body.channel,
				config: body.template.config ?? {},
			});
		} catch (err) {
			return c.json(
				{
					error: {
						code: "INVALID_TEMPLATE",
						message:
							err instanceof Error
								? err.message
								: `unknown template kind: ${body.template.kind}`,
					},
				},
				400,
			);
		}
		// Run the template-built graph through validateGraph so every node gets
		// its canonical `ports` array (derived from node.kind + node.config). The
		// template builders intentionally emit `ports: []` and let the validator
		// fill them in — this matches what PUT /{id}/graph already does and
		// guarantees the persisted graph renders handles on the dashboard canvas.
		// `applyDerivedPorts` runs even when errors are present, so we always use
		// `canonicalGraph`. A non-empty errors array here indicates a template
		// builder bug; surface it as a stderr warning but proceed so the create
		// isn't blocked by a stale template.
		const validation = validateGraph(built.graph);
		if (validation.errors.length > 0) {
			console.warn(
				`[automations] template "${body.template.kind}" produced graph with validation errors`,
				validation.errors,
			);
		}
		graph = validation.canonicalGraph;
		if (!body.name || body.name === "") name = built.name;
		createdFromTemplate = body.template.kind;
		templateConfig = body.template.config ?? {};
		entrypoints = built.entrypoints;
	}

	const [inserted] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name,
			description,
			channel: body.channel,
			status: "draft",
			graph,
			createdFromTemplate,
			templateConfig,
			// API key auth doesn't map cleanly to a user_id; createdBy is the
			// auth.user.id FK — leave null when the request comes via an API key.
			// The audit trail of which key created the automation is in request logs.
			createdBy: null,
		})
		.returning();
	if (!inserted) {
		return c.json(
			{
				error: { code: "INTERNAL_ERROR", message: "failed to create automation" },
			},
			400,
		);
	}

	if (entrypoints.length > 0) {
		await db.insert(automationEntrypoints).values(
			entrypoints.map((ep) => ({
				automationId: inserted.id,
				channel: body.channel,
				kind: ep.kind,
				socialAccountId: ep.socialAccountId ?? null,
				config: ep.config ?? {},
				filters: ep.filters ?? null,
				allowReentry: ep.allowReentry ?? true,
				reentryCooldownMin: ep.reentryCooldownMin ?? 60,
				priority: ep.priority ?? 100,
				specificity: computeSpecificity(
					ep.kind,
					ep.config ?? {},
					ep.filters ?? null,
					ep.socialAccountId ?? null,
				),
			})),
		);
	}

	return c.json(serializeAutomation(inserted), 201);
});

// ---------------------------------------------------------------------------
// G7 — Catalog (static, ETag-cached) + Global insights (live SQL aggregates)
//
// IMPORTANT: These routes use static path segments (`/catalog`, `/insights`)
// that would otherwise collide with `GET /{id}` below. Hono's router matches
// in registration order, so these MUST be registered BEFORE `/{id}` — moving
// them later causes `/v1/automations/catalog` to hit the `/{id}` handler with
// `id="catalog"`, fail the DB lookup, and return a spurious 404.
// ---------------------------------------------------------------------------

const CatalogResponseSchema = z
	.object({
		node_kinds: z.array(z.any()),
		entrypoint_kinds: z.array(z.any()),
		binding_types: z.array(z.any()),
		action_types: z.array(z.any()),
		channel_capabilities: z.record(z.string(), z.any()),
		template_kinds: z.array(z.string()),
	})
	.openapi("AutomationCatalog");

const catalogRoute = createRoute({
	operationId: "getAutomationCatalog",
	method: "get",
	path: "/catalog",
	tags: ["Automations"],
	summary: "Return the static catalog of node kinds, entrypoints, bindings, actions, and channel capabilities",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Catalog",
			content: { "application/json": { schema: CatalogResponseSchema } },
		},
		304: { description: "Not modified" },
	},
});

app.openapi(catalogRoute, async (c) => {
	// Conditional GET — serve 304 if the ETag matches.
	const incoming = c.req.header("if-none-match");
	if (incoming && incoming === AUTOMATION_CATALOG_ETAG) {
		c.header("ETag", AUTOMATION_CATALOG_ETAG);
		return c.body(null, 304);
	}
	c.header("ETag", AUTOMATION_CATALOG_ETAG);
	c.header("Cache-Control", "public, max-age=300");
	// The catalog is pre-stringified for cheap serving; but returning the
	// parsed object keeps the response type aligned with the OpenAPI schema.
	return c.json(AUTOMATION_CATALOG as unknown as z.infer<typeof CatalogResponseSchema>, 200);
});

// Global (org-wide, optionally rolled up by template kind) insights.
const globalInsightsRoute = createRoute({
	operationId: "getAutomationInsightsAll",
	method: "get",
	path: "/insights",
	tags: ["Automations"],
	summary: "Aggregate run metrics across the org, optionally rolled up by created_from_template",
	security: [{ Bearer: [] }],
	request: { query: GlobalInsightsQuery },
	responses: {
		200: {
			description: "Insights",
			content: { "application/json": { schema: InsightsResponseSchema } },
		},
	},
});

app.openapi(globalInsightsRoute, async (c) => {
	const query = c.req.valid("query");
	const db = c.get("db");
	const result = await aggregateInsights(db, query, {
		orgId: c.get("orgId"),
		createdFromTemplate: query.created_from_template,
		workspaceId: query.workspace_id,
	});
	return c.json(result, 200);
});

const getAutomation = createRoute({
	operationId: "getAutomation",
	method: "get",
	path: "/{id}",
	tags: ["Automations"],
	summary: "Get an automation with its full graph",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Automation",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getAutomation, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const { id } = c.req.valid("param");

	const [row] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1);
	if (!row) return notFound(c);
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied;
	return c.json(serializeAutomation(row), 200);
});

const updateAutomation = createRoute({
	operationId: "updateAutomation",
	method: "patch",
	path: "/{id}",
	tags: ["Automations"],
	summary: "Update automation metadata (name, description)",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: AutomationUpdateSchema } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateAutomation, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");

	const [existing] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1);
	if (!existing) return notFound(c);
	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const patch: Partial<typeof automations.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.name !== undefined) patch.name = body.name;
	if (body.description !== undefined) patch.description = body.description;

	const [updated] = await db
		.update(automations)
		.set(patch)
		.where(eq(automations.id, id))
		.returning();
	if (!updated) return notFound(c);
	return c.json(serializeAutomation(updated), 200);
});

const deleteAutomation = createRoute({
	operationId: "deleteAutomation",
	method: "delete",
	path: "/{id}",
	tags: ["Automations"],
	summary: "Delete an automation (hard delete — cascades to entrypoints and runs)",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteAutomation, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const { id } = c.req.valid("param");

	const [existing] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1);
	if (!existing) return notFound(c);
	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(automations).where(eq(automations.id, id));
	return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// G2 — Lifecycle + graph + enroll + simulate
// ---------------------------------------------------------------------------

async function loadScopedAutomation(
	c: any,
	id: string,
): Promise<AutomationRow | null> {
	const orgId = c.get("orgId");
	const db = c.get("db");
	const [row] = await db
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1);
	if (!row) return null;
	if (isWorkspaceScopeDenied(c, row.workspaceId)) return null;
	return row;
}

function hasFatalErrors(row: AutomationRow): boolean {
	if (row.validationErrors == null) return false;
	const errs = row.validationErrors as Array<unknown>;
	return Array.isArray(errs) && errs.length > 0;
}

async function setStatus(
	c: any,
	id: string,
	status: "draft" | "active" | "paused" | "archived",
): Promise<AutomationRow | null> {
	const db = c.get("db");
	const [updated] = await db
		.update(automations)
		.set({ status, updatedAt: new Date() })
		.where(eq(automations.id, id))
		.returning();
	return updated ?? null;
}

async function runValidation(
	c: any,
	row: AutomationRow,
): Promise<AutomationRow> {
	const db = c.get("db");
	const validation = validateGraph(row.graph as any);
	const [updated] = await db
		.update(automations)
		.set({
			validationErrors: validation.errors.length ? validation.errors : null,
			lastValidatedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(automations.id, row.id))
		.returning();
	return updated ?? row;
}

// Activate
const activateAutomation = createRoute({
	operationId: "activateAutomation",
	method: "post",
	path: "/{id}/activate",
	tags: ["Automations"],
	summary: "Activate an automation",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Activated",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Validation failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(activateAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);
	const revalidated = await runValidation(c, row);
	if (hasFatalErrors(revalidated)) {
		return c.json(
			{
				error: {
					code: "INVALID_GRAPH",
					message: "Cannot activate — the graph has validation errors.",
					details: {
						validation_errors: revalidated.validationErrors ?? [],
					},
				},
			},
			422,
		);
	}
	const updated = await setStatus(c, id, "active");
	if (!updated) return notFound(c);
	// Arm every schedule entrypoint belonging to this automation so
	// activating a flow that was previously paused / draft immediately
	// seeds the scheduled_trigger queue. Idempotent via the ±1s dedupe
	// in insertNextScheduledJobIfNotExists.
	await armAllScheduleEntrypointsForAutomation(c.get("db"), id);
	return c.json(serializeAutomation(updated), 200);
});

const pauseAutomation = createRoute({
	operationId: "pauseAutomation",
	method: "post",
	path: "/{id}/pause",
	tags: ["Automations"],
	summary: "Pause an automation",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Paused",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(pauseAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);
	const updated = await setStatus(c, id, "paused");
	if (!updated) return notFound(c);
	return c.json(serializeAutomation(updated), 200);
});

const resumeAutomation = createRoute({
	operationId: "resumeAutomation",
	method: "post",
	path: "/{id}/resume",
	tags: ["Automations"],
	summary: "Resume a paused automation (equivalent to activate)",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Resumed",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Validation failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(resumeAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);
	const revalidated = await runValidation(c, row);
	if (hasFatalErrors(revalidated)) {
		return c.json(
			{
				error: {
					code: "INVALID_GRAPH",
					message: "Cannot resume — the graph has validation errors.",
					details: {
						validation_errors: revalidated.validationErrors ?? [],
					},
				},
			},
			422,
		);
	}
	const updated = await setStatus(c, id, "active");
	if (!updated) return notFound(c);
	// Same as activate — seed scheduled_trigger rows for schedule
	// entrypoints so a paused automation resuming mid-day picks up.
	await armAllScheduleEntrypointsForAutomation(c.get("db"), id);
	return c.json(serializeAutomation(updated), 200);
});

const archiveAutomation = createRoute({
	operationId: "archiveAutomation",
	method: "post",
	path: "/{id}/archive",
	tags: ["Automations"],
	summary: "Archive an automation",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Archived",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(archiveAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);
	const updated = await setStatus(c, id, "archived");
	if (!updated) return notFound(c);
	return c.json(serializeAutomation(updated), 200);
});

const unarchiveAutomation = createRoute({
	operationId: "unarchiveAutomation",
	method: "post",
	path: "/{id}/unarchive",
	tags: ["Automations"],
	summary: "Unarchive an automation (returns it to paused state)",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Unarchived",
			content: { "application/json": { schema: AutomationResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(unarchiveAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);
	const updated = await setStatus(c, id, "paused");
	if (!updated) return notFound(c);
	return c.json(serializeAutomation(updated), 200);
});

const replaceGraph = createRoute({
	operationId: "replaceAutomationGraph",
	method: "put",
	path: "/{id}/graph",
	tags: ["Automations"],
	summary: "Replace the automation's graph",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: AutomationGraphUpdateSchema } },
		},
	},
	responses: {
		200: {
			description: "Graph accepted (may still carry warnings)",
			content: { "application/json": { schema: GraphUpdateResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Graph has fatal validation errors",
			content: { "application/json": { schema: GraphUpdateResponse } },
		},
	},
});

app.openapi(replaceGraph, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);

	const db = c.get("db");
	const validation = validateGraph(body.graph as any);

	// Force-pause if the current row is active and we've introduced fatal errors.
	const forcePause =
		validation.errors.length > 0 && row.status === "active";
	const nextStatus = forcePause ? "paused" : row.status;

	const [updated] = await db
		.update(automations)
		.set({
			graph: validation.canonicalGraph as never,
			validationErrors: validation.errors.length ? validation.errors : null,
			lastValidatedAt: new Date(),
			status: nextStatus,
			updatedAt: new Date(),
		})
		.where(eq(automations.id, id))
		.returning();
	if (!updated) return notFound(c);

	const responseBody = {
		graph: validation.canonicalGraph,
		validation: {
			valid: validation.valid,
			errors: validation.errors,
			warnings: validation.warnings,
		},
		automation: {
			status: updated.status as AutomationResponse["status"],
			validation_errors:
				(updated.validationErrors as AutomationResponse["validation_errors"]) ??
				null,
		},
	};

	if (validation.errors.length > 0) {
		return c.json(responseBody, 422);
	}
	return c.json(responseBody, 200);
});

const enrollAutomation = createRoute({
	operationId: "enrollAutomationContact",
	method: "post",
	path: "/{id}/enroll",
	tags: ["Automations"],
	summary: "Manually enroll a contact into an automation",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: AutomationEnrollSchema } },
		},
	},
	responses: {
		201: {
			description: "Enrolled",
			content: { "application/json": { schema: EnrollResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Could not enroll",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(enrollAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);

	// Manual enrollment into a paused/draft/archived automation is almost
	// certainly a mistake — reject with a specific error code so the dashboard
	// can surface it instead of silently creating a run that never fires.
	if (row.status !== "active") {
		return c.json(
			{
				error: {
					code: "automation_not_active",
					message: "Cannot enroll into a non-active automation",
				},
			},
			422,
		);
	}

	const db = c.get("db");
	try {
		const { runId } = await enrollContact(db, {
			automationId: row.id,
			organizationId: row.organizationId,
			contactId: body.contact_id,
			conversationId: null,
			channel: row.channel,
			entrypointId: body.entrypoint_id ?? null,
			bindingId: null,
			socialAccountId: body.social_account_id ?? null,
			contextOverrides: body.context_overrides ?? {},
			env: c.env as unknown as Record<string, unknown>,
		});
		return c.json({ run_id: runId }, 201);
	} catch (err) {
		return c.json(
			{
				error: {
					code: "ENROLL_FAILED",
					message: err instanceof Error ? err.message : String(err),
				},
			},
			422,
		);
	}
});

const simulateAutomationRoute = createRoute({
	operationId: "simulateAutomation",
	method: "post",
	path: "/{id}/simulate",
	tags: ["Automations"],
	summary: "Dry-run the graph without any side effects",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: AutomationSimulateSchema } },
		},
	},
	responses: {
		200: {
			description: "Simulation result",
			content: { "application/json": { schema: SimulateResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(simulateAutomationRoute, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);

	const result = await simulate({
		graph: row.graph as any,
		startNodeKey: body.start_node_key,
		testContext: body.test_context,
		branchChoices: body.branch_choices,
	});
	return c.json(result, 200);
});

// Per-automation insights. `/{id}/insights` has two path segments so it
// never collides with the single-segment `/{id}` route — registration
// order below is fine.
const insightsRoute = createRoute({
	operationId: "getAutomationInsights",
	method: "get",
	path: "/{id}/insights",
	tags: ["Automations"],
	summary: "Aggregate run metrics scoped to a single automation",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		query: AutomationInsightsQuery,
	},
	responses: {
		200: {
			description: "Insights",
			content: { "application/json": { schema: InsightsResponseSchema } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(insightsRoute, async (c) => {
	const { id } = c.req.valid("param");
	const query = c.req.valid("query");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);

	const db = c.get("db");
	const result = await aggregateInsights(db, query, {
		orgId: c.get("orgId"),
		automationId: id,
	});
	return c.json(result, 200);
});

export default app;
