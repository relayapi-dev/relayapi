import {
	createDb,
	type Database,
	toolJobs,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { decryptToken, encryptToken } from "../lib/crypto";
import type { Env } from "../types";
import { callDownloaderService } from "./tool-service";
import {
	persistedUsageOutcome,
	reconcileStaleReservedUsageReservations,
	type UsageDisposition,
	type UsageReservationReference,
	writeOffExpiredParkedUsageReservations,
} from "./usage-meter";

export type ToolJobKind = "download" | "transcript";
export type ToolJobStatus = "processing" | "completed" | "failed";

export interface ToolJob {
	job_id: string;
	org_id: string;
	status: ToolJobStatus;
	type: ToolJobKind;
	created_at: string;
	completed_at?: string;
	result?: Record<string, unknown>;
	error?: string;
	error_code?: string;
}

export interface ClaimedToolJob {
	id: string;
	organizationId: string;
	kind: ToolJobKind;
	request: Record<string, unknown>;
	attempts: number;
	leaseToken: number;
	deadlineAt: Date;
	usageReservation: UsageReservationReference;
}

interface ToolJobQueueEnvelope {
	type: "tool_job";
	job_id: string;
	org_id: string;
}

export const TOOL_JOB_MAX_ATTEMPTS = 3;
export const TOOL_JOB_DEADLINE_MS = 15 * 60_000;
export const TOOL_JOB_PROVIDER_DEADLINE_MS = 60_000;
export const TOOL_JOB_SETTLEMENT_MARGIN_MS = 30_000;
export const TOOL_JOB_LEASE_MS =
	TOOL_JOB_PROVIDER_DEADLINE_MS + TOOL_JOB_SETTLEMENT_MARGIN_MS;
export const TOOL_JOB_HTTP_POLL_MS = 20_000;
export const TOOL_JOB_TERMINAL_TTL_MS = 60 * 60_000;
export const TOOL_JOB_MANUAL_REVIEW_TTL_MS = 90 * 24 * 60 * 60_000;
const DISPATCH_RESERVATION_MS = 90_000;
const DEFAULT_BATCH_SIZE = 100;

export type ToolJobExecutionResult =
	| {
			delivery: "ack";
			outcome: "completed";
			data: Record<string, unknown>;
	  }
	| {
			delivery: "ack";
			outcome: "failed";
			error: string;
			errorCode: string;
	  }
	| {
			delivery: "ack";
			outcome: "manual_review" | "lost_fence";
	  }
	| {
			delivery: "retry";
			outcome: "deferred";
			delaySeconds: number;
	  };

export interface ToolJobExecutorOverrides {
	callProvider?: typeof callDownloaderService;
	armBoundary?: typeof armToolJobProviderBoundary;
	complete?: typeof completeToolJob;
	fail?: typeof failToolJob;
	markUnknown?: typeof markToolJobOutcomeUnknown;
	sameFenceIsManualReview?: typeof sameToolJobFenceIsManualReview;
	sameFenceHasDefinitiveOutcome?: typeof sameToolJobFenceHasDefinitiveOutcome;
	defer?: typeof deferToolJob;
	reconcileDefinitive?: typeof reconcileLateDefinitiveToolJobOutcome;
	now?: () => Date;
}

function requireEncryptionKey(env: Env): string {
	if (!env.ENCRYPTION_KEY) {
		throw new Error("ENCRYPTION_KEY is required for durable tool jobs");
	}
	return env.ENCRYPTION_KEY;
}

function queueEnvelope(
	id: string,
	organizationId: string,
): ToolJobQueueEnvelope {
	return { type: "tool_job", job_id: id, org_id: organizationId };
}

export async function toolJobOwnsUsageReservation(
	db: Database,
	usageReservationId: string,
	organizationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ id: toolJobs.id })
		.from(toolJobs)
		.where(
			and(
				eq(toolJobs.usageReservationId, usageReservationId),
				eq(toolJobs.organizationId, organizationId),
			),
		)
		.limit(1);
	return row !== undefined;
}

function objectPayload(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Tool job encrypted payload is invalid");
	}
	return value as Record<string, unknown>;
}

async function encryptJson(
	env: Env,
	id: string,
	field: "request" | "result" | "error",
	value: unknown,
): Promise<string> {
	return encryptToken(JSON.stringify(value), requireEncryptionKey(env), {
		recordId: id,
		field,
	});
}

async function decryptJson(
	env: Env,
	id: string,
	field: "request" | "result",
	ciphertext: string,
): Promise<Record<string, unknown>> {
	const plaintext = await decryptToken(ciphertext, requireEncryptionKey(env), {
		recordId: id,
		field,
	});
	return objectPayload(JSON.parse(plaintext) as unknown);
}

async function decryptError(
	env: Env,
	id: string,
	ciphertext: string,
): Promise<string> {
	const plaintext = await decryptToken(ciphertext, requireEncryptionKey(env), {
		recordId: id,
		field: "error",
	});
	const value = JSON.parse(plaintext) as unknown;
	if (typeof value !== "string") {
		throw new Error("Tool job encrypted error is invalid");
	}
	return value;
}

/**
 * Create the durable authority before Queue handoff. A failed handoff is safe:
 * the every-minute dispatcher will discover the pending row.
 */
