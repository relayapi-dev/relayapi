import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { tags } from "@relayapi/db";
import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import {
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import { assertAllWorkspaceScope } from "../lib/request-access";
import {
	applyWorkspaceScope,
	assertWorkspaceScope,
} from "../lib/workspace-scope";
import { ErrorResponse, IdParam } from "../schemas/common";
import {
	CreateTagBody,
	TagListQuery,
	TagListResponse,
	TagResponse,
	UpdateTagBody,
} from "../schemas/tags";
import type { Env, Variables } from "../types";

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
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
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
	// Composite keyset pagination on (created_at, id). The cursor is the id of the
	// last row from the previous page; resolve its (created_at, id) entirely in SQL
	// so microsecond-precision ties are preserved and rows sharing a timestamp are
	// never silently skipped.
	if (cursor) {
		const key = tryDecodeTimestampIdCursor(cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${tags.createdAt}, ${tags.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	const rows = await db
		.select({
			...getTableColumns(tags),
			cursorTimestamp: sql<string>`to_char(${tags.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(tags)
		.where(and(...conditions))
		.orderBy(desc(tags.createdAt), desc(tags.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit);
	const last = data.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;

	return c.json(
		{
			data: data.map(serialize),
			next_cursor: nextCursor,
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

	const denied = assertAllWorkspaceScope(
		c,
		"Only an all-workspace API key can create organization-shared tags.",
	);
	if (denied) return denied;

	const [row] = await db
		.insert(tags)
		.values({
			organizationId: orgId,
			workspaceId: null,
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
	const accessDenied = assertAllWorkspaceScope(c);
	if (accessDenied) return accessDenied as never;

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
		.where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
		.returning();

	if (!updated) {
		return c.json(
			{ error: { code: "tag_not_found", message: "Tag not found" } },
			404,
		);
	}
	return c.json(serialize(updated), 200);
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
	const accessDenied = assertAllWorkspaceScope(c);
	if (accessDenied) return accessDenied as never;

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

	const [deleted] = await db
		.delete(tags)
		.where(and(eq(tags.id, id), eq(tags.organizationId, orgId)))
		.returning({ id: tags.id });
	if (!deleted) {
		return c.json(
			{ error: { code: "tag_not_found", message: "Tag not found" } },
			404,
		);
	}

	return c.body(null, 204);
});

export default app;
