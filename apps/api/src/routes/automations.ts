import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	automationEdges,
	automationEnrollments,
	automationNodes,
	automationRunLogs,
	automationVersions,
	automations,
	createDb,
} from "@relayapi/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { automationError, suggest } from "../lib/automation-errors";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import {
	AUTOMATION_CHANNELS,
	AUTOMATION_NODE_TYPES,
	AUTOMATION_TRIGGER_TYPES,
	AutomationCreateSpec,
	AutomationEnrollmentResponse,
	AutomationListResponse,
	AutomationResponse,
	AutomationRunLogResponse,
	AutomationSchemaResponse,
	AutomationSimulateRequest,
	AutomationSimulateResponse,
	AutomationUpdateSpec,
	AutomationWithGraphResponse,
} from "../schemas/automations";
import { simulateAutomation } from "../services/automations/simulator";
import type { AutomationSnapshot } from "../services/automations/types";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const IdParams = z.object({ id: z.string() });
const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
	status: z
		.enum(["draft", "active", "paused", "archived"])
		.optional(),
	channel: z.string().optional(),
	trigger_type: z.string().optional(),
});

// --- Serializers ---

type SerializedAutomation = z.infer<typeof AutomationResponse>;

function serializeAutomation(
	a: typeof automations.$inferSelect,
): SerializedAutomation {
	return {
		id: a.id,
		organization_id: a.organizationId,
		workspace_id: a.workspaceId,
		name: a.name,
		description: a.description ?? null,
		status: a.status as SerializedAutomation["status"],
		channel: a.channel as SerializedAutomation["channel"],
		trigger_type: a.triggerType as SerializedAutomation["trigger_type"],
		trigger_config: a.triggerConfig,
		trigger_filters: a.triggerFilters,
		social_account_id: a.socialAccountId,
		entry_node_id: a.entryNodeId,
		version: a.version,
		published_version: a.publishedVersion,
		exit_on_reply: a.exitOnReply,
		allow_reentry: a.allowReentry,
		reentry_cooldown_min: a.reentryCooldownMin,
		total_enrolled: a.totalEnrolled,
		total_completed: a.totalCompleted,
		total_exited: a.totalExited,
		created_at: a.createdAt.toISOString(),
		updated_at: a.updatedAt.toISOString(),
	};
}

// --- Create ---