export async function createToolJob(
	env: Env,
	jobId: string,
	orgId: string,
	kind: ToolJobKind,
	usageReservationId: string,
	request: Record<string, unknown>,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const deadlineAt = new Date(now.getTime() + TOOL_JOB_DEADLINE_MS);
	const requestCiphertext = await encryptJson(env, jobId, "request", request);
	try {
		await db.insert(toolJobs).values({
			id: jobId,
			organizationId: orgId,
			kind,
			usageReservationId,
			requestCiphertext,
			nextAttemptAt: now,
			deadlineAt,
			purgeAt: new Date(deadlineAt.getTime() + TOOL_JOB_TERMINAL_TTL_MS),
			createdAt: now,
			updatedAt: now,
		});
	} catch (error) {
		// A commit response can be lost after PostgreSQL accepted the row. Recover
		// only this exact generated identity and reservation ownership; otherwise
		// preserve the original failure.
		const [persisted] = await db
			.select({
				id: toolJobs.id,
				kind: toolJobs.kind,
				usageReservationId: toolJobs.usageReservationId,
			})
			.from(toolJobs)
			.where(
				and(
					eq(toolJobs.id, jobId),
					eq(toolJobs.organizationId, orgId),
					eq(toolJobs.usageReservationId, usageReservationId),
				),
			)
			.limit(1);
		if (!persisted || persisted.kind !== kind) throw error;
		console.warn("[tools] recovered committed tool-job creation", {
			event: "tool_job_creation_commit_recovered",
			organizationId: orgId,
			jobId,
		});
	}

	try {
		await env.TOOLS_QUEUE.send(queueEnvelope(jobId, orgId));
		await db
			.update(toolJobs)
			.set({ lastEnqueuedAt: now, updatedAt: new Date() })
			.where(
				and(
					eq(toolJobs.id, jobId),
					eq(toolJobs.organizationId, orgId),
					eq(toolJobs.status, "pending"),
				),
			);
	} catch (error) {
		// The row is the authority; retaining it pending is the recovery path.
		console.warn("[tools] initial Queue handoff deferred", {
			event: "tool_job_handoff_deferred",
			organizationId: orgId,
			jobId,
			error,
		});
	}
}

/**
 * Claim or reclaim exactly one fenced attempt. A processing row is reclaimable
 * only while no provider boundary exists.
 */
export async function claimToolJob(
	env: Env,
	jobId: string,
	orgId: string,
	now = new Date(),
): Promise<ClaimedToolJob | null> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const leaseExpiresAt = new Date(now.getTime() + TOOL_JOB_LEASE_MS);
	const rows = (await db.execute(sql`
		WITH candidate AS (
			SELECT job.id, reservation.bucket_id
			  FROM ${toolJobs} AS job
			  JOIN ${usageReservations} AS reservation
			    ON reservation.id = job.usage_reservation_id
			   AND reservation.organization_id = job.organization_id
			 WHERE job.id = ${jobId}
			   AND job.organization_id = ${orgId}
			   AND job.deadline_at > ${now}
			   AND job.attempts < ${TOOL_JOB_MAX_ATTEMPTS}
			   AND (
					(job.status = 'pending' AND job.next_attempt_at <= ${now})
					OR (job.status = 'processing'
						AND job.request_may_have_been_sent_at IS NULL
						AND job.lease_expires_at <= ${now})
			   )
			 FOR UPDATE OF job SKIP LOCKED
		)
		UPDATE ${toolJobs} AS job
		   SET status = 'processing',
		       attempts = job.attempts + 1,
		       lease_token = job.lease_token + 1,
		       lease_expires_at = ${leaseExpiresAt},
		       last_enqueued_at = ${now},
		       updated_at = ${now}
		  FROM candidate
		 WHERE job.id = candidate.id
		RETURNING job.kind,
		          job.request_ciphertext AS "requestCiphertext",
		          job.attempts,
		          job.lease_token AS "leaseToken",
		          job.deadline_at AS "deadlineAt",
		          job.usage_reservation_id AS "usageReservationId",
		          candidate.bucket_id AS "usageBucketId"
	`)) as unknown as Array<{
		kind: ToolJobKind;
		requestCiphertext: string;
		attempts: number;
		leaseToken: number;
		deadlineAt: Date;
		usageReservationId: string;
		usageBucketId: string;
	}>;
	const claimed = rows[0];
	if (!claimed) return null;
	return {
		id: jobId,
		organizationId: orgId,
		kind: claimed.kind,
		request: await decryptJson(
			env,
			jobId,
			"request",
			claimed.requestCiphertext,
		),
		attempts: claimed.attempts,
		leaseToken: claimed.leaseToken,
		deadlineAt: new Date(claimed.deadlineAt),
		usageReservation: {
			id: claimed.usageReservationId,
			bucketId: claimed.usageBucketId,
			organizationId: orgId,
		},
	};
}

/**
 * Atomically arm the linked quota reservation and this fenced job before
 * provider egress. Either both durable boundaries exist or neither does.
 */
