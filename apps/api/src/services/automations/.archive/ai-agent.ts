import type { NodeHandler } from "../types";
import {
	buildAutomationAiContext,
	requireAutomationAi,
	resolveAgentRecord,
	retrieveKnowledgeContext,
	runAutomationAiJson,
} from "./ai-runtime";
import { sendAutomationText } from "./send-text";

interface AgentDecision {
	outcome?: unknown;
	reply?: unknown;
	reason?: unknown;
	confidence?: unknown;
}

function parseHandoffStrategy(value: unknown): {
	keywords: string[];
	confidenceThreshold?: number;
} {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { keywords: [] };
	}
	const record = value as Record<string, unknown>;
	return {
		keywords: Array.isArray(record.keywords)
			? record.keywords.filter(
					(keyword): keyword is string =>
						typeof keyword === "string" && keyword.trim().length > 0,
				)
			: [],
		confidenceThreshold:
			typeof record.confidenceThreshold === "number"
				? record.confidenceThreshold
				: undefined,
	};
}

function outcomeLabel(
	outcome: "complete" | "handoff",
	configuredLabels: unknown,
): "complete" | "handoff" {
	if (!Array.isArray(configuredLabels)) return outcome;
	return configuredLabels.includes(outcome) ? outcome : outcome;
}

export const aiAgentHandler: NodeHandler = async (ctx) => {
	const ai = requireAutomationAi(ctx);
	if (!ai) {
		return { kind: "fail", error: "Workers AI binding is not configured" };
	}

	const agentId = ctx.node.config.agent_id as string | undefined;
	if (!agentId) {
		return { kind: "fail", error: "ai_agent missing 'agent_id'" };
	}

	const agent = await resolveAgentRecord(ctx, agentId);
	if (!agent) {
		return { kind: "fail", error: "ai_agent references an unknown agent" };
	}

	const maxTurns =
		typeof ctx.node.config.max_turns === "number"
			? ctx.node.config.max_turns
			: 5;
	const turnKey = `_ai_agent_turns_${ctx.node.key}`;
	const currentTurns =
		typeof ctx.enrollment.state[turnKey] === "number"
			? (ctx.enrollment.state[turnKey] as number)
			: 0;
	if (currentTurns >= maxTurns) {
		return {
			kind: "next",
			label: outcomeLabel("handoff", ctx.node.config.handoff_labels),
			state_patch: {
				[turnKey]: currentTurns,
				last_ai_agent_outcome: "handoff",
				last_ai_agent_reason: "max_turns_exceeded",
			},
		};
	}

	const aiContext = await buildAutomationAiContext(ctx);
	const latestInput = aiContext.latestInput;
	const handoffStrategy = parseHandoffStrategy(agent.handoffStrategy);

	if (
		latestInput &&
		handoffStrategy.keywords.some((keyword) =>
			latestInput.toLowerCase().includes(keyword.toLowerCase()),
		)
	) {
		return {
			kind: "next",
			label: outcomeLabel("handoff", ctx.node.config.handoff_labels),
			state_patch: {
				[turnKey]: currentTurns + 1,
				last_ai_agent_outcome: "handoff",
				last_ai_agent_reason: "keyword_handoff",
			},
		};
	}

	const knowledge = await retrieveKnowledgeContext(
		ctx,
		agent.kbId,
		latestInput || aiContext.transcript || agent.name,
	);
	const decision = await runAutomationAiJson<AgentDecision>(ai, agent.model, [
		{
			role: "system",
			content: [
				"You are an automation AI agent.",
				agent.persona ? `Persona:\n${agent.persona}` : "",
				agent.guardrails ? `Guardrails:\n${agent.guardrails}` : "",
				"Decide whether to reply directly or hand off to a human.",
				'Return JSON only: {"outcome":"complete"|"handoff","reply":"...","reason":"...","confidence":0.0}',
			]
				.filter(Boolean)
				.join("\n\n"),
		},
		{
			role: "user",
			content: [
				latestInput
					? `Latest contact message:\n${latestInput}`
					: "Latest contact message: (empty)",
				aiContext.transcript
					? `Recent conversation transcript:\n${aiContext.transcript}`
					: "Recent conversation transcript: (empty)",
				knowledge.length > 0
					? `Relevant knowledge:\n${knowledge
							.map((chunk, index) => `${index + 1}. ${chunk.content}`)
							.join("\n\n")}`
					: "Relevant knowledge: (none)",
			].join("\n\n"),
		},
	]);

	const confidence =
		typeof decision?.confidence === "number"
			? Math.max(0, Math.min(1, decision.confidence))
			: undefined;
	const decisionOutcome =
		decision?.outcome === "handoff" ? "handoff" : "complete";
	const shouldHandoff =
		decisionOutcome === "handoff" ||
		(handoffStrategy.confidenceThreshold !== undefined &&
			(confidence ?? 1) < handoffStrategy.confidenceThreshold);

	if (shouldHandoff) {
		return {
			kind: "next",
			label: outcomeLabel("handoff", ctx.node.config.handoff_labels),
			state_patch: {
				[turnKey]: currentTurns + 1,
				last_ai_agent_outcome: "handoff",
				last_ai_agent_confidence: confidence,
				last_ai_agent_reason:
					typeof decision?.reason === "string"
						? decision.reason
						: "ai_requested_handoff",
			},
		};
	}

	const reply =
		typeof decision?.reply === "string" ? decision.reply.trim() : "";
	if (!reply) {
		return {
			kind: "next",
			label: outcomeLabel("handoff", ctx.node.config.handoff_labels),
			state_patch: {
				[turnKey]: currentTurns + 1,
				last_ai_agent_outcome: "handoff",
				last_ai_agent_reason: "empty_ai_reply",
			},
		};
	}

	const sendResult = await sendAutomationText(ctx, {
		text: reply,
		resolve_merge_tags: false,
	});
	if (!sendResult.ok) {
		return { kind: "fail", error: sendResult.error };
	}

	return {
		kind: "next",
		label: "complete",
		state_patch: {
			[turnKey]: currentTurns + 1,
			last_ai_agent_id: agentId,
			last_ai_agent_outcome: "complete",
			last_ai_agent_confidence: confidence,
			last_ai_agent_reason:
				typeof decision?.reason === "string" ? decision.reason : null,
			last_ai_agent_reply: reply,
			last_message_id: sendResult.messageId,
			last_recipient_id: sendResult.recipientId,
		},
	};
};
