import { createDb } from "@relayapi/db";
import { sql } from "drizzle-orm";
import type { Env } from "../types";

export const CUSTOMER_WEBHOOK_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_BATCH = 5_000;
const MAX_RETENTION_BATCH = 5_000;

/**
 * Delete bounded terminal customer-webhook history after its public retention
 * window. Known-not-sent manual review has its own durable deadline and is
 * terminalized first, so an unattended operator queue cannot retain payloads
 * forever. A recent attempt still keeps its parent event.
 */
export async function cleanupCustomerWebhookHistory(
	env: Env,
	limit = DEFAULT_RETENTION_BATCH,
	now = new Date(),
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const boundedLimit = Math.max(1, Math.min(limit, MAX_RETENTION_BATCH));
	const cutoff = new Date(
		now.getTime() - CUSTOMER_WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
	);

	return db.transaction(async (tx) => {
		// Manual review is a bounded intervention window, not a terminal status.
		// Take the same organization lock used by hold placement, re-evaluate
		// the hold, and preserve the truthful `unresolved` outcome when an
		// HTTP-boundary ambiguity reaches its deadline.
		await tx.execute(sql`
				WITH candidates AS MATERIALIZED (
					SELECT delivery.id, delivery.organization_id
					  FROM webhook_deliveries AS delivery
					 WHERE delivery.status = 'manual_review'
					   AND delivery.manual_review_reason IN (
							'pre_http_repair_exhausted',
							'http_outcome_unknown'
					   )
					   AND delivery.manual_review_until <= ${now}
					 ORDER BY delivery.manual_review_until, delivery.id
					 LIMIT ${boundedLimit}
				),
				locked_organizations AS MATERIALIZED (
					SELECT tenant.id
					  FROM organization AS tenant
					 WHERE tenant.id IN (
							SELECT candidate.organization_id
							  FROM candidates AS candidate
					 )
					 ORDER BY tenant.id
					 FOR SHARE OF tenant
				),
				due AS (
					SELECT delivery.id, delivery.manual_review_reason
					  FROM webhook_deliveries AS delivery
					  JOIN webhook_events AS event
					    ON event.id = delivery.webhook_event_id
					   AND event.organization_id = delivery.organization_id
					  JOIN locked_organizations AS tenant
					    ON tenant.id = delivery.organization_id
					 WHERE delivery.id IN (
							SELECT candidate.id
							  FROM candidates AS candidate
					 )
					   AND delivery.status = 'manual_review'
					   AND delivery.manual_review_reason IN (
							'pre_http_repair_exhausted',
							'http_outcome_unknown'
					   )
					   AND delivery.manual_review_until <= ${now}
					   AND NOT EXISTS (
							SELECT 1
							  FROM erasure_holds AS hold
							 WHERE hold.released_at IS NULL
							   AND hold.organization_tombstone_id = event.organization_id
							   AND (
									(hold.subject_kind = 'organization'
										AND hold.subject_id = event.organization_id)
									OR (hold.subject_kind = 'workspace'
										AND hold.subject_id = event.workspace_id)
							   )
					   )
					 ORDER BY delivery.manual_review_until, delivery.id
					 FOR UPDATE OF delivery SKIP LOCKED
				)
				UPDATE webhook_deliveries AS delivery
				   SET status = CASE
				                  WHEN due.manual_review_reason = 'http_outcome_unknown'
				                   THEN 'unresolved'
				                  ELSE 'failed'
				                END,
				       lease_token = delivery.lease_token + 1,
				       lease_expires_at = NULL,
				       claimed_at = NULL,
				       completed_at = ${now},
				       manual_review_reason = NULL,
				       manual_review_until = NULL,
				       error = CASE
				                 WHEN due.manual_review_reason = 'http_outcome_unknown'
				                  THEN 'Ambiguous delivery review window expired without operator resolution'
				                 ELSE 'Known-not-sent delivery review window expired'
				               END,
				       next_attempt_at = ${now},
			       dispatch_lease_id = NULL,
			       dispatch_lease_expires_at = NULL,
			       next_dispatch_at = ${now},
			       last_enqueued_at = NULL,
			       updated_at = ${now}
				  FROM due
				 WHERE delivery.id = due.id
				   AND delivery.status = 'manual_review'
				   AND delivery.manual_review_until <= ${now}
				RETURNING delivery.id
			`);

		// Pick only roots whose complete child history has reached the same
		// seven-day clock. This prevents a recent attempt or unresolved delivery
		// from being consumed merely because its parent occurrence is old.
		const candidates = (await tx.execute(sql`
			SELECT event.id, event.organization_id
			  FROM webhook_events AS event
			 WHERE event.created_at < ${cutoff}
			   AND NOT EXISTS (
					SELECT 1
					  FROM erasure_holds AS hold
					 WHERE hold.released_at IS NULL
					   AND hold.organization_tombstone_id = event.organization_id
					   AND (
							(hold.subject_kind = 'organization'
								AND hold.subject_id = event.organization_id)
							OR (hold.subject_kind = 'workspace'
								AND hold.subject_id = event.workspace_id)
					   )
			   )
			   AND NOT EXISTS (
					SELECT 1
					  FROM webhook_deliveries AS delivery
					 WHERE delivery.webhook_event_id = event.id
					   AND delivery.organization_id = event.organization_id
					   AND (
								delivery.status NOT IN ('succeeded', 'failed', 'unresolved')
							OR delivery.completed_at IS NULL
							OR delivery.completed_at >= ${cutoff}
					   )
			   )
			   AND NOT EXISTS (
					SELECT 1
					  FROM webhook_logs AS log
					 WHERE log.webhook_event_id = event.id
					   AND log.organization_id = event.organization_id
					   AND log.created_at >= ${cutoff}
			   )
			 ORDER BY event.created_at, event.id
			 LIMIT ${boundedLimit}
		`)) as unknown as Array<{ id: string; organization_id: string }>;
		if (candidates.length === 0) return 0;

		const organizationIds = [
			...new Set(candidates.map(({ organization_id }) => organization_id)),
		].sort();
		await tx.execute(sql`
			SELECT id
			  FROM organization
			 WHERE id = ANY(${organizationIds}::text[])
			 ORDER BY id
			 FOR SHARE
		`);

		// Re-evaluate holds and due clocks after taking the same organization
		// lock used by hold placement, then lock the event roots. FK inserts take
		// a conflicting key-share lock, so no late child can appear while this
		// child-first drain and root delete are in flight.
		const locked = (await tx.execute(sql`
			SELECT event.id
			  FROM webhook_events AS event
			 WHERE event.id = ANY(${candidates.map(({ id }) => id)}::text[])
			   AND event.created_at < ${cutoff}
			   AND NOT EXISTS (
					SELECT 1
					  FROM erasure_holds AS hold
					 WHERE hold.released_at IS NULL
					   AND hold.organization_tombstone_id = event.organization_id
					   AND (
							(hold.subject_kind = 'organization'
								AND hold.subject_id = event.organization_id)
							OR (hold.subject_kind = 'workspace'
								AND hold.subject_id = event.workspace_id)
					   )
			   )
			   AND NOT EXISTS (
					SELECT 1
					  FROM webhook_deliveries AS delivery
					 WHERE delivery.webhook_event_id = event.id
					   AND delivery.organization_id = event.organization_id
					   AND (
								delivery.status NOT IN ('succeeded', 'failed', 'unresolved')
							OR delivery.completed_at IS NULL
							OR delivery.completed_at >= ${cutoff}
					   )
			   )
			   AND NOT EXISTS (
					SELECT 1
					  FROM webhook_logs AS log
					 WHERE log.webhook_event_id = event.id
					   AND log.organization_id = event.organization_id
					   AND log.created_at >= ${cutoff}
			   )
			 ORDER BY event.created_at, event.id
			 FOR UPDATE OF event SKIP LOCKED
		`)) as unknown as Array<{ id: string }>;
		const eventIds = locked.map(({ id }) => id);
		if (eventIds.length === 0) return 0;

		await tx.execute(sql`
			WITH due AS (
				SELECT log.id
				  FROM webhook_logs AS log
				 WHERE log.webhook_event_id = ANY(${eventIds}::text[])
				   AND log.created_at < ${cutoff}
				 ORDER BY log.created_at, log.id
				 LIMIT ${boundedLimit}
				 FOR UPDATE OF log SKIP LOCKED
			)
			DELETE FROM webhook_logs AS log
			 USING due
			 WHERE log.id = due.id
		`);

		await tx.execute(sql`
			WITH due AS (
				SELECT delivery.id
				  FROM webhook_deliveries AS delivery
				 WHERE delivery.webhook_event_id = ANY(${eventIds}::text[])
					   AND delivery.status IN ('succeeded', 'failed', 'unresolved')
				   AND delivery.completed_at < ${cutoff}
				   AND NOT EXISTS (
						SELECT 1
						  FROM webhook_logs AS log
						 WHERE log.delivery_id = delivery.id
				   )
				 ORDER BY delivery.completed_at, delivery.id
				 LIMIT ${boundedLimit}
				 FOR UPDATE OF delivery SKIP LOCKED
			)
			DELETE FROM webhook_deliveries AS delivery
			 USING due
			 WHERE delivery.id = due.id
		`);

		const deleted = (await tx.execute(sql`
			WITH due AS (
				SELECT event.id
				  FROM webhook_events AS event
				 WHERE event.id = ANY(${eventIds}::text[])
				   AND NOT EXISTS (
						SELECT 1
						  FROM webhook_logs AS log
						 WHERE log.webhook_event_id = event.id
				   )
				   AND NOT EXISTS (
						SELECT 1
						  FROM webhook_deliveries AS delivery
						 WHERE delivery.webhook_event_id = event.id
				   )
				 ORDER BY event.created_at, event.id
				 LIMIT ${boundedLimit}
			)
			DELETE FROM webhook_events AS event
			 USING due
			 WHERE event.id = due.id
			RETURNING event.id
		`)) as unknown as Array<{ id: string }>;
		return deleted.length;
	});
}
