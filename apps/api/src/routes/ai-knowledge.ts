import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	AI_KNOWLEDGE_DOCUMENT_DEADLINE_MS,
	aiKnowledgeBases,
	aiKnowledgeDocuments,
	media,
} from "@relayapi/db";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";
import { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import {
	encodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	tryDecodeTimestampIdCursor,
} from "../lib/pagination-cursor";
import {
	resolveOperationalCreateScope,
	workspaceScopeKey,
} from "../lib/request-access";
import {
	applyWorkspaceScope,
	isWorkspaceScopeDenied,
	WORKSPACE_ACCESS_DENIED_BODY,
} from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import {
	KnowledgeBaseCreateSpec,
	KnowledgeBaseListResponse,
	KnowledgeBaseResponse,
	KnowledgeBaseUpdateSpec,
	KnowledgeDocumentCreateSpec,
	KnowledgeDocumentListResponse,
	KnowledgeDocumentResponse,
	KnowledgeSearchResponse,
	KnowledgeSearchSpec,
} from "../schemas/ai-knowledge";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import {
	AI_KNOWLEDGE_PROVIDER_CONTRACT,
	AiKnowledgeError,
	isSupportedKnowledgeMediaMimeType,
	searchKnowledgeBase,
} from "../services/ai-knowledge";
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
		embedding_provider: AI_KNOWLEDGE_PROVIDER_CONTRACT.embeddingProvider,
		embedding_model: AI_KNOWLEDGE_PROVIDER_CONTRACT.embeddingModel,
		embedding_dimensions: AI_KNOWLEDGE_PROVIDER_CONTRACT.embeddingDimensions,
		created_at: r.createdAt.toISOString(),
		updated_at: r.updatedAt.toISOString(),
	};
}

