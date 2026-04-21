// apps/api/src/services/automations/runner.ts
//
// Execution loop for the Manychat-parity automation engine.
// See docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
// §8.3 for the step-by-step semantics this file implements.
//
// Per-iteration behavior:
//   1. pause check (automation_contact_controls)
//   2. re-read graph from automations.graph
//   3. locate current node (graph_changed exit if missing)
//   4. dispatch handler
//   5. write automation_step_runs row
//   6. apply HandlerResult (advance / wait_input / wait_delay / end / fail)
// plus: optimistic updated_at concurrency, 200-visit infinite-loop cap.

import {
	automationContactControls,
	automationRuns,
	automationScheduledJobs,
	automationStepRuns,
	automations,
	createDb,
	type Database,
} from "@relayapi/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Graph, GraphEdge, GraphNode } from "../../schemas/automation-graph";
import { getHandler } from "./manifest";
import type { HandlerResult, RunContext, RunStatus } from "./types";

const MAX_VISITS_PER_LOOP = 200;

export type Db = Database;

export type RunLoopOptions = {
	/**
	 * Override the infinite-loop guard (default 200). Tests use a lower value
	 * to exercise the cap without making 200+ DB round-trips.
	 */
	maxVisits?: number;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runLoop(
	db: Db,
	runId: string,
	env: Record<string, any>,
	options: RunLoopOptions = {},
): Promise<{ status: RunStatus; exit_reason: string | null }> {
	const maxVisits = options.maxVisits ?? MAX_VISITS_PER_LOOP;
	let visits = 0;

	while (visits < maxVisits) {
		visits += 1;

		const run = await db.query.automationRuns.findFirst({
			where: eq(automationRuns.id, runId),
		});
		if (!run) {
			return { status: "failed", exit_reason: "run_not_found" };
		}
		if (
			run.status === "completed" ||
			run.status === "exited" ||
			run.status === "failed"
		) {
			return { status: run.status as RunStatus, exit_reason: run.exitReason };
		}

		// 1. Pause check — (contact, automation) or global (contact, NULL).
		const paused = await findActivePause(
			db,
			run.organizationId,
			run.contactId,
			run.automationId,
		);
		if (paused) {
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				status: "waiting",
				waitingFor: "external_event",
				waitingUntil: null,
			});
			if (!ok) return { status: "waiting", exit_reason: null };
			return { status: "waiting", exit_reason: null };
		}

		// 2. Load graph fresh on every iteration so edits take effect immediately.
		const auto = await db.query.automations.findFirst({
			where: eq(automations.id, run.automationId),
		});
		if (!auto) {
			await exitRun(
				db,
				run.id,
				run.updatedAt,
				"exited",
				"automation_deleted",
			);
			return { status: "exited", exit_reason: "automation_deleted" };
		}
		const graph = (auto.graph ?? {
			schema_version: 1,
			root_node_key: null,
			nodes: [],
			edges: [],
		}) as Graph;

		// 3. Locate current node.
		const currentKey = run.currentNodeKey;
		if (!currentKey) {
			await exitRun(db, run.id, run.updatedAt, "completed", "completed");
			await incrementCounter(db, run.automationId, "total_completed");
			return { status: "completed", exit_reason: "completed" };
		}
		const node = graph.nodes.find((n) => n.key === currentKey);
		if (!node) {
			await writeStepRun(db, {
				runId: run.id,
				automationId: run.automationId,
				nodeKey: currentKey,
				nodeKind: "unknown",
				enteredViaPortKey: run.currentPortKey,
				exitedViaPortKey: null,
				outcome: "graph_changed",
				durationMs: 0,
				payload: { reason: "current_node_missing" },
				error: null,
			});
			await exitRun(db, run.id, run.updatedAt, "exited", "graph_changed");
			return { status: "exited", exit_reason: "graph_changed" };
		}

		// 4. Dispatch handler.
		const handler = getHandler(node.kind);
		const ctx: RunContext = {
			runId: run.id,
			automationId: run.automationId,
			organizationId: run.organizationId,
			contactId: run.contactId,
			conversationId: run.conversationId,
			channel: auto.channel,
			graph,
			context: (run.context as Record<string, any>) ?? {},
			now: new Date(),
			env,
		};
		const startedAt = Date.now();
		let result: HandlerResult;
		if (!handler) {
			result = {
				result: "fail",
				error: new Error(`no handler registered for kind "${node.kind}"`),
			};
		} else {
			try {
				result = await handler.handle(
					{ key: node.key, kind: node.kind, config: node.config },
					ctx,
				);
			} catch (err) {
				result = {
					result: "fail",
					error: err instanceof Error ? err : new Error(String(err)),
				};
			}
		}
		const durationMs = Date.now() - startedAt;

		// 5. Write step_run row.
		const stepOutcome = stepOutcomeFromResult(result);
		const exitedPort =
			result.result === "advance" ? result.via_port : null;
		await writeStepRun(db, {
			runId: run.id,
			automationId: run.automationId,
			nodeKey: node.key,
			nodeKind: node.kind,
			enteredViaPortKey: run.currentPortKey,
			exitedViaPortKey: exitedPort,
			outcome: stepOutcome,
			durationMs,
			payload:
				result.result === "fail" ? null : (result.payload ?? null),
			error:
				result.result === "fail"
					? { message: result.error.message, stack: result.error.stack }
					: null,
		});

		// 6. Handle result.
		if (result.result === "end") {
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				status: "completed",
				exitReason: result.exit_reason,
				completedAt: new Date(),
				context: ctx.context,
			});
			if (ok) await incrementCounter(db, run.automationId, "total_completed");
			return { status: "completed", exit_reason: result.exit_reason };
		}

		if (result.result === "fail") {
			// Try the `error` output port if there's an edge from it.
			const errorEdge = graph.edges.find(
				(e) => e.from_node === node.key && e.from_port === "error",
			);
			if (errorEdge) {
				const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
					currentNodeKey: errorEdge.to_node,
					currentPortKey: errorEdge.to_port,
					context: ctx.context,
				});
				if (!ok) return { status: "active", exit_reason: null };
				continue;
			}
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				status: "failed",
				exitReason: "handler_failure",
				completedAt: new Date(),
				context: ctx.context,
			});
			if (ok) await incrementCounter(db, run.automationId, "total_failed");
			return { status: "failed", exit_reason: "handler_failure" };
		}

		if (result.result === "wait_input") {
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				status: "waiting",
				waitingFor: "input",
				waitingUntil: result.timeout_at ?? null,
				context: ctx.context,
			});
			if (ok && result.timeout_at) {
				await db.insert(automationScheduledJobs).values({
					runId: run.id,
					jobType: "input_timeout",
					automationId: run.automationId,
					runAt: result.timeout_at,
					payload: result.payload ?? null,
				});
			}
			return { status: "waiting", exit_reason: null };
		}

		if (result.result === "wait_delay") {
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				status: "waiting",
				waitingFor: "delay",
				waitingUntil: result.resume_at,
				context: ctx.context,
			});
			if (ok) {
				await db.insert(automationScheduledJobs).values({
					runId: run.id,
					jobType: "resume_run",
					automationId: run.automationId,
					runAt: result.resume_at,
					payload: result.payload ?? null,
				});
			}
			return { status: "waiting", exit_reason: null };
		}

		// result.result === "advance"
		// Special _goto signal: jump straight to target_node_key, no edge lookup.
		if (result.via_port === "_goto") {
			const target = (result.payload as { target_node_key?: string } | null)
				?.target_node_key;
			if (!target) {
				await exitRun(db, run.id, run.updatedAt, "failed", "goto_missing_target");
				await incrementCounter(db, run.automationId, "total_failed");
				return { status: "failed", exit_reason: "goto_missing_target" };
			}
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				currentNodeKey: target,
				currentPortKey: null,
				context: ctx.context,
			});
			if (!ok) return { status: "active", exit_reason: null };
			continue;
		}

		const edge = findOutgoingEdge(graph, node.key, result.via_port);
		if (!edge) {
			// No outgoing edge → treat as graceful completion (operator choice).
			const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
				status: "completed",
				exitReason: "completed",
				completedAt: new Date(),
				context: ctx.context,
			});
			if (ok) await incrementCounter(db, run.automationId, "total_completed");
			return { status: "completed", exit_reason: "completed" };
		}

		const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
			currentNodeKey: edge.to_node,
			currentPortKey: edge.to_port,
			context: ctx.context,
		});
		if (!ok) return { status: "active", exit_reason: null };
		// loop
	}

	// Infinite-loop cap.
	const runAtCap = await db.query.automationRuns.findFirst({
		where: eq(automationRuns.id, runId),
	});
	if (runAtCap) {
		const ok = await updateRunOptimistic(db, runId, runAtCap.updatedAt, {
			status: "failed",
			exitReason: "infinite_loop_cap",
			completedAt: new Date(),
		});
		if (ok) await incrementCounter(db, runAtCap.automationId, "total_failed");
	}
	return { status: "failed", exit_reason: "infinite_loop_cap" };
}

