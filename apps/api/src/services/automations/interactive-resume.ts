// apps/api/src/services/automations/interactive-resume.ts
//
// Resume a waiting run when an inbound interactive payload arrives — button
// taps (Meta postback / WhatsApp button_reply), quick-reply taps, list
// selections, and Telegram callback_query data. Runs parked on a `message`
// node expose `button.<id>` / `quick_reply.<id>` output ports (see
// `./ports.ts`); when the inbound `interactive_payload` matches one of these
// port keys, we advance the run through that port instead of feeding the
// inbound to the regular text-input resume path.
//
// Why a separate file from `input-resume.ts`: `resumeWaitingRunOnInput` is
// scoped to `node.kind === "input"` and short-circuits otherwise. Interactive
// waits live on `message` nodes (the runner parks them via the `wait_input`
// result when the node has any branch buttons or quick replies). Mixing the
// two would require a mutual-exclusion check in both helpers; splitting keeps
// each path readable.

import { automationRuns, automations, type Database } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Graph } from "../../schemas/automation-graph";
import { runLoop } from "./runner";

/**
 * Outcome of attempting to resume a waiting run on an interactive payload:
 *   - "resumed"  — the payload matched a `button.<id>` / `quick_reply.<id>`
 *                  port and the run advanced (or completed when the port has
 *                  no outgoing edge).
 *   - "no_match" — the run is parked on a valid message node, but no port
 *                  matched the payload. Caller should fall through to the
 *                  text-input resume path.
 *   - "race"     — the run was no longer eligible (wrong status, wrong node
 *                  kind, concurrent worker). Caller should skip this run.
 */
export type InteractiveResumeOutcome = "resumed" | "no_match" | "race";

/**
 * Resume a single waiting run on an inbound interactive payload.
 *
 * Matching rules (mirroring `./ports.ts`):
 *   - `button.<payload>` — branch buttons attached to text / card / gallery
 *     blocks. The `payload` is the button's `id` field.
 *   - `quick_reply.<payload>` — quick-reply chips. The `payload` is the
 *     quick reply's `id` field.
 *
 * Meta postbacks use the `payload` string the operator set when creating the
 * button; WhatsApp `interactive.button_reply.id` is the button id; Telegram
 * `callback_query.data` is operator-assigned. In all three cases the value
 * delivered here is what maps directly to `{button,quick_reply}.<payload>`.
 */
export async function resumeWaitingRunOnInteractive(
	db: Database,
	runId: string,
	interactivePayload: string,
	env: Record<string, unknown>,
): Promise<InteractiveResumeOutcome> {
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

	const node = graph.nodes.find((n) => n.key === run.currentNodeKey);
	// Interactive resume is message-only. Input nodes handle their own wait
	// via the text-input resume path. Anything else (delay, condition, ...)
	// shouldn't be waiting-for-input in the first place.
	if (!node || node.kind !== "message") return "no_match";

	const buttonPortKey = `button.${interactivePayload}`;
	const quickReplyPortKey = `quick_reply.${interactivePayload}`;
	const port = (node.ports ?? []).find(
		(p) => p.key === buttonPortKey || p.key === quickReplyPortKey,
	);
	if (!port) return "no_match";

	const edge = graph.edges.find(
		(e) => e.from_node === node.key && e.from_port === port.key,
	);

	// Stamp the captured interaction on context so merge-tags / conditions can
	// read which port fired. Mirrors the input-resume path's `last_input_value`
	// convention.
	const ctx = ((run.context as Record<string, unknown>) ?? {}) as Record<
		string,
		unknown
	>;
	const updatedContext: Record<string, unknown> = {
		...ctx,
		last_input_value: interactivePayload,
		last_interactive_port: port.key,
	};

	if (!edge) {
		// Operator wired a button but no outgoing edge — mirror runLoop's
		// graceful completion for unrouted ports.
		await db
			.update(automationRuns)
			.set({
				status: "completed",
				exitReason: "completed",
				completedAt: new Date(),
				context: updatedContext,
				currentPortKey: port.key,
				waitingFor: null,
				waitingUntil: null,
				updatedAt: new Date(),
			})
			.where(eq(automationRuns.id, runId));
		return "resumed";
	}

	await db
		.update(automationRuns)
		.set({
			status: "active",
			waitingFor: null,
			waitingUntil: null,
			currentNodeKey: edge.to_node,
			currentPortKey: edge.to_port,
			context: updatedContext,
			updatedAt: new Date(),
		})
		.where(eq(automationRuns.id, runId));

	// Mirror enrollContact / resumeWaitingRunOnInput: ensure handlers can reach
	// the live `db` binding via env even when the caller didn't populate it.
	await runLoop(db, runId, { db, ...env });
	return "resumed";
}
