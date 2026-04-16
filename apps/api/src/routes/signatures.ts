import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, signatures } from "@relayapi/db";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import { ErrorResponse, IdParam, PaginationParams } from "../schemas/common";
import {
	CreateSignatureBody,
	UpdateSignatureBody,
	SignatureResponse,
	SignatureListResponse,
} from "../schemas/signatures";
import type { Env, Variables } from "../types";
import { applyWorkspaceScope, assertWorkspaceScope } from "../lib/workspace-scope";
import { assertScopedCreateWorkspace } from "../lib/request-access";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Helpers ---

function serialize(row: typeof signatures.$inferSelect) {
	return {
		id: row.id,
		name: row.name,
		content: row.content,
		is_default: row.isDefault,
		position: row.position,
		workspace_id: row.workspaceId ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

/** Clear isDefault on all other signatures in the org, then set it on the target. */
async function setDefaultSignature(
	db: ReturnType<typeof createDb>,
	orgId: string,
	signatureId: string,
) {
	await db.transaction(async (tx) => {
		await tx
			.update(signatures)
			.set({ isDefault: false, updatedAt: new Date() })
			.where(
				and(
					eq(signatures.organizationId, orgId),
					ne(signatures.id, signatureId),
				),
			);
		await tx
			.update(signatures)
			.set({ isDefault: true, updatedAt: new Date() })
			.where(
				and(
					eq(signatures.id, signatureId),
					eq(signatures.organizationId, orgId),
				),
			);
	});
}

// --- Route definitions ---

const SignatureListQuery = PaginationParams.extend({
	workspace_id: z.string().optional().describe("Filter by workspace ID"),
});

const listSignatures = createRoute({
	operationId: "listSignatures",
	method: "get",
	path: "/",
	tags: ["Signatures"],
	summary: "List signatures",
	security: [{ Bearer: [] }],
	request: { query: SignatureListQuery },
	responses: {
		200: {
			description: "List of signatures",
			content: { "application/json": { schema: SignatureListResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const createSignatureRoute = createRoute({
	operationId: "createSignature",
	method: "post",
	path: "/",
	tags: ["Signatures"],
	summary: "Create a signature",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateSignatureBody } },
		},
	},
	responses: {
		201: {
			description: "Signature created",
			content: { "application/json": { schema: SignatureResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getSignatureRoute = createRoute({
	operationId: "getSignature",
	method: "get",
	path: "/{id}",
	tags: ["Signatures"],
	summary: "Get a signature",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Signature details",
			content: { "application/json": { schema: SignatureResponse } },
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

const getDefaultSignatureRoute = createRoute({
	operationId: "getDefaultSignature",
	method: "get",
	path: "/default",
	tags: ["Signatures"],
	summary: "Get the default signature",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Default signature",
			content: { "application/json": { schema: SignatureResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "No default signature set",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const updateSignatureRoute = createRoute({
	operationId: "updateSignature",
	method: "patch",
	path: "/{id}",
	tags: ["Signatures"],
	summary: "Update a signature",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			content: { "application/json": { schema: UpdateSignatureBody } },
		},
	},
	responses: {
		200: {
			description: "Signature updated",
			content: { "application/json": { schema: SignatureResponse } },
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

const deleteSignatureRoute = createRoute({
	operationId: "deleteSignature",
	method: "delete",
	path: "/{id}",
	tags: ["Signatures"],
	summary: "Delete a signature",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		204: { description: "Signature deleted" },
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

const setDefaultRoute = createRoute({
	operationId: "setDefaultSignature",
	method: "post",
	path: "/{id}/set-default",
	tags: ["Signatures"],
	summary: "Set a signature as the default",
	description: "Sets this signature as the default. Clears isDefault on all other signatures in the organization.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		200: {
			description: "Signature set as default",
			content: { "application/json": { schema: SignatureResponse } },
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

// --- Route handlers ---

// IMPORTANT: /default must be registered before /{id} to avoid matching "default" as an id
app.openapi(getDefaultSignatureRoute, async (c) => {
	const orgId = c.get("orgId");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(signatures)
		.where(
			and(
				eq(signatures.organizationId, orgId),
				eq(signatures.isDefault, true),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "No default signature set" } },
			404,
		);
	}

	return c.json(serialize(row), 200);
});

app.openapi(listSignatures, async (c) => {
	const orgId = c.get("orgId");
	const { limit, cursor, workspace_id } = c.req.valid("query");
	const db = c.get("db");

	const conditions = [eq(signatures.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, signatures.workspaceId);
	if (workspace_id) {
		conditions.push(eq(signatures.workspaceId, workspace_id));
	}
	if (cursor) {
		conditions.push(lt(signatures.createdAt, new Date(cursor)));
	}

	const rows = await db
		.select()
		.from(signatures)
		.where(and(...conditions))
		.orderBy(desc(signatures.createdAt))
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
app.openapi(createSignatureRoute, async (c) => {
	const orgId = c.get("orgId");
	const body = c.req.valid("json");
	const db = c.get("db");

	const denied = assertScopedCreateWorkspace(c, body.workspace_id, "signature");
	if (denied) return denied;

	let row: typeof signatures.$inferSelect | undefined;

	if (body.is_default) {
		// Atomic: insert + clear other defaults in one transaction
		await db.transaction(async (tx) => {
			const [inserted] = await tx
				.insert(signatures)
				.values({
					organizationId: orgId,
					workspaceId: body.workspace_id ?? null,
					name: body.name,
					content: body.content,
					isDefault: true,
					position: body.position,
				})
				.returning();
			row = inserted;
			if (row) {
				await tx
					.update(signatures)
					.set({ isDefault: false, updatedAt: new Date() })
					.where(
						and(
							eq(signatures.organizationId, orgId),
							ne(signatures.id, row.id),
						),
					);
			}
		});
	} else {
		const [inserted] = await db
			.insert(signatures)
			.values({
				organizationId: orgId,
				workspaceId: body.workspace_id ?? null,
				name: body.name,
				content: body.content,
				isDefault: false,
				position: body.position,
			})
			.returning();
		row = inserted;
	}

	if (!row) {
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Failed to create signature" } } as never,
			500 as never,
		);
	}

	return c.json(serialize(row), 201);
});

app.openapi(getSignatureRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [row] = await db
		.select()
		.from(signatures)
		.where(
			and(
				eq(signatures.id, id),
				eq(signatures.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Signature not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied as never;

	return c.json(serialize(row), 200);
});

app.openapi(updateSignatureRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(signatures)
		.where(
			and(
				eq(signatures.id, id),
				eq(signatures.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Signature not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	const updates: Record<string, unknown> = { updatedAt: new Date() };
	if (body.name !== undefined) updates.name = body.name;
	if (body.content !== undefined) updates.content = body.content;
	if (body.position !== undefined) updates.position = body.position;
	if (body.is_default !== undefined) updates.isDefault = body.is_default;

	let updated: typeof signatures.$inferSelect | undefined;

	if (body.is_default === true) {
		// Atomic: update this signature + clear other defaults in one transaction
		await db.transaction(async (tx) => {
			const [result] = await tx
				.update(signatures)
				.set(updates)
				.where(eq(signatures.id, id))
				.returning();
			updated = result;
			await tx
				.update(signatures)
				.set({ isDefault: false, updatedAt: new Date() })
				.where(
					and(
						eq(signatures.organizationId, orgId),
						ne(signatures.id, id),
					),
				);
		});
	} else {
		const [result] = await db
			.update(signatures)
			.set(updates)
			.where(eq(signatures.id, id))
			.returning();
		updated = result;
	}

	return c.json(serialize(updated ?? existing), 200);
});

app.openapi(deleteSignatureRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select({ id: signatures.id, workspaceId: signatures.workspaceId })
		.from(signatures)
		.where(
			and(
				eq(signatures.id, id),
				eq(signatures.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Signature not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	await db.delete(signatures).where(eq(signatures.id, id));

	return c.body(null, 204);
});

app.openapi(setDefaultRoute, async (c) => {
	const orgId = c.get("orgId");
	const { id } = c.req.valid("param");
	const db = c.get("db");

	const [existing] = await db
		.select()
		.from(signatures)
		.where(
			and(
				eq(signatures.id, id),
				eq(signatures.organizationId, orgId),
			),
		)
		.limit(1);

	if (!existing) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Signature not found" } },
			404,
		);
	}

	const denied = assertWorkspaceScope(c, existing.workspaceId);
	if (denied) return denied as never;

	await setDefaultSignature(db, orgId, id);

	return c.json(serialize({ ...existing, isDefault: true, updatedAt: new Date() }), 200);
});

export default app;
