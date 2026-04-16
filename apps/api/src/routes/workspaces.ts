import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { workspaces, socialAccounts, createDb } from "@relayapi/db";
import { eq, and, ilike, gt, inArray, sql } from "drizzle-orm";
import {
	WorkspaceListQuery,
	WorkspaceListResponse,
	WorkspaceResponse,
	CreateWorkspaceBody,
	UpdateWorkspaceBody,
} from "../schemas/workspaces";
import { ErrorResponse, IdParam } from "../schemas/common";
import type { Env, Variables } from "../types";
import {
	assertAllWorkspaceScope,
	assertWriteAccess,
} from "../lib/request-access";
import { workspaceValidKvKey } from "../middleware/workspace-validation";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
	if (c.req.method === "GET") return next();

	const denied = assertWriteAccess(c) ?? assertAllWorkspaceScope(
		c,
		"Managing workspaces requires an API key with access to all workspaces.",
	);
	if (denied) return denied;
	return next();
});

// --- Route definitions ---

const listWorkspaces = createRoute({
	operationId: "listWorkspaces",
	method: "get",
	path: "/",
	tags: ["Workspaces"],
	summary: "List workspaces",
	security: [{ Bearer: [] }],
	request: { query: WorkspaceListQuery },
	responses: {
		200: {
			description: "List of workspaces",
			content: {
				"application/json": { schema: WorkspaceListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createWorkspace = createRoute({
	operationId: "createWorkspace",
	method: "post",
	path: "/",
	tags: ["Workspaces"],
	summary: "Create a workspace",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: CreateWorkspaceBody },
			},
		},
	},
	responses: {
		201: {
			description: "Workspace created",
			content: {
				"application/json": { schema: WorkspaceResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateWorkspace = createRoute({
	operationId: "updateWorkspace",
	method: "patch",
	path: "/{id}",
	tags: ["Workspaces"],
	summary: "Update a workspace",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: {
				"application/json": { schema: UpdateWorkspaceBody },
			},
		},
	},
	responses: {
		200: {
			description: "Workspace updated",
			content: {
				"application/json": { schema: WorkspaceResponse },
			},
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

const deleteWorkspace = createRoute({
	operationId: "deleteWorkspace",
	method: "delete",
	path: "/{id}",
	tags: ["Workspaces"],
	summary: "Delete a workspace",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Workspace deleted" },
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

// --- Route handlers ---

app.openapi(listWorkspaces, async (c) => {
	const orgId = c.get("orgId");
	const { search, limit, cursor } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(workspaces.organizationId, orgId)];
	const workspaceScope = c.get("workspaceScope");
	if (workspaceScope !== "all") {
		conditions.push(inArray(workspaces.id, workspaceScope));
	}

	if (search) {
		conditions.push(ilike(workspaces.name, `%${search.replace(/[%_\\]/g, "\\$&")}%`));
	}

	if (cursor) {
		conditions.push(gt(workspaces.id, cursor));
	}

	const rows = await db
		.select({
			id: workspaces.id,
			name: workspaces.name,
			description: workspaces.description,
			createdAt: workspaces.createdAt,
			updatedAt: workspaces.updatedAt,
			accountIds: sql<string[]>`coalesce(json_agg(${socialAccounts.id}) filter (where ${socialAccounts.id} is not null), '[]'::json)`,
		})
		.from(workspaces)
		.leftJoin(socialAccounts, and(eq(socialAccounts.workspaceId, workspaces.id), eq(socialAccounts.organizationId, orgId)))
		.where(and(...conditions))
		.groupBy(workspaces.id)
		.orderBy(workspaces.name, workspaces.id)
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map((w) => {
				const ids = Array.isArray(w.accountIds) ? w.accountIds : [];
				return {
					id: w.id,
					name: w.name,
					description: w.description,
					account_ids: ids,
					account_count: ids.length,
					created_at: w.createdAt.toISOString(),
					updated_at: w.updatedAt.toISOString(),
				};
			}),
			next_cursor: hasMore ? (data.at(-1)?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(createWorkspace, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [workspace] = await db
		.insert(workspaces)
		.values({
			organizationId: orgId,
			name: body.name,
			description: body.description ?? null,
		})
		.returning();

	if (!workspace) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create workspace" } },
			500,
		);
	}

	return c.json(
		{
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
			account_ids: [] as string[],
			account_count: 0,
			created_at: workspace.createdAt.toISOString(),
			updated_at: workspace.updatedAt.toISOString(),
		},
		201,
	);
});

app.openapi(updateWorkspace, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;

	const [updated] = await db
		.update(workspaces)
		.set(updates)
		.where(and(eq(workspaces.id, id), eq(workspaces.organizationId, orgId)))
		.returning({
			id: workspaces.id,
			name: workspaces.name,
			description: workspaces.description,
			createdAt: workspaces.createdAt,
			updatedAt: workspaces.updatedAt,
		});

	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Workspace not found" } },
			404,
		);
	}

	const accountRows = await db
		.select({ id: socialAccounts.id })
		.from(socialAccounts)
		.where(and(eq(socialAccounts.workspaceId, id), eq(socialAccounts.organizationId, orgId)));

	const accountIds = accountRows.map((r) => r.id);

	return c.json(
		{
			id: updated.id,
			name: updated.name,
			description: updated.description,
			account_ids: accountIds,
			account_count: accountIds.length,
			created_at: updated.createdAt.toISOString(),
			updated_at: updated.updatedAt.toISOString(),
		},
		200,
	);
});

app.openapi(deleteWorkspace, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: workspaces.id })
		.from(workspaces)
		.where(and(eq(workspaces.id, id), eq(workspaces.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Workspace not found" } },
			404,
		);
	}

	// FK ON DELETE SET NULL handles unassigning accounts automatically
	await db.delete(workspaces).where(eq(workspaces.id, id));

	// Invalidate the positive-validation cache (bounded anyway by 5-min TTL)
	c.executionCtx.waitUntil(c.env.KV.delete(workspaceValidKvKey(orgId, id)));

	return c.body(null, 204);
});

export default app;
