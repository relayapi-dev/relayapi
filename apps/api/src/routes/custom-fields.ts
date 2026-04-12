import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	createDb,
	customFieldDefinitions,
	customFieldValues,
} from "@relayapi/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { ErrorResponse } from "../schemas/common";
import {
	CreateFieldBody,
	FieldIdParams,
	FieldListResponse,
	FieldResponse,
	UpdateFieldBody,
} from "../schemas/custom-fields";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";

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
	},
});

const updateField = createRoute({
	operationId: "updateCustomField",
	method: "patch",
	path: "/{id}",
	tags: ["Custom Fields"],
	summary: "Update a custom field definition",
	description: "Only name and options can be updated. Type and slug are immutable.",
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
		404: {
			description: "Not found",
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
	},
});

// --- Route handlers ---

// @ts-expect-error — handler returns 201, 400 or 409
app.openapi(createField, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	if (body.type === "select" && (!body.options || body.options.length === 0)) {
		return c.json(
			{ error: { code: "VALIDATION_ERROR", message: "Options are required for select type" } },
			400,
		);
	}

	const slug = body.slug ?? slugify(body.name);
	if (!slug) {
		return c.json(
			{ error: { code: "VALIDATION_ERROR", message: "Could not generate a valid slug from the field name" } },
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
			{ error: { code: "CONFLICT", message: `A field with slug "${slug}" already exists` } },
			409,
		);
	}

	const [created] = await db
		.insert(customFieldDefinitions)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const conditions = [eq(customFieldDefinitions.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, customFieldDefinitions.workspaceId);
	if (workspace_id) {
		conditions.push(eq(customFieldDefinitions.workspaceId, workspace_id));
	}

	// Cursor pagination (composite: createdAt DESC, id DESC to handle timestamp ties)
	if (cursor) {
		const [cursorRow] = await db
			.select({ createdAt: customFieldDefinitions.createdAt })
			.from(customFieldDefinitions)
			.where(eq(customFieldDefinitions.id, cursor))
			.limit(1);
		if (cursorRow) {
			conditions.push(
				sql`(${customFieldDefinitions.createdAt} < ${cursorRow.createdAt} OR (${customFieldDefinitions.createdAt} = ${cursorRow.createdAt} AND ${customFieldDefinitions.id} < ${cursor}))`,
			);
		}
	}

	const fields = await db
		.select()
		.from(customFieldDefinitions)
		.where(and(...conditions))
		.orderBy(desc(customFieldDefinitions.createdAt), desc(customFieldDefinitions.id))
		.limit(limit + 1);

	const hasMore = fields.length > limit;
	const data = fields.slice(0, limit).map(serializeField);

	return c.json(
		{
			data,
			next_cursor: hasMore ? data[data.length - 1]!.id : null,
			has_more: hasMore,
		},
		200,
	);
});

app.openapi(updateField, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

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
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const [existing] = await db
		.select({ id: customFieldDefinitions.id, workspaceId: customFieldDefinitions.workspaceId })
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

	await db
		.delete(customFieldDefinitions)
		.where(eq(customFieldDefinitions.id, id));

	return c.body(null, 204);
});

export default app;
