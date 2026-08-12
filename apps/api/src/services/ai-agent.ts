import {
	AI_INFERENCE_MODEL,
	AI_INFERENCE_PROVIDER,
	type aiAgents,
	type Database,
	organizationPrincipals,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import type { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import type { Env } from "../types";
import {
	AiKnowledgeError,
	type KnowledgeSearchResult,
	searchKnowledgeBase,
} from "./ai-knowledge";

type AiAgentRow = typeof aiAgents.$inferSelect;

export class AiAgentRuntimeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "AiAgentRuntimeError";
		this.code = code;
	}
}

export interface AiAgentTurn {
	role: "user" | "assistant";
	content: string;
}

export interface AiAgentRuntimeResult {
	message: string;
	confidence: number;
	handoffRequired: boolean;
	handoffReason:
		| "guardrail"
		| "keyword"
		| "low_confidence"
		| "model_request"
		| null;
	handoffPrincipalId: string | null;
	knowledge: KnowledgeSearchResult[];
}

function normalize(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function firstMatchedTerm(message: string, terms: string[]): string | null {
	const normalizedMessage = normalize(message);
	return (
		terms.find((term) => {
			const normalizedTerm = normalize(term);
			return (
				normalizedTerm.length > 0 && normalizedMessage.includes(normalizedTerm)
			);
		}) ?? null
	);
}

function extractJsonObject(raw: string): unknown {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match)
		throw new AiAgentRuntimeError(
			"invalid_model_response",
			"AI model returned no JSON object",
		);
	try {
		return JSON.parse(match[0]);
	} catch {
		throw new AiAgentRuntimeError(
			"invalid_model_response",
			"AI model returned invalid JSON",
		);
	}
}

function assertRuntimeContract(env: Env): Ai {
	if (
		env.AI_EMBEDDING_PROVIDER !== undefined &&
		env.AI_EMBEDDING_PROVIDER !== "openai"
	) {
		throw new AiAgentRuntimeError(
			"unsupported_embedding_provider",
			"Configured embedding provider is not supported",
		);
	}
	if (
		env.AI_INFERENCE_PROVIDER !== undefined &&
		env.AI_INFERENCE_PROVIDER !== AI_INFERENCE_PROVIDER
	) {
		throw new AiAgentRuntimeError(
			"unsupported_inference_provider",
			"Configured inference provider is not supported",
		);
	}
	if (
		env.AI_INFERENCE_MODEL !== undefined &&
		env.AI_INFERENCE_MODEL !== AI_INFERENCE_MODEL
	) {
		throw new AiAgentRuntimeError(
			"unsupported_inference_model",
			"Configured inference model is not supported",
		);
	}
	const ai = env.AI as Ai | undefined;
	if (!ai) {
		throw new AiAgentRuntimeError(
			"inference_provider_not_configured",
			"Workers AI binding is not configured",
		);
	}
	return ai;
}

async function activeHandoffPrincipal(
	db: Database,
	agent: AiAgentRow,
): Promise<string | null> {
	if (!agent.handoffPrincipalId) return null;
	const principal = await db.query.organizationPrincipals.findFirst({
		columns: { id: true },
		where: and(
			eq(organizationPrincipals.id, agent.handoffPrincipalId),
			eq(organizationPrincipals.organizationId, agent.organizationId),
			eq(organizationPrincipals.lifecycleStatus, "active"),
		),
	});
	if (!principal) {
		throw new AiAgentRuntimeError(
			"handoff_principal_unavailable",
			"Configured handoff principal is no longer active",
		);
	}
	return principal.id;
}

async function handoffResult(
	db: Database,
	agent: AiAgentRow,
	reason: "guardrail" | "keyword",
): Promise<AiAgentRuntimeResult> {
	return {
		message: agent.guardrails.fallbackMessage,
		confidence: 1,
		handoffRequired: true,
		handoffReason: reason,
		handoffPrincipalId: await activeHandoffPrincipal(db, agent),
		knowledge: [],
	};
}