export async function armToolJobProviderBoundary(
	env: Env,
	claim: ClaimedToolJob,
	now = new Date(),
): Promise<void> {
	if (now >= claim.deadlineAt) {
		throw new Error("Tool job deadline elapsed before provider egress");
	}
	const db = createDb(env.HYPERDRIVE.connectionString);
	await db.transaction(async (tx) => {
		// Keep every tool/usage transition on the canonical bucket ->
		// reservation -> job lock order. The usage projection trigger also
		// touches the bucket when the reservation changes.
		const [bucket] = await tx
			.select({ id: usageBuckets.id })
			.from(usageBuckets)
			.where(eq(usageBuckets.id, claim.usageReservation.bucketId))
			.for("update")
			.limit(1);
		const [reservation] = await tx
			.select({
				id: usageReservations.id,
				state: usageReservations.state,
				requestMayHaveBeenSentAt: usageReservations.requestMayHaveBeenSentAt,
			})
			.from(usageReservations)
			.where(
				and(
					eq(usageReservations.id, claim.usageReservation.id),
					eq(
						usageReservations.organizationId,
						claim.usageReservation.organizationId,
					),
					eq(usageReservations.bucketId, claim.usageReservation.bucketId),
				),
			)
			.for("update")
			.limit(1);
		const [job] = await tx
			.select({
				id: toolJobs.id,
				status: toolJobs.status,
				leaseToken: toolJobs.leaseToken,
				requestMayHaveBeenSentAt: toolJobs.requestMayHaveBeenSentAt,
			})
			.from(toolJobs)
			.where(
				and(
					eq(toolJobs.id, claim.id),
					eq(toolJobs.organizationId, claim.organizationId),
					eq(toolJobs.usageReservationId, claim.usageReservation.id),
					sql`${toolJobs.deadlineAt} > statement_timestamp()`,
				),
			)
			.for("update")
			.limit(1);
		if (
			!bucket ||
			!reservation ||
			reservation.state !== "reserved" ||
			reservation.requestMayHaveBeenSentAt !== null ||
			!job ||
			job.status !== "processing" ||
			job.leaseToken !== claim.leaseToken ||
			job.requestMayHaveBeenSentAt !== null
		) {
			throw new Error("Tool job is no longer eligible for provider egress");
		}

		const usageRows = await tx
			.update(usageReservations)
			.set({ requestMayHaveBeenSentAt: now })
			.where(
				and(
					eq(usageReservations.id, claim.usageReservation.id),
					eq(
						usageReservations.organizationId,
						claim.usageReservation.organizationId,
					),
					eq(usageReservations.bucketId, claim.usageReservation.bucketId),
					eq(usageReservations.state, "reserved"),
					isNull(usageReservations.requestMayHaveBeenSentAt),
				),
			)
			.returning({ id: usageReservations.id });
		if (usageRows.length !== 1) {
			throw new Error(
				"Linked usage reservation is no longer eligible for provider egress",
			);
		}

		const jobRows = await tx
			.update(toolJobs)
			.set({
				requestMayHaveBeenSentAt: now,
				leaseExpiresAt: new Date(now.getTime() + TOOL_JOB_LEASE_MS),
				updatedAt: now,
			})
			.where(
				and(
					eq(toolJobs.id, claim.id),
					eq(toolJobs.organizationId, claim.organizationId),
					eq(toolJobs.usageReservationId, claim.usageReservation.id),
					eq(toolJobs.status, "processing"),
					eq(toolJobs.leaseToken, claim.leaseToken),
					isNull(toolJobs.requestMayHaveBeenSentAt),
					sql`${toolJobs.deadlineAt} > statement_timestamp()`,
				),
			)
			.returning({ id: toolJobs.id });
		if (jobRows.length !== 1) {
			throw new Error("Tool job lost its provider-boundary fence");
		}
	});
}

async function settleToolJobClaim(
	env: Env,
	claim: ClaimedToolJob,
	input: {
		status: "completed" | "failed" | "manual_review";
		resultCiphertext?: string | null;
		errorCiphertext?: string | null;
		errorCode?: string | null;
		retainRequest: boolean;
		disposition: UsageDisposition;
		now: Date;
		expectedStatus?: "pending" | "processing";
	},
): Promise<boolean> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	return db.transaction(async (tx) => {
		// Preserve the projection's bucket-first lock order, then fence the
		// reservation and job in one transaction.
		const [bucket] = await tx
			.select({ id: usageBuckets.id })
			.from(usageBuckets)
			.where(eq(usageBuckets.id, claim.usageReservation.bucketId))
			.for("update")
			.limit(1);
		const [reservation] = await tx
			.select()
			.from(usageReservations)
			.where(
				and(
					eq(usageReservations.id, claim.usageReservation.id),
					eq(
						usageReservations.organizationId,
						claim.usageReservation.organizationId,
					),
					eq(usageReservations.bucketId, claim.usageReservation.bucketId),
				),
			)
			.for("update")
			.limit(1);
		if (!bucket || !reservation || reservation.state !== "reserved")
			return false;
		const outcome = persistedUsageOutcome(
			reservation.requestMayHaveBeenSentAt,
			input.disposition,
			reservation.units,
		);
		const jobBoundaryPredicate = input.disposition.commit
			? isNotNull(toolJobs.requestMayHaveBeenSentAt)
			: isNull(toolJobs.requestMayHaveBeenSentAt);
		const rows = await tx
			.update(toolJobs)
			.set({
				status: input.status,
				...(input.retainRequest ? {} : { requestCiphertext: null }),
				resultCiphertext: input.resultCiphertext ?? null,
				errorCiphertext: input.errorCiphertext ?? null,
				errorCode: input.errorCode ?? null,
				lastEnqueuedAt: null,
				leaseExpiresAt: null,
				completedAt: input.now,
				purgeAt: new Date(
					input.now.getTime() +
						(input.status === "manual_review"
							? TOOL_JOB_MANUAL_REVIEW_TTL_MS
							: TOOL_JOB_TERMINAL_TTL_MS),
				),
				updatedAt: input.now,
			})
			.where(
				and(
					eq(toolJobs.id, claim.id),
					eq(toolJobs.organizationId, claim.organizationId),
					eq(toolJobs.usageReservationId, claim.usageReservation.id),
					eq(toolJobs.status, input.expectedStatus ?? "processing"),
					eq(toolJobs.leaseToken, claim.leaseToken),
					jobBoundaryPredicate,
				),
			)
			.returning({ id: toolJobs.id });
		if (rows.length !== 1) return false;

		const usageRows = await tx
			.update(usageReservations)
			.set({
				state: outcome.state,
				disposition: outcome.disposition,
				committedUnits: outcome.committedUnits,
				responseStatus: outcome.responseStatus,
				finalizedAt: outcome.state === "parked" ? null : input.now,
			})
			.where(
				and(
					eq(usageReservations.id, reservation.id),
					eq(usageReservations.state, "reserved"),
				),
			)
			.returning({ id: usageReservations.id });
		if (usageRows.length !== 1) {
			throw new Error("Tool-job usage settlement lost its reservation fence");
		}
		return true;
	});
}

