import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { aiKnowledgeBases, aiKnowledgeDocuments } from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { applyWorkspaceScope } from "../lib/workspace-scope";
import {
	KnowledgeBaseCreateSpec,
	KnowledgeBaseListResponse,
	KnowledgeBaseResponse,
	KnowledgeBaseUpdateSpec,
	KnowledgeDocumentCreateSpec,
	KnowledgeDocumentListResponse,
	KnowledgeDocumentResponse,
} from "../schemas/ai-knowledge";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const IdParams = z.object({ id: z.string() });
const KbDocParams = z.object({ id: z.string(), documentId: z.string() });
const ListQuery = PaginationParams.extend({
	workspace_id: z.string().optional(),
});

type KbRow = typeof aiKnowledgeBases.$inferSelect;
type DocRow = typeof aiKnowledgeDocuments.$inferSelect;

function serializeKb(r: KbRow): z.infer<typeof KnowledgeBaseResponse> {
	return {
		id: r.id,
		organization_id: r.organizationId,
		workspace_id: r.workspaceId,
		name: r.name,
		description: r.description ?? null,
		embedding_model: r.embeddingModel,
		embedding_dimensions: r.embeddingDimensions,
		created_at: r.createdAt.toISOString(),
		updated_at: r.updatedAt.toISOString(),
	};
}

function serializeDoc(r: DocRow): z.infer<typeof KnowledgeDocumentResponse> {
	return {
		id: r.id,
		kb_id: r.kbId,
		source_type: r.sourceType,
		source_ref: r.sourceRef,
		title: r.title ?? null,
		status: r.status,
		last_crawled_at: r.lastCrawledAt?.toISOString() ?? null,
		error: r.error ?? null,
		created_at: r.createdAt.toISOString(),
		updated_at: r.updatedAt.toISOString(),
	};
}

// ---------- Knowledge bases ----------

const createKb = createRoute({
	operationId: "createKnowledgeBase",
	method: "post",
	path: "/",
	tags: ["AI Knowledge"],
	summary: "Create a knowledge base",
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: KnowledgeBaseCreateSpec } },
		},
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: KnowledgeBaseResponse } },
		},
	},
});

app.openapi(createKb, async (c) => {
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const [row] = await db
		.insert(aiKnowledgeBases)
		.values({
			organizationId: orgId,
			workspaceId: body.workspace_id ?? null,
			name: body.name,
			description: body.description,
			embeddingModel: body.embedding_model,
			embeddingDimensions: body.embedding_dimensions,
		})
		.returning();

	return c.json(serializeKb(row!), 201);
});

const listKbs = createRoute({
	operationId: "listKnowledgeBases",
	method: "get",
	path: "/",
	tags: ["AI Knowledge"],
	summary: "List knowledge bases",
	security: [{ Bearer: [] }],
	request: { query: ListQuery },
	responses: {
		200: {
			description: "List",
			content: { "application/json": { schema: KnowledgeBaseListResponse } },
		},
	},
});

