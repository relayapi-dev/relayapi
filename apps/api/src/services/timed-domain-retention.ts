import {
	ads,
	createDb,
	type Database,
	externalPosts,
	externalSubjectCleanupJobs,
	generateId,
	sql,
} from "@relayapi/db";
import { and, inArray } from "drizzle-orm";
import type { Env } from "../types";
import { dispatchRetentionBacklogAlert } from "./operator-alerts";
import {
	PHONE_PROVISIONING_DETAIL_REDACTION_BATCH,
	PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES,
	redactExpiredPhoneProvisioningDetails,
} from "./phone-number-operations";

export const TIMED_DOMAIN_RETENTION_BATCH = 500;
export const TIMED_DOMAIN_RETENTION_MAX_PASSES = 4;
export const TIMED_DOMAIN_RETENTION_CRON = "0 9 * * *";
export const TIMED_DOMAIN_RETENTION_TASK = "timed_domain_retention";

const AI_FAILURE_REDACTED_DETAIL = "failure detail expired";

interface RetentionMutationRow {
	id: string;
	organization_id: string;
	retention_clock: Date | string;
}

interface ExternalPostRetentionCandidate extends RetentionMutationRow {
	workspace_id: string | null;
	social_account_id: string;
	preview_thumbnail_key: string | null;
}

export interface TimedDomainRetentionResult {
	processed: number;
	minimized: number;
	deleted: number;
	moreDue: boolean;
	oldestDueAt: string | null;
	oldestDueOrganizationId: string | null;
}

interface TimedDomainRetentionOptions {
	db?: Database;
	now?: Date;
}

interface MutableRetentionResult extends TimedDomainRetentionResult {
	capacityReached: boolean;
}

function emptyResult(): MutableRetentionResult {
	return {
		processed: 0,
		minimized: 0,
		deleted: 0,
		moreDue: false,
		oldestDueAt: null,
		oldestDueOrganizationId: null,
		capacityReached: false,
	};
}

function retentionClock(value: Date | string): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

function absorbRows(
	result: MutableRetentionResult,
	rows: readonly RetentionMutationRow[],
	action: "minimized" | "deleted",
): void {
	result.processed += rows.length;
	result[action] += rows.length;
	for (const row of rows) {
		const clock = retentionClock(row.retention_clock);
		if (!result.oldestDueAt || clock < result.oldestDueAt) {
			result.oldestDueAt = clock;
			result.oldestDueOrganizationId = row.organization_id;
		}
	}
}

function finishResult(
	result: MutableRetentionResult,
): TimedDomainRetentionResult {
	result.moreDue = result.capacityReached;
	const { capacityReached: _, ...finished } = result;
	return finished;
}

async function runMutationPasses(
	result: MutableRetentionResult,
	action: "minimized" | "deleted",
	mutate: () => Promise<readonly RetentionMutationRow[]>,
	options: { batch?: number; maxPasses?: number } = {},
): Promise<void> {
	const batch = options.batch ?? TIMED_DOMAIN_RETENTION_BATCH;
	const maxPasses = options.maxPasses ?? TIMED_DOMAIN_RETENTION_MAX_PASSES;
	for (let pass = 0; pass < maxPasses; pass++) {
		const rows = await mutate();
		absorbRows(result, rows, action);
		if (rows.length < batch) return;
		if (pass === maxPasses - 1) result.capacityReached = true;
	}
}

/**
 * Minimize superseded consent transitions without weakening current grant or
 * denial authority. The next transition's timestamp is the retention clock;
 * the immutable hashes, status, policy, source, and ordering tuple survive.
 * The privacy registry deliberately classifies this store as `minimize`: an
 * active hold preserves that minimal receipt, not stale contact detail.
 */