export async function completeToolJob(
	env: Env,
	claim: ClaimedToolJob,
	result: Record<string, unknown>,
	now = new Date(),
): Promise<boolean> {
	const resultCiphertext = await encryptJson(env, claim.id, "result", result);
	return settleToolJobClaim(env, claim, {
		status: "completed",
		resultCiphertext,
		retainRequest: false,
		disposition: {
			commit: true,
			reason: "settled",
			responseStatus: null,
		},
		now,
	});
}

export async function failToolJob(
	env: Env,
	claim: ClaimedToolJob,
	error: string,
	errorCode: string,
	disposition: UsageDisposition,
	now = new Date(),
	expectedStatus: "pending" | "processing" = "processing",
): Promise<boolean> {
	const errorCiphertext = await encryptJson(
		env,
		claim.id,
		"error",
		error.slice(0, 2_000),
	);
	return settleToolJobClaim(env, claim, {
		status: "failed",
		errorCiphertext,
		errorCode,
		retainRequest: false,
		disposition,
		now,
		expectedStatus,
	});
}

export async function markToolJobOutcomeUnknown(
	env: Env,
	claim: ClaimedToolJob,
	now = new Date(),
): Promise<boolean> {
	const errorCiphertext = await encryptJson(
		env,
		claim.id,
		"error",
		"Provider request started, but its outcome could not be persisted safely",
	);
	return settleToolJobClaim(env, claim, {
		status: "manual_review",
		errorCiphertext,
		errorCode: "PROVIDER_OUTCOME_UNKNOWN",
		retainRequest: true,
		disposition: { commit: true, reason: "unknown", responseStatus: null },
		now,
	});
}

type DefinitiveToolJobOutcome =
	| { kind: "completed"; result: Record<string, unknown> }
	| { kind: "failed"; error: string; errorCode: string };

/**
 * A live Queue invocation can finish after the stale-lease terminalizer has
 * conservatively moved its armed attempt to manual review. Reconcile only that
 * exact fence: operator action increments the lease token or changes status,
 * so it always wins over a late provider response.
 */
export async function reconcileLateDefinitiveToolJobOutcome(
	env: Env,
	claim: ClaimedToolJob,
	outcome: DefinitiveToolJobOutcome,
	now = new Date(),
): Promise<boolean> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const resultCiphertext =
		outcome.kind === "completed"
			? await encryptJson(env, claim.id, "result", outcome.result)
			: null;
	const errorCiphertext =
		outcome.kind === "failed"
			? await encryptJson(env, claim.id, "error", outcome.error.slice(0, 2_000))
			: null;

	return db.transaction(async (tx) => {
		const [bucket] = await tx
			.select({ id: usageBuckets.id })
			.from(usageBuckets)
			.where(eq(usageBuckets.id, claim.usageReservation.bucketId))
			.for("update")
			.limit(1);
		const [reservation] = await tx
			.select()
			.from(usageReservations)
			.where(
				and(
					eq(usageReservations.id, claim.usageReservation.id),
					eq(
						usageReservations.organizationId,
						claim.usageReservation.organizationId,
					),
					eq(usageReservations.bucketId, claim.usageReservation.bucketId),
				),
			)
			.for("update")
			.limit(1);
		const [job] = await tx
			.select()
			.from(toolJobs)
			.where(
				and(
					eq(toolJobs.id, claim.id),
					eq(toolJobs.organizationId, claim.organizationId),
					eq(toolJobs.usageReservationId, claim.usageReservation.id),
				),
			)
			.for("update")
			.limit(1);
		if (
			!bucket ||
			!reservation ||
			!job ||
			job.status !== "manual_review" ||
			job.leaseToken !== claim.leaseToken ||
			job.errorCode !== "PROVIDER_OUTCOME_UNKNOWN" ||
			job.requestMayHaveBeenSentAt === null ||
			reservation.state !== "parked" ||
			reservation.disposition !== "unknown" ||
			reservation.requestMayHaveBeenSentAt === null ||
			reservation.requestMayHaveBeenSentAt.getTime() !==
				job.requestMayHaveBeenSentAt.getTime()
		) {
			return false;
		}

		const jobRows = await tx
			.update(toolJobs)
			.set({
				status: outcome.kind,
				requestCiphertext: null,
				resultCiphertext,
				errorCiphertext,
				errorCode: outcome.kind === "failed" ? outcome.errorCode : null,
				lastEnqueuedAt: null,
				leaseExpiresAt: null,
				completedAt: now,
				purgeAt: new Date(now.getTime() + TOOL_JOB_TERMINAL_TTL_MS),
				updatedAt: now,
			})
			.where(
				and(
					eq(toolJobs.id, job.id),
					eq(toolJobs.status, "manual_review"),
					eq(toolJobs.leaseToken, claim.leaseToken),
					eq(toolJobs.errorCode, "PROVIDER_OUTCOME_UNKNOWN"),
					eq(toolJobs.requestMayHaveBeenSentAt, job.requestMayHaveBeenSentAt),
				),
			)
			.returning({ id: toolJobs.id });
		if (jobRows.length !== 1) return false;

		const usageRows = await tx
			.update(usageReservations)
			.set({
				state: "committed",
				disposition: "settled",
				committedUnits: reservation.units,
				responseStatus: null,
				finalizedAt: now,
			})
			.where(
				and(
					eq(usageReservations.id, reservation.id),
					eq(usageReservations.state, "parked"),
					eq(usageReservations.disposition, "unknown"),
					eq(
						usageReservations.requestMayHaveBeenSentAt,
						reservation.requestMayHaveBeenSentAt,
					),
				),
			)
			.returning({ id: usageReservations.id });
		if (usageRows.length !== 1) {
			throw new Error(
				"Late tool-job reconciliation lost its usage-reservation fence",
			);
		}
		return true;
	});
}