const createAutomation = createRoute({
	operationId: "createAutomation",
	method: "post",
	path: "/",
	tags: ["Automations"],
	summary: "Create an automation (single-blob spec)",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: AutomationCreateSpec } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: AutomationWithGraphResponse } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Server error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createAutomation, async (c) => {
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	// Validate node keys are unique + edges reference known keys
	const keys = new Set<string>();
	for (const n of body.nodes) {
		if (keys.has(n.key)) {
			return c.json(
				automationError(
					"duplicate_node_key",
					`Node key '${n.key}' appears more than once`,
					{ path: `nodes[].key`, details: { key: n.key } },
				),
				400,
			);
		}
		keys.add(n.key);
	}

	const allKeys = new Set([...keys, "trigger"]);
	for (let i = 0; i < body.edges.length; i++) {
		const e = body.edges[i]!;
		if (!allKeys.has(e.from)) {
			return c.json(
				automationError(
					"unknown_node_reference",
					`Edge ${i} references unknown node '${e.from}'`,
					{
						path: `edges[${i}].from`,
						suggestion: suggest(e.from, Array.from(allKeys)),
					},
				),
				400,
			);
		}
		if (!allKeys.has(e.to)) {
			return c.json(
				automationError(
					"unknown_node_reference",
					`Edge ${i} references unknown node '${e.to}'`,
					{
						path: `edges[${i}].to`,
						suggestion: suggest(e.to, Array.from(allKeys)),
					},
				),
				400,
			);
		}
	}

	// Optional workspace scope check
	if (body.workspace_id) {
		// Workspace-level enforcement deferred to middleware.
	}

	// 1. Insert automation header
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			description: body.description,
			status: body.status,
			channel: body.channel as never,
			triggerType: body.trigger.type as never,
			triggerConfig: body.trigger.config ?? {},
			triggerFilters: body.trigger.filters ?? {},
			socialAccountId: body.trigger.account_id ?? null,
			exitOnReply: body.exit_on_reply,
			allowReentry: body.allow_reentry,
			reentryCooldownMin: body.reentry_cooldown_min,
			createdBy: c.get("keyId"),
		})
		.returning();

	if (!auto) {
		return c.json(
			automationError("create_failed", "Failed to create automation"),
			500,
		);
	}

	// 2. Insert a virtual 'trigger' node as the entry point
	const [triggerNode] = await db
		.insert(automationNodes)
		.values({
			automationId: auto.id,
			key: "trigger",
			type: "trigger" as never,
			config: {},
		})
		.returning();

	// 3. Insert user nodes
	const insertedNodes = await db
		.insert(automationNodes)
		.values(
			body.nodes.map((n) => ({
				automationId: auto.id,
				key: n.key,
				type: n.type as never,
				config: extractNodeConfig(n),
				canvasX: n.canvas_x,
				canvasY: n.canvas_y,
				notes: n.notes,
			})),
		)
		.returning();

	const keyToId = new Map<string, string>([
		["trigger", triggerNode!.id],
		...insertedNodes.map((n) => [n.key, n.id] as [string, string]),
	]);

	// 4. Insert edges
	if (body.edges.length > 0) {
		await db.insert(automationEdges).values(
			body.edges.map((e) => ({
				automationId: auto.id,
				fromNodeId: keyToId.get(e.from)!,
				toNodeId: keyToId.get(e.to)!,
				label: e.label ?? "next",
				order: e.order ?? 0,
				conditionExpr: e.condition_expr ?? null,
			})),
		);
	}

	// 5. Set entry node
	await db
		.update(automations)
		.set({ entryNodeId: triggerNode!.id })
		.where(eq(automations.id, auto.id));

	// 6. If created active, snapshot version 1
	if (body.status === "active") {
		await publishVersion(db, auto.id);
	}

	return c.json(await loadGraphResponse(db, auto.id), 201);
});

// --- List ---

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
			description: "List",
			content: { "application/json": { schema: AutomationListResponse } },
		},
	},
});

