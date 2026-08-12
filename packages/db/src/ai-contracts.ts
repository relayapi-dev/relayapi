/**
 * The first supported AI provider registry is deliberately closed. A knowledge
 * base can only contain one vector width, and inference must never silently
 * substitute another model with different behavior or pricing.
 */
export const AI_EMBEDDING_PROVIDER = "openai" as const;
export const AI_EMBEDDING_MODEL = "text-embedding-3-small" as const;
export const AI_EMBEDDING_DIMENSIONS = 1536 as const;

export const AI_INFERENCE_PROVIDER = "workers_ai" as const;
export const AI_INFERENCE_MODEL = "@cf/zai-org/glm-4.7-flash" as const;

export const AI_KNOWLEDGE_DOCUMENT_SOURCE_TYPES = [
	"url",
	"media",
	"text",
] as const;

export const AI_KNOWLEDGE_DOCUMENT_STATUSES = [
	"pending",
	"in_flight",
	"ready",
	"retryable_failure",
	"terminal_failure",
] as const;

export const AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS = 8;
export const AI_KNOWLEDGE_DOCUMENT_DEADLINE_MS = 24 * 60 * 60 * 1_000;