export async function deferToolJob(
	env: Env,
	claim: ClaimedToolJob,
	delaySeconds: number,
	now = new Date(),
): Promise<boolean> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const rows = await db
		.update(toolJobs)
		.set({
			status: "pending",
			nextAttemptAt: new Date(now.getTime() + delaySeconds * 1_000),
			lastEnqueuedAt: null,
			leaseExpiresAt: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(toolJobs.id, claim.id),
				eq(toolJobs.organizationId, claim.organizationId),
				eq(toolJobs.status, "processing"),
				eq(toolJobs.leaseToken, claim.leaseToken),
				isNull(toolJobs.requestMayHaveBeenSentAt),
			),
		)
		.returning({ id: toolJobs.id });
	return rows.length === 1;
}

function retryDelaySeconds(attempts: number): number {
	return Math.min(2 ** Math.max(attempts, 1), 900);
}

function logLostToolJobFence(
	claim: ClaimedToolJob,
	outcome: string,
	error?: unknown,
): void {
	console.error(
		"[tools] definitive provider outcome lost its lifecycle fence",
		{
			event: "tool_job_definitive_outcome_lost_fence",
			organizationId: claim.organizationId,
			jobId: claim.id,
			leaseToken: claim.leaseToken,
			outcome,
			...(error === undefined ? {} : { error }),
		},
	);
}

async function sameToolJobFenceIsManualReview(
	env: Env,
	claim: ClaimedToolJob,
): Promise<boolean> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const [row] = await db
		.select({ id: toolJobs.id })
		.from(toolJobs)
		.where(
			and(
				eq(toolJobs.id, claim.id),
				eq(toolJobs.organizationId, claim.organizationId),
				eq(toolJobs.status, "manual_review"),
				eq(toolJobs.leaseToken, claim.leaseToken),
				eq(toolJobs.errorCode, "PROVIDER_OUTCOME_UNKNOWN"),
				isNotNull(toolJobs.requestMayHaveBeenSentAt),
			),
		)
		.limit(1);
	return row !== undefined;
}

async function sameToolJobFenceHasDefinitiveOutcome(
	env: Env,
	claim: ClaimedToolJob,
	outcome: DefinitiveToolJobOutcome,
): Promise<boolean> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const [row] = await db
		.select({
			status: toolJobs.status,
			leaseToken: toolJobs.leaseToken,
			resultCiphertext: toolJobs.resultCiphertext,
			errorCiphertext: toolJobs.errorCiphertext,
			errorCode: toolJobs.errorCode,
			jobBoundary: toolJobs.requestMayHaveBeenSentAt,
			usageState: usageReservations.state,
			usageDisposition: usageReservations.disposition,
			usageBoundary: usageReservations.requestMayHaveBeenSentAt,
		})
		.from(toolJobs)
		.innerJoin(
			usageReservations,
			and(
				eq(usageReservations.id, toolJobs.usageReservationId),
				eq(usageReservations.organizationId, toolJobs.organizationId),
			),
		)
		.where(
			and(
				eq(toolJobs.id, claim.id),
				eq(toolJobs.organizationId, claim.organizationId),
				eq(toolJobs.usageReservationId, claim.usageReservation.id),
			),
		)
		.limit(1);
	if (
		!row ||
		row.leaseToken !== claim.leaseToken ||
		row.jobBoundary === null ||
		row.usageBoundary === null ||
		row.jobBoundary.getTime() !== row.usageBoundary.getTime() ||
		row.usageState !== "committed" ||
		row.usageDisposition !== "settled"
	) {
		return false;
	}
	return outcome.kind === "completed"
		? row.status === "completed" && row.resultCiphertext !== null
		: row.status === "failed" &&
				row.errorCiphertext !== null &&
				row.errorCode === outcome.errorCode;
}

async function settleUnknownAfterBoundary(
	env: Env,
	claim: ClaimedToolJob,
	overrides: ToolJobExecutorOverrides,
): Promise<ToolJobExecutionResult> {
	let settlementError: unknown;
	try {
		const markUnknown = overrides.markUnknown ?? markToolJobOutcomeUnknown;
		if (await markUnknown(env, claim)) {
			return { delivery: "ack", outcome: "manual_review" };
		}
	} catch (error) {
		settlementError = error;
	}
	try {
		const sameFenceIsManualReview =
			overrides.sameFenceIsManualReview ?? sameToolJobFenceIsManualReview;
		if (await sameFenceIsManualReview(env, claim)) {
			return { delivery: "ack", outcome: "manual_review" };
		}
	} catch (error) {
		logLostToolJobFence(claim, "unknown_manual_review_check", error);
	}
	logLostToolJobFence(claim, "unknown", settlementError);
	return { delivery: "ack", outcome: "lost_fence" };
}

