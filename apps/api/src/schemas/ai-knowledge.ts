import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

export const KnowledgeBaseCreateSpec = z.object({
	name: z.string().min(1).max(200),
	description: z.string().optional(),
	workspace_id: z.string().optional(),
	embedding_model: z.string().default("text-embedding-3-small"),
	embedding_dimensions: z.number().int().default(1536),
});

export const KnowledgeBaseUpdateSpec = KnowledgeBaseCreateSpec.partial();

export const KnowledgeBaseResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	embedding_model: z.string(),
	embedding_dimensions: z.number().int(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const KnowledgeBaseListResponse = paginatedResponse(KnowledgeBaseResponse);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const KnowledgeDocumentCreateSpec = z.object({
	source_type: z.enum(["url", "file", "text"]),
	source_ref: z
		.string()
		.describe(
			"URL for source_type=url, media_id for file, or raw content for text",
		),
	title: z.string().optional(),
});

export const KnowledgeDocumentResponse = z.object({
	id: z.string(),
	kb_id: z.string(),
	source_type: z.string(),
	source_ref: z.string(),
	title: z.string().nullable(),
	status: z.string(),
	last_crawled_at: z.string().datetime().nullable(),
	error: z.string().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const KnowledgeDocumentListResponse = paginatedResponse(
	KnowledgeDocumentResponse,
);