function serializeDoc(r: DocRow): z.infer<typeof KnowledgeDocumentResponse> {
	return {
		id: r.id,
		kb_id: r.kbId,
		source_type: r.sourceType,
		source_url: r.sourceUrl,
		source_media_id: r.sourceMediaId,
		title: r.title ?? null,
		status: r.status,
		attempt_count: r.attemptCount,
		next_attempt_at: r.nextAttemptAt.toISOString(),
		last_crawled_at: r.lastCrawledAt?.toISOString() ?? null,
		last_error_code: r.lastErrorCode,
		last_error: r.lastError,
		completed_at: r.completedAt?.toISOString() ?? null,
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
	const scope = await resolveOperationalCreateScope(
		c,
		body.workspace_id,
		"knowledge base",
	);
	if (!scope.ok) return scope.response as never;

	const [row] = await db
		.insert(aiKnowledgeBases)
		.values({
			organizationId: orgId,
			workspaceId: scope.workspaceId,
			name: body.name,
			description: body.description,
		})
		.returning();

	if (!row) throw new Error("Failed to create knowledge base");
	return c.json(serializeKb(row), 201);
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
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
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

	// Keyset pagination on (createdAt, id). Read the cursor row's created_at as raw
	// text so it isn't round-tripped through a JS Date, which truncates Postgres
	// microseconds to millisecond precision and would skip rows sharing the cursor's
	// millisecond. Bind it back with an explicit ::timestamptz cast.
	if (cursor) {
		const key = tryDecodeTimestampIdCursor(cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${aiKnowledgeBases.createdAt}, ${aiKnowledgeBases.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	const rows = await db
		.select({
			...getTableColumns(aiKnowledgeBases),
			cursorTimestamp: sql<string>`to_char(${aiKnowledgeBases.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(aiKnowledgeBases)
		.where(and(...conditions))
		.orderBy(desc(aiKnowledgeBases.createdAt), desc(aiKnowledgeBases.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const pageRows = rows.slice(0, limit);
	const last = pageRows.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;
	const data = pageRows.map(serializeKb);
	return c.json(
		{
			data,
			next_cursor: nextCursor,
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

app.openapi(getKb, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");
	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(
			eq(aiKnowledgeBases.id, id),
			eq(aiKnowledgeBases.organizationId, orgId),
		),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
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

app.openapi(updateKb, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(
			eq(aiKnowledgeBases.id, id),
			eq(aiKnowledgeBases.organizationId, orgId),
		),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const updates: Partial<typeof aiKnowledgeBases.$inferInsert> = {
		updatedAt: new Date(),
	};
	if (body.name !== undefined) updates.name = body.name;
	if (body.description !== undefined) updates.description = body.description;

	const [updated] = await db
		.update(aiKnowledgeBases)
		.set(updates)
		.where(eq(aiKnowledgeBases.id, id))
		.returning();
	if (!updated) throw new Error("Failed to update knowledge base");
	return c.json(serializeKb(updated), 200);
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

app.openapi(deleteKb, async (c) => {
	const { id } = c.req.valid("param");
	const db = c.get("db");
	const orgId = c.get("orgId");

	const row = await db.query.aiKnowledgeBases.findFirst({
		where: and(
			eq(aiKnowledgeBases.id, id),
			eq(aiKnowledgeBases.organizationId, orgId),
		),
	});
	if (!row)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, row.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

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
		400: {
			description: "Unsupported media source",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
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
	if (isWorkspaceScopeDenied(c, kb.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const scopeKey = workspaceScopeKey(kb.workspaceId);
	if (body.source_type === "media") {
		const [source] = await db
			.select({ id: media.id, mimeType: media.mimeType })
			.from(media)
			.where(
				and(
					eq(media.id, body.media_id),
					eq(media.organizationId, kb.organizationId),
					eq(media.scopeKey, scopeKey),
					eq(media.status, "ready"),
				),
			)
			.limit(1);
		if (!source) {
			return c.json(
				{
					error: {
						code: "not_found",
						message:
							"Ready media source not found in this knowledge-base scope",
					},
				},
				404,
			);
		}
		if (!isSupportedKnowledgeMediaMimeType(source.mimeType)) {
			return c.json(
				{
					error: {
						code: "unsupported_media_type",
						message:
							"Knowledge media must be text, JSON, XML, PDF, JPEG, PNG, GIF, or WebP",
					},
				},
				400,
			);
		}
	}

	const [row] = await db
		.insert(aiKnowledgeDocuments)
		.values({
			organizationId: kb.organizationId,
			scopeKey,
			kbId: id,
			sourceType: body.source_type,
			sourceUrl: body.source_type === "url" ? body.url : null,
			sourceMediaId: body.source_type === "media" ? body.media_id : null,
			sourceText: body.source_type === "text" ? body.text : null,
			title: body.title,
			status: "pending",
			deadlineAt: new Date(Date.now() + AI_KNOWLEDGE_DOCUMENT_DEADLINE_MS),
		})
		.returning();

	if (!row) throw new Error("Failed to create knowledge document");
	return c.json(serializeDoc(row), 201);
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
		400: {
			description: "Invalid cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
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
	if (isWorkspaceScopeDenied(c, kb.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

	const conditions = [
		eq(aiKnowledgeDocuments.kbId, id),
		eq(aiKnowledgeDocuments.organizationId, c.get("orgId")),
		eq(aiKnowledgeDocuments.scopeKey, kb.scopeKey),
	];
	// Keyset pagination on (createdAt, id). Read the cursor row's created_at as raw
	// text so it isn't round-tripped through a JS Date, which truncates Postgres
	// microseconds to millisecond precision and would skip rows sharing the cursor's
	// millisecond. Bind it back with an explicit ::timestamptz cast.
	if (cursor) {
		const key = tryDecodeTimestampIdCursor(cursor);
		if (!key) return c.json(INVALID_CURSOR_BODY, 400);
		conditions.push(
			sql`(${aiKnowledgeDocuments.createdAt}, ${aiKnowledgeDocuments.id}) < (${key.timestamp}::timestamptz, ${key.id})`,
		);
	}

	const rows = await db
		.select({
			...getTableColumns(aiKnowledgeDocuments),
			cursorTimestamp: sql<string>`to_char(${aiKnowledgeDocuments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
		})
		.from(aiKnowledgeDocuments)
		.where(and(...conditions))
		.orderBy(
			desc(aiKnowledgeDocuments.createdAt),
			desc(aiKnowledgeDocuments.id),
		)
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const pageRows = rows.slice(0, limit);
	const last = pageRows.at(-1);
	const nextCursor =
		hasMore && last
			? encodeTimestampIdCursor(last.cursorTimestamp, last.id)
			: null;
	const data = pageRows.map(serializeDoc);
	return c.json(
		{
			data,
			next_cursor: nextCursor,
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

app.openapi(deleteDoc, async (c) => {
	const { id, documentId } = c.req.valid("param");
	const db = c.get("db");

	const kb = await loadKb(c, id);
	if (!kb)
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	if (isWorkspaceScopeDenied(c, kb.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}

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

	await db
		.delete(aiKnowledgeDocuments)
		.where(eq(aiKnowledgeDocuments.id, documentId));
	return c.body(null, 204);
});

const retryDoc = createRoute({
	operationId: "retryKnowledgeDocument",
	method: "post",
	path: "/{id}/documents/{documentId}/retry",
	tags: ["AI Knowledge"],
	summary: "Retry a failed knowledge document",
	security: [{ Bearer: [] }],
	request: { params: KbDocParams },
	responses: {
		202: {
			description: "Retry scheduled",
			content: { "application/json": { schema: KnowledgeDocumentResponse } },
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
			description: "Document is not failed",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(retryDoc, async (c) => {
	const { id, documentId } = c.req.valid("param");
	const db = c.get("db");
	const kb = await loadKb(c, id);
	if (!kb) {
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, kb.workspaceId)) {
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const [document] = await db
		.select()
		.from(aiKnowledgeDocuments)
		.where(
			and(
				eq(aiKnowledgeDocuments.id, documentId),
				eq(aiKnowledgeDocuments.kbId, id),
				eq(aiKnowledgeDocuments.organizationId, kb.organizationId),
				eq(aiKnowledgeDocuments.scopeKey, workspaceScopeKey(kb.workspaceId)),
			),
		)
		.limit(1);
	if (!document) {
		return c.json(
			{ error: { code: "not_found", message: "Document not found" } },
			404,
		);
	}
	if (
		document.status !== "retryable_failure" &&
		document.status !== "terminal_failure"
	) {
		return c.json(
			{
				error: {
					code: "invalid_state",
					message: "Only failed documents can be retried",
				},
			},
			409,
		);
	}
	const now = new Date();
	const [updated] = await db
		.update(aiKnowledgeDocuments)
		.set({
			status: "pending",
			attemptCount: 0,
			nextAttemptAt: now,
			attemptId: null,
			claimedAt: null,
			leaseExpiresAt: null,
			lastErrorCode: null,
			lastError: null,
			contentHash: null,
			completedAt: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(aiKnowledgeDocuments.id, documentId),
				inArray(aiKnowledgeDocuments.status, [
					"retryable_failure",
					"terminal_failure",
				]),
			),
		)
		.returning();
	if (!updated) {
		return c.json(
			{
				error: {
					code: "invalid_state",
					message: "Document state changed before the retry was scheduled",
				},
			},
			409,
		);
	}
	return c.json(serializeDoc(updated), 202);
});

const searchKb = createRoute({
	operationId: "searchKnowledgeBase",
	method: "post",
	path: "/{id}/search",
	tags: ["AI Knowledge"],
	summary: "Search a knowledge base",
	security: [{ Bearer: [] }],
	request: {
		params: IdParams,
		body: {
			content: { "application/json": { schema: KnowledgeSearchSpec } },
		},
	},
	responses: {
		200: {
			description: "Nearest knowledge chunks",
			content: { "application/json": { schema: KnowledgeSearchResponse } },
		},
		403: {
			description: "Forbidden",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "Embedding provider unavailable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(searchKb, async (c) => {
	const { id } = c.req.valid("param");
	const { query, limit } = c.req.valid("json");
	const db = c.get("db");
	const kb = await loadKb(c, id);
	if (!kb) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "not_found", message: "Knowledge base not found" } },
			404,
		);
	}
	if (isWorkspaceScopeDenied(c, kb.workspaceId)) {
		markMutationInputNotApplied(c);
		return c.json(WORKSPACE_ACCESS_DENIED_BODY, 403);
	}
	const mutation = new SingleUnitProviderMutationAggregate(
		c.get("mutationEffectTracker"),
	);
	try {
		const rows = await searchKnowledgeBase(
			db,
			c.env,
			{
				organizationId: kb.organizationId,
				scopeKey: workspaceScopeKey(kb.workspaceId),
				kbId: kb.id,
				query,
				limit,
			},
			mutation,
		);
		mutation.markCommitted();
		return c.json(
			{
				data: rows.map((row) => ({
					chunk_id: row.chunkId,
					document_id: row.documentId,
					content: row.content,
					similarity: row.similarity,
				})),
			},
			200,
		);
	} catch (error) {
		if (error instanceof AiKnowledgeError) {
			return c.json(
				{
					error: {
						code: error.code,
						message: "Embedding provider is unavailable",
					},
				},
				503,
			);
		}
		throw error;
	} finally {
		mutation.finalize();
	}
});

export default app;