export async function retainSupersededContactConsentEvents(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "minimized", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT event.id,
				       event.organization_id,
				       superseding.occurred_at AS retention_clock
				  FROM contact_consent_events AS event
				  JOIN LATERAL (
						SELECT later.occurred_at
						  FROM contact_consent_events AS later
						 WHERE later.organization_id = event.organization_id
						   AND later.channel = event.channel
						   AND later.purpose = event.purpose
						   AND later.logical_identifier_hash =
						       event.logical_identifier_hash
						   AND (
								later.ordering_hlc,
								later.ordering_region,
								later.id
						   ) > (
								event.ordering_hlc,
								event.ordering_region,
								event.id
						   )
						 ORDER BY
							later.ordering_hlc,
							later.ordering_region,
							later.id
						 LIMIT 1
				  ) AS superseding ON TRUE
				 WHERE superseding.occurred_at <= ${now} - interval '2 years'
				   AND (
						event.contact_id IS NOT NULL
						OR event.identifier_masked IS NOT NULL
						OR event.evidence IS NOT NULL
				   )
				 ORDER BY superseding.occurred_at, event.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR UPDATE OF event SKIP LOCKED
			)
			UPDATE contact_consent_events AS event
			   SET contact_id = NULL,
			       identifier_masked = NULL,
			       evidence = NULL
			  FROM due
			 WHERE event.id = due.id
			RETURNING event.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/**
 * Recipient PII expires before the minimized delivery outcome. Deletion is
 * child-first relative to broadcasts and pauses for organization/workspace
 * holds; unresolved provider outcomes remain available for operator action.
 * A hold does not lengthen raw recipient-PII retention because this store's
 * declared treatment is `minimize`.
 */
export async function retainBroadcastRecipients(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "minimized", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT recipient.id,
				       recipient.organization_id,
				       parent.completed_at AS retention_clock
				  FROM broadcast_recipients AS recipient
				  JOIN broadcasts AS parent
				    ON parent.id = recipient.broadcast_id
				   AND parent.organization_id = recipient.organization_id
				   AND parent.scope_key = recipient.scope_key
				 WHERE recipient.status IN ('sent', 'failed', 'cancelled')
				   AND parent.completed_at <= ${now} - interval '30 days'
				   AND recipient.pii_erased_at IS NULL
				 ORDER BY parent.completed_at, recipient.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR KEY SHARE OF parent
				 FOR UPDATE OF recipient SKIP LOCKED
			)
			UPDATE broadcast_recipients AS recipient
			   SET contact_id = NULL,
			       contact_identifier = NULL,
			       variables = NULL,
			       error = NULL,
			       pii_erased_at = ${now}
			  FROM due
			 WHERE recipient.id = due.id
			RETURNING recipient.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	await runMutationPasses(result, "deleted", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT recipient.id,
				       recipient.organization_id,
				       parent.completed_at AS retention_clock
				  FROM broadcast_recipients AS recipient
				  JOIN broadcasts AS parent
				    ON parent.id = recipient.broadcast_id
				   AND parent.organization_id = recipient.organization_id
				   AND parent.scope_key = recipient.scope_key
				  JOIN auth.organization AS tenant
				    ON tenant.id = recipient.organization_id
				 WHERE recipient.status IN ('sent', 'failed', 'cancelled')
				   AND parent.completed_at <= ${now} - interval '1 year'
				   AND recipient.pii_erased_at IS NOT NULL
				   AND NOT EXISTS (
						SELECT 1
						  FROM erasure_holds AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id =
						       recipient.organization_id
						   AND (
								(hold.subject_kind = 'organization'
								 AND hold.subject_id = recipient.organization_id)
								OR (hold.subject_kind = 'workspace'
									AND hold.subject_id = parent.workspace_id)
						   )
				   )
				 ORDER BY parent.completed_at, recipient.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR SHARE OF tenant
				 FOR KEY SHARE OF parent
				 FOR UPDATE OF recipient SKIP LOCKED
			)
			DELETE FROM broadcast_recipients AS recipient
			 USING due
			 WHERE recipient.id = due.id
			RETURNING recipient.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/**
 * Completed campaign definitions expire only after their recipient rows have
 * drained. `requires_attention` is deliberately not terminal for retention.
 */
