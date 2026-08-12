import { z } from "@hono/zod-openapi";
import { paginatedResponse } from "./common";

export const AiInferenceProvider = z.literal("workers_ai");
export const AiInferenceModel = z.literal("@cf/zai-org/glm-4.7-flash");

export const AiAgentGuardrails = z.object({
	version: z.literal(1).default(1),
	blocked_topics: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
	fallback_message: z
		.string()
		.trim()
		.min(1)
		.max(1_000)
		.default("I can’t help with that request. A team member can take over."),
});

export const AiAgentHandoff = z.object({
	version: z.literal(1).default(1),
	keywords: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
	confidence_threshold: z.number().min(0).max(1).default(0.6),
	principal_id: z.string().nullable().default(null),
});

export const AiAgentCreateSpec = z.object({
	name: z.string().trim().min(1).max(200),
	workspace_id: z.string().optional(),
	persona: z.string().trim().max(8_000).nullable().optional(),
	guardrails: AiAgentGuardrails.optional(),
	handoff: AiAgentHandoff.optional(),
	knowledge_base_id: z.string().nullable().optional(),
	temperature: z.number().min(0).max(2).default(0.7),
	max_tokens: z.number().int().min(1).max(8_192).default(1_024),
	enabled: z.boolean().default(true),
});

export const AiAgentUpdateSpec = z.object({
	name: z.string().trim().min(1).max(200).optional(),
	persona: z.string().trim().max(8_000).nullable().optional(),
	guardrails: AiAgentGuardrails.optional(),
	handoff: AiAgentHandoff.optional(),
	knowledge_base_id: z.string().nullable().optional(),
	temperature: z.number().min(0).max(2).optional(),
	max_tokens: z.number().int().min(1).max(8_192).optional(),
	enabled: z.boolean().optional(),
});

export const AiAgentResponse = z.object({
	id: z.string(),
	organization_id: z.string(),
	workspace_id: z.string().nullable(),
	name: z.string(),
	persona: z.string().nullable(),
	provider: AiInferenceProvider,
	model: AiInferenceModel,
	guardrails: AiAgentGuardrails,
	handoff: AiAgentHandoff,
	knowledge_base_id: z.string().nullable(),
	temperature: z.number(),
	max_tokens: z.number().int(),
	enabled: z.boolean(),
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
});

export const AiAgentListResponse = paginatedResponse(AiAgentResponse);

export const AiAgentRespondSpec = z.object({
	message: z.string().trim().min(1).max(12_000),
	conversation_context: z
		.array(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string().trim().min(1).max(12_000),
			}),
		)
		.max(20)
		.default([]),
});

export const AiAgentRespondResponse = z.object({
	message: z.string(),
	confidence: z.number().min(0).max(1),
	handoff_required: z.boolean(),
	handoff_reason: z
		.enum(["guardrail", "keyword", "low_confidence", "model_request"])
		.nullable(),
	handoff_principal_id: z.string().nullable(),
	knowledge: z.array(
		z.object({
			document_id: z.string(),
			similarity: z.number().min(0).max(1),
		}),
	),
});
