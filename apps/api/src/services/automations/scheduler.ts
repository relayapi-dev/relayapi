// apps/api/src/services/automations/scheduler.ts
//
// Cron-driven job processor for automation_scheduled_jobs (spec §8.7).
// Supports job_types: resume_run, input_timeout, scheduled_trigger,
// webhook_reception_failure. Uses row-level locking (FOR UPDATE SKIP LOCKED)
// to allow multiple workers to share the queue safely.

import {
	automationEntrypoints,
	automationRuns,
	automationScheduledJobs,
	automations as automationsTable,
	contactSegmentMemberships,
	contacts,
	createDb,
	type Database,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Env } from "../../types";
import { matchAndEnrollOrBinding } from "./binding-router";
import { runLoop } from "./runner";
import type { InboundEvent } from "./trigger-matcher";

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
			if (!job.entrypoint_id) {
				return { failed: true, error: "missing entrypoint_id" };
			}
			return await dispatchScheduledTrigger(db, env, job.entrypoint_id);
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

// ---------------------------------------------------------------------------
// scheduled_trigger dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatches a `scheduled_trigger` job:
 *   1. Load the entrypoint and verify it's an active `schedule` entrypoint.
 *   2. Compute and enqueue the NEXT occurrence *before* running enrollment
 *      (spec §B4 fix). Keeping this step on the failure path kept the schedule
 *      alive even if the enrollment phase throws (DB hiccup, etc.) — previously
 *      a single transient failure would silently kill the entire schedule.
 *      Idempotency: we check for an existing pending `scheduled_trigger` job
 *      with the same `entrypoint_id` and `run_at` (within a one-second clock-
 *      drift window) before inserting, so re-running the same job twice
 *      (e.g. after a stale-claim reclaim) doesn't double-queue.
 *   3. Enumerate contacts that match the entrypoint's `filters` (tag or
 *      segment predicates in v1). A filter IS REQUIRED — unfiltered schedule
 *      entrypoints would enroll the entire org, which is never what the
 *      operator wants.
 *   4. For each matching contact, call `matchAndEnrollOrBinding` with a
 *      synthetic `schedule` event. The matcher handles reentry / pause
 *      semantics per-contact. Individual failures are logged but never block
 *      the remaining contacts.
 *   5. If enrollment throws, mark the current job failed but the next-run
 *      job stays queued, so the schedule survives.
 */
