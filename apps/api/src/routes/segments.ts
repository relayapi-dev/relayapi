import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { segments } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyWorkspaceScope } from "../lib/workspace-scope";
import {
	SegmentCreateSpec,
	SegmentListResponse,
	SegmentResponse,
	SegmentUpdateSpec,
} from "../schemas/segments";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const IdParams = z.object({ id: z.string() });
const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
});

type Row = typeof segments.$inferSelect;

function serialize(s: Row): z.infer<typeof SegmentResponse> {
	return {
		id: s.id,
		organization_id: s.organizationId,
		workspace_id: s.workspaceId,
		name: s.name,
		description: s.description ?? null,
		filter: s.filter,
		is_dynamic: s.isDynamic,
		member_count: s.memberCount,
		created_at: s.createdAt.toISOString(),
		updated_at: s.updatedAt.toISOString(),
	};
}

const createSegment = createRoute({
	operationId: "createSegment",
	method: "post",
	path: "/",
	tags: ["Segments"],
	summary: "Create a segment",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: SegmentCreateSpec } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: SegmentResponse } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createSegment, async (c) => {
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const [row] = await db
		.insert(segments)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			description: body.description,
			filter: body.filter,
			isDynamic: body.is_dynamic,
		})
		.returning();

	return c.json(serialize(row!), 201);
});

const listSegments = createRoute({
	operationId: "listSegments",
	method: "get",
	path: "/",
	tags: ["Segments"],
	summary: "List segments",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "List",
			content: { "application/json": { schema: SegmentListResponse } },
		},
	},
});

app.openapi(listSegments, async (c) => {
	const { workspace_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const conditions = [eq(segments.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, segments.workspaceId);
	if (workspace_id) conditions.push(eq(segments.workspaceId, workspace_id));

	if (cursor) {
		const cursorRow = await db
			.select({ createdAt: segments.createdAt })
			.from(segments)
			.where(eq(segments.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${segments.createdAt}, ${segments.id}) < (${cursorRow[0].createdAt}, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select()
		.from(segments)
		.where(and(...conditions))
		.orderBy(desc(segments.createdAt), desc(segments.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serialize);
	return c.json(
		{
			data,
			next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

const getSegment = createRoute({
	operationId: "getSegment",
	method: "get",
	path: "/{id}",
	tags: ["Segments"],
	summary: "Get a segment",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Segment",
			content: { "application/json": { schema: SegmentResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getSegment, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.segments.findFirst({
		where: and(eq(segments.id, id), eq(segments.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Segment not found" } }, 404);
	// Workspace-level enforcement deferred to middleware.
	return c.json(serialize(row), 200);
});

const updateSegment = createRoute({
	operationId: "updateSegment",
	method: "patch",
	path: "/{id}",
	tags: ["Segments"],
	summary: "Update a segment",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: SegmentUpdateSpec } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: SegmentResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateSegment, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.segments.findFirst({
		where: and(eq(segments.id, id), eq(segments.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Segment not found" } }, 404);
	// Workspace-level enforcement deferred to middleware.

	const updates: Partial<typeof segments.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.filter !== undefined) updates.filter = body.filter;
	if (body.is_dynamic !== undefined) updates.isDynamic = body.is_dynamic;

	const [updated] = await db
		.update(segments)
		.set(updates)
		.where(eq(segments.id, id))
		.returning();
	return c.json(serialize(updated!), 200);
});

const deleteSegment = createRoute({
	operationId: "deleteSegment",
	method: "delete",
	path: "/{id}",
	tags: ["Segments"],
	summary: "Delete a segment",
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

app.openapi(deleteSegment, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.segments.findFirst({
		where: and(eq(segments.id, id), eq(segments.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Segment not found" } }, 404);
	// Workspace-level enforcement deferred to middleware.

	await db.delete(segments).where(eq(segments.id, id));
	return c.body(null, 204);
});

export default app;
