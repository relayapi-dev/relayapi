// apps/api/src/services/automations/scheduler.ts
//
// Cron-driven job processor for automation_scheduled_jobs (spec §8.7).
// Supports job_types: resume_run, input_timeout, scheduled_trigger,
// webhook_reception_failure. Uses row-level locking (FOR UPDATE SKIP LOCKED)
// to allow multiple workers to share the queue safely.

import {
	automationRuns,
	automationScheduledJobs,
	createDb,
	type Database,
} from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../../types";
import { runLoop } from "./runner";

type Db = Database;

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_STALE_TIMEOUT_MINUTES = 5;

export type ProcessScheduledJobsOptions = {
	batchSize?: number;
	staleTimeoutMinutes?: number;
};

export type ProcessScheduledJobsResult = {
	processed: number;
	failed: number;
};

/**
 * Main entry: reclaim stale rows, claim a batch of due rows, then dispatch
 * each by `job_type`.
 */
export async function processScheduledJobs(
	db: Db,
	env: Record<string, unknown>,
	opts: ProcessScheduledJobsOptions = {},
): Promise<ProcessScheduledJobsResult> {
	const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
	const staleMin = opts.staleTimeoutMinutes ?? DEFAULT_STALE_TIMEOUT_MINUTES;

	// 1. Reclaim stale 'processing' rows.
	await db.execute(sql`
		UPDATE automation_scheduled_jobs
		   SET status = 'pending',
		       attempts = attempts + 1,
		       claimed_at = NULL
		 WHERE status = 'processing'
		   AND claimed_at < NOW() - make_interval(mins => ${staleMin})
	`);

	// 2. Batch-claim pending rows whose run_at is due.
	//    FOR UPDATE SKIP LOCKED lets multiple workers share the queue.
	const claimed = (await db.execute(sql`
		WITH claimed AS (
			SELECT id
			  FROM automation_scheduled_jobs
			 WHERE status = 'pending'
			   AND run_at <= NOW()
			 ORDER BY run_at ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE automation_scheduled_jobs j
		   SET status = 'processing',
		       claimed_at = NOW()
		  FROM claimed
		 WHERE j.id = claimed.id
		RETURNING j.id, j.run_id, j.job_type, j.automation_id, j.entrypoint_id, j.payload
	`)) as unknown as Array<{
		id: string;
		run_id: string | null;
		job_type: string;
		automation_id: string | null;
		entrypoint_id: string | null;
		payload: unknown;
	}>;

	let processed = 0;
	let failed = 0;

	for (const job of claimed) {
		try {
			const outcome = await dispatchJob(db, env, job);
			if (outcome === "done") {
				processed++;
				await db
					.update(automationScheduledJobs)
					.set({ status: "done" })
					.where(eq(automationScheduledJobs.id, job.id));
			} else {
				failed++;
				await db
					.update(automationScheduledJobs)
					.set({ status: "failed", error: outcome.error })
					.where(eq(automationScheduledJobs.id, job.id));
			}
		} catch (err) {
			failed++;
			await db
				.update(automationScheduledJobs)
				.set({
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
				})
				.where(eq(automationScheduledJobs.id, job.id));
		}
	}

	return { processed, failed };
}

type DispatchOutcome = "done" | { failed: true; error: string };

async function dispatchJob(
	db: Db,
	env: Record<string, unknown>,
	job: {
		id: string;
		run_id: string | null;
		job_type: string;
		automation_id: string | null;
		entrypoint_id: string | null;
		payload: unknown;
	},
): Promise<DispatchOutcome> {
	switch (job.job_type) {
		case "resume_run": {
			if (!job.run_id) return { failed: true, error: "missing run_id" };
			const result = await runLoop(db, job.run_id, env);
			if (result.status === "failed") {
				return {
					failed: true,
					error: `runLoop exit_reason=${result.exit_reason ?? "unknown"}`,
				};
			}
			return "done";
		}

		case "input_timeout": {
			if (!job.run_id) return { failed: true, error: "missing run_id" };
			const run = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, job.run_id),
			});
			if (!run) return "done"; // run gone — nothing to do
			if (run.status !== "waiting" || run.waitingFor !== "input") {
				// Someone else already moved the run forward — no-op.
				return "done";
			}
			if (run.waitingUntil && run.waitingUntil > new Date()) {
				// Wait window extended — not our turn.
				return "done";
			}
			// Try to advance via the `timeout` port from the current node.
			const auto = await db.query.automations.findFirst({
				where: (t, { eq }) => eq(t.id, run.automationId),
			});
			const graph = (auto?.graph ?? { edges: [] }) as {
				edges?: Array<{
					from_node: string;
					from_port: string;
					to_node: string;
					to_port: string;
				}>;
			};
			const edges = graph.edges ?? [];
			const timeoutEdge = run.currentNodeKey
				? edges.find(
						(e) =>
							e.from_node === run.currentNodeKey && e.from_port === "timeout",
					)
				: undefined;
			if (timeoutEdge) {
				await db
					.update(automationRuns)
					.set({
						status: "active",
						currentNodeKey: timeoutEdge.to_node,
						currentPortKey: timeoutEdge.to_port,
						waitingFor: null,
						waitingUntil: null,
						updatedAt: new Date(),
					})
					.where(eq(automationRuns.id, run.id));
				await runLoop(db, run.id, env);
			} else {
				await db
					.update(automationRuns)
					.set({
						status: "exited",
						exitReason: "input_timeout",
						completedAt: new Date(),
						waitingFor: null,
						waitingUntil: null,
						updatedAt: new Date(),
					})
					.where(eq(automationRuns.id, run.id));
			}
			return "done";
		}

		case "scheduled_trigger": {
			// v1: if the entrypoint config carries a static contact list, enroll
			// them. Dynamic contact enumeration (segment-based scheduled runs) is
			// deferred. Without an entrypoint_id we can't act.
			if (!job.entrypoint_id) return "done";
			// TODO: expand this once the scheduled-trigger UI lands. For now we
			// treat the job as a no-op and let the entrypoint's config carry its
			// own enrollment metadata in a future handler.
			return "done";
		}

		case "webhook_reception_failure": {
			// Audit-only record; mark done so it doesn't retry.
			return "done";
		}

		default:
			return { failed: true, error: `unknown job_type: ${job.job_type}` };
	}
}

// ---------------------------------------------------------------------------
// Cron entry points — called by scheduled/index.ts every minute
// ---------------------------------------------------------------------------

/**
 * Legacy entry-point name kept for scheduled/index.ts. Wraps processScheduledJobs.
 */
export async function processAutomationSchedule(env: Env): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const { processed } = await processScheduledJobs(
		db,
		env as unknown as Record<string, unknown>,
	);
	return processed;
}

/**
 * Input-timeout sweeps now flow through automation_scheduled_jobs with
 * job_type='input_timeout', enqueued by the runner when a wait_input node
 * sets a timeout_at. This function is preserved as a no-op for cron wiring
 * compatibility; callers should migrate to processScheduledJobs directly.
 */
export async function processAutomationInputTimeouts(
	_env: Env,
): Promise<number> {
	// Handled inside processScheduledJobs via job_type=input_timeout.
	return 0;
}
