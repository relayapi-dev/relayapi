import type { NodeHandler } from "../types";
import {
	applyAutomationPromptTemplate,
	buildAutomationAiContext,
	requireAutomationAi,
	runAutomationAiText,
} from "./ai-runtime";

export const aiStepHandler: NodeHandler = async (ctx) => {
	const ai = requireAutomationAi(ctx);
	if (!ai) {
		return { kind: "fail", error: "Workers AI binding is not configured" };
	}

	const systemPrompt = ctx.node.config.system_prompt as string | undefined;
	if (!systemPrompt) {
		return { kind: "fail", error: "ai_step missing 'system_prompt'" };
	}

	const aiContext = await buildAutomationAiContext(ctx);
	const renderedSystemPrompt = applyAutomationPromptTemplate(systemPrompt, {
		contact: aiContext.contact,
		state: ctx.enrollment.state,
	});
	const response = await runAutomationAiText(ai, ctx.node.config.model, [
		{ role: "system", content: renderedSystemPrompt },
		{
			role: "user",
			content: [
				"Current automation state:",
				JSON.stringify(ctx.enrollment.state ?? {}, null, 2),
				aiContext.latestInput
					? `Latest contact input:\n${aiContext.latestInput}`
					: "Latest contact input: (empty)",
				aiContext.transcript
					? `Recent conversation transcript:\n${aiContext.transcript}`
					: "Recent conversation transcript: (empty)",
				"Respond with the best possible completion as plain text.",
			].join("\n\n"),
		},
	]);

	const saveToField = ctx.node.config.save_to_field as string | undefined;
	return {
		kind: "next",
		state_patch: {
			last_ai_output: response,
			last_ai_model: String(ctx.node.config.model ?? ""),
			...(saveToField ? { [saveToField]: response } : {}),
		},
	};
};