app.openapi(listAutomations, async (c) => {
	const { workspace_id, status, channel, trigger_type, cursor, limit } =
		c.req.valid("query");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const conditions = [eq(automations.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, automations.workspaceId);
	if (workspace_id) conditions.push(eq(automations.workspaceId, workspace_id));
	if (status) conditions.push(eq(automations.status, status));
	if (channel) conditions.push(eq(automations.channel, channel as never));
	if (trigger_type)
		conditions.push(eq(automations.triggerType, trigger_type as never));

	if (cursor) {
		const cursorRow = await db
			.select({ createdAt: automations.createdAt })
			.from(automations)
			.where(eq(automations.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${automations.createdAt}, ${automations.id}) < (${cursorRow[0].createdAt}, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select()
		.from(automations)
		.where(and(...conditions))
		.orderBy(desc(automations.createdAt), desc(automations.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const items = rows.slice(0, limit).map(serializeAutomation);
	const nextCursor = hasMore ? rows[limit - 1]?.id ?? null : null;

	return c.json({ data: items, next_cursor: nextCursor, has_more: hasMore }, 200);
});

// --- Get (with graph) ---

const getAutomation = createRoute({
	operationId: "getAutomation",
	method: "get",
	path: "/{id}",
	tags: ["Automations"],
	summary: "Get automation with nodes + edges",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Automation",
			content: { "application/json": { schema: AutomationWithGraphResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.automations.findFirst({
		where: and(eq(automations.id, id), eq(automations.organizationId, orgId)),
	});
	if (!row) {
		return c.json({ error: { code: "not_found", message: "Automation not found" } }, 404);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	return c.json(await loadGraphResponse(db, id), 200);
});

// --- Update metadata ---

const updateAutomation = createRoute({
	operationId: "updateAutomation",
	method: "patch",
	path: "/{id}",
	tags: ["Automations"],
	summary: "Update automation metadata",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: AutomationUpdateSpec } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: AutomationResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.automations.findFirst({
		where: and(eq(automations.id, id), eq(automations.organizationId, orgId)),
	});
	if (!row) {
		return c.json({ error: { code: "not_found", message: "Automation not found" } }, 404);
	}
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const updates: Partial<typeof automations.$inferInsert> = {};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.status !== undefined) updates.status = body.status;
	if (body.channel !== undefined) updates.channel = body.channel as never;
	if (body.exit_on_reply !== undefined) updates.exitOnReply = body.exit_on_reply;
	if (body.allow_reentry !== undefined)
		updates.allowReentry = body.allow_reentry;
	if (body.reentry_cooldown_min !== undefined)
		updates.reentryCooldownMin = body.reentry_cooldown_min;
	if (body.trigger) {
		updates.triggerType = body.trigger.type as never;
		updates.triggerConfig = body.trigger.config ?? {};
		updates.triggerFilters = body.trigger.filters ?? {};
		if (body.trigger.account_id !== undefined) {
			updates.socialAccountId = body.trigger.account_id ?? null;
		}
	}
	updates.updatedAt = new Date();

	// Persist the metadata update FIRST, then publish — otherwise a PATCH that
	// activates + changes trigger/channel/etc. in the same request would
	// publish the stale pre-PATCH row.
	const [updated] = await db
		.update(automations)
		.set(updates)
		.where(eq(automations.id, id))
		.returning();

	if (updates.status === "active" && row.publishedVersion === null) {
		await publishVersion(db, id);
		const refreshed = await db.query.automations.findFirst({
			where: eq(automations.id, id),
		});
		if (refreshed) return c.json(serializeAutomation(refreshed), 200);
	}

	return c.json(serializeAutomation(updated!), 200);
});

// --- Publish / pause / resume / archive ---

for (const [name, action, status] of [
	["pauseAutomation", "pause", "paused"],
	["resumeAutomation", "resume", "active"],
	["archiveAutomation", "archive", "archived"],
] as const) {
	const route = createRoute({
		operationId: name,
		method: "post",
		path: `/{id}/${action}`,
		tags: ["Automations"],
		summary: `${action[0]!.toUpperCase()}${action.slice(1)} automation`,
		security: [{ Bearer: [] }],
		request: { params: IdParams },
		responses: {
			200: {
				description: "Updated",
				content: { "application/json": { schema: AutomationResponse } },
			},
			403: {
				description: "Forbidden",
				content: { "application/json": { schema: ErrorResponse } },
			},
			404: {
				description: "Not found",
				content: { "application/json": { schema: ErrorResponse } },
			},
		},
	});

	app.openapi(route, async (c) => {
		const { id } = c.req.valid("param");
		const db = c.get("db");
		const orgId = c.get("orgId");
		const row = await db.query.automations.findFirst({
			where: and(
				eq(automations.id, id),
				eq(automations.organizationId, orgId),
			),
		});
		if (!row)
			return c.json({ error: { code: "not_found", message: "Automation not found" } }, 404);
		if (isWorkspaceScopeDenied(c, row.workspaceId)) {
			return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
		}

		// Ensure a published snapshot exists before the runner can enrol anyone.
		if (status === "active" && row.publishedVersion === null) {
			await publishVersion(db, id);
		}

		const [updated] = await db
			.update(automations)
			.set({ status, updatedAt: new Date() })
			.where(eq(automations.id, id))
			.returning();

		return c.json(serializeAutomation(updated!), 200);
	});
}

const publishAutomation = createRoute({
	operationId: "publishAutomation",
	method: "post",
	path: "/{id}/publish",
	tags: ["Automations"],
	summary: "Publish a new version of the automation",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Published",
			content: { "application/json": { schema: AutomationResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(publishAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.automations.findFirst({
		where: and(
			eq(automations.id, id),
			eq(automations.organizationId, orgId),
		),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Automation not found" } }, 404);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	await publishVersion(db, id);

	const updated = await db.query.automations.findFirst({
		where: eq(automations.id, id),
	});
	return c.json(serializeAutomation(updated!), 200);
});

// --- Delete ---

const deleteAutomation = createRoute({
	operationId: "deleteAutomation",
	method: "delete",
	path: "/{id}",
	tags: ["Automations"],
	summary: "Delete automation",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		204: { description: "Deleted" },
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteAutomation, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.automations.findFirst({
		where: and(
			eq(automations.id, id),
			eq(automations.organizationId, orgId),
		),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Automation not found" } }, 404);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	await db.delete(automations).where(eq(automations.id, id));
	return c.body(null, 204);
});

// --- Schema introspection (for MCP / AI agents) ---

const getSchema = createRoute({
	operationId: "getAutomationSchema",
	method: "get",
	path: "/schema",
	tags: ["Automations"],
	summary: "Get the full catalog of triggers, nodes, and templates",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Catalog",
			content: { "application/json": { schema: AutomationSchemaResponse } },
		},
	},
});

app.openapi(getSchema, async (c) => {
	return c.json(
		{
			triggers: AUTOMATION_TRIGGER_TYPES.map((t) => ({
				type: t,
				description: describeTrigger(t),
				channel: channelForTrigger(t),
				tier: tierForTrigger(t),
				transport: transportForTrigger(t),
				config_schema: {},
				output_labels: ["next"],
			})),
			nodes: AUTOMATION_NODE_TYPES.map((t) => ({
				type: t,
				description: describeNode(t),
				category: categoryForNode(t),
				fields_schema: {},
				output_labels: outputLabelsForNode(t),
			})),
			templates: [
				{
					id: "comment-to-dm",
					name: "Comment to DM",
					description: "Reply to an Instagram comment + send a DM to the commenter",
					input_schema: {},
				},
				{
					id: "welcome-dm",
					name: "Welcome DM",
					description: "Send a welcome DM when a contact starts a conversation",
					input_schema: {},
				},
				{
					id: "keyword-reply",
					name: "Keyword Reply",
					description: "Reply to DMs matching a keyword",
					input_schema: {},
				},
				{
					id: "story-reply",
					name: "Story Reply",
					description: "Respond when a user replies to an Instagram story",
					input_schema: {},
				},
				{
					id: "follow-to-dm",
					name: "Follow to DM",
					description: "DM new followers on Instagram",
					input_schema: {},
				},
				{
					id: "giveaway",
					name: "Giveaway",
					description: "Run a giveaway that enters users who comment a keyword",
					input_schema: {},
				},
			],
			merge_tags: [
				"first_name",
				"last_name",
				"full_name",
				"email",
				"phone",
				"contact.*",
				"state.*",
			],
		},
		200,
	);
});

// --- Simulate (dry-run graph traversal for the dashboard Playground) ---

const simulateRoute = createRoute({
	operationId: "simulateAutomation",
	method: "post",
	path: "/{id}/simulate",
	tags: ["Automations"],
	summary: "Simulate a graph run without executing handlers or side effects",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: AutomationSimulateRequest } },
		},
	},
	responses: {
		200: {
			description: "Simulation result",
			content: { "application/json": { schema: AutomationSimulateResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(simulateRoute, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const auto = await db.query.automations.findFirst({
		where: and(eq(automations.id, id), eq(automations.organizationId, orgId)),
	});
	if (!auto) {
		return c.json(
			{ error: { code: "not_found", message: "Automation not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, auto.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	// Prefer an explicit version (error if missing), else build the live draft.
	const requestedVersion = body.version;
	const targetVersion = requestedVersion ?? auto.version;

	let snapshot: AutomationSnapshot | null = null;

	const versionRow = await db.query.automationVersions.findFirst({
		where: and(
			eq(automationVersions.automationId, id),
			eq(automationVersions.version, targetVersion),
		),
	});
	if (versionRow) {
		snapshot = versionRow.snapshot as AutomationSnapshot;
	} else if (requestedVersion !== undefined) {
		// Caller asked for a specific version that doesn't exist — don't
		// silently substitute the live draft; that would mislead debugging of
		// historical snapshots.
		return c.json(
			{
				error: {
					code: "version_not_found",
					message: `Version ${requestedVersion} not found for this automation`,
				},
			},
			404,
		);
	} else {
		// Build an on-the-fly snapshot from the current draft graph so callers can
		// simulate unpublished changes.
		const nodes = await db
			.select()
			.from(automationNodes)
			.where(eq(automationNodes.automationId, id));
		const edges = await db
			.select()
			.from(automationEdges)
			.where(eq(automationEdges.automationId, id));
		const idToKey = new Map(nodes.map((n) => [n.id, n.key]));
		snapshot = {
			automation_id: id,
			version: auto.version,
			name: auto.name,
			channel: auto.channel,
			trigger: {
				type: auto.triggerType,
				account_id: auto.socialAccountId ?? undefined,
				config: (auto.triggerConfig as Record<string, unknown>) ?? {},
				filters: (auto.triggerFilters as Record<string, unknown>) ?? {},
			},
			entry_node_key: "trigger",
			nodes: nodes.map((n) => ({
				id: n.id,
				key: n.key,
				type: n.type,
				config: (n.config as Record<string, unknown>) ?? {},
			})),
			edges: edges.map((e) => ({
				id: e.id,
				from_node_key: idToKey.get(e.fromNodeId) ?? "",
				to_node_key: idToKey.get(e.toNodeId) ?? "",
				label: e.label,
				order: e.order,
				condition_expr: e.conditionExpr ?? null,
			})),
		};
	}

	const result = simulateAutomation(snapshot, {
		branch_choices: body.branch_choices,
		max_steps: body.max_steps,
	});

	return c.json(result, 200);
});

// --- Enrollments & runs (read-only) ---

const listEnrollments = createRoute({
	operationId: "listAutomationEnrollments",
	method: "get",
	path: "/{id}/enrollments",
	tags: ["Automations"],
	summary: "List enrollments for this automation",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		query: PaginationParams.extend({
			status: z
				.enum(["active", "waiting", "completed", "exited", "failed"])
				.optional(),
		}),
	},
	responses: {
		200: {
			description: "Enrollments",
			content: {
				"application/json": {
					schema: z.object({
						data: z.array(AutomationEnrollmentResponse),
						next_cursor: z.string().nullable(),
						has_more: z.boolean(),
					}),
				},
			},
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listEnrollments, async (c) => {
	const { id } = c.req.valid("param");
	const { status, cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	const orgId = c.get("orgId");

	// Verify the automation exists + caller's workspace scope covers it.
	const auto = await db.query.automations.findFirst({
		where: and(eq(automations.id, id), eq(automations.organizationId, orgId)),
	});
	if (!auto) {
		return c.json(
			{ error: { code: "not_found", message: "Automation not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, auto.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const conditions = [
		eq(automationEnrollments.automationId, id),
		eq(automationEnrollments.organizationId, orgId),
	];
	if (status) conditions.push(eq(automationEnrollments.status, status));

	if (cursor) {
		const cursorRow = await db
			.select({ enrolledAt: automationEnrollments.enrolledAt })
			.from(automationEnrollments)
			.where(eq(automationEnrollments.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${automationEnrollments.enrolledAt}, ${automationEnrollments.id}) < (${cursorRow[0].enrolledAt}, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select()
		.from(automationEnrollments)
		.where(and(...conditions))
		.orderBy(desc(automationEnrollments.enrolledAt), desc(automationEnrollments.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map((r) => ({
		id: r.id,
		automation_id: r.automationId,
		automation_version: r.automationVersion,
		contact_id: r.contactId,
		conversation_id: r.conversationId,
		current_node_id: r.currentNodeId,
		state: r.state,
		status: r.status,
		next_run_at: r.nextRunAt?.toISOString() ?? null,
		enrolled_at: r.enrolledAt.toISOString(),
		completed_at: r.completedAt?.toISOString() ?? null,
		exited_at: r.exitedAt?.toISOString() ?? null,
		exit_reason: r.exitReason,
	}));

	return c.json(
		{
			data,
			next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

const getRuns = createRoute({
	operationId: "listAutomationRuns",
	method: "get",
	path: "/{id}/enrollments/{enrollmentId}/runs",
	tags: ["Automations"],
	summary: "Per-node execution log for an enrollment",
	security: [{ Bearer: [] }],
	request: {
		params: z.object({ id: z.string(), enrollmentId: z.string() }),
	},
	responses: {
		200: {
			description: "Run logs",
			content: {
				"application/json": {
					schema: z.object({ data: z.array(AutomationRunLogResponse) }),
				},
			},
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getRuns, async (c) => {
	const { id: automationId, enrollmentId } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");

	// Verify the enrollment exists, belongs to the caller's org, and to the
	// automation in the URL path. Without this, log data could leak across orgs.
	const enrollment = await db.query.automationEnrollments.findFirst({
		where: and(
			eq(automationEnrollments.id, enrollmentId),
			eq(automationEnrollments.automationId, automationId),
			eq(automationEnrollments.organizationId, orgId),
		),
	});
	if (!enrollment) {
		return c.json(
			{ error: { code: "not_found", message: "Enrollment not found" } },
			404,
		);
	}

	// Enforce workspace scope via the parent automation's workspace.
	const auto = await db.query.automations.findFirst({
		where: eq(automations.id, automationId),
	});
	if (auto && isWorkspaceScopeDenied(c, auto.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const logs = await db
		.select()
		.from(automationRunLogs)
		.where(eq(automationRunLogs.enrollmentId, enrollmentId))
		.orderBy(asc(automationRunLogs.executedAt));

	// Resolve node_id → node_key using the enrollment's frozen snapshot so the
	// dashboard can highlight the executed path on the current canvas.
	const versionRow = await db.query.automationVersions.findFirst({
		where: and(
			eq(automationVersions.automationId, automationId),
			eq(automationVersions.version, enrollment.automationVersion),
		),
	});
	const snap = versionRow?.snapshot as AutomationSnapshot | undefined;
	const idToKey = new Map<string, string>(
		snap?.nodes.map((n) => [n.id, n.key]) ?? [],
	);

	return c.json(
		{
			data: logs.map((l) => ({
				id: l.id,
				enrollment_id: l.enrollmentId,
				node_id: l.nodeId,
				node_key: l.nodeId ? idToKey.get(l.nodeId) ?? null : null,
				node_type: l.nodeType,
				executed_at: l.executedAt.toISOString(),
				outcome: l.outcome,
				branch_label: l.branchLabel,
				duration_ms: l.durationMs,
				error: l.error,
				payload: l.payload,
			})),
		},
		200,
	);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractNodeConfig(node: unknown): Record<string, unknown> {
	// node is a discriminated-union member; every field except `type`, `key`, `notes`, `canvas_x`, `canvas_y` is config
	const n = node as Record<string, unknown>;
	const { type: _t, key: _k, notes: _n, canvas_x: _x, canvas_y: _y, ...rest } = n;
	return rest;
}

type GraphResponse = z.infer<typeof AutomationWithGraphResponse>;

async function loadGraphResponse(
	db: ReturnType<typeof createDb>,
	automationId: string,
): Promise<GraphResponse> {
	const auto = await db.query.automations.findFirst({
		where: eq(automations.id, automationId),
	});
	if (!auto) throw new Error("automation not found");

	const nodes = await db
		.select()
		.from(automationNodes)
		.where(eq(automationNodes.automationId, automationId));

	const edges = await db
		.select()
		.from(automationEdges)
		.where(eq(automationEdges.automationId, automationId));

	const idToKey = new Map(nodes.map((n) => [n.id, n.key]));

	return {
		...serializeAutomation(auto),
		nodes: nodes.map((n) => ({
			id: n.id,
			key: n.key,
			type: n.type as GraphResponse["nodes"][number]["type"],
			config: n.config,
			canvas_x: n.canvasX,
			canvas_y: n.canvasY,
			notes: n.notes,
		})),
		edges: edges.map((e) => ({
			id: e.id,
			from_node_key: idToKey.get(e.fromNodeId) ?? "",
			to_node_key: idToKey.get(e.toNodeId) ?? "",
			label: e.label,
			order: e.order,
			condition_expr: e.conditionExpr,
		})),
	};
}

/**
 * Builds and persists a versioned snapshot. Called on publish and on initial
 * create-with-status=active.
 */
export async function publishVersion(
	db: ReturnType<typeof createDb>,
	automationId: string,
): Promise<number> {
	const auto = await db.query.automations.findFirst({
		where: eq(automations.id, automationId),
	});
	if (!auto) throw new Error("automation not found");

	const nodes = await db
		.select()
		.from(automationNodes)
		.where(eq(automationNodes.automationId, automationId));
	const edges = await db
		.select()
		.from(automationEdges)
		.where(eq(automationEdges.automationId, automationId));

	const idToKey = new Map(nodes.map((n) => [n.id, n.key]));

	const snapshot = {
		automation_id: automationId,
		version: auto.version,
		name: auto.name,
		channel: auto.channel,
		trigger: {
			type: auto.triggerType,
			account_id: auto.socialAccountId ?? undefined,
			config: (auto.triggerConfig as Record<string, unknown>) ?? {},
			filters: (auto.triggerFilters as Record<string, unknown>) ?? {},
		},
		entry_node_key: "trigger",
		nodes: nodes.map((n) => ({
			id: n.id,
			key: n.key,
			type: n.type,
			config: (n.config as Record<string, unknown>) ?? {},
		})),
		edges: edges.map((e) => ({
			id: e.id,
			from_node_key: idToKey.get(e.fromNodeId) ?? "",
			to_node_key: idToKey.get(e.toNodeId) ?? "",
			label: e.label,
			order: e.order,
			condition_expr: e.conditionExpr ?? null,
		})),
	};

	await db.insert(automationVersions).values({
		automationId,
		version: auto.version,
		snapshot,
		publishedAt: new Date(),
	});

	const [updated] = await db
		.update(automations)
		.set({
			publishedVersion: auto.version,
			version: auto.version + 1,
			updatedAt: new Date(),
		})
		.where(eq(automations.id, automationId))
		.returning({ publishedVersion: automations.publishedVersion });

	return updated?.publishedVersion ?? auto.version;
}

// Minimal catalog metadata for introspection — expanded in Phase 5 (docs).

function describeTrigger(t: string): string {
	const map: Record<string, string> = {
		instagram_comment: "Fires when a user comments on an Instagram post or reel",
		instagram_dm: "Fires when a user DMs the Instagram business account",
		instagram_story_reply: "Fires when a user replies to an Instagram story",
		instagram_follow_to_dm: "Fires when a new user follows the account",
		whatsapp_message: "Fires on any inbound WhatsApp message",
		whatsapp_keyword: "Fires when an inbound WhatsApp message matches a keyword",
		telegram_message: "Fires on any inbound Telegram message",
		telegram_command: "Fires when a Telegram user sends a bot command",
		scheduled_time: "Fires on a cron schedule",
		manual: "No automatic trigger — enrolled via API",
	};
	return map[t] ?? `Trigger type: ${t}`;
}

function channelForTrigger(
	t: string,
): (typeof AUTOMATION_CHANNELS)[number] {
	for (const ch of AUTOMATION_CHANNELS) {
		if (ch !== "multi" && t.startsWith(`${ch}_`)) return ch;
	}
	return "multi";
}

function tierForTrigger(t: string): number {
	const tier1 = [
		"instagram",
		"facebook",
		"whatsapp",
		"telegram",
		"discord",
		"sms",
		"twitter",
		"bluesky",
	];
	const tier2 = [
		"threads",
		"youtube",
		"linkedin",
		"mastodon",
		"reddit",
		"googlebusiness",
	];
	const tier3 = ["beehiiv", "kit", "mailchimp"];
	for (const p of tier1) if (t.startsWith(`${p}_`)) return 1;
	for (const p of tier2) if (t.startsWith(`${p}_`)) return 2;
	for (const p of tier3) if (t.startsWith(`${p}_`)) return 3;
	return 0;
}

function transportForTrigger(t: string): "webhook" | "polling" | "streaming" {
	if (
		t.startsWith("reddit_") ||
		t.startsWith("linkedin_") ||
		t.startsWith("youtube_")
	)
		return "polling";
	if (t.startsWith("mastodon_") || t.startsWith("bluesky_"))
		return "streaming";
	return "webhook";
}

function describeNode(t: string): string {
	if (t === "trigger") return "Virtual root node — the automation's entry point";
	if (t.startsWith("message_")) return `Send a ${t.slice(8)} message to the contact`;
	if (t.startsWith("user_input_"))
		return `Ask the contact for ${t.slice(11)} and save to a custom field`;
	if (t === "condition")
		return "Branch on contact tags, fields, or captured state";
	if (t === "smart_delay") return "Wait a fixed duration before continuing";
	if (t === "randomizer") return "Split into weighted random branches";
	if (t === "http_request")
		return "Call an external HTTP endpoint and optionally capture the response";
	if (t === "ai_agent")
		return "Hand the conversation to an AI agent with a knowledge base";
	if (t === "goto") return "Jump to another node in the graph";
	if (t === "end") return "Terminate the automation";
	return t;
}

function categoryForNode(
	t: string,
): "content" | "input" | "logic" | "ai" | "action" | "ops" | "platform_send" {
	if (t === "trigger") return "logic";
	if (t.startsWith("message_")) return "content";
	if (t.startsWith("user_input_")) return "input";
	if (["condition", "smart_delay", "randomizer", "split_test", "goto", "end", "subflow_call"].includes(t))
		return "logic";
	if (["ai_step", "ai_agent", "ai_intent_router"].includes(t)) return "ai";
	if (
		[
			"tag_add",
			"tag_remove",
			"field_set",
			"field_clear",
			"subscription_add",
			"subscription_remove",
			"segment_add",
			"segment_remove",
		].includes(t)
	)
		return "action";
	if (
		[
			"notify_admin",
			"conversation_assign",
			"conversation_status",
			"http_request",
			"webhook_out",
		].includes(t)
	)
		return "ops";
	return "platform_send";
}

function outputLabelsForNode(t: string): string[] {
	if (t === "condition") return ["yes", "no"];
	if (t === "randomizer") return ["branch_1", "branch_2", "branch_N"];
	if (t === "split_test") return ["variant_a", "variant_b"];
	if (t.startsWith("user_input_")) return ["captured", "no_match", "timeout"];
	if (t === "ai_agent") return ["complete", "handoff"];
	if (t === "ai_intent_router") return ["intent_1", "intent_2"];
	return ["next"];
}

export default app;