async function dispatchScheduledTrigger(
	db: Db,
	env: Record<string, unknown>,
	entrypointId: string,
): Promise<DispatchOutcome> {
	const ep = await db.query.automationEntrypoints.findFirst({
		where: eq(automationEntrypoints.id, entrypointId),
	});
	if (!ep) {
		// Entrypoint deleted — job has nothing to do, succeed silently.
		return "done";
	}
	if (ep.kind !== "schedule" || ep.status !== "active") {
		return "done";
	}
	const auto = await db.query.automations.findFirst({
		where: eq(automationsTable.id, ep.automationId),
	});
	if (!auto || auto.status !== "active") {
		return "done";
	}

	// 1. Compute and enqueue the next firing BEFORE any other work. This keeps
	//    the schedule alive across transient enrollment failures.
	const cfg = (ep.config ?? {}) as { cron?: string; timezone?: string };
	const nextRun = cfg.cron ? computeNextCronRun(cfg.cron, new Date()) : null;
	if (!nextRun) {
		return { failed: true, error: "unsupported cron pattern" };
	}
	await insertNextScheduledJobIfNotExists(db, auto.id, ep.id, nextRun);

	// 2. Require a filter — enrolling an entire org is never intended.
	const filters = (ep.filters ?? null) as Record<string, unknown> | null;
	let candidateIds: string[] | null;
	try {
		candidateIds = await enumerateContactsForScheduleFilter(
			db,
			auto.organizationId,
			filters,
		);
	} catch (err) {
		return {
			failed: true,
			error: `schedule filter enumeration failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (candidateIds === null) {
		return {
			failed: true,
			error: "schedule entrypoint requires filters",
		};
	}

	// 3. Fire enroll-or-binding for each candidate. Individual contact failures
	//    never block the remaining contacts; a catastrophic error (thrown out
	//    of the loop itself) is caught here so the next-run job we already
	//    queued above survives.
	try {
		for (const contactId of candidateIds) {
			const event: InboundEvent = {
				kind: "schedule" as never,
				channel: auto.channel as InboundEvent["channel"],
				organizationId: auto.organizationId,
				socialAccountId: ep.socialAccountId ?? null,
				contactId,
				conversationId: null,
				payload: {
					source: "schedule",
					entrypoint_id: ep.id,
					scheduled_at: new Date().toISOString(),
				},
			};
			try {
				await matchAndEnrollOrBinding(db, event, env);
			} catch (err) {
				console.error(
					`[scheduler] scheduled_trigger enroll failed for contact ${contactId}:`,
					err,
				);
			}
		}
	} catch (err) {
		// The enrollment loop itself blew up (rare — usually the inner catch
		// absorbs per-contact errors). Mark THIS job failed, but the next-run
		// row inserted above remains pending so the schedule continues.
		return {
			failed: true,
			error: `scheduled_trigger enrollment loop failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return "done";
}

/**
 * Idempotently inserts the next `scheduled_trigger` job for an entrypoint.
 * Skips the insert if a pending row already exists for the same entrypoint
 * within a 1-second window of `runAt` — handles the case where the same
 * scheduled_trigger job gets processed twice (e.g. after a stale-claim
 * reclaim) without double-queueing successors.
 */
async function insertNextScheduledJobIfNotExists(
	db: Db,
	automationId: string,
	entrypointId: string,
	runAt: Date,
): Promise<void> {
	const windowStartIso = new Date(runAt.getTime() - 1000).toISOString();
	const windowEndIso = new Date(runAt.getTime() + 1000).toISOString();
	// Use ISO strings so the postgres driver binds them as timestamptz — direct
	// Date binding via drizzle's sql tag is unreliable across driver versions.
	const existing = (await db.execute(sql`
		SELECT id
		  FROM automation_scheduled_jobs
		 WHERE entrypoint_id = ${entrypointId}
		   AND job_type = 'scheduled_trigger'
		   AND status = 'pending'
		   AND run_at >= ${windowStartIso}::timestamptz
		   AND run_at <= ${windowEndIso}::timestamptz
		 LIMIT 1
	`)) as unknown as Array<{ id: string }>;
	if (existing.length > 0) return;
	await db.insert(automationScheduledJobs).values({
		jobType: "scheduled_trigger",
		automationId,
		entrypointId,
		runAt,
		status: "pending",
	});
}

/**
 * Returns the set of contact IDs matching the schedule entrypoint's filter
 * block. Supported predicates in v1:
 *   - `{ all: [{ field: "tags", op: "contains", value: "<tag>" }] }`
 *   - `{ all: [{ field: "segment_ids", op: "contains", value: "<id>" }] }`
 *   - `{ any: [ … ] }` — union of the above
 *
 * Returns `null` if the filters block is missing or contains no actionable
 * predicate (signals "required filter not satisfied" upstream).
 */
async function enumerateContactsForScheduleFilter(
	db: Db,
	organizationId: string,
	filters: Record<string, unknown> | null,
): Promise<string[] | null> {
	if (!filters) return null;

	const groups: Array<unknown> = [];
	if (Array.isArray((filters as { all?: unknown[] }).all)) {
		for (const p of (filters as { all: unknown[] }).all) groups.push(p);
	}
	if (Array.isArray((filters as { any?: unknown[] }).any)) {
		for (const p of (filters as { any: unknown[] }).any) groups.push(p);
	}
	if (groups.length === 0) return null;

	const ids = new Set<string>();
	let matchedAnyPredicate = false;
	for (const raw of groups) {
		const predicate = raw as {
			field?: string;
			op?: string;
			value?: unknown;
		};
		if (!predicate || typeof predicate !== "object") continue;

		// Tag filter.
		if (
			(predicate.field === "tags" || predicate.field === "tag") &&
			typeof predicate.value === "string"
		) {
			matchedAnyPredicate = true;
			const rows = await db
				.select({ id: contacts.id })
				.from(contacts)
				.where(
					and(
						eq(contacts.organizationId, organizationId),
						sql`${contacts.tags} @> ARRAY[${predicate.value}]::text[]`,
					),
				);
			for (const r of rows) ids.add(r.id);
			continue;
		}

		// Segment filter.
		if (
			(predicate.field === "segment_ids" ||
				predicate.field === "segment" ||
				predicate.field === "segments") &&
			(typeof predicate.value === "string" ||
				Array.isArray(predicate.value))
		) {
			matchedAnyPredicate = true;
			const segmentIds = Array.isArray(predicate.value)
				? (predicate.value as string[])
				: [predicate.value as string];
			if (segmentIds.length === 0) continue;
			const rows = await db
				.select({ id: contactSegmentMemberships.contactId })
				.from(contactSegmentMemberships)
				.where(
					and(
						eq(contactSegmentMemberships.organizationId, organizationId),
						inArray(contactSegmentMemberships.segmentId, segmentIds),
					),
				);
			for (const r of rows) ids.add(r.id);
			continue;
		}
	}

	if (!matchedAnyPredicate) return null;
	return Array.from(ids);
}

/**
 * Minimal cron parser. Supports the subset required by the schedule
 * entrypoint (documented in spec §8.7):
 *   - `M H * * *`   daily at H:M UTC
 *   - `0 H * * *`   daily at the top of hour H UTC
 *   - `0 * * * *`   hourly
 *   - `*\u002FN * * * *`  every N minutes (1–59)
 *
 * Returns the next Date strictly greater than `from`, or `null` for any
 * unsupported pattern.
 */
export function computeNextCronRun(cron: string, from: Date): Date | null {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [mStr, hStr, dom, mon, dow] = parts;
	if (dom !== "*" || mon !== "*" || dow !== "*") return null;

	const next = new Date(from.getTime());
	next.setUTCSeconds(0, 0);

	// `*/N * * * *` — every N minutes.
	if (hStr === "*" && /^\*\/\d+$/.test(mStr!)) {
		const n = Number(mStr!.slice(2));
		if (!Number.isFinite(n) || n < 1 || n > 59) return null;
		const minutes = next.getUTCMinutes();
		const rem = minutes % n;
		const add = rem === 0 ? n : n - rem;
		next.setUTCMinutes(minutes + add);
		return next;
	}

	// `0 * * * *` — hourly.
	if (hStr === "*" && mStr === "0") {
		next.setUTCMinutes(0);
		next.setUTCHours(next.getUTCHours() + 1);
		return next;
	}

	// `M H * * *` — daily at H:M UTC.
	const minute = Number(mStr);
	const hour = Number(hStr);
	if (
		Number.isInteger(minute) &&
		minute >= 0 &&
		minute <= 59 &&
		Number.isInteger(hour) &&
		hour >= 0 &&
		hour <= 23
	) {
		next.setUTCHours(hour, minute, 0, 0);
		if (next.getTime() <= from.getTime()) {
			next.setUTCDate(next.getUTCDate() + 1);
		}
		return next;
	}

	return null;
}
