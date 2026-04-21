import type { NodeHandler } from "../types";
import {
	buildAutomationAiContext,
	requireAutomationAi,
	runAutomationAiJson,
} from "./ai-runtime";

interface IntentResult {
	label?: unknown;
	confidence?: unknown;
	reason?: unknown;
}

export const aiIntentRouterHandler: NodeHandler = async (ctx) => {
	const ai = requireAutomationAi(ctx);
	if (!ai) {
		return { kind: "fail", error: "Workers AI binding is not configured" };
	}

	const intents = Array.isArray(ctx.node.config.intents)
		? ctx.node.config.intents.filter(
				(intent): intent is { label: string; description: string } =>
					!!intent &&
					typeof intent === "object" &&
					typeof (intent as { label?: unknown }).label === "string" &&
					typeof (intent as { description?: unknown }).description === "string",
			)
		: [];
	if (intents.length < 2) {
		return {
			kind: "fail",
			error: "ai_intent_router needs at least two intents",
		};
	}

	const aiContext = await buildAutomationAiContext(ctx);
	const firstIntent = intents[0]?.label ?? "intent_1";
	const response = await runAutomationAiJson<IntentResult>(
		ai,
		ctx.node.config.model,
		[
			{
				role: "system",
				content:
					"You route automation traffic. Choose exactly one configured intent label and respond with JSON only.",
			},
			{
				role: "user",
				content: [
					"Available intents:",
					...intents.map(
						(intent) => `- ${intent.label}: ${intent.description}`,
					),
					aiContext.latestInput
						? `Latest contact message:\n${aiContext.latestInput}`
						: "Latest contact message: (empty)",
					aiContext.transcript
						? `Recent conversation transcript:\n${aiContext.transcript}`
						: "",
					'Return JSON with keys: {"label":"...", "confidence":0.0, "reason":"..."}',
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		],
	);

	const selectedLabel =
		typeof response?.label === "string" &&
		intents.some((intent) => intent.label === response.label)
			? response.label
			: firstIntent;
	const confidence =
		typeof response?.confidence === "number"
			? Math.max(0, Math.min(1, response.confidence))
			: undefined;

	return {
		kind: "next",
		label: selectedLabel,
		state_patch: {
			last_intent: selectedLabel,
			last_intent_confidence: confidence,
			last_intent_reason:
				typeof response?.reason === "string" ? response.reason : undefined,
		},
	};
};