export async function enrollContact(
	db: Db,
	args: {
		automationId: string;
		organizationId: string;
		contactId: string;
		conversationId: string | null;
		channel: string;
		entrypointId: string | null;
		bindingId: string | null;
		contextOverrides?: Record<string, any>;
		env: Record<string, any>;
		runLoopOptions?: RunLoopOptions;
	},
): Promise<{ runId: string }> {
	const auto = await db.query.automations.findFirst({
		where: eq(automations.id, args.automationId),
	});
	if (!auto) throw new Error(`automation ${args.automationId} not found`);
	const graph = (auto.graph ?? {
		schema_version: 1,
		root_node_key: null,
		nodes: [],
		edges: [],
	}) as Graph;
	const rootKey = graph.root_node_key;

	const [inserted] = await db
		.insert(automationRuns)
		.values({
			automationId: args.automationId,
			organizationId: args.organizationId,
			entrypointId: args.entrypointId,
			bindingId: args.bindingId,
			contactId: args.contactId,
			conversationId: args.conversationId,
			status: "active",
			currentNodeKey: rootKey,
			currentPortKey: null,
			context: args.contextOverrides ?? {},
		})
		.returning();

	if (!inserted) throw new Error("failed to create automation run");

	await db
		.update(automations)
		.set({ totalEnrolled: sql`${automations.totalEnrolled} + 1` })
		.where(eq(automations.id, args.automationId));

	await runLoop(db, inserted.id, args.env, args.runLoopOptions);
	return { runId: inserted.id };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findActivePause(
	db: Db,
	organizationId: string,
	contactId: string,
	automationId: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: automationContactControls.id })
		.from(automationContactControls)
		.where(
			and(
				eq(automationContactControls.organizationId, organizationId),
				eq(automationContactControls.contactId, contactId),
				or(
					eq(automationContactControls.automationId, automationId),
					isNull(automationContactControls.automationId),
				),
				or(
					isNull(automationContactControls.pausedUntil),
					sql`${automationContactControls.pausedUntil} > NOW()`,
				),
			),
		)
		.limit(1);
	return rows.length > 0;
}