app.openapi(listKbs, async (c) => {
	const { workspace_id, cursor, limit } = c.req.valid("query");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const conditions = [eq(aiKnowledgeBases.organizationId, orgId)];
	applyWorkspaceScope(c, conditions, aiKnowledgeBases.workspaceId);
	if (workspace_id)
		conditions.push(eq(aiKnowledgeBases.workspaceId, workspace_id));

	if (cursor) {
		const cursorRow = await db
			.select({ createdAt: aiKnowledgeBases.createdAt })
			.from(aiKnowledgeBases)
			.where(eq(aiKnowledgeBases.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${aiKnowledgeBases.createdAt}, ${aiKnowledgeBases.id}) < (${cursorRow[0].createdAt}, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select()
		.from(aiKnowledgeBases)
		.where(and(...conditions))
		.orderBy(desc(aiKnowledgeBases.createdAt), desc(aiKnowledgeBases.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeKb);
	return c.json(
		{
			data,
			next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

const getKb = createRoute({
	operationId: "getKnowledgeBase",
	method: "get",
	path: "/{id}",
	tags: ["AI Knowledge"],
	summary: "Get a knowledge base",
	security: [{ Bearer: [] }],
	request: { params: IdParams },
	responses: {
		200: {
			description: "Knowledge base",
			content: { "application/json": { schema: KnowledgeBaseResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getKb, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(eq(aiKnowledgeBases.id, id), eq(aiKnowledgeBases.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	// Workspace-level enforcement deferred to middleware.
	return c.json(serializeKb(row), 200);
});

const updateKb = createRoute({
	operationId: "updateKnowledgeBase",
	method: "patch",
	path: "/{id}",
	tags: ["AI Knowledge"],
	summary: "Update a knowledge base",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: KnowledgeBaseUpdateSpec } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: KnowledgeBaseResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateKb, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(eq(aiKnowledgeBases.id, id), eq(aiKnowledgeBases.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	// Workspace-level enforcement deferred to middleware.

	const updates: Partial<typeof aiKnowledgeBases.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;
	if (body.embedding_model !== undefined)
		updates.embeddingModel = body.embedding_model;
	if (body.embedding_dimensions !== undefined)
		updates.embeddingDimensions = body.embedding_dimensions;

	const [updated] = await db
		.update(aiKnowledgeBases)
		.set(updates)
		.where(eq(aiKnowledgeBases.id, id))
		.returning();
	return c.json(serializeKb(updated!), 200);
});

const deleteKb = createRoute({
	operationId: "deleteKnowledgeBase",
	method: "delete",
	path: "/{id}",
	tags: ["AI Knowledge"],
	summary: "Delete a knowledge base",
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

app.openapi(deleteKb, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(eq(aiKnowledgeBases.id, id), eq(aiKnowledgeBases.organizationId, orgId)),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	// Workspace-level enforcement deferred to middleware.

	await db.delete(aiKnowledgeBases).where(eq(aiKnowledgeBases.id, id));
	return c.body(null, 204);
});

// ---------- Documents ----------

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

async function loadKb(c: AppContext, kbId: string): Promise<KbRow | null> {
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(
			eq(aiKnowledgeBases.id, kbId),
			eq(aiKnowledgeBases.organizationId, orgId),
		),
	});
	return row ?? null;
}

const createDoc = createRoute({
	operationId: "createKnowledgeDocument",
	method: "post",
	path: "/{id}/documents",
	tags: ["AI Knowledge"],
	summary: "Add a document to a knowledge base",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: {
				"application/json": { schema: KnowledgeDocumentCreateSpec },
			},
		},
	},
	responses: {
		201: {
			description: "Created",
			content: { "application/json": { schema: KnowledgeDocumentResponse } },
		},
		404: {
			description: "Knowledge base not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createDoc, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");

	const kb = await loadKb(c, id);
	if (!kb)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	// Workspace-level enforcement deferred to middleware.

	const [row] = await db
		.insert(aiKnowledgeDocuments)
		.values({
			kbId: id,
			sourceType: body.source_type,
			sourceRef: body.source_ref,
			title: body.title,
			status: "pending",
		})
		.returning();

	return c.json(serializeDoc(row!), 201);
});

const listDocs = createRoute({
	operationId: "listKnowledgeDocuments",
	method: "get",
	path: "/{id}/documents",
	tags: ["AI Knowledge"],
	summary: "List documents in a knowledge base",
	security: [{ Bearer: [] }],
	request: { params: IdParams, query: PaginationParams },
	responses: {
		200: {
			description: "List",
			content: {
				"application/json": { schema: KnowledgeDocumentListResponse },
			},
		},
		404: {
			description: "Knowledge base not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listDocs, async (c) => {
	const { id } = c.req.valid("param");
	const { cursor, limit } = c.req.valid("query");
	const db = c.get("db");

	const kb = await loadKb(c, id);
	if (!kb)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	// Workspace-level enforcement deferred to middleware.

	const conditions = [eq(aiKnowledgeDocuments.kbId, id)];
	if (cursor) {
		const cursorRow = await db
			.select({ createdAt: aiKnowledgeDocuments.createdAt })
			.from(aiKnowledgeDocuments)
			.where(eq(aiKnowledgeDocuments.id, cursor))
			.limit(1);
		if (cursorRow[0]) {
			conditions.push(
				sql`(${aiKnowledgeDocuments.createdAt}, ${aiKnowledgeDocuments.id}) < (${cursorRow[0].createdAt}, ${cursor})`,
			);
		}
	}

	const rows = await db
		.select()
		.from(aiKnowledgeDocuments)
		.where(and(...conditions))
		.orderBy(desc(aiKnowledgeDocuments.createdAt), desc(aiKnowledgeDocuments.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const data = rows.slice(0, limit).map(serializeDoc);
	return c.json(
		{
			data,
			next_cursor: hasMore ? (data[data.length - 1]?.id ?? null) : null,
			has_more: hasMore,
		},
		200,
	);
});

const deleteDoc = createRoute({
	operationId: "deleteKnowledgeDocument",
	method: "delete",
	path: "/{id}/documents/{documentId}",
	tags: ["AI Knowledge"],
	summary: "Remove a document",
	security: [{ Bearer: [] }],
	request: { params: KbDocParams },
	responses: {
		204: { description: "Deleted" },
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteDoc, async (c) => {
	const { id, documentId } = c.req.valid("param");
	const db = c.get("db");

	const kb = await loadKb(c, id);
	if (!kb)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	// Workspace-level enforcement deferred to middleware.

	const doc = await db.query.aiKnowledgeDocuments.findFirst({
		where: and(
			eq(aiKnowledgeDocuments.id, documentId),
			eq(aiKnowledgeDocuments.kbId, id),
		),
	});
	if (!doc)
		return c.json(
			{ error: { code: "not_found", message: "Document not found" } },
			404,
		);

	await db.delete(aiKnowledgeDocuments).where(eq(aiKnowledgeDocuments.id, documentId));
	return c.body(null, 204);
});

export default app;
