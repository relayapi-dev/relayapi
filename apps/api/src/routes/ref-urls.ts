import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { refUrls } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { applyWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	RefUrlCreateSpec,
	RefUrlListResponse,
	RefUrlResponse,
	RefUrlUpdateSpec,
} from "../schemas/ref-urls";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const IdParams = z.object({ id: z.string() });
const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
	automation_id: z.string().optional(),
});

type Row = typeof refUrls.$inferSelect;

function serialize(r: Row): z.infer<typeof RefUrlResponse> {
	return {
		id: r.id,
		organization_id: r.organizationId,
		workspace_id: r.workspaceId,
		slug: r.slug,
		automation_id: r.automationId,
		uses: r.uses,
		enabled: r.enabled,
		created_at: r.createdAt.toISOString(),
	};
}

const createRefUrl = createRoute({
	operationId: "createRefUrl",
	method: "post",
	path: "/",
	tags: ["Ref URLs"],
	summary: "Create a reference URL",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: RefUrlCreateSpec } } },
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: RefUrlResponse } },
		},
		409: {
			description: "Slug already taken",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createRefUrl, async (c) => {
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const existing = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.organizationId, orgId), eq(refUrls.slug, body.slug)),
	});
	if (existing) {
		return c.json(
			{
				error: {
					code: "slug_conflict",
					message: `Slug '${body.slug}' already exists in this organization`,
				},
			},
			409,
		);
	}

	const [row] = await db
		.insert(refUrls)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			slug: body.slug,
			automationId: body.automation_id ?? null,
			enabled: body.enabled,
		})
		.returning();
	return c.json(serialize(row!), 201);
});

const listRefUrls = createRoute({
	operationId: "listRefUrls",
	method: "get",
	path: "/",
	tags: ["Ref URLs"],
	summary: "List reference URLs",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "List",
			content: { "application/json": { schema: RefUrlListResponse } },
		},
	},
});

app.openapi(listRefUrls, async (c) => {
	const { workspace_id, automation_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const conditions = [eq(refUrls.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, refUrls.workspaceId);
	if (workspace_id) conditions.push(eq(refUrls.workspaceId, workspace_id));
	if (automation_id) conditions.push(eq(refUrls.automationId, automation_id));

	if (cursor) {
		const cursorRow = await db
			.select({ createdAt: refUrls.createdAt })
			.from(refUrls)
			.where(eq(refUrls.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${refUrls.createdAt}, ${refUrls.id}) < (${cursorRow[0].createdAt}, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select()
		.from(refUrls)
		.where(and(...conditions))
		.orderBy(desc(refUrls.createdAt), desc(refUrls.id))
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

const getRefUrl = createRoute({
	operationId: "getRefUrl",
	method: "get",
	path: "/{id}",
	tags: ["Ref URLs"],
	summary: "Get a reference URL",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Ref URL",
			content: { "application/json": { schema: RefUrlResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getRefUrl, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.id, id), eq(refUrls.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Ref URL not found" } }, 404);
	// Workspace-level enforcement deferred to middleware.
	return c.json(serialize(row), 200);
});

const updateRefUrl = createRoute({
	operationId: "updateRefUrl",
	method: "patch",
	path: "/{id}",
	tags: ["Ref URLs"],
	summary: "Update a reference URL",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: RefUrlUpdateSpec } } },
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: RefUrlResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Slug conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateRefUrl, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.id, id), eq(refUrls.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Ref URL not found" } }, 404);
	// Workspace-level enforcement deferred to middleware.

	if (body.slug && body.slug !== row.slug) {
		const conflict = await db.query.refUrls.findFirst({
			where: and(eq(refUrls.organizationId, orgId), eq(refUrls.slug, body.slug)),
		});
		if (conflict) {
			return c.json(
				{
					error: {
						code: "slug_conflict",
						message: `Slug '${body.slug}' already exists`,
					},
				},
				409,
			);
		}
	}

	const updates: Partial<typeof refUrls.$inferInsert> = {};
	if (body.slug !== undefined) updates.slug = body.slug;
	if (body.automation_id !== undefined)
		updates.automationId = body.automation_id ?? null;
	if (body.enabled !== undefined) updates.enabled = body.enabled;

	const [updated] = await db
		.update(refUrls)
		.set(updates)
		.where(eq(refUrls.id, id))
		.returning();
	return c.json(serialize(updated!), 200);
});

const deleteRefUrl = createRoute({
	operationId: "deleteRefUrl",
	method: "delete",
	path: "/{id}",
	tags: ["Ref URLs"],
	summary: "Delete a reference URL",
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

app.openapi(deleteRefUrl, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.id, id), eq(refUrls.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Ref URL not found" } }, 404);
	// Workspace-level enforcement deferred to middleware.

	await db.delete(refUrls).where(eq(refUrls.id, id));
	return c.body(null, 204);
});

export default app;