function findOutgoingEdge(
	graph: Graph,
	fromNode: string,
	fromPort: string,
): GraphEdge | null {
	return (
		graph.edges.find(
			(e) => e.from_node === fromNode && e.from_port === fromPort,
		) ?? null
	);
}

function stepOutcomeFromResult(result: HandlerResult): string {
	switch (result.result) {
		case "advance":
			return "ok";
		case "wait_input":
			return "wait_input";
		case "wait_delay":
			return "wait_delay";
		case "end":
			return "end";
		case "fail":
			return "failed";
	}
}

type RunUpdate = Partial<{
	status: RunStatus;
	currentNodeKey: string | null;
	currentPortKey: string | null;
	context: Record<string, any>;
	waitingFor: string | null;
	waitingUntil: Date | null;
	exitReason: string | null;
	completedAt: Date | null;
}>;

/**
 * Applies a run update guarded by the prior updated_at value. Returns true iff
 * the update hit a row (i.e. this worker still owned the run). A false return
 * means another worker took over; callers should exit the loop gracefully.
 */
async function updateRunOptimistic(
	db: Db,
	runId: string,
	priorUpdatedAt: Date,
	patch: RunUpdate,
): Promise<boolean> {
	const setPayload: Record<string, any> = { updatedAt: new Date() };
	if (patch.status !== undefined) setPayload.status = patch.status;
	if (patch.currentNodeKey !== undefined)
		setPayload.currentNodeKey = patch.currentNodeKey;
	if (patch.currentPortKey !== undefined)
		setPayload.currentPortKey = patch.currentPortKey;
	if (patch.context !== undefined) setPayload.context = patch.context;
	if (patch.waitingFor !== undefined)
		setPayload.waitingFor = patch.waitingFor;
	if (patch.waitingUntil !== undefined)
		setPayload.waitingUntil = patch.waitingUntil;
	if (patch.exitReason !== undefined) setPayload.exitReason = patch.exitReason;
	if (patch.completedAt !== undefined)
		setPayload.completedAt = patch.completedAt;

	// Compare at millisecond precision. Postgres stores timestamps with
	// microsecond resolution, but JS Dates only carry milliseconds; a naive
	// `eq(updatedAt, priorUpdatedAt)` filter would never match because the
	// serialized bound parameter loses the sub-ms digits.
	const rows = await db
		.update(automationRuns)
		.set(setPayload)
		.where(
			and(
				eq(automationRuns.id, runId),
				sql`date_trunc('milliseconds', ${automationRuns.updatedAt}) = date_trunc('milliseconds', ${priorUpdatedAt.toISOString()}::timestamptz)`,
			),
		)
		.returning({ id: automationRuns.id });
	return rows.length > 0;
}

