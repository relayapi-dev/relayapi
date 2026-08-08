import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { contactSegmentMemberships, segments } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { resolveOperationalCreateScope } from "../lib/request-access";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	SegmentCreateSpec,
	SegmentFilter,
	SegmentListResponse,
	SegmentResponse,
	SegmentUpdateSpec,
} from "../schemas/segments";
import { getSegmentMemberCounts } from "../services/dynamic-segments";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const IdParams = z.object({ id: z.string() });
const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
});

type Row = typeof segments.$inferSelect;

function serialize(
	s: Row,
	memberCount = s.memberCount,
): z.infer<typeof SegmentResponse> {
	return {
		id: s.id,
		organization_id: s.organizationId,
		workspace_id: s.workspaceId,
		name: s.name,
		description: s.description ?? null,
		filter: s.filter === null ? null : SegmentFilter.parse(s.filter),
		is_dynamic: s.isDynamic,
		member_count: memberCount,
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
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"segment",
	);
	if (!scope.ok) return scope.response as never;

	const [row] = await db
		.insert(segments)
		.values({
			organizationId: orgId,
			workspaceId: scope.workspaceId,
			name: body.name,
			description: body.description,
			filter: body.filter ?? null,
			isDynamic: body.is_dynamic,
		})
		.returning();

	if (!row) throw new Error("Failed to create segment");
	const counts = await getSegmentMemberCounts(db, [row]);
	return c.json(serialize(row, counts.get(row.id)), 201);
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

	// Keyset pagination on (createdAt, id). Read the cursor row's created_at as raw
	// text so it isn't round-tripped through a JS Date, which truncates Postgres
	// microseconds to millisecond precision and would skip rows sharing the cursor's
	// millisecond. Bind it back with an explicit ::timestamptz cast.
	if (cursor) {
		const cursorRow = await db
			.select({ createdAt: sql<string>`${segments.createdAt}::text` })
			.from(segments)
			.where(eq(segments.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${segments.createdAt}, ${segments.id}) < (${cursorRow[0].createdAt}::timestamptz, ${cursor})`,
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
	const pageRows = rows.slice(0, limit);
	const counts = await getSegmentMemberCounts(db, pageRows);
	const data = pageRows.map((row) => serialize(row, counts.get(row.id)));
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

app.openapi(getSegment, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.segments.findFirst({
		where: and(eq(segments.id, id), eq(segments.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Segment not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const counts = await getSegmentMemberCounts(db, [row]);
	return c.json(serialize(row, counts.get(row.id)), 200);
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
		400: {
			description: "Invalid segment definition",
			content: { "application/json": { schema: ErrorResponse } },
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

app.openapi(updateSegment, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.segments.findFirst({
		where: and(eq(segments.id, id), eq(segments.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Segment not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const nextIsDynamic = body.is_dynamic ?? row.isDynamic;
	const nextFilter =
		body.is_dynamic === false && body.filter === undefined
			? null
			: body.filter === undefined
				? row.filter
				: body.filter;
	if (nextIsDynamic) {
		const parsed = SegmentFilter.safeParse(nextFilter);
		if (!parsed.success) {
			return c.json(
				{
					error: {
						code: "validation_error",
						message: "A dynamic segment requires a valid filter",
						details: parsed.error.flatten(),
					},
				},
				400,
			);
		}
	} else if (nextFilter !== null) {
		return c.json(
			{
				error: {
					code: "validation_error",
					message: "Static segments store memberships, not a filter",
				},
			},
			400,
		);
	}

	const updates: Partial<typeof segments.$inferInsert> = {
		updatedAt: new Date(),
		filter: nextFilter,
		isDynamic: nextIsDynamic,
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;

	const updated = await db.transaction(async (tx) => {
		// A static segment's stored rows stop being authoritative at the exact
		// transaction that turns it dynamic. Delete them before the parent mode
		// changes so the database's static-membership FK remains satisfied.
		if (!row.isDynamic && nextIsDynamic) {
			await tx
				.delete(contactSegmentMemberships)
				.where(
					and(
						eq(contactSegmentMemberships.organizationId, orgId),
						eq(contactSegmentMemberships.segmentId, id),
					),
				);
		}
		const [result] = await tx
			.update(segments)
			.set(updates)
			.where(and(eq(segments.id, id), eq(segments.organizationId, orgId)))
			.returning();
		return result;
	});
	if (!updated) throw new Error("Failed to update segment");
	const counts = await getSegmentMemberCounts(db, [updated]);
	return c.json(serialize(updated, counts.get(updated.id)), 200);
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

app.openapi(deleteSegment, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.segments.findFirst({
		where: and(eq(segments.id, id), eq(segments.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Segment not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	await db.delete(segments).where(eq(segments.id, id));
	return c.body(null, 204);
});

export default app;
