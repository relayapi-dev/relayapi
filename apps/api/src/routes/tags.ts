import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, tags } from "@relayapi/db";
import { and, desc, eq, lt } from "drizzle-orm";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateTagBody,
	UpdateTagBody,
	TagResponse,
	TagListQuery,
	TagListResponse,
} from "../schemas/tags";
import type { Env, Variables } from "../types";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

function serialize(row: typeof tags.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		color: row.color,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
	};
}

// ── List tags ────────────────────────────────────────────────────────────────

const listTags = createRoute({
	operationId: "listTags",
	method: "get",
	path: "/",
	tags: ["Tags"],
	summary: "List tags",
	security: [{ Bearer: [] }],
	request: { query: TagListQuery },
	responses: {
		200: {
			description: "List of tags",
			content: { "application/json": { schema: TagListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listTags, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(tags.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, tags.workspaceId);
	if (workspace_id) {
		conditions.push(eq(tags.workspaceId, workspace_id));
	}
	if (cursor) {
		conditions.push(lt(tags.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(tags)
		.where(and(...conditions))
		.orderBy(desc(tags.createdAt))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);

	return c.json(
		{
			data: data.map(serialize),
			next_cursor: hasMore
				? (data.at(-1)?.createdAt.toISOString() ?? null)
				: null,
			has_more: hasMore,
		},
		200,
	);
});

// ── Create tag ───────────────────────────────────────────────────────────────

const createTag = createRoute({
	operationId: "createTag",
	method: "post",
	path: "/",
	tags: ["Tags"],
	summary: "Create a tag",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateTagBody } },
		},
	},
	responses: {
		201: {
			description: "Tag created",
			content: { "application/json": { schema: TagResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// @ts-expect-error — handler may return 400/403 from scoped workspace checks
app.openapi(createTag, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "tag");
	if (denied) return denied;

	const [row] = await db
		.insert(tags)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			color: body.color,
		})
		.returning();

	if (!row) {
		return c.json(
			{
				error: {
					code: "INTERNAL_ERROR",
					message: "Failed to create tag",
				},
			} as never,
			500 as never,
		);
	}

	return c.json(serialize(row), 201);
});

// ── Update tag ───────────────────────────────────────────────────────────────

const updateTag = createRoute({
	operationId: "updateTag",
	method: "patch",
	path: "/{id}",
	tags: ["Tags"],
	summary: "Update a tag",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateTagBody } },
		},
	},
	responses: {
		200: {
			description: "Tag updated",
			content: { "application/json": { schema: TagResponse } },
		},
		404: {
			description: "Tag not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateTag, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(tags)
		.where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "tag_not_found", message: "Tag not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = {};
	if (body.name !== undefined) updates.name = body.name;
	if (body.color !== undefined) updates.color = body.color;

	if (Object.keys(updates).length === 0) {
		return c.json(serialize(existing), 200);
	}

	const [updated] = await db
		.update(tags)
		.set(updates)
		.where(eq(tags.id, id))
		.returning();

	return c.json(serialize(updated ?? existing), 200);
});

// ── Delete tag ───────────────────────────────────────────────────────────────

const deleteTag = createRoute({
	operationId: "deleteTag",
	method: "delete",
	path: "/{id}",
	tags: ["Tags"],
	summary: "Delete a tag",
	description:
		"Deletes a tag and removes it from all associated ideas and posts.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Tag deleted" },
		404: {
			description: "Tag not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteTag, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: tags.id, workspaceId: tags.workspaceId })
		.from(tags)
		.where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "tag_not_found", message: "Tag not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	await db.delete(tags).where(eq(tags.id, id));

	return c.body(null, 204);
});

export default app;
