import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { automations as automationsTable, contacts, refUrls } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { emitInternalEvent } from "../services/automations/internal-events";
import type { InboundEvent } from "../services/automations/trigger-matcher";
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

app.openapi(getRefUrl, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.id, id), eq(refUrls.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Ref URL not found" } }, 404);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
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
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
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
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

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

app.openapi(deleteRefUrl, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.id, id), eq(refUrls.organizationId, orgId)),
	});
	if (!row)
		return c.json({ error: { code: "not_found", message: "Ref URL not found" } }, 404);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	await db.delete(refUrls).where(eq(refUrls.id, id));
	return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Click tracking — records a ref-url click and fires the `ref_link_click`
// internal event so automations can enroll the contact. The ref URL itself
// doesn't store a redirect target in this schema; external systems call this
// endpoint after they've already redirected the user so the automation
// engine can react.
// ---------------------------------------------------------------------------

const ClickBody = z.object({
	contact_id: z.string(),
});

const recordRefUrlClick = createRoute({
	operationId: "recordRefUrlClick",
	method: "post",
	path: "/{id}/click",
	tags: ["Ref URLs"],
	summary: "Record a click on a ref URL",
	description:
		"Increments the click counter and, when a contact is supplied, fires a " +
		"`ref_link_click` automation event so matching entrypoints enroll the " +
		"contact.",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: { content: { "application/json": { schema: ClickBody } } },
	},
	responses: {
		200: {
			description: "Click recorded",
			content: { "application/json": { schema: RefUrlResponse } },
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

app.openapi(recordRefUrlClick, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.refUrls.findFirst({
		where: and(eq(refUrls.id, id), eq(refUrls.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Ref URL not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const [updated] = await db
		.update(refUrls)
		.set({ uses: sql`${refUrls.uses} + 1` })
		.where(eq(refUrls.id, id))
		.returning();

	// Best-effort event emit. Look up the bound automation's channel (if any)
	// so `ref_link_click` entrypoints for that channel match. If the ref URL
	// isn't bound to an automation, fall back to "instagram" — the matcher
	// filters on channel+kind, so a cross-channel entrypoint can still miss
	// but we shouldn't crash here.
	let channel: InboundEvent["channel"] = "instagram";
	if (row.automationId) {
		const auto = await db.query.automations.findFirst({
			where: eq(automationsTable.id, row.automationId),
		});
		if (auto?.channel) channel = auto.channel as InboundEvent["channel"];
	}

	// Validate the contact belongs to the same org before emitting.
	const contact = await db.query.contacts.findFirst({
		where: and(
			eq(contacts.id, body.contact_id),
			eq(contacts.organizationId, orgId),
		),
	});
	if (contact) {
		await emitInternalEvent(
			db,
			{
				kind: "ref_link_click",
				channel,
				organizationId: orgId,
				socialAccountId: null,
				contactId: body.contact_id,
				conversationId: null,
				refUrlId: row.id,
				payload: {
					source: "ref_url_click",
					slug: row.slug,
					ref_url_id: row.id,
				},
			},
			c.env as unknown as Record<string, unknown>,
		);
	}

	return c.json(serialize(updated!), 200);
});

export default app;
