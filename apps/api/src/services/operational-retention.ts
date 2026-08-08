import {
	apiRequestLogs,
	automationEntrypointDailyCounts,
	createDb,
	type Database,
	emailDeliveries,
	erasureHolds,
	invitation,
	inviteTokens,
	inviteTokenWorkspaces,
	organizationCreationReservations,
	queueFailures,
	session,
	tenantDeletionJobs,
	tenantDeletionSteps,
	verification,
	workspaceErasureJobs,
	workspaceErasureSteps,
} from "@relayapi/db";
import {
	and,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { mapConcurrently } from "../lib/concurrency";
import { EMAIL_PROVIDER_MAX_ATTEMPTS } from "../lib/email-queue/policy";
import { dispatchEmailDelivery } from "../lib/email-queue/producer";
import type { Env } from "../types";

export const API_REQUEST_LOG_RETENTION_DAYS = 90;
export const API_REQUEST_LOG_DELETE_BATCH = 5_000;
export const API_REQUEST_LOG_MAX_DELETE_PASSES = 20;
export const AUTH_EPHEMERAL_DELETE_BATCH = 5_000;
export const AUTH_EPHEMERAL_MAX_DELETE_PASSES = 20;
export const TERMINAL_INVITATION_RETENTION_DAYS = 30;
export const TERMINAL_ERASURE_STEP_RETENTION_DAYS = 90;
export const ERASURE_STEP_RETENTION_DELETE_BATCH = 5_000;
export const ERASURE_STEP_RETENTION_MAX_DELETE_PASSES = 20;

export interface AuthEphemeralRetentionResult {
	sessions: number;
	verification: number;
	organizationCreationReservations: number;
	invitations: number;
	inviteTokens: number;
}

export interface ErasureStepRetentionResult {
	tenantSteps: number;
	workspaceSteps: number;
}

export const EMAIL_RETENTION_DELETE_BATCH = 5_000;
export const EMAIL_RETENTION_MAX_DELETE_PASSES = 20;
export const EMAIL_DISPATCH_RECOVERY_LIMIT = 100;
export const EMAIL_DISPATCH_OWNER_CAP = 5;
export const EMAIL_DISPATCH_RECOVERY_CONCURRENCY = 4;

export interface EmailRetentionResult {
	redacted: number;
	deleted: number;
}

export const QUEUE_FAILURE_RETENTION_BATCH = 5_000;
export const QUEUE_FAILURE_RETENTION_MAX_PASSES = 20;

export interface QueueFailureRetentionResult {
	redacted: number;
	deleted: number;
}

export const AUTOMATION_DAILY_COUNT_RETENTION_DAYS = 90;
export const AUTOMATION_DAILY_COUNT_DELETE_BATCH = 5_000;
export const AUTOMATION_DAILY_COUNT_MAX_DELETE_PASSES = 20;

/**
 * Recover PostgreSQL email outbox rows whose initial Queue handoff was
 * interrupted. The rank is per owner, so one noisy organization or identity cannot own
 * the whole bounded batch.
 */
export async function recoverEmailDispatches(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<number> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	await db
		.update(emailDeliveries)
		.set({
			status: sql`CASE
				WHEN ${emailDeliveries.requestMayHaveBeenSentAt} IS NULL
					THEN 'pending'
				ELSE 'unknown'
			END`,
			leaseExpiresAt: null,
			nextAttemptAt: now,
			nextDispatchAt: now,
			error: "Recovered an expired provider-attempt lease",
		})
		.where(
			and(
				eq(emailDeliveries.status, "processing"),
				lte(emailDeliveries.leaseExpiresAt, now),
			),
		);
	await db
		.update(emailDeliveries)
		.set({
			status: "manual_review",
			leaseExpiresAt: null,
			dispatchLeaseExpiresAt: null,
			error: "Email delivery exhausted its provider-attempt budget or deadline",
			completedAt: now,
		})
		.where(
			and(
				inArray(emailDeliveries.status, ["pending", "unknown"]),
				or(
					lte(emailDeliveries.deadlineAt, now),
					sql`${emailDeliveries.providerAttempts} >= ${EMAIL_PROVIDER_MAX_ATTEMPTS}`,
				),
			),
		);
	const candidates = (await db.execute(sql`
		WITH ranked AS (
			SELECT delivery.id,
			       row_number() OVER (
				       PARTITION BY delivery.intent,
				                    COALESCE(delivery.organization_id, delivery.auth_user_id)
				       ORDER BY delivery.next_dispatch_at, delivery.created_at, delivery.id
			       ) AS owner_rank
			  FROM ${emailDeliveries} AS delivery
			 WHERE delivery.status IN ('pending', 'unknown')
			   AND delivery.next_dispatch_at <= ${now}
			   AND delivery.provider_attempts < ${EMAIL_PROVIDER_MAX_ATTEMPTS}
			   AND delivery.deadline_at > ${now}
			   AND (delivery.dispatch_lease_expires_at IS NULL
			        OR delivery.dispatch_lease_expires_at <= ${now})
			   AND (delivery.status = 'pending'
			        OR delivery.next_attempt_at <= ${now})
		)
		SELECT id
		  FROM ranked
		 WHERE owner_rank <= ${EMAIL_DISPATCH_OWNER_CAP}
		 ORDER BY owner_rank, id
		 LIMIT ${EMAIL_DISPATCH_RECOVERY_LIMIT}
	`)) as unknown as Array<{ id: string }>;

	const outcomes = await mapConcurrently(
		candidates,
		EMAIL_DISPATCH_RECOVERY_CONCURRENCY,
		async (candidate) => {
			try {
				return {
					dispatched:
						(await dispatchEmailDelivery(env, candidate.id, db)) ===
						"dispatched",
					error: null,
				};
			} catch (error) {
				return { dispatched: false, error };
			}
		},
	);
	const failures = outcomes.filter(
		(outcome): outcome is { dispatched: false; error: unknown } =>
			outcome.error !== null,
	);
	if (failures.length > 0) {
		throw new AggregateError(
			failures.map(({ error }) => error),
			`${failures.length} email dispatch recovery attempt(s) failed`,
		);
	}
	return outcomes.filter(({ dispatched }) => dispatched).length;
}

/**
 * Shred recipient/content envelopes after 30 days and drain minimized delivery
 * metadata after 90 days. An active organization hold retains only the already
 * redacted receipt; it never extends the encrypted envelope.
 */
export async function retainEmailDeliveries(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<EmailRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	let redacted = 0;
	let deleted = 0;

	for (let pass = 0; pass < EMAIL_RETENTION_MAX_DELETE_PASSES; pass++) {
		const rows = await db
			.update(emailDeliveries)
			.set({
				envelopeCiphertext: null,
				envelopeKeyId: null,
				status: sql`CASE
					WHEN ${emailDeliveries.status} IN ('sent', 'failed', 'manual_review')
						THEN ${emailDeliveries.status}
					ELSE 'manual_review'
				END`,
				leaseExpiresAt: null,
				dispatchLeaseExpiresAt: null,
				completedAt: sql`COALESCE(${emailDeliveries.completedAt}, ${now})`,
				error: sql`COALESCE(${emailDeliveries.error}, 'delivery envelope expired')`,
				redactedAt: now,
			})
			.where(
				inArray(
					emailDeliveries.id,
					db
						.select({ id: emailDeliveries.id })
						.from(emailDeliveries)
						.where(
							and(
								lte(emailDeliveries.expiresAt, now),
								isNull(emailDeliveries.redactedAt),
							),
						)
						.orderBy(emailDeliveries.expiresAt, emailDeliveries.id)
						.limit(EMAIL_RETENTION_DELETE_BATCH),
				),
			)
			.returning({ id: emailDeliveries.id });
		redacted += rows.length;
		if (rows.length < EMAIL_RETENTION_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < EMAIL_RETENTION_MAX_DELETE_PASSES; pass++) {
		const rows = await db
			.delete(emailDeliveries)
			.where(
				inArray(
					emailDeliveries.id,
					db
						.select({ id: emailDeliveries.id })
						.from(emailDeliveries)
						.where(
							and(
								lte(emailDeliveries.purgeAt, now),
								isNotNull(emailDeliveries.redactedAt),
								sql`NOT EXISTS (
									SELECT 1
									  FROM ${erasureHolds} AS hold
									 WHERE hold.subject_kind = 'organization'
									   AND hold.subject_id = ${emailDeliveries.organizationId}
									   AND hold.organization_tombstone_id = ${emailDeliveries.organizationId}
									   AND hold.released_at IS NULL
								)`,
							),
						)
						.orderBy(emailDeliveries.purgeAt, emailDeliveries.id)
						.limit(EMAIL_RETENTION_DELETE_BATCH),
				),
			)
			.returning({ id: emailDeliveries.id });
		deleted += rows.length;
		if (rows.length < EMAIL_RETENTION_DELETE_BATCH) break;
	}

	return { redacted, deleted };
}

/**
 * Shred replay payloads at 30 days even when a tenant is under legal hold.
 * A hold can preserve the minimized operational receipt, but it cannot extend
 * the lifetime of credentials, webhook bodies, or other secret queue input.
 * Rows whose payload expires before resolution become dismissed because replay
 * is no longer possible. Minimized receipts drain at 90 days unless an active
 * organization/workspace hold matches one of their typed locators.
 */
export async function retainQueueFailures(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<QueueFailureRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	let redacted = 0;
	let deleted = 0;

	for (let pass = 0; pass < QUEUE_FAILURE_RETENTION_MAX_PASSES; pass++) {
		const rows = await db
			.update(queueFailures)
			.set({
				payloadCiphertext: null,
				payloadKeyId: null,
				payloadRedactedAt: now,
				status: sql`CASE
					WHEN ${queueFailures.status} IN ('replayed', 'dismissed')
						THEN ${queueFailures.status}
					ELSE 'dismissed'
				END`,
				replayClaimToken: null,
				replayClaimExpiresAt: null,
				resolvedAt: sql`COALESCE(${queueFailures.resolvedAt}, ${now})`,
				error: sql`COALESCE(${queueFailures.error}, 'queue payload expired')`,
			})
			.where(
				inArray(
					queueFailures.id,
					db
						.select({ id: queueFailures.id })
						.from(queueFailures)
						.where(
							and(
								lte(queueFailures.payloadExpiresAt, now),
								isNull(queueFailures.payloadRedactedAt),
							),
						)
						.orderBy(queueFailures.payloadExpiresAt, queueFailures.id)
						.limit(QUEUE_FAILURE_RETENTION_BATCH),
				),
			)
			.returning({ id: queueFailures.id });
		redacted += rows.length;
		if (rows.length < QUEUE_FAILURE_RETENTION_BATCH) break;
	}

	for (let pass = 0; pass < QUEUE_FAILURE_RETENTION_MAX_PASSES; pass++) {
		const rows = await db
			.delete(queueFailures)
			.where(
				inArray(
					queueFailures.id,
					db
						.select({ id: queueFailures.id })
						.from(queueFailures)
						.where(
							and(
								lte(queueFailures.purgeAt, now),
								isNotNull(queueFailures.payloadRedactedAt),
								sql`NOT EXISTS (
									SELECT 1
									  FROM ${erasureHolds} AS hold
									 WHERE hold.released_at IS NULL
									   AND (
										   (
											   hold.subject_kind = 'organization'
											   AND hold.subject_id = ANY(${queueFailures.organizationIds})
											   AND hold.organization_tombstone_id = hold.subject_id
										   )
										   OR (
											   hold.subject_kind = 'workspace'
											   AND hold.subject_id = ANY(${queueFailures.workspaceIds})
											   AND hold.organization_tombstone_id = ANY(${queueFailures.organizationIds})
										   )
									   )
								)`,
							),
						)
						.orderBy(queueFailures.purgeAt, queueFailures.id)
						.limit(QUEUE_FAILURE_RETENTION_BATCH),
				),
			)
			.returning({ id: queueFailures.id });
		deleted += rows.length;
		if (rows.length < QUEUE_FAILURE_RETENTION_BATCH) break;
	}

	return { redacted, deleted };
}

/**
 * Drain admission counters once they can no longer affect the current
 * calendar-day cap. Rows are already minimized aggregate evidence. Active
 * organization/workspace holds may preserve that receipt, but ordinary data
 * is deleted in bounded, oldest-first pages after 90 UTC days.
 */
export async function pruneAutomationEntrypointDailyCounts(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<number> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const cutoff = new Date(
		now.getTime() -
			AUTOMATION_DAILY_COUNT_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	)
		.toISOString()
		.slice(0, 10);
	let deletedCount = 0;

	for (let pass = 0; pass < AUTOMATION_DAILY_COUNT_MAX_DELETE_PASSES; pass++) {
		const deleted = await db
			.delete(automationEntrypointDailyCounts)
			.where(
				inArray(
					automationEntrypointDailyCounts.id,
					db
						.select({ id: automationEntrypointDailyCounts.id })
						.from(automationEntrypointDailyCounts)
						.where(
							and(
								lt(automationEntrypointDailyCounts.day, cutoff),
								sql`NOT EXISTS (
									SELECT 1
									  FROM ${erasureHolds} AS hold
									 WHERE hold.released_at IS NULL
									   AND hold.organization_tombstone_id =
										   ${automationEntrypointDailyCounts.organizationId}
									   AND (
										   (
											   hold.subject_kind = 'organization'
											   AND hold.subject_id =
												   ${automationEntrypointDailyCounts.organizationId}
										   )
										   OR (
											   hold.subject_kind = 'workspace'
											   AND ${automationEntrypointDailyCounts.scopeKey}
												   = 'ws/' || hold.subject_id
										   )
									   )
								)`,
							),
						)
						.orderBy(
							automationEntrypointDailyCounts.day,
							automationEntrypointDailyCounts.id,
						)
						.limit(AUTOMATION_DAILY_COUNT_DELETE_BATCH),
				),
			)
			.returning({ id: automationEntrypointDailyCounts.id });
		deletedCount += deleted.length;
		if (deleted.length < AUTOMATION_DAILY_COUNT_DELETE_BATCH) break;
	}

	return deletedCount;
}

/**
 * Total drain for Better Auth's ephemeral database state.
 *
 * Better Auth opportunistically removes records when a capability is read,
 * which is not a retention guarantee for abandoned tokens. The daily worker
 * deletes expired verification/reset/OAuth rows and quota reservations in
 * bounded pages. Directed invitations retain a 30-day post-expiry receipt.
 */
export async function pruneExpiredAuthState(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<AuthEphemeralRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const invitationCutoff = new Date(
		now.getTime() - TERMINAL_INVITATION_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	);
	const result: AuthEphemeralRetentionResult = {
		sessions: 0,
		verification: 0,
		organizationCreationReservations: 0,
		invitations: 0,
		inviteTokens: 0,
	};

	for (let pass = 0; pass < AUTH_EPHEMERAL_MAX_DELETE_PASSES; pass++) {
		const deleted = await db
			.delete(session)
			.where(
				inArray(
					session.id,
					db
						.select({ id: session.id })
						.from(session)
						.where(lte(session.expiresAt, now))
						.orderBy(session.expiresAt, session.id)
						.limit(AUTH_EPHEMERAL_DELETE_BATCH),
				),
			)
			.returning({ id: session.id });
		result.sessions += deleted.length;
		if (deleted.length < AUTH_EPHEMERAL_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < AUTH_EPHEMERAL_MAX_DELETE_PASSES; pass++) {
		const deleted = await db
			.delete(verification)
			.where(
				inArray(
					verification.id,
					db
						.select({ id: verification.id })
						.from(verification)
						.where(lte(verification.expiresAt, now))
						.orderBy(verification.expiresAt, verification.id)
						.limit(AUTH_EPHEMERAL_DELETE_BATCH),
				),
			)
			.returning({ id: verification.id });
		result.verification += deleted.length;
		if (deleted.length < AUTH_EPHEMERAL_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < AUTH_EPHEMERAL_MAX_DELETE_PASSES; pass++) {
		const deleted = await db
			.delete(organizationCreationReservations)
			.where(
				inArray(
					organizationCreationReservations.id,
					db
						.select({ id: organizationCreationReservations.id })
						.from(organizationCreationReservations)
						.where(lte(organizationCreationReservations.expiresAt, now))
						.orderBy(
							organizationCreationReservations.expiresAt,
							organizationCreationReservations.id,
						)
						.limit(AUTH_EPHEMERAL_DELETE_BATCH),
				),
			)
			.returning({ id: organizationCreationReservations.id });
		result.organizationCreationReservations += deleted.length;
		if (deleted.length < AUTH_EPHEMERAL_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < AUTH_EPHEMERAL_MAX_DELETE_PASSES; pass++) {
		const deleted = await db
			.delete(invitation)
			.where(
				inArray(
					invitation.id,
					db
						.select({ id: invitation.id })
						.from(invitation)
						.where(lte(invitation.expiresAt, invitationCutoff))
						.orderBy(invitation.expiresAt, invitation.id)
						.limit(AUTH_EPHEMERAL_DELETE_BATCH),
				),
			)
			.returning({ id: invitation.id });
		result.invitations += deleted.length;
		if (deleted.length < AUTH_EPHEMERAL_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < AUTH_EPHEMERAL_MAX_DELETE_PASSES; pass++) {
		const deleted = (await db.execute(sql`
			WITH due AS (
				SELECT child.organization_id,
				       child.invite_token_id,
				       child.workspace_id
				  FROM ${inviteTokenWorkspaces} AS child
				  JOIN ${inviteTokens} AS token
				    ON token.id = child.invite_token_id
				   AND token.organization_id = child.organization_id
				 WHERE token.expires_at <= ${invitationCutoff}
				    OR token.used_at <= ${invitationCutoff}
				 ORDER BY token.expires_at,
				          child.invite_token_id,
				          child.workspace_id
				 LIMIT ${AUTH_EPHEMERAL_DELETE_BATCH}
				 FOR UPDATE OF child SKIP LOCKED
			)
			DELETE FROM ${inviteTokenWorkspaces} AS child
			 USING due
			 WHERE child.organization_id = due.organization_id
			   AND child.invite_token_id = due.invite_token_id
			   AND child.workspace_id = due.workspace_id
			RETURNING child.invite_token_id
		`)) as unknown as Array<{ invite_token_id: string }>;
		if (deleted.length < AUTH_EPHEMERAL_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < AUTH_EPHEMERAL_MAX_DELETE_PASSES; pass++) {
		const deleted = (await db.execute(sql`
			WITH due AS (
				SELECT token.id
				  FROM ${inviteTokens} AS token
				 WHERE (
						token.expires_at <= ${invitationCutoff}
						OR token.used_at <= ${invitationCutoff}
				 )
				   AND NOT EXISTS (
						SELECT 1
						  FROM ${inviteTokenWorkspaces} AS child
						 WHERE child.invite_token_id = token.id
						   AND child.organization_id = token.organization_id
				   )
				 ORDER BY token.expires_at, token.id
				 LIMIT ${AUTH_EPHEMERAL_DELETE_BATCH}
				 FOR UPDATE OF token SKIP LOCKED
			)
			DELETE FROM ${inviteTokens} AS token
			 USING due
			 WHERE token.id = due.id
			RETURNING token.id
		`)) as unknown as Array<{ id: string }>;
		result.inviteTokens += deleted.length;
		if (deleted.length < AUTH_EPHEMERAL_DELETE_BATCH) break;
	}

	return result;
}

/**
 * Remove detailed phase/cursor/error rows after a completed erasure has kept
 * them for 90 days. The minimized job and workspace tombstone remain. Active
 * organization/workspace holds pause only their matching completed detail.
 */
export async function pruneCompletedErasureSteps(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<ErasureStepRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const cutoff = new Date(
		now.getTime() - TERMINAL_ERASURE_STEP_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	);
	const result: ErasureStepRetentionResult = {
		tenantSteps: 0,
		workspaceSteps: 0,
	};

	for (let pass = 0; pass < ERASURE_STEP_RETENTION_MAX_DELETE_PASSES; pass++) {
		const deleted = (await db.execute(sql`
			WITH due AS (
				SELECT step.id
				  FROM ${tenantDeletionSteps} AS step
				  JOIN ${tenantDeletionJobs} AS job
				    ON job.organization_id = step.organization_id
				 WHERE step.status = 'completed'
				   AND step.completed_at <= ${cutoff}
				   AND job.status = 'purged'
				   AND NOT EXISTS (
						SELECT 1
						  FROM ${erasureHolds} AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id = step.organization_id
				   )
				 ORDER BY step.completed_at, step.id
				 LIMIT ${ERASURE_STEP_RETENTION_DELETE_BATCH}
			)
			DELETE FROM ${tenantDeletionSteps} AS step
			 USING due
			 WHERE step.id = due.id
			RETURNING step.id
		`)) as unknown as Array<{ id: string }>;
		result.tenantSteps += deleted.length;
		if (deleted.length < ERASURE_STEP_RETENTION_DELETE_BATCH) break;
	}

	for (let pass = 0; pass < ERASURE_STEP_RETENTION_MAX_DELETE_PASSES; pass++) {
		const deleted = (await db.execute(sql`
			WITH due AS (
				SELECT step.id
				  FROM ${workspaceErasureSteps} AS step
				  JOIN ${workspaceErasureJobs} AS job
				    ON job.workspace_id = step.workspace_id
				   AND job.organization_id = step.organization_id
				   AND job.scope_key = step.scope_key
				 WHERE step.status = 'completed'
				   AND step.completed_at <= ${cutoff}
				   AND job.status = 'purged'
				   AND NOT EXISTS (
						SELECT 1
						  FROM ${erasureHolds} AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id = step.organization_id
						   AND (
								(hold.subject_kind = 'organization'
								 AND hold.subject_id = step.organization_id)
								OR (hold.subject_kind = 'workspace'
									AND hold.subject_id = step.workspace_id)
						   )
				   )
				 ORDER BY step.completed_at, step.id
				 LIMIT ${ERASURE_STEP_RETENTION_DELETE_BATCH}
			)
			DELETE FROM ${workspaceErasureSteps} AS step
			 USING due
			 WHERE step.id = due.id
			RETURNING step.id
		`)) as unknown as Array<{ id: string }>;
		result.workspaceSteps += deleted.length;
		if (deleted.length < ERASURE_STEP_RETENTION_DELETE_BATCH) break;
	}

	return result;
}

/**
 * Total, deployment-neutral retention for the request ledger.
 *
 * The middleware writes this table in hosted and self-hosted deployments, so
 * billing must not own its drain. Each daily invocation has an exact statement
 * and row bound; a backlog remains visible as repeated scheduled-task failures
 * instead of turning one cron into an unbounded delete.
 */
export async function pruneApiRequestLogs(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<number> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const cutoff = new Date(
		now.getTime() - API_REQUEST_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	);
	let deletedCount = 0;

	for (let pass = 0; pass < API_REQUEST_LOG_MAX_DELETE_PASSES; pass++) {
		const deleted = await db
			.delete(apiRequestLogs)
			.where(
				inArray(
					apiRequestLogs.id,
					db
						.select({ id: apiRequestLogs.id })
						.from(apiRequestLogs)
						.where(
							and(
								lt(apiRequestLogs.createdAt, cutoff),
								sql`NOT EXISTS (
									SELECT 1
									  FROM ${erasureHolds} AS hold
									 WHERE hold.released_at IS NULL
									   AND hold.organization_tombstone_id =
										   ${apiRequestLogs.organizationId}
									   AND hold.subject_kind = 'organization'
									   AND hold.subject_id =
										   ${apiRequestLogs.organizationId}
								)`,
							),
						)
						.orderBy(apiRequestLogs.createdAt, apiRequestLogs.id)
						.limit(API_REQUEST_LOG_DELETE_BATCH),
				),
			)
			.returning({ id: apiRequestLogs.id });
		deletedCount += deleted.length;
		if (deleted.length < API_REQUEST_LOG_DELETE_BATCH) break;
	}

	if (
		deletedCount ===
		API_REQUEST_LOG_DELETE_BATCH * API_REQUEST_LOG_MAX_DELETE_PASSES
	) {
		console.warn("[Operational retention] request-log backlog remains", {
			deletedCount,
			cutoff: cutoff.toISOString(),
		});
	}
	return deletedCount;
}
