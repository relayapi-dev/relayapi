import { automationRuns, automations, type Database } from "@relayapi/db";
import { and, asc, eq } from "drizzle-orm";
import type { Graph } from "../../schemas/automation-graph";
import { runLoop, updateRunOptimistic } from "./runner";
import type { InboundEvent } from "./trigger-matcher";

export function waitingRunMatchesEventScope(
	automationChannel: string,
	triggeringSocialAccountId: unknown,
	event: Pick<InboundEvent, "channel" | "socialAccountId">,
): boolean {
	if (automationChannel !== event.channel) return false;
	return !(
		event.socialAccountId &&
		typeof triggeringSocialAccountId === "string" &&
		triggeringSocialAccountId !== event.socialAccountId
	);
}

/** Resume the oldest compatible run parked on a wait_event node. */
export async function resumeWaitingRunOnEvent(
	db: Database,
	event: InboundEvent,
	env: Record<string, unknown>,
): Promise<boolean> {
	const rows = await db
		.select({
			run: automationRuns,
			graph: automations.graph,
			channel: automations.channel,
		})
		.from(automationRuns)
		.innerJoin(automations, eq(automations.id, automationRuns.automationId))
		.where(
			and(
				eq(automationRuns.organizationId, event.organizationId),
				eq(automationRuns.contactId, event.contactId),
				eq(automationRuns.status, "waiting"),
				eq(automationRuns.waitingFor, "inbound_event"),
			),
		)
		.orderBy(asc(automationRuns.startedAt));

	for (const row of rows) {
		const context = (row.run.context as Record<string, unknown>) ?? {};
		const triggeringAccount = context._triggering_social_account_id;
		if (!waitingRunMatchesEventScope(row.channel, triggeringAccount, event))
			continue;
		const graph = row.graph as Graph;
		const node = graph.nodes.find(
			(candidate) => candidate.key === row.run.currentNodeKey,
		);
		if (node?.kind !== "wait_event") continue;
		const config = node.config as { event_kinds?: unknown };
		const eventKinds = Array.isArray(context._wait_event_kinds)
			? context._wait_event_kinds.filter(
					(value): value is string => typeof value === "string",
				)
			: Array.isArray(config.event_kinds)
				? config.event_kinds.filter(
						(value): value is string => typeof value === "string",
					)
				: [];
		if (!eventKinds.includes(event.kind)) continue;

		const receivedEdge = graph.edges.find(
			(edge) => edge.from_node === node.key && edge.from_port === "received",
		);
		const nextContext: Record<string, unknown> = {
			...context,
			last_event: event,
			triggerEvent: event,
		};
		delete nextContext._wait_event_kinds;
		const updated = await updateRunOptimistic(
			db,
			row.run.id,
			row.run.revision,
			{
				status: "active",
				currentNodeKey: receivedEdge?.to_node ?? null,
				currentPortKey: receivedEdge?.to_port ?? null,
				waitingFor: null,
				waitingUntil: null,
				context: nextContext,
			},
		);
		if (!updated) continue;
		await runLoop(
			db,
			row.run.id,
			{
				...env,
				socialAccountId: event.socialAccountId ?? undefined,
			},
			{ refreshContactContext: true },
		);
		return true;
	}
	return false;
}