export async function retainBroadcasts(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "deleted", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT parent.id,
				       parent.organization_id,
				       parent.completed_at AS retention_clock
				  FROM broadcasts AS parent
				  JOIN auth.organization AS tenant
				    ON tenant.id = parent.organization_id
				 WHERE parent.status IN (
						'sent',
						'partially_failed',
						'failed',
						'cancelled'
				   )
				   AND parent.completed_at <= ${now} - interval '1 year'
				   AND NOT EXISTS (
						SELECT 1
						  FROM broadcast_recipients AS recipient
						 WHERE recipient.broadcast_id = parent.id
						   AND recipient.organization_id = parent.organization_id
				   )
				   AND NOT EXISTS (
						SELECT 1
						  FROM erasure_holds AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id =
						       parent.organization_id
						   AND (
								(hold.subject_kind = 'organization'
								 AND hold.subject_id = parent.organization_id)
								OR (hold.subject_kind = 'workspace'
									AND hold.subject_id = parent.workspace_id)
						   )
				   )
				 ORDER BY parent.completed_at, parent.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR SHARE OF tenant
				 FOR UPDATE OF parent SKIP LOCKED
			)
			DELETE FROM broadcasts AS parent
			 USING due
			 WHERE parent.id = due.id
			RETURNING parent.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/**
 * Delete a 25-month provider mirror only when no ad still references it.
 * Durable preview deletion is enqueued in the same transaction before the row
 * disappears, so a database retry cannot orphan an R2 object locator.
 *
 * One candidate produces at most two physical writes: its PostgreSQL delete
 * and, when it owns a preview, one bounded external-cleanup job insert.
 */
export async function retainExternalPosts(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	for (let pass = 0; pass < TIMED_DOMAIN_RETENTION_MAX_PASSES; pass++) {
		const rows = await db.transaction(async (tx) => {
			const candidates = (await tx.execute(sql`
				SELECT item.id,
				       item.organization_id,
				       item.workspace_id,
				       item.social_account_id,
				       item.preview_thumbnail_key,
				       item.published_at AS retention_clock
				  FROM external_posts AS item
				  JOIN auth.organization AS tenant
				    ON tenant.id = item.organization_id
				 WHERE item.published_at <= ${now} - interval '25 months'
				   AND NOT EXISTS (
						SELECT 1
						  FROM ads AS ad
						 WHERE ad.boost_external_post_id = item.id
				   )
				   AND NOT EXISTS (
						SELECT 1
						  FROM erasure_holds AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id =
						       item.organization_id
						   AND (
								(hold.subject_kind = 'organization'
								 AND hold.subject_id = item.organization_id)
								OR (hold.subject_kind = 'workspace'
									AND hold.subject_id = item.workspace_id)
						   )
				   )
				 ORDER BY item.published_at, item.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR SHARE OF tenant
				 FOR UPDATE OF item SKIP LOCKED
			`)) as unknown as ExternalPostRetentionCandidate[];
			if (candidates.length === 0) return [];

			const cleanupJobs = candidates.flatMap((candidate) =>
				candidate.preview_thumbnail_key
					? [
							{
								id: generateId("escj_"),
								organizationId: candidate.organization_id,
								workspaceId: candidate.workspace_id,
								subjectKind: "account" as const,
								subjectId: candidate.social_account_id,
								operation: "delete_exact" as const,
								bucket: "thumbnail" as const,
								objectLocator: candidate.preview_thumbnail_key,
								status: "pending" as const,
								nextAttemptAt: now,
								deadlineAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
								createdAt: now,
								updatedAt: now,
							},
						]
					: [],
			);
			if (cleanupJobs.length > 0) {
				await tx
					.insert(externalSubjectCleanupJobs)
					.values(cleanupJobs)
					.onConflictDoNothing();
			}

			const deleted = await tx
				.delete(externalPosts)
				.where(
					and(
						inArray(
							externalPosts.id,
							candidates.map(({ id }) => id),
						),
						sql`NOT EXISTS (
							SELECT 1
							  FROM ${ads} AS ad
							 WHERE ad.boost_external_post_id = ${externalPosts.id}
						)`,
					),
				)
				.returning({ id: externalPosts.id });
			const deletedIds = new Set(deleted.map(({ id }) => id));
			return candidates.filter(({ id }) => deletedIds.has(id));
		});
		absorbRows(result, rows, "deleted");
		if (rows.length < TIMED_DOMAIN_RETENTION_BATCH) break;
		if (pass === TIMED_DOMAIN_RETENTION_MAX_PASSES - 1) {
			result.capacityReached = true;
		}
	}

	return finishResult(result);
}