async function handlePreBoundaryToolFailure(
	env: Env,
	claim: ClaimedToolJob,
	error: unknown,
	overrides: ToolJobExecutorOverrides,
): Promise<ToolJobExecutionResult> {
	const now = overrides.now?.() ?? new Date();
	if (claim.attempts >= TOOL_JOB_MAX_ATTEMPTS || now >= claim.deadlineAt) {
		try {
			const fail = overrides.fail ?? failToolJob;
			const persisted = await fail(
				env,
				claim,
				"Tool processing could not be completed",
				"PROCESSING_RETRY_EXHAUSTED",
				{
					commit: false,
					reason: "pre_boundary",
					responseStatus: 503,
				},
				now,
			);
			if (persisted) {
				return {
					delivery: "ack",
					outcome: "failed",
					error: "Tool processing could not be completed",
					errorCode: "PROCESSING_RETRY_EXHAUSTED",
				};
			}
		} catch (settlementError) {
			console.error("[tools] pre-boundary terminal settlement failed", {
				event: "tool_job_pre_boundary_terminal_settlement_failed",
				organizationId: claim.organizationId,
				jobId: claim.id,
				error: settlementError,
			});
			return {
				delivery: "retry",
				outcome: "deferred",
				delaySeconds: retryDelaySeconds(claim.attempts),
			};
		}
		// An arm transaction can commit and lose its response. If the
		// known-not-started transition lost, conservatively test the durable
		// provider boundary before allowing any replay.
		return settleUnknownAfterBoundary(env, claim, overrides);
	}

	const delaySeconds = retryDelaySeconds(claim.attempts);
	try {
		const defer = overrides.defer ?? deferToolJob;
		if (await defer(env, claim, delaySeconds, now)) {
			console.warn("[tools] provider call deferred before egress", {
				event: "tool_job_provider_retry",
				organizationId: claim.organizationId,
				jobId: claim.id,
				attempt: claim.attempts,
				delaySeconds,
				error,
			});
			return { delivery: "retry", outcome: "deferred", delaySeconds };
		}
	} catch (deferError) {
		console.error("[tools] pre-boundary defer persistence failed", {
			event: "tool_job_pre_boundary_defer_failed",
			organizationId: claim.organizationId,
			jobId: claim.id,
			error: deferError,
		});
		return { delivery: "retry", outcome: "deferred", delaySeconds };
	}
	return settleUnknownAfterBoundary(env, claim, overrides);
}

function definitiveExecutionResult(
	outcome: DefinitiveToolJobOutcome,
): ToolJobExecutionResult {
	return outcome.kind === "completed"
		? { delivery: "ack", outcome: "completed", data: outcome.result }
		: {
				delivery: "ack",
				outcome: "failed",
				error: outcome.error,
				errorCode: outcome.errorCode,
			};
}

function logDefinitiveReconciliationFailure(
	claim: ClaimedToolJob,
	phase: string,
	error: unknown,
): void {
	console.error("[tools] definitive provider reconciliation failed", {
		event: "tool_job_definitive_reconciliation_failed",
		organizationId: claim.organizationId,
		jobId: claim.id,
		leaseToken: claim.leaseToken,
		phase,
		error,
	});
}

async function settleDefinitiveToolJobOutcome(
	env: Env,
	claim: ClaimedToolJob,
	outcome: DefinitiveToolJobOutcome,
	overrides: ToolJobExecutorOverrides,
): Promise<ToolJobExecutionResult> {
	const settledResult = definitiveExecutionResult(outcome);
	try {
		const persisted =
			outcome.kind === "completed"
				? await (overrides.complete ?? completeToolJob)(
						env,
						claim,
						outcome.result,
					)
				: await (overrides.fail ?? failToolJob)(
						env,
						claim,
						outcome.error,
						outcome.errorCode,
						{
							commit: true,
							reason: "settled",
							responseStatus: null,
						},
					);
		if (persisted) return settledResult;
	} catch (error) {
		// The transition can commit and lose its response. Never discard the
		// known provider outcome or allow another provider attempt.
		logDefinitiveReconciliationFailure(
			claim,
			"initial_terminal_settlement",
			error,
		);
	}

	const reconcile =
		overrides.reconcileDefinitive ?? reconcileLateDefinitiveToolJobOutcome;
	const durableDefinitive =
		overrides.sameFenceHasDefinitiveOutcome ??
		sameToolJobFenceHasDefinitiveOutcome;
	const reconcileOnce = async (phase: string): Promise<boolean> => {
		try {
			return await reconcile(env, claim, outcome);
		} catch (error) {
			logDefinitiveReconciliationFailure(claim, phase, error);
			return false;
		}
	};
	const alreadyDurable = async (phase: string): Promise<boolean> => {
		try {
			return await durableDefinitive(env, claim, outcome);
		} catch (error) {
			logDefinitiveReconciliationFailure(claim, phase, error);
			return false;
		}
	};

	// A lease terminalizer may already have established manual review.
	if (await reconcileOnce("reconcile_existing_manual_review")) {
		return settledResult;
	}
	// Or the first settlement may have committed before its response was lost.
	if (await alreadyDurable("verify_initial_terminal_settlement")) {
		return settledResult;
	}

	try {
		const markUnknown = overrides.markUnknown ?? markToolJobOutcomeUnknown;
		const marked = await markUnknown(env, claim);
		if (!marked) {
			const sameFenceIsManualReview =
				overrides.sameFenceIsManualReview ?? sameToolJobFenceIsManualReview;
			try {
				if (!(await sameFenceIsManualReview(env, claim))) {
					logLostToolJobFence(claim, `${outcome.kind}:manual_review_fence`);
				}
			} catch (error) {
				logDefinitiveReconciliationFailure(
					claim,
					"verify_manual_review",
					error,
				);
			}
		}
	} catch (error) {
		logDefinitiveReconciliationFailure(claim, "establish_manual_review", error);
	}

	if (await reconcileOnce("reconcile_established_manual_review")) {
		return settledResult;
	}
	if (await alreadyDurable("verify_final_terminal_settlement")) {
		return settledResult;
	}
	logLostToolJobFence(claim, outcome.kind);
	// The provider request already happened. Acknowledging this delivery is the
	// only safe response; maintenance/operator review owns the durable row.
	return { delivery: "ack", outcome: "lost_fence" };
}

/**
 * Execute one already-claimed Queue attempt.
 *
 * The database, not Cloudflare delivery attempts, enforces the deliberate
 * three-attempt provider bound. Queue redelivery is only a hint: a claim is the
 * sole authority to perform egress, and an armed claim is never reclaimable.
 */
