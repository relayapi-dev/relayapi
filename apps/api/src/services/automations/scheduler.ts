// apps/api/src/services/automations/scheduler.ts
//
// Cron-driven job processor for automation_scheduled_jobs (spec §8.7).
// Supports job_types: resume_run, input_timeout, event_timeout, scheduled_trigger,
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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env } from "../../types";
import { matchAndEnrollOrBinding } from "./binding-router";
import { runLoop, transitionRunTerminal, updateRunOptimistic } from "./runner";
import {
	isValidAutomationTimezone,
	parseAutomationCron,
} from "./schedule-expression";
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

export function automationScheduleOccurrenceBase(
	entrypointId: string,
	scheduledFor: Date,
): string {
	return `schedule:${entrypointId}:${scheduledFor.toISOString()}`;
}

export function automationScheduleOccurrenceId(
	entrypointId: string,
	scheduledFor: Date,
	cursorOffset = 0,
): string {
	return `${automationScheduleOccurrenceBase(entrypointId, scheduledFor)}:page:${cursorOffset}`;
}

export function automationScheduleContactOccurrenceId(
	rootOccurrenceId: string,
	contactId: string,
): string {
	return `${rootOccurrenceId}:contact:${contactId}`;
}

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

	// 1. Reclaim expired leases. Jobs that crossed their effect boundary become
	//    explicit unknown outcomes and are never replayed automatically. Jobs that
	//    died before that boundary remain safe to retry under the same occurrence.
	await db.execute(sql`
		UPDATE automation_scheduled_jobs
		   SET status = CASE
		                  WHEN effect_started_at IS NOT NULL THEN 'unknown'
		                  WHEN attempts >= ${MAX_JOB_ATTEMPTS} THEN 'failed'
		                  ELSE 'pending'
		                END,
		       claimed_at = NULL,
		       lease_expires_at = NULL,
		       error = CASE
		                  WHEN effect_started_at IS NOT NULL
		                    THEN 'lease expired after scheduled effect processing began'
		                  WHEN attempts >= ${MAX_JOB_ATTEMPTS}
		                    THEN 'max attempts exceeded'
		                  ELSE error
		                END
		 WHERE status = 'processing'
		   AND COALESCE(lease_expires_at, claimed_at + make_interval(mins => ${staleMin})) < NOW()
	`);

	// 2. Batch-claim pending rows whose run_at is due.
	//    FOR UPDATE SKIP LOCKED lets multiple workers share the queue.
	const claimedRows = (await db.execute(sql`
		WITH claimed AS (
			SELECT id
			  FROM automation_scheduled_jobs
			 WHERE status = 'pending'
			   AND run_at <= NOW()
			   AND attempts < ${MAX_JOB_ATTEMPTS}
			 ORDER BY run_at ASC
			 LIMIT ${batchSize}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE automation_scheduled_jobs j
		   SET status = 'processing',
		       claimed_at = NOW(),
		       lease_expires_at = NOW() + make_interval(mins => ${staleMin}),
		       lease_token = lease_token + 1,
		       attempts = attempts + 1,
		       effect_started_at = NULL,
		       error = NULL
		  FROM claimed
		 WHERE j.id = claimed.id
		RETURNING j.id, j.run_id, j.job_type, j.automation_id, j.entrypoint_id,
		          j.run_at, j.occurrence_id, j.lease_token, j.attempts, j.payload
	`)) as unknown as Array<{
		id: string;
		run_id: string | null;
		job_type: string;
		automation_id: string | null;
		entrypoint_id: string | null;
		run_at: Date | string;
		occurrence_id: string;
		lease_token: number;
		attempts: number;
		payload: unknown;
	}>;
	const claimed = claimedRows.map((job) => ({
		...job,
		run_at: job.run_at instanceof Date ? job.run_at : new Date(job.run_at),
	}));

	let processed = 0;
	let failed = 0;

	for (const job of claimed) {
		let effectStarted = false;
		const markEffectStarted = async (): Promise<void> => {
			if (effectStarted) return;
			const [armed] = await db
				.update(automationScheduledJobs)
				.set({ effectStartedAt: sql`CURRENT_TIMESTAMP` })
				.where(
					and(
						eq(automationScheduledJobs.id, job.id),
						eq(automationScheduledJobs.status, "processing"),
						eq(automationScheduledJobs.leaseToken, job.lease_token),
					),
				)
				.returning({ id: automationScheduledJobs.id });
			if (!armed) throw new Error("Scheduled job lease lost");
			effectStarted = true;
		};
		try {
			const outcome = await dispatchJob(db, env, job, markEffectStarted);
			if (outcome === "done") {
				const [completed] = await db
					.update(automationScheduledJobs)
					.set({ status: "done", leaseExpiresAt: null })
					.where(
						and(
							eq(automationScheduledJobs.id, job.id),
							eq(automationScheduledJobs.status, "processing"),
							eq(automationScheduledJobs.leaseToken, job.lease_token),
						),
					)
					.returning({ id: automationScheduledJobs.id });
				if (completed) processed++;
			} else {
				const [terminal] = await db
					.update(automationScheduledJobs)
					.set({ status: "failed", error: outcome.error, leaseExpiresAt: null })
					.where(
						and(
							eq(automationScheduledJobs.id, job.id),
							eq(automationScheduledJobs.status, "processing"),
							eq(automationScheduledJobs.leaseToken, job.lease_token),
						),
					)
					.returning({ id: automationScheduledJobs.id });
				if (terminal) failed++;
			}
		} catch (err) {
			const terminal = job.attempts >= MAX_JOB_ATTEMPTS;
			const unknown = effectStarted;
			const [updated] = await db
				.update(automationScheduledJobs)
				.set({
					status: unknown ? "unknown" : terminal ? "failed" : "pending",
					runAt:
						unknown || terminal
							? job.run_at
							: new Date(
									Date.now() +
										Math.min(30 * 60_000, 30_000 * 2 ** job.attempts),
								),
					claimedAt: null,
					leaseExpiresAt: null,
					effectStartedAt: unknown ? sql`CURRENT_TIMESTAMP` : null,
					error: err instanceof Error ? err.message : String(err),
				})
				.where(
					and(
						eq(automationScheduledJobs.id, job.id),
						eq(automationScheduledJobs.status, "processing"),
						eq(automationScheduledJobs.leaseToken, job.lease_token),
					),
				)
				.returning({ id: automationScheduledJobs.id });
			if (updated && (unknown || terminal)) failed++;
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
		run_at: Date;
		occurrence_id: string;
		lease_token: number;
		attempts: number;
		payload: unknown;
	},
	markEffectStarted: () => Promise<void>,
): Promise<DispatchOutcome> {
	switch (job.job_type) {
		case "resume_run": {
			if (!job.run_id) return { failed: true, error: "missing run_id" };
			await markEffectStarted();
			// A delay node parks the run with waitingFor='delay' and leaves
			// currentNodeKey pointing at the delay node itself. If we call runLoop
			// directly it would re-dispatch the delay handler, which recomputes a
			// fresh resume_at and re-parks the run forever. So advance the run
			// through the delay node's outgoing edge BEFORE re-entering runLoop —
			// mirroring the input_timeout path. Guard on revision so a concurrent
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
				const advanced = nextEdge
					? await updateRunOptimistic(db, delayRun.id, delayRun.revision, {
							status: "active",
							currentNodeKey: nextEdge.to_node,
							currentPortKey: nextEdge.to_port,
							waitingFor: null,
							waitingUntil: null,
						})
					: await transitionRunTerminal(
							db,
							delayRun.id,
							delayRun.revision,
							delayRun.automationId,
							"completed",
							"completed",
							{ waitingFor: null, waitingUntil: null },
						);
				if (!advanced) {
					// Another worker advanced this run first — no-op.
					return "done";
				}
				if (!nextEdge) {
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
			await markEffectStarted();
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
				const ok = await updateRunOptimistic(db, run.id, run.revision, {
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
				await transitionRunTerminal(
					db,
					run.id,
					run.revision,
					run.automationId,
					"exited",
					"input_timeout",
					{ waitingFor: null, waitingUntil: null },
				);
			}
			return "done";
		}

		case "event_timeout": {
			if (!job.run_id) return { failed: true, error: "missing run_id" };
			await markEffectStarted();
			const run = await db.query.automationRuns.findFirst({
				where: eq(automationRuns.id, job.run_id),
			});
			if (!run) return "done";
			if (run.status !== "waiting" || run.waitingFor !== "inbound_event") {
				return "done";
			}
			if (run.waitingUntil && run.waitingUntil > new Date()) return "done";

			const timeoutPayload = (job.payload ?? {}) as Record<string, unknown>;
			const scheduledNodeKey =
				typeof timeoutPayload._timeout_node_key === "string"
					? timeoutPayload._timeout_node_key
					: null;
			if (scheduledNodeKey && run.currentNodeKey !== scheduledNodeKey) {
				return "done";
			}

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
			const timeoutEdge = (graph.edges ?? []).find(
				(edge) =>
					edge.from_node === run.currentNodeKey && edge.from_port === "timeout",
			);
			if (timeoutEdge) {
				const ok = await updateRunOptimistic(db, run.id, run.revision, {
					status: "active",
					currentNodeKey: timeoutEdge.to_node,
					currentPortKey: timeoutEdge.to_port,
					waitingFor: null,
					waitingUntil: null,
				});
				if (!ok) return "done";
				await runLoop(db, run.id, env);
			} else {
				await transitionRunTerminal(
					db,
					run.id,
					run.revision,
					run.automationId,
					"exited",
					"event_timeout",
					{ waitingFor: null, waitingUntil: null },
				);
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
				job.occurrence_id,
				job.run_at,
				job.payload,
				markEffectStarted,
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
	occurrenceId: string,
	scheduledFor: Date,
	jobPayload: unknown,
	markEffectStarted: () => Promise<void>,
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
	if (auto?.status !== "active") {
		return "done";
	}

	// A continuation tick carries a cursor offset in its payload. Such ticks must
	// NOT re-enqueue the next cron occurrence (the originating tick already did),
	// otherwise each continuation would double-arm the schedule.
	const payload = (jobPayload ?? {}) as Record<string, unknown>;
	const payloadScheduledFor =
		typeof payload._scheduled_for === "string"
			? new Date(payload._scheduled_for)
			: null;
	const occurrenceScheduledFor =
		payloadScheduledFor && !Number.isNaN(payloadScheduledFor.getTime())
			? payloadScheduledFor
			: scheduledFor;
	const cursorOffset =
		typeof payload._cursor_offset === "number" && payload._cursor_offset > 0
			? payload._cursor_offset
			: 0;
	const isContinuation = cursorOffset > 0;
	const rootOccurrenceId =
		typeof payload._root_occurrence_id === "string"
			? payload._root_occurrence_id
			: automationScheduleOccurrenceBase(ep.id, occurrenceScheduledFor);

	// 1. Compute and enqueue the next firing BEFORE any other work. This keeps
	//    the schedule alive across transient enrollment failures. Skip on
	//    continuation ticks.
	if (!isContinuation) {
		const cfg = (ep.config ?? {}) as { cron?: string; timezone?: string };
		const nextRun = cfg.cron
			? computeNextCronRun(
					cfg.cron,
					occurrenceScheduledFor > new Date()
						? occurrenceScheduledFor
						: new Date(),
					cfg.timezone,
				)
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
			auto.workspaceId,
			filters,
		);
	} catch (err) {
		if (err instanceof InvalidScheduleFilterError) {
			return { failed: true, error: err.message };
		}
		throw new Error(
			`schedule filter enumeration failed: ${err instanceof Error ? err.message : String(err)}`,
		);
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

	// Persist the next page before crossing this page's effect boundary. If any
	// contact below has an ambiguous outcome, the current page becomes unknown,
	// but the rest of this logical occurrence must still be allowed to proceed.
	// The deterministic occurrence id makes this insert safe when a pre-boundary
	// failure causes the current page to retry.
	const nextOffset = cursorOffset + batch.length;
	if (nextOffset < candidateIds.length && batch.length > 0) {
		await db
			.insert(automationScheduledJobs)
			.values({
				occurrenceId: `${rootOccurrenceId}:page:${nextOffset}`,
				jobType: "scheduled_trigger",
				automationId: auto.id,
				entrypointId: ep.id,
				runAt: new Date(),
				status: "pending",
				payload: {
					_cursor_offset: nextOffset,
					_root_occurrence_id: rootOccurrenceId,
					_scheduled_for: occurrenceScheduledFor.toISOString(),
				},
			})
			.onConflictDoNothing();
	}
	if (batch.length > 0) await markEffectStarted();

	// 3. Fire enroll-or-binding for each candidate in this batch. Continue through
	//    the page to maximize progress, but preserve any partial page as unknown so
	//    it is never silently acknowledged or blindly replayed.
	let enrollmentFailures = 0;
	try {
		for (const contactId of batch) {
			const event: InboundEvent = {
				kind: "schedule" as never,
				channel: auto.channel as InboundEvent["channel"],
				organizationId: auto.organizationId,
				socialAccountId: ep.socialAccountId ?? null,
				contactId,
				conversationId: null,
				triggerOccurrenceId: automationScheduleContactOccurrenceId(
					rootOccurrenceId,
					contactId,
				),
				payload: {
					source: "schedule",
					entrypoint_id: ep.id,
					scheduled_at: occurrenceScheduledFor.toISOString(),
					occurrence_id: occurrenceId,
				},
			};
			try {
				await matchAndEnrollOrBinding(db, event, env);
			} catch (err) {
				enrollmentFailures++;
				console.error(
					`[scheduler] scheduled_trigger enroll failed for contact ${contactId}:`,
					err,
				);
			}
		}
	} catch (err) {
		throw new Error(
			`scheduled_trigger enrollment loop failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (enrollmentFailures > 0) {
		throw new Error(
			`${enrollmentFailures} scheduled contacts have an unknown enrollment outcome`,
		);
	}

	return "done";
}

/**
 * Idempotently inserts the next `scheduled_trigger` job for an entrypoint.
 * The exact logical occurrence is a database uniqueness key, so retries and
 * overlapping workers cannot create duplicate successors regardless of state.
 */
async function insertNextScheduledJobIfNotExists(
	db: Pick<Db, "insert">,
	entrypointId: string,
	runAt: Date,
	automationId: string,
): Promise<void> {
	await db
		.insert(automationScheduledJobs)
		.values({
			occurrenceId: automationScheduleOccurrenceId(entrypointId, runAt),
			jobType: "scheduled_trigger",
			automationId,
			entrypointId,
			runAt,
			status: "pending",
			payload: {
				_root_occurrence_id: automationScheduleOccurrenceBase(
					entrypointId,
					runAt,
				),
				_scheduled_for: runAt.toISOString(),
			},
		})
		.onConflictDoNothing();
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
type ScheduleFilterPredicate = {
	field: "tags" | "segment_ids";
	op: "contains";
	value: string | string[];
};

type ParsedScheduleFilter = {
	all: ScheduleFilterPredicate[];
	any: ScheduleFilterPredicate[];
};

class InvalidScheduleFilterError extends Error {}

function parseScheduleFilter(
	filters: Record<string, unknown>,
): ParsedScheduleFilter | null {
	const none = filters.none;
	if (none !== undefined && (!Array.isArray(none) || none.length > 0)) {
		throw new InvalidScheduleFilterError(
			"schedule filters support only all/any tag or segment predicates",
		);
	}
	const parseGroup = (name: "all" | "any"): ScheduleFilterPredicate[] => {
		const rawGroup = filters[name];
		if (rawGroup === undefined) return [];
		if (!Array.isArray(rawGroup)) {
			throw new InvalidScheduleFilterError(`${name} must be an array`);
		}
		return rawGroup.map((raw, index) => {
			if (!raw || typeof raw !== "object") {
				throw new InvalidScheduleFilterError(
					`${name}[${index}] must be an object`,
				);
			}
			const predicate = raw as {
				field?: unknown;
				op?: unknown;
				value?: unknown;
			};
			const field =
				predicate.field === "tag" || predicate.field === "contact.tags"
					? "tags"
					: predicate.field === "segment" ||
							predicate.field === "segments" ||
							predicate.field === "contact.segments" ||
							predicate.field === "contact.segment_ids"
						? "segment_ids"
						: predicate.field;
			if (field !== "tags" && field !== "segment_ids") {
				throw new InvalidScheduleFilterError(
					`${name}[${index}] has unsupported field`,
				);
			}
			if (predicate.op !== "contains") {
				throw new InvalidScheduleFilterError(
					`${name}[${index}] has unsupported operator`,
				);
			}
			if (
				typeof predicate.value !== "string" &&
				!(
					field === "segment_ids" &&
					Array.isArray(predicate.value) &&
					predicate.value.length > 0 &&
					predicate.value.every((value) => typeof value === "string")
				)
			) {
				throw new InvalidScheduleFilterError(
					`${name}[${index}] has an invalid value`,
				);
			}
			return {
				field,
				op: "contains",
				value: predicate.value as string | string[],
			};
		});
	};

	const parsed = { all: parseGroup("all"), any: parseGroup("any") };
	return parsed.all.length === 0 && parsed.any.length === 0 ? null : parsed;
}

/** Validate the bounded filter subset a schedule can enumerate efficiently. */
export function validateScheduleEntrypointFilters(
	filters: unknown,
): { valid: true } | { valid: false; error: string } {
	if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
		return {
			valid: false,
			error: "schedule entrypoint requires an all/any tag or segment filter",
		};
	}
	try {
		const parsed = parseScheduleFilter(filters as Record<string, unknown>);
		return parsed
			? { valid: true }
			: {
					valid: false,
					error:
						"schedule entrypoint requires an all/any tag or segment filter",
				};
	} catch (error) {
		return {
			valid: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function combineSchedulePredicateSets(
	allSets: ReadonlyArray<ReadonlySet<string>>,
	anySets: ReadonlyArray<ReadonlySet<string>>,
): string[] {
	let result = new Set<string>();
	if (allSets.length > 0) {
		result = new Set(allSets[0]);
		for (const predicateSet of allSets.slice(1)) {
			result = new Set(Array.from(result).filter((id) => predicateSet.has(id)));
		}
	}
	if (anySets.length > 0) {
		const union = new Set<string>();
		for (const predicateSet of anySets) {
			for (const id of predicateSet) union.add(id);
		}
		result =
			allSets.length === 0
				? union
				: new Set(Array.from(result).filter((id) => union.has(id)));
	}
	return Array.from(result);
}

async function enumerateContactsForScheduleFilter(
	db: Db,
	organizationId: string,
	workspaceId: string | null,
	filters: Record<string, unknown> | null,
): Promise<string[] | null> {
	if (!filters) return null;
	const parsed = parseScheduleFilter(filters);
	if (!parsed) return null;
	const contactScope = workspaceId
		? eq(contacts.workspaceId, workspaceId)
		: isNull(contacts.workspaceId);

	const queryPredicate = async (
		predicate: ScheduleFilterPredicate,
	): Promise<Set<string>> => {
		if (predicate.field === "tags") {
			const rows = await db
				.select({ id: contacts.id })
				.from(contacts)
				.where(
					and(
						eq(contacts.organizationId, organizationId),
						contactScope,
						sql`${contacts.tags} @> ARRAY[${predicate.value as string}]::text[]`,
					),
				);
			return new Set(rows.map((row) => row.id));
		}

		const segmentIds = Array.isArray(predicate.value)
			? predicate.value
			: [predicate.value];
		const rows = await db
			.select({ id: contactSegmentMemberships.contactId })
			.from(contactSegmentMemberships)
			.innerJoin(
				contacts,
				and(
					eq(contactSegmentMemberships.contactId, contacts.id),
					eq(contactSegmentMemberships.organizationId, contacts.organizationId),
				),
			)
			.where(
				and(
					eq(contactSegmentMemberships.organizationId, organizationId),
					contactScope,
					inArray(contactSegmentMemberships.segmentId, segmentIds),
				),
			);
		return new Set(rows.map((row) => row.id));
	};

	const allSets: Set<string>[] = [];
	for (const predicate of parsed.all) {
		allSets.push(await queryPredicate(predicate));
	}
	const anySets: Set<string>[] = [];
	for (const predicate of parsed.any) {
		anySets.push(await queryPredicate(predicate));
	}
	return combineSchedulePredicateSets(allSets, anySets);
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
	if (!isValidAutomationTimezone(tz)) return null;
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
	const expression = parseAutomationCron(cron);
	if (!expression) return null;

	// Seed with the zone-local wall-clock components of `from`, zero
	// seconds/milliseconds for cleanliness.
	const fromZoned = utcToZonedComponents(from, tz);

	// `*/N * * * *` — every N minutes. Timezone-independent (the minute
	// hand ticks the same in every zone), but we still round to the
	// next boundary using the wall-clock minute to preserve intuition
	// when the operator expects firings at ":00 / :15 / :30 / :45".
	if (expression.kind === "interval") {
		const n = expression.minutes;
		const minutes = fromZoned.minute;
		const rem = minutes % n;
		const add = rem === 0 ? n : n - rem;
		const next = { ...fromZoned, minute: minutes + add, second: 0 };
		return zonedComponentsToUtc(next, tz);
	}

	// `0 * * * *` — hourly at the top of the hour.
	if (expression.kind === "hourly") {
		const next = {
			...fromZoned,
			hour: fromZoned.hour + 1,
			minute: 0,
			second: 0,
		};
		return zonedComponentsToUtc(next, tz);
	}

	// `M H * * *` — daily at H:M in the target timezone.
	if (expression.kind === "daily") {
		const { hour, minute } = expression;
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
	return db.transaction(async (tx) => {
		// Lock both definitions through the insert. A concurrent pause/config edit
		// then either lands first (and is observed here) or lands second and removes
		// the pending row, so no stale firing can survive a lifecycle transition.
		const [ep] = await tx
			.select()
			.from(automationEntrypoints)
			.where(eq(automationEntrypoints.id, entrypointId))
			.limit(1)
			.for("update");
		if (!ep) return { queued: false, reason: "entrypoint_not_found" };
		if (ep.kind !== "schedule") {
			return { queued: false, reason: "not_schedule" };
		}
		if (ep.status !== "active") {
			return { queued: false, reason: "entrypoint_not_active" };
		}

		const [automation] = await tx
			.select()
			.from(automationsTable)
			.where(eq(automationsTable.id, ep.automationId))
			.limit(1)
			.for("update");
		if (automation?.status !== "active") {
			return { queued: false, reason: "automation_not_active" };
		}

		const cfg = (ep.config ?? {}) as { cron?: string; timezone?: string };
		if (!cfg.cron) return { queued: false, reason: "no_cron" };

		const nextRun = computeNextCronRun(cfg.cron, new Date(), cfg.timezone);
		if (!nextRun) return { queued: false, reason: "invalid_cron" };

		await insertNextScheduledJobIfNotExists(
			tx,
			entrypointId,
			nextRun,
			ep.automationId,
		);
		return { queued: true, runAt: nextRun };
	});
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
