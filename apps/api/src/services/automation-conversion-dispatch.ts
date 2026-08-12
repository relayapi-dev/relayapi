import {
	automationConversionEvents,
	createDb,
	type Database,
} from "@relayapi/db";
import { sql } from "drizzle-orm";
import type { Env } from "../types";
import { MAX_INTERNAL_EVENT_DEPTH } from "./automations/internal-events";
import type { InboundEvent } from "./automations/trigger-matcher";
import { matchAndEnroll } from "./automations/trigger-matcher";

export const AUTOMATION_CONVERSION_DISPATCH_LEASE_MS = 5 * 60 * 1_000;
export const AUTOMATION_CONVERSION_DISPATCH_DEADLINE_MS =
	7 * 24 * 60 * 60 * 1_000;
export const AUTOMATION_CONVERSION_DISPATCH_MAX_ATTEMPTS = 12;
export const AUTOMATION_CONVERSION_DISPATCH_BATCH_SIZE = 100;

interface ClaimedConversionEvent extends Record<string, unknown> {
	id: string;
	organizationId: string;
	automationId: string;
	runId: string;
	contactId: string;
	occurrenceId: string;
	eventName: string;
	value: string | null;
	currency: string | null;
	channel: InboundEvent["channel"];
	socialAccountId: string | null;
	conversationId: string | null;
	eventDepth: number;
	metadata: Record<string, unknown> | null;
	dispatchAttempts: number;
	dispatchLeaseToken: number;
	dispatchDeadlineAt: Date;
}

export interface AutomationConversionDispatchResult {
	claimed: number;
	dispatched: number;
	retried: number;
	manualReview: number;
}

function boundedBatchSize(value: number | undefined): number {
	return Math.min(
		Math.max(Math.trunc(value ?? AUTOMATION_CONVERSION_DISPATCH_BATCH_SIZE), 1),
		500,
	);
}

function retryDelayMs(attempts: number): number {
	return Math.min(
		2 ** Math.min(Math.max(attempts - 1, 0), 8) * 5_000,
		60 * 60_000,
	);
}

async function terminalizeExhausted(
	db: Database,
	now: Date,
	occurrenceId?: string,
): Promise<number> {
	const rows = await db.execute<{ id: string }>(sql`
		UPDATE ${automationConversionEvents} AS event
		   SET dispatch_status = 'manual_review',
		       dispatch_lease_expires_at = NULL,
		       last_dispatch_error = COALESCE(
		         event.last_dispatch_error,
		         'conversion_trigger_dispatch_exhausted'
		       ),
		       updated_at = ${now}
		 WHERE event.dispatch_status IN ('pending', 'processing')
		   AND (
		         event.dispatch_status = 'pending'
		         OR event.dispatch_lease_expires_at <= ${now}
		       )
		   AND (
		         event.dispatch_deadline_at <= ${now}
		         OR event.dispatch_attempts >=
		            ${AUTOMATION_CONVERSION_DISPATCH_MAX_ATTEMPTS}
		       )
		   ${occurrenceId ? sql`AND event.occurrence_id = ${occurrenceId}` : sql``}
		RETURNING event.id
	`);
	return rows.length;
}

async function claimDue(
	db: Database,
	now: Date,
	limit: number,
	occurrenceId?: string,
): Promise<ClaimedConversionEvent[]> {
	const leaseExpiresAt = new Date(
		now.getTime() + AUTOMATION_CONVERSION_DISPATCH_LEASE_MS,
	);
	return db.execute<ClaimedConversionEvent>(sql`
		WITH ranked AS MATERIALIZED (
			SELECT event.id,
			       event.next_dispatch_at,
			       row_number() OVER (
			         PARTITION BY event.organization_id
			         ORDER BY event.next_dispatch_at ASC, event.id ASC
			       ) AS tenant_rank
			  FROM ${automationConversionEvents} AS event
			 WHERE event.dispatch_deadline_at > ${now}
			   AND event.dispatch_attempts <
			       ${AUTOMATION_CONVERSION_DISPATCH_MAX_ATTEMPTS}
			   AND (
			         (
			           event.dispatch_status = 'pending'
			           AND event.next_dispatch_at <= ${now}
			         )
			         OR (
			           event.dispatch_status = 'processing'
			           AND event.dispatch_lease_expires_at <= ${now}
			         )
			       )
			   ${occurrenceId ? sql`AND event.occurrence_id = ${occurrenceId}` : sql``}
		),
		due AS (
			SELECT event.id
			  FROM ranked
			  JOIN ${automationConversionEvents} AS event ON event.id = ranked.id
			 ORDER BY ranked.tenant_rank ASC, ranked.next_dispatch_at ASC, ranked.id ASC
			 LIMIT ${limit}
			 FOR UPDATE OF event SKIP LOCKED
		)
		UPDATE ${automationConversionEvents} AS event
		   SET dispatch_status = 'processing',
		       dispatch_attempts = event.dispatch_attempts + 1,
		       dispatch_lease_token = event.dispatch_lease_token + 1,
		       dispatch_lease_expires_at = ${leaseExpiresAt},
		       updated_at = ${now}
		  FROM due
		 WHERE event.id = due.id
		RETURNING
			event.id,
			event.organization_id AS "organizationId",
			event.automation_id AS "automationId",
			event.run_id AS "runId",
			event.contact_id AS "contactId",
			event.occurrence_id AS "occurrenceId",
			event.event_name AS "eventName",
			event.value,
			event.currency,
			event.channel,
			event.social_account_id AS "socialAccountId",
			event.conversation_id AS "conversationId",
			event.event_depth AS "eventDepth",
			event.metadata,
			event.dispatch_attempts AS "dispatchAttempts",
			event.dispatch_lease_token AS "dispatchLeaseToken",
			event.dispatch_deadline_at AS "dispatchDeadlineAt"
	`);
}

