import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { customFieldDefinitions } from "@relayapi/db";
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
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { ErrorResponse } from "../schemas/common";
import {
	CreateFieldBody,
	FieldIdParams,
	FieldListResponse,
	FieldResponse,
	UpdateFieldBody,
} from "../schemas/custom-fields";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "")
		.slice(0, 64);
}

function serializeField(f: typeof customFieldDefinitions.$inferSelect) {
	return {
		id: f.id,
		name: f.name,
		slug: f.slug,
		type: f.type as "text" | "number" | "date" | "boolean" | "select",
		options: (f.options as string[] | null) ?? null,
		created_at: f.createdAt.toISOString(),
	};
}

// --- Route definitions ---

const createField = createRoute({
	operationId: "createCustomField",
	method: "post",
	path: "/",
	tags: ["Custom Fields"],
	summary: "Create a custom field definition",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateFieldBody } } },
	},
	responses: {
		201: {
			description: "Field created",
			content: { "application/json": { schema: FieldResponse } },
		},
		400: {
			description: "Validation error",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Slug already exists",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const FieldListQuery = z.object({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
	cursor: z.string().optional().describe("Pagination cursor"),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(100)
		.default(20)
		.describe("Number of items per page"),
});

const listFields = createRoute({
	operationId: "listCustomFields",
	method: "get",
	path: "/",
	tags: ["Custom Fields"],
	summary: "List custom field definitions",
	security: [{ Bearer: [] }],
	request: { query: FieldListQuery },
	responses: {
		200: {
			description: "List of fields",
			content: { "application/json": { schema: FieldListResponse } },
		},
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateField = createRoute({
	operationId: "updateCustomField",
	method: "patch",
	path: "/{id}",
	tags: ["Custom Fields"],
	summary: "Update a custom field definition",
	description:
		"Only name and options can be updated. Type and slug are immutable.",
	security: [{ Bearer: [] }],
	request: {
		params: FieldIdParams,
		body: { content: { "application/json": { schema: UpdateFieldBody } } },
	},
	responses: {
		200: {
			description: "Updated field",
			content: { "application/json": { schema: FieldResponse } },
		},
		400: {
			description: "Options are invalid for the immutable field type",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const deleteField = createRoute({
	operationId: "deleteCustomField",
	method: "delete",
	path: "/{id}",
	tags: ["Custom Fields"],
	summary: "Delete a custom field definition",
	description: "Deletes the field definition and all associated values.",
	security: [{ Bearer: [] }],
	request: { params: FieldIdParams },
	responses: {
		204: { description: "Field deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Workspace access denied",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

// @ts-expect-error — handler returns 201, 400 or 409
app.openapi(createField, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");
	const accessDenied = assertAllWorkspaceScope(
		c,
		"Only an all-workspace API key can create organization-shared custom fields.",
	);
	if (accessDenied) return accessDenied as never;

	if (body.type === "select" && (!body.options || body.options.length === 0)) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "Options are required for select type",
				},
			},
			400,
		);
	}

	const slug = body.slug ?? slugify(body.name);
	if (!slug) {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "Could not generate a valid slug from the field name",
				},
			},
			400,
		);
	}

	// Check for duplicate slug
	const [existing] = await db
		.select({ id: customFieldDefinitions.id })
		.from(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.organizationId, orgId),
				eq(customFieldDefinitions.slug, slug),
			),
		)
		.limit(1);

	if (existing) {
		return c.json(
			{
				error: {
					code: "CONFLICT",
					message: `A field with slug "${slug}" already exists`,
				},
			},
			409,
		);
	}

	const [created] = await db
		.insert(customFieldDefinitions)
		.values({
			organizationId: orgId,
			workspaceId: null,
			name: body.name,
			slug,
			type: body.type,
			options: body.type === "select" ? body.options : null,
		})
		.returning();

	if (!created) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create field" } },
			500,
		);
	}

	return c.json(serializeField(created), 201);
});

app.openapi(listFields, async (c) => {
	const orgId = c.get("orgId");
	const { workspace_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(customFieldDefinitions.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, customFieldDefinitions.workspaceId);
	if (workspace_id) {
		conditions.push(eq(customFieldDefinitions.workspaceId, workspace_id));
	}

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp ties).
	// Read the cursor row's created_at as raw text so it isn't round-tripped through a
	// JS Date, which truncates Postgres microseconds to millisecond precision and would
	// skip rows sharing the cursor's millisecond. Bind it back with an explicit
	// ::timestamptz cast to keep the keyset comparison exact.
	if (cursor) {
		const key = tryDecodeTimestampIdCursor(cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${customFieldDefinitions.createdAt}, ${customFieldDefinitions.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	const fields = await db
		.select({
			...getTableColumns(customFieldDefinitions),
			cursorTimestamp: sql<string>`to_char(${customFieldDefinitions.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(customFieldDefinitions)
		.where(and(...conditions))
		.orderBy(
			desc(customFieldDefinitions.createdAt),
			desc(customFieldDefinitions.id),
		)
		.limit(limit + 1);

	const hasMore = fields.length > limit;
	const pageRows = fields.slice(0, limit);
	const last = pageRows.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;
	const data = pageRows.map(serializeField);

	return c.json(
		{
			data,
			next_cursor: nextCursor,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(updateField, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const accessDenied = assertAllWorkspaceScope(c);
	if (accessDenied) return accessDenied as never;
	const [existing] = await db
		.select({
			id: customFieldDefinitions.id,
			workspaceId: customFieldDefinitions.workspaceId,
			type: customFieldDefinitions.type,
		})
		.from(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.id, id),
				eq(customFieldDefinitions.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Field not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, existing.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	if (body.options !== undefined && existing.type !== "select") {
		return c.json(
			{
				error: {
					code: "VALIDATION_ERROR",
					message: "Options are allowed only for select fields",
				},
			},
			400,
		);
	}

	const updateSet: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updateSet.name = body.name;
	if (body.options !== undefined) updateSet.options = body.options;

	const [updated] = await db
		.update(customFieldDefinitions)
		.set(updateSet)
		.where(
			and(
				eq(customFieldDefinitions.id, id),
				eq(customFieldDefinitions.organizationId, orgId),
			),
		)
		.returning();

	if (!updated) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Field not found" } },
			404,
		);
	}

	return c.json(serializeField(updated), 200);
});

app.openapi(deleteField, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const accessDenied = assertAllWorkspaceScope(c);
	if (accessDenied) return accessDenied as never;

	const [existing] = await db
		.select({
			id: customFieldDefinitions.id,
			workspaceId: customFieldDefinitions.workspaceId,
		})
		.from(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.id, id),
				eq(customFieldDefinitions.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Field not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied;

	const [deleted] = await db
		.delete(customFieldDefinitions)
		.where(
			and(
				eq(customFieldDefinitions.id, id),
				eq(customFieldDefinitions.organizationId, orgId),
			),
		)
		.returning({ id: customFieldDefinitions.id });
	if (!deleted) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Field not found" } },
			404,
		);
	}

	return c.body(null, 204);
});

export default app;
