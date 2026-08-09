// apps/api/src/routes/automations.ts
//
// Automation CRUD + lifecycle + graph + enroll + simulate routes for the
// Manychat-parity engine. See spec §9.1 + §7 for the endpoint surface.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	AUTOMATION_NODE_KINDS,
	automationEntrypoints,
	automationScheduledJobs,
	automations,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import type { Context } from "hono";
import {
	type CredentialMutationAuthorityResult,
	type CredentialMutationTransaction,
	withCredentialMutationAuthority,
	withCredentialMutationAuthorityInTransaction,
} from "../lib/credential-mutation-authority";
import {
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import {
	resolveOperationalCreateScope,
	workspaceScopeKey,
} from "../lib/request-access";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
	isWorkspaceScopeDenied,
} from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import {
	EntrypointFilterGroupSchema,
	isEntrypointKindSupportedOnChannel,
	validateEntrypointConfig,
} from "../schemas/automation-entrypoints";
import type { Graph } from "../schemas/automation-graph";
import { GraphSchema } from "../schemas/automation-graph";
import {
	AutomationChannelSchema,
	AutomationCreateSchema,
	AutomationEnrollSchema,
	AutomationGraphUpdateSchema,
	AutomationListItemSchema,
	AutomationResponseSchema,
	AutomationSimulateSchema,
	AutomationStatusSchema,
	AutomationUpdateSchema,
	AutomationValidationSchema,
} from "../schemas/automations";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	AutomationSecretInputError,
	redactAutomationGraphSecrets,
	sealAutomationGraphSecrets,
} from "../services/automations/graph-secrets";
import {
	EnrollmentBlockedError,
	enrollContact,
} from "../services/automations/runner";
import { armAllScheduleEntrypointsForAutomation } from "../services/automations/scheduler";
import { simulate } from "../services/automations/simulator";
import {
	buildGraphFromTemplate,
	type TemplateBuildOutput,
	type TemplateKind,
} from "../services/automations/templates";
import { computeSpecificity } from "../services/automations/trigger-matcher";
import { validateGraph } from "../services/automations/validator";
import type { Env, Variables } from "../types";
import {
	AUTOMATION_CATALOG,
	AUTOMATION_CATALOG_ETAG,
} from "./_automation-catalog";
import {
	AutomationInsightsQuery,
	aggregateInsights,
	GlobalInsightsQuery,
	InsightsResponseSchema,
} from "./_automation-insights";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type CredentialAuthorityFailure = Extract<
	CredentialMutationAuthorityResult<unknown>,
	{ ok: false }
>;

class EnrollmentAuthorityRejectedError extends Error {
	constructor(readonly failure: CredentialAuthorityFailure) {
		super("automation enrollment authority rejected");
		this.name = "EnrollmentAuthorityRejectedError";
	}
}

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
		graph: redactAutomationGraphSecrets(
			(row.graph ?? {
				schema_version: 1,
				root_node_key: null,
				nodes: [],
				edges: [],
			}) as Graph,
		) as AutomationResponse["graph"],
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

type AutomationListItem = z.infer<typeof AutomationListItemSchema>;

/**
 * List serializer — omits the heavy `graph` / `template_config` /
 * `validation_errors` JSONB blobs (BREAKING: GET /v1/automations no longer
 * returns these). Clients needing the graph must call GET /v1/automations/{id}.
 * Pairs with the column projection in listAutomations that never fetches them.
 */
function serializeAutomationListItem(
	row: Omit<
		AutomationRow,
		"graph" | "scopeKey" | "templateConfig" | "validationErrors"
	>,
): AutomationListItem {
	return {
		id: row.id,
		organization_id: row.organizationId,
		workspace_id: row.workspaceId,
		name: row.name,
		description: row.description,
		channel: row.channel as AutomationListItem["channel"],
		status: row.status as AutomationListItem["status"],
		created_from_template: row.createdFromTemplate,
		total_enrolled: row.totalEnrolled,
		total_completed: row.totalCompleted,
		total_exited: row.totalExited,
		total_failed: row.totalFailed,
		last_validated_at: row.lastValidatedAt?.toISOString() ?? null,
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

function notFound(c: AppContext) {
	return c.json(
		{ error: { code: "NOT_FOUND", message: "Automation not found" } },
		404,
	) as never;
}

function markEnrollmentNotApplied(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "not_applied",
	});
}