export async function runAiAgent(
	db: Database,
	env: Env,
	agent: AiAgentRow,
	input: { message: string; conversationContext: AiAgentTurn[] },
	providerMutation?: SingleUnitProviderMutationAggregate,
): Promise<AiAgentRuntimeResult> {
	if (!agent.enabled) {
		throw new AiAgentRuntimeError("agent_disabled", "AI agent is disabled");
	}
	if (
		agent.provider !== AI_INFERENCE_PROVIDER ||
		agent.model !== AI_INFERENCE_MODEL
	) {
		throw new AiAgentRuntimeError(
			"unsupported_agent_model",
			"AI agent contains an unsupported provider/model pair",
		);
	}
	if (firstMatchedTerm(input.message, agent.guardrails.blockedTopics)) {
		return handoffResult(db, agent, "guardrail");
	}
	if (firstMatchedTerm(input.message, agent.handoffStrategy.keywords)) {
		return handoffResult(db, agent, "keyword");
	}

	const knowledge = agent.kbId
		? await searchKnowledgeBase(
				db,
				env,
				{
					organizationId: agent.organizationId,
					scopeKey: agent.scopeKey,
					kbId: agent.kbId,
					query: input.message,
					limit: 5,
				},
				providerMutation,
			)
		: [];
	const knowledgeContext =
		knowledge.length === 0
			? "No knowledge-base excerpts were retrieved."
			: knowledge
					.map(
						(item, index) =>
							`[Knowledge ${index + 1}; similarity ${item.similarity.toFixed(3)}]\n${item.content}`,
					)
					.join("\n\n");
	const systemPrompt = [
		agent.persona?.trim() ||
			"You are a careful social-media customer support assistant.",
		"Use retrieved knowledge when it is relevant. Do not invent facts.",
		"Return only JSON with keys message (string), confidence (0..1), and handoff (boolean).",
		`If unsure, set handoff=true. The handoff confidence threshold is ${agent.handoffStrategy.confidenceThreshold}.`,
		knowledgeContext,
	].join("\n\n");

	const ai = assertRuntimeContract(env);
	let result: unknown;
	try {
		const runInference = () =>
			ai.run(AI_INFERENCE_MODEL, {
				messages: [
					{ role: "system", content: systemPrompt },
					...input.conversationContext,
					{ role: "user", content: input.message },
				],
				temperature: agent.temperature,
				max_completion_tokens: agent.maxTokens,
			});
		result = providerMutation
			? await providerMutation.trackAcknowledged(
					"cloudflare.workers_ai.inference",
					runInference,
				)
			: await runInference();
	} catch {
		throw new AiAgentRuntimeError(
			"inference_provider_failed",
			"Workers AI inference failed",
		);
	}
	const raw = (result as { response?: unknown }).response;
	if (typeof raw !== "string") {
		throw new AiAgentRuntimeError(
			"invalid_model_response",
			"Workers AI returned no text response",
		);
	}
	const parsed = extractJsonObject(raw) as {
		message?: unknown;
		confidence?: unknown;
		handoff?: unknown;
	};
	if (
		typeof parsed.message !== "string" ||
		typeof parsed.confidence !== "number" ||
		!Number.isFinite(parsed.confidence) ||
		parsed.confidence < 0 ||
		parsed.confidence > 1 ||
		typeof parsed.handoff !== "boolean"
	) {
		throw new AiAgentRuntimeError(
			"invalid_model_response",
			"Workers AI returned an invalid structured response",
		);
	}
	const lowConfidence =
		parsed.confidence < agent.handoffStrategy.confidenceThreshold;
	const handoffRequired = parsed.handoff || lowConfidence;
	return {
		message:
			handoffRequired && parsed.message.trim().length === 0
				? agent.guardrails.fallbackMessage
				: parsed.message.trim(),
		confidence: parsed.confidence,
		handoffRequired,
		handoffReason: parsed.handoff
			? "model_request"
			: lowConfidence
				? "low_confidence"
				: null,
		handoffPrincipalId: handoffRequired
			? await activeHandoffPrincipal(db, agent)
			: null,
		knowledge,
	};
}

export function aiRuntimeHttpStatus(error: unknown): 409 | 503 {
	if (error instanceof AiAgentRuntimeError && error.code === "agent_disabled") {
		return 409;
	}
	if (error instanceof AiKnowledgeError && !error.retryable) return 503;
	return 503;
}
