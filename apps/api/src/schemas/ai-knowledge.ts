import { z } from "@hono/zod-openapi";
import { AI_KNOWLEDGE_SOURCE_TYPES } from "@relayapi/db";
import { paginatedResponse } from "./common";

export const EmbeddingProvider = z.literal("openai");
export const EmbeddingModel = z.literal("text-embedding-3-small");
export const EmbeddingDimensions = z.literal(1536);

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

export const KnowledgeBaseCreateSpec = z.object({
	name: z.string().trim().min(1).max(200),
	description: z.string().trim().max(2_000).optional(),
	workspace_id: z.string().optional(),
});

export const KnowledgeBaseUpdateSpec = z.object({
	name: z.string().trim().min(1).max(200).optional(),
	description: z.string().trim().max(2_000).nullable().optional(),
});

export const KnowledgeBaseResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	embedding_provider: EmbeddingProvider,
	embedding_model: EmbeddingModel,
	embedding_dimensions: EmbeddingDimensions,
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const KnowledgeBaseListResponse = paginatedResponse(
	KnowledgeBaseResponse,
);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

const KnowledgeDocumentCommon = {
	title: z.string().trim().min(1).max(500).optional(),
};

export const KnowledgeDocumentCreateSpec = z.discriminatedUnion("source_type", [
	z.object({
		...KnowledgeDocumentCommon,
		source_type: z.literal("url"),
		url: z.string().url().max(4_000),
	}),
	z.object({
		...KnowledgeDocumentCommon,
		source_type: z.literal("media"),
		media_id: z.string().min(1).max(200),
	}),
	z.object({
		...KnowledgeDocumentCommon,
		source_type: z.literal("text"),
		text: z
			.string()
			.min(1)
			.max(2 * 1024 * 1024),
	}),
]);

export const KnowledgeDocumentStatus = z.enum([
	"pending",
	"in_flight",
	"ready",
	"retryable_failure",
	"terminal_failure",
]);

export const KnowledgeDocumentResponse = z.object({
	id: z.string(),
	kb_id: z.string(),
	source_type: z.enum(AI_KNOWLEDGE_SOURCE_TYPES),
	source_url: z.string().url().nullable(),
	source_media_id: z.string().nullable(),
	title: z.string().nullable(),
	status: KnowledgeDocumentStatus,
	attempt_count: z.number().int().nonnegative(),
	next_attempt_at: z.string().datetime(),
	last_crawled_at: z.string().datetime().nullable(),
	last_error_code: z.string().nullable(),
	last_error: z.string().nullable(),
	completed_at: z.string().datetime().nullable(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const KnowledgeDocumentListResponse = paginatedResponse(
	KnowledgeDocumentResponse,
);

export const KnowledgeSearchSpec = z.object({
	query: z.string().trim().min(1).max(8_000),
	limit: z.number().int().min(1).max(20).default(5),
});

export const KnowledgeSearchResponse = z.object({
	data: z.array(
		z.object({
			chunk_id: z.string(),
			document_id: z.string(),
			content: z.string(),
			similarity: z.number().min(0).max(1),
		}),
	),
});