/** Keep current sync authority while removing free-form provider errors. */
export async function redactSocialAccountSyncErrors(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "minimized", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT item.id,
				       item.organization_id,
				       item.last_error_at AS retention_clock
				  FROM social_account_sync_state AS item
				 WHERE item.last_error IS NOT NULL
				   AND item.last_error_at <= ${now} - interval '90 days'
				 ORDER BY item.last_error_at, item.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR UPDATE OF item SKIP LOCKED
			)
			UPDATE social_account_sync_state AS item
			   SET last_error = NULL
			  FROM due
			 WHERE item.id = due.id
			RETURNING item.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/** Keep the binding definition and typed failure class, not old error prose. */
export async function redactAutomationBindingSyncErrors(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "minimized", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT item.id,
				       item.organization_id,
				       item.sync_error_at AS retention_clock
				  FROM automation_bindings AS item
				 WHERE item.sync_error IS NOT NULL
				   AND item.sync_error_at <= ${now} - interval '90 days'
				   AND NOT EXISTS (
						SELECT 1
						  FROM erasure_holds AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id = item.organization_id
						   AND (
								(hold.subject_kind = 'organization'
									AND hold.subject_id = item.organization_id)
								OR (hold.subject_kind = 'workspace'
									AND item.scope_key = 'ws/' || hold.subject_id)
						   )
				   )
				 ORDER BY item.sync_error_at, item.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR UPDATE OF item SKIP LOCKED
			)
			UPDATE automation_bindings AS item
			   SET sync_error = NULL,
			       sync_error_at = NULL
			  FROM due
			 WHERE item.id = due.id
			RETURNING item.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/**
 * A terminal failed document remains a user-visible entity. Replace only its
 * free-form failure detail; the stable error code and terminal state survive.
 */
export async function redactAiKnowledgeFailureDetails(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "minimized", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT item.id,
				       item.organization_id,
				       item.completed_at AS retention_clock
				  FROM ai_knowledge_documents AS item
				 WHERE item.status = 'terminal_failure'
				   AND item.completed_at <= ${now} - interval '90 days'
				   AND item.last_error <> ${AI_FAILURE_REDACTED_DETAIL}
				   AND NOT EXISTS (
						SELECT 1
						  FROM erasure_holds AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id = item.organization_id
						   AND (
								(hold.subject_kind = 'organization'
									AND hold.subject_id = item.organization_id)
								OR (hold.subject_kind = 'workspace'
									AND item.scope_key = 'ws/' || hold.subject_id)
						   )
				   )
				 ORDER BY item.completed_at, item.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR UPDATE OF item SKIP LOCKED
			)
			UPDATE ai_knowledge_documents AS item
			   SET last_error = ${AI_FAILURE_REDACTED_DETAIL}
			  FROM due
			 WHERE item.id = due.id
			RETURNING item.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/**
 * Provisioning is still the current read projection, so its row earns its
 * place. Seven-day checkout material shreds first; after one year only hashes,
 * provider locators, typed state, and timestamps remain.
 */