function markEnrollmentCommitted(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({
		kind: "committed",
		units: 1,
	});
}

function markEnrollmentUnknown(c: AppContext): void {
	c.get("mutationEffectTracker")?.setAuthoritativeOutcome({ kind: "unknown" });
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
	data: z.array(AutomationListItemSchema),
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
			node_kind: z.enum(AUTOMATION_NODE_KINDS),
			entered_via_port_key: z.string().nullable(),
			exited_via_port_key: z.string().nullable(),
			outcome: z.enum([
				"advance",
				"wait_input",
				"wait_delay",
				"wait_event",
				"end",
				"fail",
			]),
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
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
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

	// Keyset pagination (composite: createdAt DESC, id DESC). Read the cursor row's
	// created_at as raw text so it isn't round-tripped through a JS Date, which
	// truncates Postgres microseconds to millisecond precision and would skip rows
	// sharing the cursor's millisecond. Bind it back with an explicit ::timestamptz
	// cast to keep the keyset comparison exact.
	if (query.cursor) {
		const key = tryDecodeTimestampIdCursor(query.cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${automations.createdAt}, ${automations.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	// Explicit column projection — never SELECT the heavy graph / template_config
	// / validation_errors JSONB on the list path (BREAKING change vs. the old
	// full-row response; the full graph is available on GET /{id}).
	const rows = await db
		.select({
			id: automations.id,
			organizationId: automations.organizationId,
			workspaceId: automations.workspaceId,
			name: automations.name,
			description: automations.description,
			channel: automations.channel,
			status: automations.status,
			createdFromTemplate: automations.createdFromTemplate,
			totalEnrolled: automations.totalEnrolled,
			totalCompleted: automations.totalCompleted,
			totalExited: automations.totalExited,
			totalFailed: automations.totalFailed,
			lastValidatedAt: automations.lastValidatedAt,
			createdBy: automations.createdBy,
			createdAt: automations.createdAt,
			updatedAt: automations.updatedAt,
			cursorTimestamp: sql<string>`to_char(${automations.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(automations)
		.where(and(...conditions))
		.orderBy(desc(automations.createdAt), desc(automations.id))
		.limit(query.limit + 1);

	const hasMore = rows.length > query.limit;
	const data = rows.slice(0, query.limit);
	const last = data.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;

	return c.json(
		{
			data: data.map((row) => serializeAutomationListItem(row)),
			next_cursor: nextCursor,
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
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"automation",
	);
	if (!scope.ok) return scope.response as never;

	let name = body.name;
	const description = body.description ?? null;
	let graph: Graph = {
		schema_version: 1,
		root_node_key: null,
		nodes: [],
		edges: [],
	};
	let createdFromTemplate: string | null = null;
	let templateConfig: Record<string, unknown> | null = null;
	let entrypoints: TemplateBuildOutput["entrypoints"] = [];

	if (body.template) {
		let built: TemplateBuildOutput | undefined;
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
		// `canonicalGraph`. A non-empty error list is a server-side preset defect;
		// never persist a flow the runtime already knows is invalid.
		const validation = validateGraph(built.graph, body.channel);
		if (validation.errors.length > 0) {
			return c.json(
				{
					error: {
						code: "INVALID_TEMPLATE",
						message: `template ${body.template.kind} produced an invalid graph`,
						details: { errors: validation.errors },
					},
				},
				400,
			);
		}
		graph = validation.canonicalGraph;
		if (!body.name || body.name === "") name = built.name;
		createdFromTemplate = body.template.kind;
		templateConfig = body.template.config ?? {};
		entrypoints = built.entrypoints;
	}

	// Template builders are privileged graph factories, but their generated
	// entrypoints still cross the same public runtime boundary as entrypoints
	// created through /automation-entrypoints. Canonicalize and validate them
	// before persistence so a preset can never bypass kind/channel/config
	// validation as those two paths evolve independently.
	const canonicalEntrypoints: TemplateBuildOutput["entrypoints"] = [];
	for (const entrypoint of entrypoints) {
		if (!isEntrypointKindSupportedOnChannel(entrypoint.kind, body.channel)) {
			return c.json(
				{
					error: {
						code: "INVALID_TEMPLATE",
						message: `${entrypoint.kind} is not supported on ${body.channel}`,
					},
				},
				400,
			);
		}
		const parsedConfig = validateEntrypointConfig(
			entrypoint.kind,
			entrypoint.config ?? {},
		);
		if (!parsedConfig.success) {
			return c.json(
				{
					error: {
						code: "INVALID_TEMPLATE",
						message: `template produced invalid ${entrypoint.kind} config`,
						details: { errors: parsedConfig.error.issues },
					},
				},
				400,
			);
		}
		const parsedFilters =
			entrypoint.filters == null
				? null
				: EntrypointFilterGroupSchema.safeParse(entrypoint.filters);
		if (parsedFilters && !parsedFilters.success) {
			return c.json(
				{
					error: {
						code: "INVALID_TEMPLATE",
						message: "template produced invalid entrypoint filters",
						details: { errors: parsedFilters.error.issues },
					},
				},
				400,
			);
		}
		canonicalEntrypoints.push({
			...entrypoint,
			config: parsedConfig.data as Record<string, unknown>,
			filters: parsedFilters ? parsedFilters.data : null,
		});
	}
	entrypoints = canonicalEntrypoints;

	// Give template creation the same account ownership, workspace, platform,
	// and lifecycle checks as direct entrypoint creation. The composite DB
	// foreign key is the final tenant-scope backstop; this check supplies a
	// deterministic client error and also rejects inactive/wrong-platform rows.
	const accountIds = new Set(
		entrypoints.flatMap((entrypoint) =>
			entrypoint.socialAccountId ? [entrypoint.socialAccountId] : [],
		),
	);
	for (const accountId of accountIds) {
		const [account] = await db
			.select({
				id: socialAccounts.id,
				workspaceId: socialAccounts.workspaceId,
				platform: socialAccounts.platform,
				lifecycleStatus: socialAccounts.lifecycleStatus,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, accountId),
					eq(socialAccounts.organizationId, orgId),
				),
			)
			.limit(1);
		if (
			!account ||
			account.workspaceId !== scope.workspaceId ||
			account.platform !== body.channel ||
			account.lifecycleStatus !== "active"
		) {
			return c.json(
				{
					error: {
						code: "INVALID_ACCOUNT",
						message:
							"Template account must be active and belong to the automation workspace and channel",
					},
				},
				400,
			);
		}
	}

	const inserted = await db.transaction(async (tx) => {
		const [automation] = await tx
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId: scope.workspaceId,
				name,
				description,
				channel: body.channel,
				status: "draft",
				graph,
				createdFromTemplate,
				templateConfig,
				createdBy: null,
			})
			.returning();
		if (!automation) return null;

		if (entrypoints.length > 0) {
			await tx.insert(automationEntrypoints).values(
				entrypoints.map((ep) => ({
					organizationId: orgId,
					scopeKey: workspaceScopeKey(automation.workspaceId),
					automationId: automation.id,
					channel: body.channel,
					kind: ep.kind,
					socialAccountId: ep.socialAccountId ?? null,
					config: ep.config ?? {},
					filters: ep.filters ?? null,
					allowReentry: ep.allowReentry ?? true,
					reentryCooldownMin: ep.reentryCooldownMin ?? 60,
					dailyCap: ep.dailyCap ?? null,
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
		return automation;
	});
	if (!inserted) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "failed to create automation",
				},
			},
			400,
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
	summary:
		"Return the static catalog of node kinds, entrypoints, bindings, actions, and channel capabilities",
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
	return c.json(
		AUTOMATION_CATALOG as unknown as z.infer<typeof CatalogResponseSchema>,
		200,
	);
});

// Global (org-wide, optionally rolled up by template kind) insights.
const globalInsightsRoute = createRoute({
	operationId: "getAutomationInsightsAll",
	method: "get",
	path: "/insights",
	tags: ["Automations"],
	summary:
		"Aggregate run metrics across the org, optionally rolled up by created_from_template",
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
	if (denied) return denied as never;
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
	if (denied) return denied as never;

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
	summary:
		"Delete an automation (hard delete — cascades to entrypoints and runs)",
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
	if (denied) return denied as never;

	await db.delete(automations).where(eq(automations.id, id));
	return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// G2 — Lifecycle + graph + enroll + simulate
// ---------------------------------------------------------------------------

async function loadScopedAutomation(
	c: AppContext,
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

async function setStatus(
	c: AppContext,
	id: string,
	status: "draft" | "active" | "paused" | "archived",
): Promise<AutomationRow | null> {
	const db = c.get("db");
	const orgId = c.get("orgId");
	return db.transaction(async (tx) => {
		const [updated] = await tx
			.update(automations)
			.set({ status, updatedAt: new Date() })
			.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
			.returning();
		if (!updated) return null;
		if (status !== "active") {
			await tx
				.delete(automationScheduledJobs)
				.where(
					and(
						eq(automationScheduledJobs.automationId, id),
						eq(automationScheduledJobs.jobType, "scheduled_trigger"),
						eq(automationScheduledJobs.status, "pending"),
					),
				);
		}
		return updated;
	});
}

async function validateAndActivate(
	c: AppContext,
	tx: CredentialMutationTransaction,
	id: string,
): Promise<{
	row: AutomationRow;
	errors: ReturnType<typeof validateGraph>["errors"];
} | null> {
	const orgId = c.get("orgId");
	// Lock and validate the authoritative graph snapshot in the same
	// transaction that activates it. Otherwise a concurrent graph replacement
	// can land between validation and the status update and make an invalid
	// graph active.
	const [current] = await tx
		.select()
		.from(automations)
		.where(and(eq(automations.id, id), eq(automations.organizationId, orgId)))
		.limit(1)
		.for("update");
	if (!current) return null;
	const validation = validateGraph(current.graph as Graph, current.channel);
	const [updated] = await tx
		.update(automations)
		.set({
			validationErrors: validation.errors.length ? validation.errors : null,
			lastValidatedAt: new Date(),
			...(validation.errors.length === 0 ? { status: "active" as const } : {}),
			updatedAt: new Date(),
		})
		.where(eq(automations.id, current.id))
		.returning();
	if (
		updated &&
		validation.errors.length === 0 &&
		current.status !== "active"
	) {
		// Retire any legacy/stale occurrence left from the inactive period before
		// armAllScheduleEntrypointsForAutomation computes one fresh successor.
		await tx
			.delete(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.automationId, current.id),
					eq(automationScheduledJobs.jobType, "scheduled_trigger"),
					eq(automationScheduledJobs.status, "pending"),
				),
			);
	}
	return updated ? { row: updated, errors: validation.errors } : null;
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
	const authority = await withCredentialMutationAuthority(c, {}, (tx) =>
		validateAndActivate(c, tx, id),
	);
	if (!authority.ok) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: authority.code, message: authority.message } } as never,
			authority.status as never,
		);
	}
	const activation = authority.value;
	if (!activation) return notFound(c);
	if (activation.errors.length > 0) {
		return c.json(
			{
				error: {
					code: "INVALID_GRAPH",
					message: "Cannot activate — the graph has validation errors.",
					details: {
						validation_errors: activation.errors,
					},
				},
			},
			422,
		);
	}
	// Arm every schedule entrypoint belonging to this automation so
	// activating a flow that was previously paused / draft immediately
	// seeds the scheduled_trigger queue. Idempotent via the ±1s dedupe
	// in insertNextScheduledJobIfNotExists.
	await armAllScheduleEntrypointsForAutomation(c.get("db"), id);
	return c.json(serializeAutomation(activation.row), 200);
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
	const authority = await withCredentialMutationAuthority(c, {}, (tx) =>
		validateAndActivate(c, tx, id),
	);
	if (!authority.ok) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: authority.code, message: authority.message } } as never,
			authority.status as never,
		);
	}
	const activation = authority.value;
	if (!activation) return notFound(c);
	if (activation.errors.length > 0) {
		return c.json(
			{
				error: {
					code: "INVALID_GRAPH",
					message: "Cannot resume — the graph has validation errors.",
					details: {
						validation_errors: activation.errors,
					},
				},
			},
			422,
		);
	}
	// Same as activate — seed scheduled_trigger rows for schedule
	// entrypoints so a paused automation resuming mid-day picks up.
	await armAllScheduleEntrypointsForAutomation(c.get("db"), id);
	return c.json(serializeAutomation(activation.row), 200);
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
		400: {
			description: "Invalid write-only credential configuration",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(replaceGraph, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const row = await loadScopedAutomation(c, id);
	if (!row) return notFound(c);

	const validation = validateGraph(body.graph as Graph, row.channel);

	let sealedGraph: Graph;
	let updated: AutomationRow | undefined;
	try {
		const authority = await withCredentialMutationAuthority(
			c,
			{},
			async (tx) => {
				// Serialize graph replacement with activation/pause/archive operations.
				// The status decision must use the latest locked row, not the snapshot
				// loaded for authorization before the transaction.
				const [current] = await tx
					.select({
						id: automations.id,
						organizationId: automations.organizationId,
						status: automations.status,
					})
					.from(automations)
					.where(
						and(
							eq(automations.id, id),
							eq(automations.organizationId, row.organizationId),
						),
					)
					.limit(1)
					.for("update");
				if (!current) {
					return { graph: validation.canonicalGraph, saved: undefined };
				}
				const nextStatus =
					validation.errors.length > 0 && current.status === "active"
						? "paused"
						: current.status;
				const graph = await sealAutomationGraphSecrets(
					tx as unknown as Parameters<typeof sealAutomationGraphSecrets>[0],
					c.env.ENCRYPTION_KEY,
					current.organizationId,
					id,
					validation.canonicalGraph,
				);
				const [saved] = await tx
					.update(automations)
					.set({
						graph: graph as never,
						validationErrors: validation.errors.length
							? validation.errors
							: null,
						lastValidatedAt: new Date(),
						status: nextStatus,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(automations.id, id),
							eq(automations.organizationId, row.organizationId),
						),
					)
					.returning();
				return { graph, saved };
			},
		);
		if (!authority.ok) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		const result = authority.value;
		sealedGraph = result.graph;
		updated = result.saved;
	} catch (error) {
		if (!(error instanceof AutomationSecretInputError)) throw error;
		return c.json(
			{
				error: {
					code: "INVALID_AUTOMATION_CREDENTIALS",
					message: error.message,
				},
			},
			400,
		);
	}
	if (!updated) return notFound(c);

	const responseBody = {
		graph: redactAutomationGraphSecrets(sealedGraph),
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
	if (!row) {
		markEnrollmentNotApplied(c);
		return notFound(c);
	}

	// Manual enrollment into a paused/draft/archived automation is almost
	// certainly a mistake — reject with a specific error code so the dashboard
	// can surface it instead of silently creating a run that never fires.
	if (row.status !== "active") {
		markEnrollmentNotApplied(c);
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
	let admissionBoundaryEntered = false;
	let admissionCommitted = false;
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
			onPreflightComplete: () => {
				admissionBoundaryEntered = true;
			},
			admissionAuthority: async (tx) => {
				const authority = await withCredentialMutationAuthorityInTransaction(
					c,
					{},
					tx,
					async () => undefined,
				);
				if (!authority.ok) {
					throw new EnrollmentAuthorityRejectedError(authority);
				}
			},
			onAdmissionCommitted: () => {
				admissionCommitted = true;
				markEnrollmentCommitted(c);
			},
		});
		return c.json({ run_id: runId }, 201);
	} catch (err) {
		if (err instanceof EnrollmentAuthorityRejectedError) {
			markEnrollmentNotApplied(c);
			return c.json(
				{
					error: {
						code: err.failure.code,
						message: err.failure.message,
					},
				} as never,
				err.failure.status as never,
			);
		}
		if (
			err instanceof EnrollmentBlockedError &&
			err.reason === "automation_inactive"
		) {
			markEnrollmentNotApplied(c);
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
		if (!admissionBoundaryEntered) {
			// enrollContact performs reads/decryption only before this boundary.
			markEnrollmentNotApplied(c);
		} else if (!admissionCommitted) {
			// A rejected transaction acknowledgement cannot prove whether COMMIT
			// reached PostgreSQL, so keep the reservation parked for reconciliation.
			markEnrollmentUnknown(c);
		}
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
		graph: redactAutomationGraphSecrets(row.graph as Graph),
		channel: row.channel,
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