async function exitRun(
	db: Db,
	runId: string,
	priorUpdatedAt: Date,
	status: Extract<RunStatus, "completed" | "exited" | "failed">,
	exitReason: string,
): Promise<void> {
	await updateRunOptimistic(db, runId, priorUpdatedAt, {
		status,
		exitReason,
		completedAt: new Date(),
	});
}

async function incrementCounter(
	db: Db,
	automationId: string,
	column: "total_completed" | "total_failed" | "total_exited",
): Promise<void> {
	const colExpr =
		column === "total_completed"
			? sql`${automations.totalCompleted} + 1`
			: column === "total_failed"
				? sql`${automations.totalFailed} + 1`
				: sql`${automations.totalExited} + 1`;
	const set =
		column === "total_completed"
			? { totalCompleted: colExpr }
			: column === "total_failed"
				? { totalFailed: colExpr }
				: { totalExited: colExpr };
	await db
		.update(automations)
		.set(set as never)
		.where(eq(automations.id, automationId));
}

async function writeStepRun(
	db: Db,
	row: {
		runId: string;
		automationId: string;
		nodeKey: string;
		nodeKind: string;
		enteredViaPortKey: string | null;
		exitedViaPortKey: string | null;
		outcome: string;
		durationMs: number;
		payload: unknown;
		error: unknown;
	},
): Promise<void> {
	await db.insert(automationStepRuns).values({
		runId: row.runId,
		automationId: row.automationId,
		nodeKey: row.nodeKey,
		nodeKind: row.nodeKind,
		enteredViaPortKey: row.enteredViaPortKey,
		exitedViaPortKey: row.exitedViaPortKey,
		outcome: row.outcome,
		durationMs: row.durationMs,
		payload: row.payload ?? null,
		error: row.error ?? null,
		executedAt: new Date(),
	});
}