export async function retainTerminalPhoneProvisioningEvidence(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	const detailRedacted = await redactExpiredPhoneProvisioningDetails(env, {
		db,
		now,
	});
	result.processed += detailRedacted;
	result.minimized += detailRedacted;
	if (
		detailRedacted ===
		PHONE_PROVISIONING_DETAIL_REDACTION_BATCH *
			PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES
	) {
		result.capacityReached = true;
		const [oldest] = (await db.execute(sql`
			SELECT operation.organization_id,
			       operation.detail_expires_at AS retention_clock
			  FROM whatsapp_phone_provisioning_operations AS operation
			 WHERE operation.status IN ('completed', 'cancelled')
			   AND operation.detail_expires_at <= ${now}
			   AND operation.detail_redacted_at IS NULL
			 ORDER BY operation.detail_expires_at, operation.id
			 LIMIT 1
		`)) as unknown as RetentionMutationRow[];
		if (oldest) absorbRows(result, [oldest], "minimized");
		if (oldest) {
			result.processed -= 1;
			result.minimized -= 1;
		}
	}

	await runMutationPasses(result, "minimized", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT operation.id,
				       operation.organization_id,
				       CASE
							WHEN operation.status = 'completed'
								THEN operation.detail_expires_at - interval '7 days'
							ELSE operation.detail_expires_at
				       END AS retention_clock
				  FROM whatsapp_phone_provisioning_operations AS operation
				 WHERE operation.status IN ('completed', 'cancelled')
				   AND operation.detail_redacted_at IS NOT NULL
				   AND operation.detail_expires_at <=
				       ${now} - interval '358 days'
				   AND CASE
							WHEN operation.status = 'completed'
								THEN operation.detail_expires_at - interval '7 days'
							ELSE operation.detail_expires_at
				       END <= ${now} - interval '1 year'
				   AND (
						operation.stripe_checkout_session_id IS NOT NULL
						OR operation.last_error IS NOT NULL
				   )
				   AND (
						operation.usage_reservation_id IS NULL
						OR EXISTS (
							SELECT 1
							  FROM usage_reservations AS reservation
							 WHERE reservation.id = operation.usage_reservation_id
							   AND reservation.organization_id = operation.organization_id
							   AND reservation.state IN ('committed', 'released')
						)
				   )
				 ORDER BY operation.detail_expires_at, operation.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR UPDATE OF operation SKIP LOCKED
			)
			UPDATE whatsapp_phone_provisioning_operations AS operation
			   SET stripe_checkout_session_id = NULL,
			       last_error = NULL,
			       updated_at = ${now}
			  FROM due
			 WHERE operation.id = due.id
			RETURNING operation.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/** Completed release evidence is redundant with the phone's released state. */
export async function retainTerminalPhoneReleaseEvidence(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "deleted", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT operation.id,
				       operation.organization_id,
				       operation.completed_at AS retention_clock
				  FROM whatsapp_phone_release_operations AS operation
				  JOIN auth.organization AS tenant
				    ON tenant.id = operation.organization_id
				 WHERE operation.status = 'completed'
				   AND operation.completed_at <= ${now} - interval '1 year'
				   AND (
						operation.usage_reservation_id IS NULL
						OR EXISTS (
							SELECT 1
							  FROM usage_reservations AS reservation
							 WHERE reservation.id = operation.usage_reservation_id
							   AND reservation.organization_id = operation.organization_id
							   AND reservation.state IN ('committed', 'released')
						)
				   )
				   AND NOT EXISTS (
						SELECT 1
						  FROM erasure_holds AS hold
						 WHERE hold.released_at IS NULL
						   AND hold.organization_tombstone_id =
						       operation.organization_id
						   AND hold.subject_kind = 'organization'
						   AND hold.subject_id = operation.organization_id
				   )
				 ORDER BY operation.completed_at, operation.id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR SHARE OF tenant
				 FOR UPDATE OF operation SKIP LOCKED
			)
			DELETE FROM whatsapp_phone_release_operations AS operation
			 USING due
			 WHERE operation.id = due.id
			RETURNING operation.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

/**
 * Delete encrypted operator prose at its exact expiry. The immutable evidence
 * receipt remains independently useful through its closed reason code, digest,
 * scalar before/after state, and transition timestamps.
 *
 * Legal holds never extend this satellite: it is deliberately optional
 * explanatory text, not the authoritative operator decision.
 */
export async function retainOperatorResolutionNotes(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<TimedDomainRetentionResult> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const result = emptyResult();

	await runMutationPasses(result, "deleted", async () => {
		return (await db.execute(sql`
			WITH due AS (
				SELECT note.evidence_id AS id,
				       COALESCE(note.organization_id, '__system__') AS organization_id,
				       note.expires_at AS retention_clock
				  FROM operator_resolution_notes AS note
				 WHERE note.expires_at <= ${now}
				 ORDER BY note.expires_at, note.evidence_id
				 LIMIT ${TIMED_DOMAIN_RETENTION_BATCH}
				 FOR UPDATE OF note SKIP LOCKED
			)
			DELETE FROM operator_resolution_notes AS note
			 USING due
			 WHERE note.evidence_id = due.id
			RETURNING due.id,
			          due.organization_id,
			          due.retention_clock
		`)) as unknown as RetentionMutationRow[];
	});

	return finishResult(result);
}

interface TimedDomainRetentionRun {
	handlerId: string;
	storeId: `postgres:${string}`;
	hardLimit: number;
	run: (
		env: Env,
		options?: TimedDomainRetentionOptions,
	) => Promise<TimedDomainRetentionResult>;
}

const TIMED_DOMAIN_RETENTION_RUNS: readonly TimedDomainRetentionRun[] = [
	{
		handlerId: "retain_superseded_contact_consent_events",
		storeId: "postgres:public.contact_consent_events",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainSupersededContactConsentEvents,
	},
	{
		handlerId: "retain_broadcast_recipients",
		storeId: "postgres:public.broadcast_recipients",
		hardLimit:
			2 * TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainBroadcastRecipients,
	},
	{
		handlerId: "retain_broadcasts",
		storeId: "postgres:public.broadcasts",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainBroadcasts,
	},
	{
		handlerId: "retain_external_posts",
		storeId: "postgres:public.external_posts",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainExternalPosts,
	},
	{
		handlerId: "redact_social_account_sync_errors",
		storeId: "postgres:public.social_account_sync_state",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: redactSocialAccountSyncErrors,
	},
	{
		handlerId: "redact_automation_binding_sync_errors",
		storeId: "postgres:public.automation_bindings",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: redactAutomationBindingSyncErrors,
	},
	{
		handlerId: "redact_ai_knowledge_failure_details",
		storeId: "postgres:public.ai_knowledge_documents",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: redactAiKnowledgeFailureDetails,
	},
	{
		handlerId: "retain_terminal_phone_provisioning_evidence",
		storeId: "postgres:public.whatsapp_phone_provisioning_operations",
		hardLimit:
			PHONE_PROVISIONING_DETAIL_REDACTION_BATCH *
				PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES +
			TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainTerminalPhoneProvisioningEvidence,
	},
	{
		handlerId: "retain_terminal_phone_release_evidence",
		storeId: "postgres:public.whatsapp_phone_release_operations",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainTerminalPhoneReleaseEvidence,
	},
	{
		handlerId: "retain_operator_resolution_notes",
		storeId: "postgres:public.operator_resolution_notes",
		hardLimit: TIMED_DOMAIN_RETENTION_BATCH * TIMED_DOMAIN_RETENTION_MAX_PASSES,
		run: retainOperatorResolutionNotes,
	},
] as const;

export interface TimedDomainRetentionRunResult {
	handlerId: string;
	storeId: `postgres:${string}`;
	result: TimedDomainRetentionResult;
}

/** Canonical daily entry point and durable backlog-alert boundary. */
export async function retainTimedDomainData(
	env: Env,
	options?: TimedDomainRetentionOptions,
): Promise<readonly TimedDomainRetentionRunResult[]> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const results: TimedDomainRetentionRunResult[] = [];
	const alertFailures: unknown[] = [];

	for (const handler of TIMED_DOMAIN_RETENTION_RUNS) {
		const result = await handler.run(env, { db, now });
		results.push({
			handlerId: handler.handlerId,
			storeId: handler.storeId,
			result,
		});
		if (
			result.moreDue &&
			result.oldestDueAt &&
			result.oldestDueOrganizationId
		) {
			try {
				await dispatchRetentionBacklogAlert(
					{
						type: "retention_backlog",
						organizationId: result.oldestDueOrganizationId,
						storeId: handler.storeId,
						handlerId: handler.handlerId,
						processed: result.processed,
						hardLimit: handler.hardLimit,
						oldestDueAt: result.oldestDueAt,
						observedAt: now.toISOString(),
						occurrenceId: `retention:${handler.handlerId}:${now
							.toISOString()
							.slice(0, 10)}`,
					},
					env,
				);
			} catch (error) {
				alertFailures.push(error);
			}
		}
	}

	if (alertFailures.length > 0) {
		throw new AggregateError(
			alertFailures,
			`${alertFailures.length} timed-domain retention alert(s) failed`,
		);
	}
	return results;
}