export async function executeClaimedToolJob(
	env: Env,
	claim: ClaimedToolJob,
	overrides: ToolJobExecutorOverrides = {},
): Promise<ToolJobExecutionResult> {
	let providerBoundaryArmed = false;
	try {
		const endpoint = claim.kind === "download" ? "/download" : "/transcript";
		const callProvider = overrides.callProvider ?? callDownloaderService;
		const armBoundary = overrides.armBoundary ?? armToolJobProviderBoundary;
		const result = await callProvider(
			env,
			endpoint,
			claim.request,
			TOOL_JOB_PROVIDER_DEADLINE_MS,
			async () => {
				await armBoundary(env, claim);
				providerBoundaryArmed = true;
			},
		);

		if (result.ok) {
			return settleDefinitiveToolJobOutcome(
				env,
				claim,
				{ kind: "completed", result: result.data },
				overrides,
			);
		}

		if (!result.requestStarted) {
			return handlePreBoundaryToolFailure(env, claim, result.error, overrides);
		}
		if (result.outcomeUnknown) {
			return settleUnknownAfterBoundary(env, claim, overrides);
		}

		return settleDefinitiveToolJobOutcome(
			env,
			claim,
			{
				kind: "failed",
				error: result.error,
				errorCode: "EXTRACTION_FAILED",
			},
			overrides,
		);
	} catch (error) {
		if (providerBoundaryArmed) {
			return settleUnknownAfterBoundary(env, claim, overrides);
		}
		return handlePreBoundaryToolFailure(env, claim, error, overrides);
	}
}

async function getToolJobFromDb(
	db: Database,
	env: Env,
	jobId: string,
	orgId: string,
	now = new Date(),
): Promise<ToolJob | null> {
	const [row] = await db
		.select()
		.from(toolJobs)
		.where(
			and(
				eq(toolJobs.id, jobId),
				eq(toolJobs.organizationId, orgId),
				gt(toolJobs.purgeAt, now),
			),
		)
		.limit(1);
	if (!row) return null;

	const base: ToolJob = {
		job_id: row.id,
		org_id: row.organizationId,
		status:
			row.status === "pending" || row.status === "processing"
				? "processing"
				: row.status === "manual_review"
					? "failed"
					: row.status,
		type: row.kind,
		created_at: row.createdAt.toISOString(),
		...(row.completedAt ? { completed_at: row.completedAt.toISOString() } : {}),
	};
	if (row.status === "completed" && row.resultCiphertext) {
		base.result = await decryptJson(
			env,
			row.id,
			"result",
			row.resultCiphertext,
		);
	}
	if (
		(row.status === "failed" || row.status === "manual_review") &&
		row.errorCiphertext
	) {
		base.error = await decryptError(env, row.id, row.errorCiphertext);
		base.error_code = row.errorCode ?? "EXTRACTION_FAILED";
	}
	return base;
}

export async function getToolJob(
	env: Env,
	jobId: string,
	orgId: string,
	now = new Date(),
): Promise<ToolJob | null> {
	return getToolJobFromDb(
		createDb(env.HYPERDRIVE.connectionString),
		env,
		jobId,
		orgId,
		now,
	);
}

/**
 * Give the Queue fast path a bounded chance to produce the synchronous API
 * response. HTTP waitUntil extends only 30 seconds after a response, which
 * cannot safely contain this service's 60-second provider deadline plus
 * settlement; the request therefore polls durable state and never performs or
 * continues provider egress itself.
 */
export async function pollToolJobUntilTerminal(
	env: Env,
	jobId: string,
	orgId: string,
	timeoutMs = TOOL_JOB_HTTP_POLL_MS,
): Promise<ToolJob | null> {
	const stopAt = Date.now() + Math.max(0, timeoutMs);
	const db = createDb(env.HYPERDRIVE.connectionString);
	let delayMs = 100;
	let job = await getToolJobFromDb(db, env, jobId, orgId);
	while (job?.status === "processing") {
		const remainingMs = stopAt - Date.now();
		if (remainingMs <= 0) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(delayMs, remainingMs)),
		);
		job = await getToolJobFromDb(db, env, jobId, orgId);
		delayMs = Math.min(delayMs * 2, 1_000);
	}
	return job;
}

/**
 * Re-enqueue unclaimed pending work and stale leases. The reservation timestamp
 * bounds duplicate Queue hints; the SQL claim remains the execution fence.
 */
export async function dispatchDueToolJobs(
	env: Env,
	batchSize = DEFAULT_BATCH_SIZE,
	now = new Date(),
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 100);
	const staleEnqueueAt = new Date(now.getTime() - DISPATCH_RESERVATION_MS);
	const rows = (await db.execute(sql`
		WITH due AS (
			SELECT id
			  FROM ${toolJobs}
			 WHERE deadline_at > ${now}
			   AND attempts < ${TOOL_JOB_MAX_ATTEMPTS}
			   AND (last_enqueued_at IS NULL OR last_enqueued_at <= ${staleEnqueueAt})
			   AND (
					(status = 'pending' AND next_attempt_at <= ${now})
					OR (status = 'processing'
						AND request_may_have_been_sent_at IS NULL
						AND lease_expires_at <= ${now})
			   )
			 ORDER BY next_attempt_at ASC, id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		)
		UPDATE ${toolJobs} AS job
		   SET last_enqueued_at = ${now},
		       updated_at = ${now}
		  FROM due
		 WHERE job.id = due.id
		RETURNING job.id, job.organization_id AS "organizationId"
	`)) as unknown as Array<{ id: string; organizationId: string }>;
	if (rows.length === 0) return 0;

	try {
		await env.TOOLS_QUEUE.sendBatch(
			rows.map((row) => ({
				body: queueEnvelope(row.id, row.organizationId),
			})),
		);
		return rows.length;
	} catch (error) {
		await db.execute(sql`
			UPDATE ${toolJobs}
			   SET last_enqueued_at = NULL,
			       updated_at = NOW()
			 WHERE id IN (${sql.join(
					rows.map((row) => sql`${row.id}`),
					sql`, `,
				)})
			   AND last_enqueued_at = ${now}
		`);
		throw error;
	}
}

