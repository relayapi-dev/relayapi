// Resume a waiting run parked on a plain `message` node whose config has
// `wait_for_reply: true`. Interactive buttons and quick replies are handled by
// `interactive-resume.ts`; this path is only for an ordinary text or attachment
// reply and advances through the message node's canonical `next` port.

import { automationRuns, automations, type Database } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../../schemas/automation-graph";
import type { AttachmentInput } from "./input-resume";
import { runLoop, transitionRunTerminal, updateRunOptimistic } from "./runner";

export type MessageReplyResumeOutcome = "resumed" | "no_match" | "race";

export async function resumeWaitingMessageOnReply(
	db: Database,
	runId: string,
	inboundText: string,
	attachment: AttachmentInput,
	env: Record<string, unknown>,
): Promise<MessageReplyResumeOutcome> {
	const run = await db.query.automationRuns.findFirst({
		where: eq(automationRuns.id, runId),
	});
	if (!run) return "race";
	if (run.status !== "waiting" || run.waitingFor !== "input") return "race";
	if (!run.currentNodeKey) return "race";

	const automation = await db.query.automations.findFirst({
		where: eq(automations.id, run.automationId),
	});
	if (!automation) return "race";

	const graph = (automation.graph ?? {
		schema_version: 1,
		root_node_key: null,
		nodes: [],
		edges: [],
	}) as Graph;
	const node = graph.nodes.find(
		(candidate) => candidate.key === run.currentNodeKey,
	);
	if (node?.kind !== "message" || node.config.wait_for_reply !== true) {
		return "no_match";
	}

	// A message wait requires an actual inbound reply. This also prevents an
	// unmatched/empty provider callback from accidentally taking the default
	// branch. Attachment-only replies are valid user activity.
	const text = inboundText ?? "";
	if (text.trim().length === 0 && !attachment) return "no_match";

	const edge = graph.edges.find(
		(candidate) =>
			candidate.from_node === node.key && candidate.from_port === "next",
	);
	const context = (run.context as Record<string, unknown> | null) ?? {};
	const capturedValue = text.trim().length > 0 ? text : attachment;
	const nextContext: Record<string, unknown> = {
		...context,
		last_input_value: capturedValue,
		last_reply: {
			text: text || null,
			attachment: attachment ?? null,
		},
	};

	if (!edge) {
		const updated = await transitionRunTerminal(
			db,
			runId,
			run.revision,
			run.automationId,
			"completed",
			"completed",
			{
				context: nextContext,
				currentPortKey: "next",
				waitingFor: null,
				waitingUntil: null,
			},
		);
		if (!updated) return "race";
		return "resumed";
	}

	const updated = await updateRunOptimistic(db, runId, run.revision, {
		status: "active",
		waitingFor: null,
		waitingUntil: null,
		currentNodeKey: edge.to_node,
		currentPortKey: edge.to_port,
		context: nextContext,
	});
	if (!updated) return "race";

	await runLoop(db, runId, { db, ...env }, { refreshContactContext: true });
	return "resumed";
}
