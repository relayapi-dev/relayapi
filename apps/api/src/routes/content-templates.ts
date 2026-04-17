import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { contentTemplates } from "@relayapi/db";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateContentTemplateBody,
	UpdateContentTemplateBody,
	ContentTemplateResponse,
	ContentTemplateListResponse,
} from "../schemas/content-templates";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serialize(row: typeof contentTemplates.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		description: row.description ?? null,
		content: row.content,
		platform_overrides: row.platformOverrides ?? null,
		tags: row.tags ?? [],
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

// --- Route definitions ---

const ContentTemplateListQuery = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	tag: z.string().optional().describe("Filter by tag"),
});

const listContentTemplates = createRoute({
	operationId: "listContentTemplates",
	method: "get",
	path: "/",
	tags: ["Content Templates"],
	summary: "List content templates",
	security: [{ Bearer: [] }],
	request: { query: ContentTemplateListQuery },
	responses: {
		200: {
			description: "List of content templates",
			content: { "application/json": { schema: ContentTemplateListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createContentTemplateRoute = createRoute({
	operationId: "createContentTemplate",
	method: "post",
	path: "/",
	tags: ["Content Templates"],
	summary: "Create a content template",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateContentTemplateBody } },
		},
	},
	responses: {
		201: {
			description: "Content template created",
			content: { "application/json": { schema: ContentTemplateResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getContentTemplate = createRoute({
	operationId: "getContentTemplate",
	method: "get",
	path: "/{id}",
	tags: ["Content Templates"],
	summary: "Get a content template",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Content template details",
			content: { "application/json": { schema: ContentTemplateResponse } },
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

const updateContentTemplateRoute = createRoute({
	operationId: "updateContentTemplate",
	method: "patch",
	path: "/{id}",
	tags: ["Content Templates"],
	summary: "Update a content template",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateContentTemplateBody } },
		},
	},
	responses: {
		200: {
			description: "Content template updated",
			content: { "application/json": { schema: ContentTemplateResponse } },
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

const deleteContentTemplate = createRoute({
	operationId: "deleteContentTemplate",
	method: "delete",
	path: "/{id}",
	tags: ["Content Templates"],
	summary: "Delete a content template",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Content template deleted" },
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

app.openapi(listContentTemplates, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id, tag } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(contentTemplates.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, contentTemplates.workspaceId);
	if (workspace_id) {
		conditions.push(eq(contentTemplates.workspaceId, workspace_id));
	}
	if (tag) {
		conditions.push(sql`${contentTemplates.tags} @> ${JSON.stringify([tag])}::jsonb`);
	}
	if (cursor) {
		// Cursor is the createdAt timestamp of the last item
		conditions.push(lt(contentTemplates.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(contentTemplates)
		.where(and(...conditions))
		.orderBy(desc(contentTemplates.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map(serialize),
			next_cursor: hasMore ? (data.at(-1)?.createdAt.toISOString() ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

// @ts-expect-error — handler may return 400/403 from scoped workspace checks
app.openapi(createContentTemplateRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "content template");
	if (denied) return denied;

	const [row] = await db
		.insert(contentTemplates)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			description: body.description ?? null,
			content: body.content,
			platformOverrides: body.platform_overrides ?? null,
			tags: body.tags,
		})
		.returning();

	if (!row) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create content template" } } as never,
			500 as never,
		);
	}

	return c.json(serialize(row), 201);
});

app.openapi(getContentTemplate, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(contentTemplates)
		.where(
			and(
				eq(contentTemplates.id, id),
				eq(contentTemplates.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Content template not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied as never;

	return c.json(serialize(row), 200);
});

app.openapi(updateContentTemplateRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(contentTemplates)
		.where(
			and(
				eq(contentTemplates.id, id),
				eq(contentTemplates.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Content template not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.content !== undefined) updates.content = body.content;
	if (body.platform_overrides !== undefined) updates.platformOverrides = body.platform_overrides;
	if (body.tags !== undefined) updates.tags = body.tags;

	const [updated] = await db
		.update(contentTemplates)
		.set(updates)
		.where(eq(contentTemplates.id, id))
		.returning();

	return c.json(serialize(updated ?? existing), 200);
});

app.openapi(deleteContentTemplate, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: contentTemplates.id, workspaceId: contentTemplates.workspaceId })
		.from(contentTemplates)
		.where(
			and(
				eq(contentTemplates.id, id),
				eq(contentTemplates.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Content template not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(contentTemplates).where(eq(contentTemplates.id, id));

	return c.body(null, 204);
});

export default app;