function inboundEvent(row: ClaimedConversionEvent): InboundEvent {
	const actionId =
		typeof row.metadata?.action_id === "string" ? row.metadata.action_id : null;
	return {
		kind: "conversion_event",
		channel: row.channel,
		organizationId: row.organizationId,
		socialAccountId: row.socialAccountId,
		contactId: row.contactId,
		conversationId: row.conversationId,
		eventName: row.eventName,
		triggerOccurrenceId: row.occurrenceId,
		payload: {
			value: row.value,
			currency: row.currency,
			source: "automation",
			automation_id: row.automationId,
			run_id: row.runId,
			...(actionId ? { action_id: actionId } : {}),
			_event_depth: row.eventDepth + 1,
		},
	};
}

async function completeDispatch(
	db: Database,
	row: ClaimedConversionEvent,
	now: Date,
): Promise<boolean> {
	const rows = await db.execute<{ id: string }>(sql`
		UPDATE ${automationConversionEvents} AS event
		   SET dispatch_status = 'succeeded',
		       dispatch_lease_expires_at = NULL,
		       dispatched_at = ${now},
		       last_dispatch_error = NULL,
		       updated_at = ${now}
		 WHERE event.id = ${row.id}
		   AND event.dispatch_status = 'processing'
		   AND event.dispatch_lease_token = ${row.dispatchLeaseToken}
		RETURNING event.id
	`);
	return rows.length === 1;
}

async function deferDispatch(
	db: Database,
	row: ClaimedConversionEvent,
	now: Date,
): Promise<"retried" | "manual_review" | "lost_claim"> {
	const nextDispatchAt = new Date(
		now.getTime() + retryDelayMs(row.dispatchAttempts),
	);
	const terminal =
		row.dispatchAttempts >= AUTOMATION_CONVERSION_DISPATCH_MAX_ATTEMPTS ||
		nextDispatchAt.getTime() >= new Date(row.dispatchDeadlineAt).getTime();
	const rows = await db.execute<{ id: string }>(sql`
		UPDATE ${automationConversionEvents} AS event
		   SET dispatch_status = ${terminal ? "manual_review" : "pending"},
		       dispatch_lease_expires_at = NULL,
		       next_dispatch_at = ${nextDispatchAt},
		       last_dispatch_error = 'conversion_trigger_dispatch_failed',
		       updated_at = ${now}
		 WHERE event.id = ${row.id}
		   AND event.dispatch_status = 'processing'
		   AND event.dispatch_lease_token = ${row.dispatchLeaseToken}
		RETURNING event.id
	`);
	if (rows.length !== 1) return "lost_claim";
	return terminal ? "manual_review" : "retried";
}

/**
 * Claims conversion facts oldest-first and durably evaluates their internal
 * trigger. Enrollment itself is deferred to the existing automation scheduler,
 * keeping provider work outside this outbox transaction.
 */
export async function processAutomationConversionDispatch(
	db: Database,
	env: Record<string, unknown>,
	options: {
		now?: Date;
		limit?: number;
		occurrenceId?: string;
	} = {},
): Promise<AutomationConversionDispatchResult> {
	const now = options.now ?? new Date();
	const limit = boundedBatchSize(options.limit);
	let manualReview = await terminalizeExhausted(db, now, options.occurrenceId);
	const claimed = await claimDue(db, now, limit, options.occurrenceId);
	let dispatched = 0;
	let retried = 0;

	for (const row of claimed) {
		try {
			if (row.eventDepth < MAX_INTERNAL_EVENT_DEPTH) {
				await matchAndEnroll(db, inboundEvent(row), env, {
					deferRun: true,
				});
			}
			if (await completeDispatch(db, row, new Date())) dispatched += 1;
		} catch {
			const disposition = await deferDispatch(db, row, new Date());
			if (disposition === "retried") retried += 1;
			if (disposition === "manual_review") manualReview += 1;
		}
	}

	return {
		claimed: claimed.length,
		dispatched,
		retried,
		manualReview,
	};
}

export async function processDueAutomationConversionEvents(
	env: Env,
): Promise<AutomationConversionDispatchResult> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	return processAutomationConversionDispatch(
		db,
		env as unknown as Record<string, unknown>,
	);
}
