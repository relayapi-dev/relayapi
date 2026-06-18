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
import { incrementCounter, runLoop, updateRunOptimistic } from "./runner";
import type { InboundEvent } from "./trigger-matcher";

type Db = Database;

// Claim fewer jobs per tick so a single heavy job (a resume_run that walks a
// deep graph, or a scheduled_trigger enrollment slice) is less likely to blow
// the cron CPU/wall budget and leave the rest of the batch stuck in
// 'processing' until the stale reclaim. scheduled_trigger now self-paginates
// (SCHEDULE_ENROLL_BATCH) so a single schedule no longer consumes the tick.
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_TIMEOUT_MINUTES = 5;
// After this many stale-reclaim cycles a job is marked 'failed' rather than
// re-queued, so a job that repeatedly kills its worker can't retry forever.
const MAX_JOB_ATTEMPTS = 5;

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

	// 1. Reclaim stale 'processing' rows. Cap retries: a job that consistently
	//    kills its worker before the failed-mark (CPU/wall limit, OOM) would
	//    otherwise be re-dispatched forever, re-executing side effects each time.
	//    Once attempts reach the cap, mark it 'failed' instead of re-queuing.
	await db.execute(sql`
		UPDATE automation_scheduled_jobs
		   SET status = CASE
		                  WHEN attempts + 1 >= ${MAX_JOB_ATTEMPTS} THEN 'failed'
		                  ELSE 'pending'
		                END,
		       attempts = attempts + 1,
		       claimed_at = NULL,
		       error = CASE
		                  WHEN attempts + 1 >= ${MAX_JOB_ATTEMPTS}
		                    THEN 'max attempts exceeded after stale reclaim'
		                  ELSE error
		                END
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
			// A delay node parks the run with waitingFor='delay' and leaves
			// currentNodeKey pointing at the delay node itself. If we call runLoop
			// directly it would re-dispatch the delay handler, which recomputes a
			// fresh resume_at and re-parks the run forever. So advance the run
			// through the delay node's outgoing edge BEFORE re-entering runLoop —
			// mirroring the input_timeout path. Guard on updatedAt so a concurrent
			// worker doesn't double-advance.
			const delayRun = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, job.run_id),
			});
			if (!delayRun) return "done"; // run gone — nothing to do
			if (
				delayRun.status === "waiting" &&
				delayRun.waitingFor === "delay" &&
				(!delayRun.waitingUntil || delayRun.waitingUntil <= new Date())
			) {
				const auto = await db.query.automations.findFirst({
					where: (t, { eq: eqOp }) => eqOp(t.id, delayRun.automationId),
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
				const nextEdge = delayRun.currentNodeKey
					? edges.find(
							(e) =>
								e.from_node === delayRun.currentNodeKey &&
								e.from_port === "next",
						)
					: undefined;
				const advanced = await updateRunOptimistic(
					db,
					delayRun.id,
					delayRun.updatedAt,
					nextEdge
						? {
								status: "active",
								currentNodeKey: nextEdge.to_node,
								currentPortKey: nextEdge.to_port,
								waitingFor: null,
								waitingUntil: null,
							}
						: {
								// Delay node has no outgoing edge — graceful completion,
								// matching runLoop's no-outgoing-edge behavior.
								status: "completed",
								exitReason: "completed",
								completedAt: new Date(),
								waitingFor: null,
								waitingUntil: null,
							},
				);
				if (!advanced) {
					// Another worker advanced this run first — no-op.
					return "done";
				}
				if (!nextEdge) {
					// Completed via the no-outgoing-edge path — mirror runLoop and
					// bump the completion counter (it would otherwise undercount).
					await incrementCounter(db, delayRun.automationId, "total_completed");
					return "done"; // completed, no further work
				}
			}
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
			// Bind the job to the node that armed it. A run can answer one input,
			// advance to a SECOND wait (another input with no timeout, or a buttons
			// message), and this stale job's deadline can then elapse. Only act when
			// the run is still parked on the same node that scheduled this timeout.
			const timeoutPayload = (job.payload ?? {}) as Record<string, unknown>;
			const scheduledNodeKey =
				typeof timeoutPayload._timeout_node_key === "string"
					? timeoutPayload._timeout_node_key
					: null;
			if (scheduledNodeKey && run.currentNodeKey !== scheduledNodeKey) {
				// The run has advanced past the node that armed this timeout — stale
				// job, no-op.
				return "done";
			}
			// Try to advance via the timeout port from the current node. Message
			// nodes expose this port as `no_response`; input nodes as `timeout`
			// (see ports.ts). Accept either so operator-wired no-response branches
			// off a message node actually fire instead of the run being killed.
			const auto = await db.query.automations.findFirst({
				where: (t, { eq: eqOp }) => eqOp(t.id, run.automationId),
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
							e.from_node === run.currentNodeKey &&
							(e.from_port === "timeout" || e.from_port === "no_response"),
					)
				: undefined;
			if (timeoutEdge) {
				const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
					status: "active",
					currentNodeKey: timeoutEdge.to_node,
					currentPortKey: timeoutEdge.to_port,
					waitingFor: null,
					waitingUntil: null,
				});
				// A concurrent reply (input/interactive resume) won the race and
				// advanced the run already — don't re-enter runLoop on a snapshot we
				// no longer own.
				if (!ok) return "done";
				await runLoop(db, run.id, env);
			} else {
				const ok = await updateRunOptimistic(db, run.id, run.updatedAt, {
					status: "exited",
					exitReason: "input_timeout",
					completedAt: new Date(),
					waitingFor: null,
					waitingUntil: null,
				});
				if (ok) {
					await incrementCounter(db, run.automationId, "total_exited");
				}
			}
			return "done";
		}

		case "scheduled_trigger": {
			if (!job.entrypoint_id) {
				return { failed: true, error: "missing entrypoint_id" };
			}
			return await dispatchScheduledTrigger(
				db,
				env,
				job.entrypoint_id,
				job.payload,
			);
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
// Max contacts enrolled per scheduled_trigger tick. A schedule with a large
// segment can match thousands of contacts; enrolling all of them serially
// (each running runLoop) inside one cron tick can blow the CPU/wall budget and
// starve every other org's jobs. We process this many per tick and re-enqueue a
// continuation job (due immediately) carrying the cursor offset for the rest.
const SCHEDULE_ENROLL_BATCH = 200;

async function dispatchScheduledTrigger(
	db: Db,
	env: Record<string, unknown>,
	entrypointId: string,
	jobPayload: unknown,
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

	// A continuation tick carries a cursor offset in its payload. Such ticks must
	// NOT re-enqueue the next cron occurrence (the originating tick already did),
	// otherwise each continuation would double-arm the schedule.
	const payload = (jobPayload ?? {}) as Record<string, unknown>;
	const cursorOffset =
		typeof payload._cursor_offset === "number" && payload._cursor_offset > 0
			? payload._cursor_offset
			: 0;
	const isContinuation = cursorOffset > 0;

	// 1. Compute and enqueue the next firing BEFORE any other work. This keeps
	//    the schedule alive across transient enrollment failures. Skip on
	//    continuation ticks.
	if (!isContinuation) {
		const cfg = (ep.config ?? {}) as { cron?: string; timezone?: string };
		const nextRun = cfg.cron
			? computeNextCronRun(cfg.cron, new Date(), cfg.timezone)
			: null;
		if (!nextRun) {
			return { failed: true, error: "unsupported cron pattern" };
		}
		await insertNextScheduledJobIfNotExists(db, ep.id, nextRun, auto.id);
	}

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

	// Stable order so the cursor offset paginates deterministically across
	// continuation ticks (enumeration returns an unordered Set).
	candidateIds.sort();
	const batch = candidateIds.slice(
		cursorOffset,
		cursorOffset + SCHEDULE_ENROLL_BATCH,
	);

	// 3. Fire enroll-or-binding for each candidate in this batch. Individual
	//    contact failures never block the rest; a catastrophic error (thrown out
	//    of the loop itself) is caught here so the next-run job survives.
	try {
		for (const contactId of batch) {
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

	// More candidates remain — re-enqueue a continuation job (due now) for the
	// next slice so this tick stays bounded.
	const nextOffset = cursorOffset + batch.length;
	if (nextOffset < candidateIds.length && batch.length > 0) {
		await db.insert(automationScheduledJobs).values({
			jobType: "scheduled_trigger",
			automationId: auto.id,
			entrypointId: ep.id,
			runAt: new Date(),
			status: "pending",
			payload: { _cursor_offset: nextOffset },
		});
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
	entrypointId: string,
	runAt: Date,
	automationId: string,
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
		}
	}

	if (!matchedAnyPredicate) return null;
	return Array.from(ids);
}

/**
 * Minimal cron parser. Supports the subset required by the schedule
 * entrypoint (documented in spec §8.7):
 *   - `M H * * *`   daily at H:M in the target timezone
 *   - `0 H * * *`   daily at the top of hour H in the target timezone
 *   - `0 * * * *`   hourly
 *   - `*\u002FN * * * *`  every N minutes (1–59)
 *
 * Returns the next Date strictly greater than `from`, or `null` for any
 * unsupported pattern. If `timezone` is undefined or `"UTC"`, all math
 * happens in UTC (original behavior preserved). Otherwise we interpret
 * the cron in the IANA zone and convert back to a UTC Date for storage.
 */
export function computeNextCronRun(
	cron: string,
	from: Date,
	timezone?: string,
): Date | null {
	const tz = timezone && timezone.length > 0 ? timezone : "UTC";
	if (tz === "UTC") {
		return computeNextCronRunInZone(cron, from, "UTC");
	}
	// Validate the zone — `Intl.DateTimeFormat` throws `RangeError` on an
	// unknown IANA id. Catching here keeps the error surface consistent
	// with other unsupported-cron returns (null rather than throw).
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
	} catch {
		return null;
	}
	return computeNextCronRunInZone(cron, from, tz);
}

// ---------------------------------------------------------------------------
// Timezone-aware cron math helpers
// ---------------------------------------------------------------------------

/**
 * Returns the offset, in minutes, that `tz` is AHEAD of UTC at the given
 * UTC instant. Example: America/New_York during EDT returns -240
 * (UTC-4h); Europe/London during BST returns +60.
 *
 * Implemented via `Intl.DateTimeFormat` — no external dep. We read the
 * wall-clock Y/M/D/H/m/s in the zone, reconstruct a "naive" UTC Date
 * from those components, and compare to the instant itself.
 */
function zoneOffsetMinutes(instant: Date, tz: string): number {
	if (tz === "UTC") return 0;
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(instant);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	let hour = get("hour");
	// Intl can emit "24" for midnight under some locales; normalize to 0.
	if (hour === 24) hour = 0;
	const asIfUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		hour,
		get("minute"),
		get("second"),
	);
	return Math.round((asIfUtc - instant.getTime()) / 60000);
}

/**
 * Compute the next cron firing given `from` (a UTC instant) and a target
 * `tz`. The trick: we read the wall-clock time as observed in `tz` at
 * `from`, compute the next cron boundary in that zoned wall-clock space,
 * then convert the resulting wall-clock time back to UTC for storage.
 *
 * DST-correct: when the resulting wall-clock lands in a gap or overlap,
 * we use the zone's offset at the resulting instant rather than the
 * offset at `from`, so the stored UTC Date matches the zone's actual
 * clock at that moment.
 */
function computeNextCronRunInZone(
	cron: string,
	from: Date,
	tz: string,
): Date | null {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return null;
	const [mStr, hStr, dom, mon, dow] = parts;
	if (mStr === undefined || hStr === undefined) return null;
	if (dom !== "*" || mon !== "*" || dow !== "*") return null;

	// Seed with the zone-local wall-clock components of `from`, zero
	// seconds/milliseconds for cleanliness.
	const fromZoned = utcToZonedComponents(from, tz);

	// `*/N * * * *` — every N minutes. Timezone-independent (the minute
	// hand ticks the same in every zone), but we still round to the
	// next boundary using the wall-clock minute to preserve intuition
	// when the operator expects firings at ":00 / :15 / :30 / :45".
	if (hStr === "*" && /^\*\/\d+$/.test(mStr)) {
		const n = Number(mStr.slice(2));
		if (!Number.isFinite(n) || n < 1 || n > 59) return null;
		const minutes = fromZoned.minute;
		const rem = minutes % n;
		const add = rem === 0 ? n : n - rem;
		const next = { ...fromZoned, minute: minutes + add, second: 0 };
		return zonedComponentsToUtc(next, tz);
	}

	// `0 * * * *` — hourly at the top of the hour.
	if (hStr === "*" && mStr === "0") {
		const next = {
			...fromZoned,
			hour: fromZoned.hour + 1,
			minute: 0,
			second: 0,
		};
		return zonedComponentsToUtc(next, tz);
	}

	// `M H * * *` — daily at H:M in the target timezone.
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
		const candidate = {
			...fromZoned,
			hour,
			minute,
			second: 0,
		};
		let result = zonedComponentsToUtc(candidate, tz);
		if (result.getTime() <= from.getTime()) {
			// Advance one day in zone-local space. Adding 24h in UTC and
			// re-reading the zoned components handles DST transitions
			// cleanly (the resulting zoned H:M is the same as the target).
			const advanced = utcToZonedComponents(
				new Date(result.getTime() + 24 * 60 * 60 * 1000),
				tz,
			);
			result = zonedComponentsToUtc(
				{ ...advanced, hour, minute, second: 0 },
				tz,
			);
		}
		return result;
	}

	return null;
}

type ZonedComponents = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

function utcToZonedComponents(instant: Date, tz: string): ZonedComponents {
	if (tz === "UTC") {
		return {
			year: instant.getUTCFullYear(),
			month: instant.getUTCMonth() + 1,
			day: instant.getUTCDate(),
			hour: instant.getUTCHours(),
			minute: instant.getUTCMinutes(),
			second: instant.getUTCSeconds(),
		};
	}
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = fmt.formatToParts(instant);
	const get = (type: string) =>
		Number(parts.find((p) => p.type === type)?.value ?? "0");
	let hour = get("hour");
	if (hour === 24) hour = 0;
	return {
		year: get("year"),
		month: get("month"),
		day: get("day"),
		hour,
		minute: get("minute"),
		second: get("second"),
	};
}

/**
 * Convert zone-local wall-clock components to a UTC Date. Uses a two-pass
 * offset resolution to handle DST transitions: the offset at the target
 * wall-clock instant may differ from the offset at the seed guess, so we
 * re-check and correct after the first conversion.
 */
function zonedComponentsToUtc(c: ZonedComponents, tz: string): Date {
	if (tz === "UTC") {
		return new Date(
			Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second),
		);
	}
	// First pass: treat components as if they were UTC, then correct by
	// the offset we observe at that "naive" instant.
	const naiveUtcMs = Date.UTC(
		c.year,
		c.month - 1,
		c.day,
		c.hour,
		c.minute,
		c.second,
	);
	const firstGuess = new Date(naiveUtcMs);
	const off1 = zoneOffsetMinutes(firstGuess, tz);
	const correctedMs = naiveUtcMs - off1 * 60000;
	// Second pass: in a DST transition the offset at the CORRECTED
	// instant might differ from the offset at the first guess. One more
	// correction converges everywhere outside the degenerate "gap" hour
	// (where the wall-clock doesn't exist — we accept whichever side the
	// second pass lands on).
	const corrected = new Date(correctedMs);
	const off2 = zoneOffsetMinutes(corrected, tz);
	if (off2 === off1) return corrected;
	return new Date(naiveUtcMs - off2 * 60000);
}

// ---------------------------------------------------------------------------
// Schedule-arming helpers (used by create / update / activate handlers)
// ---------------------------------------------------------------------------

/**
 * Ensures a `scheduled_trigger` job is queued for a single schedule
 * entrypoint. Called from the entrypoint create / update / activate
 * paths so cron schedules self-arm — without this, newly activated
 * schedules would sit idle until the first cron tick that happened to
 * inherit a pending row from the previous deployment.
 *
 * Returns a diagnostic tuple so callers (routes) can surface the reason
 * to operators when arming is skipped.
 */
export async function armScheduleEntrypoint(
	db: Db,
	entrypointId: string,
): Promise<{ queued: boolean; runAt?: Date; reason?: string }> {
	const ep = await db.query.automationEntrypoints.findFirst({
		where: eq(automationEntrypoints.id, entrypointId),
	});
	if (!ep) return { queued: false, reason: "entrypoint_not_found" };
	if (ep.kind !== "schedule") return { queued: false, reason: "not_schedule" };
	if (ep.status !== "active") {
		return { queued: false, reason: "entrypoint_not_active" };
	}

	const automation = await db.query.automations.findFirst({
		where: eq(automationsTable.id, ep.automationId),
	});
	if (!automation || automation.status !== "active") {
		return { queued: false, reason: "automation_not_active" };
	}

	const cfg = (ep.config ?? {}) as { cron?: string; timezone?: string };
	if (!cfg.cron) return { queued: false, reason: "no_cron" };

	const nextRun = computeNextCronRun(cfg.cron, new Date(), cfg.timezone);
	if (!nextRun) return { queued: false, reason: "invalid_cron" };

	await insertNextScheduledJobIfNotExists(db, entrypointId, nextRun, ep.automationId);
	return { queued: true, runAt: nextRun };
}

/**
 * Arms every active schedule entrypoint belonging to an automation.
 * Used by the activate / resume handlers so a transition of the
 * automation itself from paused/draft → active seeds pending jobs for
 * its existing schedule entrypoints.
 */
export async function armAllScheduleEntrypointsForAutomation(
	db: Db,
	automationId: string,
): Promise<{ armed: number }> {
	const eps = await db.query.automationEntrypoints.findMany({
		where: and(
			eq(automationEntrypoints.automationId, automationId),
			eq(automationEntrypoints.kind, "schedule"),
			eq(automationEntrypoints.status, "active"),
		),
	});
	let armed = 0;
	for (const ep of eps) {
		const result = await armScheduleEntrypoint(db, ep.id);
		if (result.queued) armed++;
	}
	return { armed };
}