/** Terminalize work that can no longer be safely attempted. */
export async function failExpiredToolJobs(
	env: Env,
	batchSize = DEFAULT_BATCH_SIZE,
	now = new Date(),
	organizationId?: string,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 500);
	const rows = (await db.execute(sql`
		SELECT job.id, job.organization_id AS "organizationId", job.kind, job.status,
		       job.attempts, job.lease_token AS "leaseToken",
		       job.deadline_at AS "deadlineAt",
		       job.request_may_have_been_sent_at AS "requestMayHaveBeenSentAt",
		       job.usage_reservation_id AS "usageReservationId",
		       reservation.bucket_id AS "usageBucketId"
		  FROM ${toolJobs} AS job
		 JOIN ${usageReservations} AS reservation
		    ON reservation.id = job.usage_reservation_id
		   AND reservation.organization_id = job.organization_id
		 WHERE job.status IN ('pending', 'processing')
		   -- Never terminalize a live Queue invocation. An armed attempt becomes
		   -- unknown as soon as its lease expires; an unarmed attempt remains
		   -- reclaimable until the overall deadline/attempt bound.
		   AND (job.status = 'pending' OR job.lease_expires_at <= ${now})
		   AND (
				(job.status = 'processing'
					AND job.request_may_have_been_sent_at IS NOT NULL
					AND job.lease_expires_at <= ${now})
				OR job.deadline_at <= ${now}
				OR job.attempts >= ${TOOL_JOB_MAX_ATTEMPTS}
		   )
		   ${organizationId ? sql`AND job.organization_id = ${organizationId}` : sql``}
		 ORDER BY job.deadline_at ASC, job.id ASC
		 LIMIT ${limit}
	`)) as unknown as Array<{
		id: string;
		organizationId: string;
		kind: ToolJobKind;
		status: "pending" | "processing";
		attempts: number;
		leaseToken: number;
		deadlineAt: Date;
		requestMayHaveBeenSentAt: Date | null;
		usageReservationId: string;
		usageBucketId: string;
	}>;
	let completed = 0;
	for (const row of rows) {
		try {
			const outcomeUnknown = row.requestMayHaveBeenSentAt !== null;
			const claim: ClaimedToolJob = {
				id: row.id,
				organizationId: row.organizationId,
				kind: row.kind,
				request: {},
				attempts: row.attempts,
				leaseToken: row.leaseToken,
				deadlineAt: new Date(row.deadlineAt),
				usageReservation: {
					id: row.usageReservationId,
					bucketId: row.usageBucketId,
					organizationId: row.organizationId,
				},
			};
			const updated = outcomeUnknown
				? await markToolJobOutcomeUnknown(env, claim, now)
				: await failToolJob(
						env,
						claim,
						"Tool processing deadline exceeded before provider egress",
						"PROCESSING_DEADLINE_EXCEEDED",
						{
							commit: false,
							reason: "pre_boundary",
							responseStatus: 504,
						},
						now,
						row.status,
					);
			completed += updated ? 1 : 0;
		} catch (error) {
			// A concurrent worker/operator can win either fence after discovery.
			// Keep maintenance progressing for the remainder of the bounded batch.
			console.error("Failed to terminalize expired tool job", {
				jobId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return completed;
}

export async function pruneExpiredToolJobs(
	env: Env,
	batchSize = 500,
	now = new Date(),
	organizationId?: string,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const limit = Math.min(Math.max(Math.trunc(batchSize), 1), 1_000);
	const rows = (await db.execute(sql`
		WITH expired AS (
			SELECT id
			  FROM ${toolJobs}
			 WHERE purge_at <= ${now}
			   AND status IN ('completed', 'failed', 'manual_review')
			   -- A manual-review job is the reconciliation handle for an unknown
			   -- provider outcome. Retention may delete it only after usage no
			   -- longer remains parked (definitive settlement or audited write-off).
			   AND NOT EXISTS (
					SELECT 1
					  FROM ${usageReservations} AS reservation
					 WHERE reservation.id = ${toolJobs.usageReservationId}
					   AND reservation.organization_id = ${toolJobs.organizationId}
					   AND reservation.state = 'parked'
			   )
			   ${organizationId ? sql`AND organization_id = ${organizationId}` : sql``}
			 ORDER BY purge_at ASC, id ASC
			 LIMIT ${limit}
			 FOR UPDATE SKIP LOCKED
		)
		DELETE FROM ${toolJobs} AS job
		 USING expired
		 WHERE job.id = expired.id
		RETURNING job.id
	`)) as unknown as Array<{ id: string }>;
	return rows.length;
}

export async function maintainToolJobs(env: Env): Promise<{
	failed: number;
	dispatched: number;
	staleReleased: number;
	staleParked: number;
	writtenOff: number;
	pruned: number;
}> {
	const failed = await failExpiredToolJobs(env);
	const dispatched = await dispatchDueToolJobs(env);
	const usageDb = createDb(env.HYPERDRIVE.connectionString);
	const { released: staleReleased, parked: staleParked } =
		await reconcileStaleReservedUsageReservations(usageDb);
	const writtenOff = await writeOffExpiredParkedUsageReservations(
		usageDb,
	);
	const pruned = await pruneExpiredToolJobs(env);
	return {
		failed,
		dispatched,
		staleReleased,
		staleParked,
		writtenOff,
		pruned,
	};
}
