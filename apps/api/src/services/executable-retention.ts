import {
	createDb,
	type Database,
	HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS,
	type LegalHoldTreatment,
	type RetentionHoldScope,
	retentionDrainRuns,
} from "@relayapi/db";
import { type SQL, sql } from "drizzle-orm";
import type { Env } from "../types";
import { dispatchRetentionBacklogAlert } from "./operator-alerts";

export const RETENTION_DRAIN_LEASE_MS = 2 * 60 * 1_000;
export const RETENTION_DRAIN_WALL_BUDGET_MS = 20_000;
export const RETENTION_BACKLOG_SLO_MS = 24 * 60 * 60 * 1_000;
export const RETENTION_CONTINUATION_HANDLER_LIMIT = 4;

export interface RetentionDrainResult {
	readonly processed: number;
	readonly minimized: number;
	readonly deleted: number;
	readonly moreDue: boolean;
	readonly oldestDueAt: string | null;
	readonly oldestDueOrganizationId: string | null;
	readonly continuationRequired: boolean;
	readonly cursorDueAt: string | null;
	readonly cursorRowId: string | null;
}

export interface ExecutableRetentionRunResult {
	readonly handlerId: string;
	readonly storeId: `postgres:${string}`;
	readonly result: RetentionDrainResult;
}

export interface RetentionCursor {
	readonly dueAt: string;
	readonly rowId: string;
}

export interface RetentionHandlerOptions {
	readonly db?: Database;
	readonly now?: Date;
	readonly cursor?: RetentionCursor | null;
}

interface RetentionPhase {
	/** Absolute due timestamp expression, using the `item` alias. */
	readonly dueAt: string;
	readonly predicate: string;
}

interface MinimizePhase extends RetentionPhase {
	/** Makes minimization idempotent and prevents a permanent rescan. */
	readonly needsMinimization: string;
	readonly setClause: string;
}

interface RetentionSqlPlan {
	readonly handlerId: string;
	readonly table: string;
	readonly primaryKey: string;
	readonly joins?: string;
	readonly organizationExpression: string;
	readonly scopeExpression?: string;
	readonly holdScope: RetentionHoldScope;
	readonly minimize?: MinimizePhase;
	readonly delete?: RetentionPhase;
	/** A due manual/unknown row remains visible after its raw detail is gone. */
	readonly unresolved?: RetentionPhase;
}

interface RetentionActionRow {
	readonly action: "minimized" | "deleted";
	readonly due_at: Date | string;
	readonly row_id: string;
}

interface RetentionProbeRow {
	readonly due_at: Date | string;
	readonly organization_id: string;
	readonly row_id: string;
}

const RETENTION_SQL_PLANS: readonly RetentionSqlPlan[] = [
	{
		handlerId: "retain_account_revocation_jobs",
		table: "account_revocation_jobs",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		holdScope: "organization",
		minimize: {
			dueAt: "item.completed_at + interval '7 days'",
			predicate:
				"item.status IN ('manual_required', 'succeeded', 'abandoned') AND item.completed_at IS NOT NULL",
			needsMinimization:
				"item.access_token_ciphertext IS NOT NULL OR item.refresh_token_ciphertext IS NOT NULL OR item.provider_response IS NOT NULL OR item.last_error IS NOT NULL",
			setClause:
				"access_token_ciphertext = NULL, refresh_token_ciphertext = NULL, provider_response = NULL, last_error = NULL",
		},
		delete: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status IN ('succeeded', 'abandoned') AND item.completed_at IS NOT NULL",
		},
		unresolved: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status = 'manual_required' AND item.completed_at IS NOT NULL",
		},
	},
	{
		handlerId: "retain_token_refresh_operations",
		table: "token_refresh_operations",
		primaryKey: "account_id",
		joins: "JOIN social_accounts AS account ON account.id = item.account_id",
		organizationExpression: "account.organization_id",
		scopeExpression: "account.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '30 days'",
			predicate: "item.state = 'unknown'",
			needsMinimization: "item.last_error IS NOT NULL",
			setClause: "last_error = NULL",
		},
		delete: {
			dueAt:
				"CASE WHEN item.state = 'succeeded' THEN item.completed_at + interval '30 days' ELSE COALESCE(item.completed_at, item.updated_at) + interval '90 days' END",
			predicate:
				"item.state = 'succeeded' OR (item.state = 'unknown' AND (account.token_version <> item.source_token_version OR account.lifecycle_status <> 'active'))",
		},
		unresolved: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '90 days'",
			predicate:
				"item.state = 'unknown' AND account.token_version = item.source_token_version AND account.lifecycle_status = 'active'",
		},
	},
	{
		handlerId: "retain_thread_executions",
		table: "thread_executions",
		primaryKey: "thread_group_id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.updated_at + interval '30 days'",
			predicate: "item.status IN ('completed', 'failed', 'unknown')",
			needsMinimization:
				'item.failure IS NOT NULL AND item.failure <> \'{"code":"retained","message":"Detail expired"}\'::jsonb',
			setClause:
				'failure = CASE WHEN failure IS NULL THEN NULL ELSE \'{"code":"retained","message":"Detail expired"}\'::jsonb END',
		},
		delete: {
			dueAt: "item.updated_at + interval '90 days'",
			predicate: "item.status IN ('completed', 'failed')",
		},
		unresolved: {
			dueAt: "item.updated_at + interval '90 days'",
			predicate: "item.status = 'unknown'",
		},
	},
	{
		handlerId: "retain_publish_attempts",
		table: "publish_attempts",
		primaryKey: "id",
		joins:
			"JOIN post_targets AS target ON target.id = item.post_target_id AND target.publish_operation_id = item.publish_operation_id",
		organizationExpression: "target.organization_id",
		scopeExpression: "target.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '30 days'",
			predicate:
				"item.state IN ('succeeded', 'failed', 'unknown') AND item.completed_at IS NOT NULL",
			needsMinimization:
				"item.error IS NOT NULL OR item.provider_state IS NOT NULL OR item.provider_effects IS NOT NULL OR (item.state <> 'unknown' AND (item.provider_post_id IS NOT NULL OR item.provider_operation_id IS NOT NULL OR item.provider_disposition IS NOT NULL))",
			setClause:
				"error = NULL, provider_state = NULL, provider_effects = NULL, provider_post_id = CASE WHEN state = 'unknown' THEN provider_post_id ELSE NULL END, provider_operation_id = CASE WHEN state = 'unknown' THEN provider_operation_id ELSE NULL END, provider_disposition = CASE WHEN state = 'unknown' THEN provider_disposition ELSE NULL END",
		},
		delete: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.completed_at IS NOT NULL AND target.attempt_id IS DISTINCT FROM item.id AND (item.state IN ('succeeded', 'failed') OR (item.state = 'unknown' AND target.delivery_state <> 'unknown'))",
		},
		unresolved: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.state = 'unknown' AND item.completed_at IS NOT NULL AND target.delivery_state = 'unknown'",
		},
	},
	{
		handlerId: "retain_recycling_occurrences",
		table: "recycling_occurrences",
		primaryKey: "id",
		joins:
			"JOIN post_recycling_configs AS config ON config.id = item.config_id AND config.organization_id = item.organization_id",
		organizationExpression: "item.organization_id",
		scopeExpression: "config.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '30 days'",
			predicate:
				"item.status IN ('committed', 'terminal_failure', 'unknown') AND item.completed_at IS NOT NULL",
			needsMinimization: "item.error IS NOT NULL",
			setClause: "error = NULL",
		},
		delete: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status IN ('committed', 'terminal_failure') AND item.completed_at IS NOT NULL",
		},
		unresolved: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate: "item.status = 'unknown' AND item.completed_at IS NOT NULL",
		},
	},
	{
		handlerId: "retain_connection_logs",
		table: "connection_logs",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		holdScope: "organization",
		minimize: {
			dueAt: "item.created_at + interval '30 days'",
			predicate: "TRUE",
			needsMinimization:
				"item.message IS NOT NULL OR item.snapshot IS NOT NULL",
			setClause: "message = NULL, snapshot = NULL",
		},
		delete: {
			dueAt: "item.created_at + interval '90 days'",
			predicate: "TRUE",
		},
	},
	{
		handlerId: "retain_notifications",
		table: "notifications",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		holdScope: "organization",
		minimize: {
			dueAt:
				"CASE WHEN item.read THEN item.created_at + interval '90 days' ELSE item.created_at + interval '180 days' END",
			predicate: "TRUE",
			needsMinimization:
				"item.data IS NOT NULL OR item.title <> 'Notification expired' OR item.body <> 'Notification detail is no longer retained'",
			setClause:
				"title = 'Notification expired', body = 'Notification detail is no longer retained', data = NULL",
		},
		delete: {
			dueAt: "item.created_at + interval '365 days'",
			predicate: "TRUE",
		},
	},
	{
		handlerId: "retain_inbox_event_effects",
		table: "inbox_event_effects",
		primaryKey: "id",
		joins:
			"JOIN social_accounts AS account ON account.id = item.account_id AND account.organization_id = item.organization_id",
		organizationExpression: "item.organization_id",
		scopeExpression: "account.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '30 days'",
			predicate: "item.status IN ('completed', 'unknown')",
			needsMinimization:
				"item.error IS NOT NULL OR item.replay_payload IS NOT NULL",
			setClause: "error = NULL, replay_payload = NULL",
		},
		delete: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate: "item.status = 'completed' AND item.completed_at IS NOT NULL",
		},
		unresolved: {
			dueAt: "item.updated_at + interval '90 days'",
			predicate: "item.status = 'unknown'",
		},
	},
	{
		handlerId: "retain_auto_post_feed_items",
		table: "auto_post_feed_items",
		primaryKey: "id",
		joins:
			"JOIN auto_post_rules AS rule ON rule.id = item.rule_id AND rule.organization_id = item.organization_id",
		organizationExpression: "item.organization_id",
		scopeExpression: "rule.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt:
				"COALESCE(item.completed_at, item.created_at) + interval '90 days'",
			predicate:
				"item.status IN ('ignored', 'committed', 'transient_failure', 'terminal_failure', 'unknown')",
			needsMinimization:
				"item.source_item_id IS NOT NULL OR item.canonical_url IS NOT NULL OR item.error IS NOT NULL",
			setClause: "source_item_id = NULL, canonical_url = NULL, error = NULL",
		},
		unresolved: {
			dueAt:
				"COALESCE(item.completed_at, item.created_at) + interval '90 days'",
			predicate: "item.status = 'unknown'",
		},
	},
	{
		handlerId: "retain_ad_creation_operations",
		table: "ad_creation_operations",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '30 days'",
			predicate:
				"(item.status = 'completed' OR (item.status = 'manual_review' AND EXISTS (SELECT 1 FROM operator_resolution_evidence AS evidence WHERE evidence.target_type = 'ad_creation_operation' AND evidence.target_id = item.id AND evidence.action IN ('mark_succeeded', 'mark_not_applied'))) AND (item.usage_reservation_id IS NULL OR EXISTS (SELECT 1 FROM usage_reservations AS usage_reservation WHERE usage_reservation.id = item.usage_reservation_id AND usage_reservation.organization_id = item.organization_id AND usage_reservation.state IN ('committed', 'released')))",
			needsMinimization:
				"item.request_payload <> '{}'::jsonb OR item.last_error IS NOT NULL",
			setClause: "request_payload = '{}'::jsonb, last_error = NULL",
		},
		delete: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '90 days'",
			predicate:
				"item.status = 'completed' AND (item.usage_reservation_id IS NULL OR EXISTS (SELECT 1 FROM usage_reservations AS usage_reservation WHERE usage_reservation.id = item.usage_reservation_id AND usage_reservation.organization_id = item.organization_id AND usage_reservation.state IN ('committed', 'released')))",
		},
		unresolved: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '365 days'",
			predicate:
				"item.status IN ('unknown', 'manual_review') AND NOT EXISTS (SELECT 1 FROM operator_resolution_evidence AS evidence WHERE evidence.target_type = 'ad_creation_operation' AND evidence.target_id = item.id AND evidence.action IN ('mark_succeeded', 'mark_not_applied'))",
		},
	},
	{
		handlerId: "retain_ad_mutation_operations",
		table: "ad_mutation_operations",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		holdScope: "organization",
		minimize: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '30 days'",
			predicate:
				"(item.status = 'completed' OR (item.status = 'failed' AND EXISTS (SELECT 1 FROM operator_resolution_evidence AS evidence WHERE evidence.target_type = 'ad_mutation_operation' AND evidence.target_id = item.id AND evidence.action = 'mark_not_applied'))) AND (item.usage_reservation_id IS NULL OR EXISTS (SELECT 1 FROM usage_reservations AS usage_reservation WHERE usage_reservation.id = item.usage_reservation_id AND usage_reservation.organization_id = item.organization_id AND usage_reservation.state IN ('committed', 'released')))",
			needsMinimization:
				"item.request_payload <> '{}'::jsonb OR item.last_error IS NOT NULL",
			setClause: "request_payload = '{}'::jsonb, last_error = NULL",
		},
		unresolved: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '365 days'",
			predicate:
				"item.status IN ('unknown', 'manual_review') AND NOT EXISTS (SELECT 1 FROM operator_resolution_evidence AS evidence WHERE evidence.target_type = 'ad_mutation_operation' AND evidence.target_id = item.id AND evidence.action IN ('mark_succeeded', 'mark_not_applied'))",
		},
	},
	{
		handlerId: "retain_ad_metrics",
		table: "ad_metrics",
		primaryKey: "id",
		joins: "JOIN ads AS ad ON ad.id = item.ad_id",
		organizationExpression: "ad.organization_id",
		scopeExpression: "ad.scope_key",
		holdScope: "organization_or_workspace",
		delete: {
			dueAt: "item.date + interval '25 months'",
			predicate: "TRUE",
		},
	},
	{
		handlerId: "retain_ad_sync_logs",
		table: "ad_sync_logs",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '30 days'",
			predicate: "item.completed_at IS NOT NULL",
			needsMinimization: "item.error IS NOT NULL",
			setClause: "error = NULL",
		},
		delete: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate: "item.completed_at IS NOT NULL",
		},
	},
	{
		handlerId: "retain_cross_post_actions",
		table: "cross_post_actions",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status IN ('executed', 'failed', 'cancelled', 'unknown') AND item.completed_at IS NOT NULL",
			needsMinimization: "item.content IS NOT NULL OR item.error IS NOT NULL",
			setClause: "content = NULL, error = NULL",
		},
		unresolved: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate: "item.status = 'unknown' AND item.completed_at IS NOT NULL",
		},
	},
	{
		handlerId: "retain_idea_conversion_operations",
		table: "idea_conversion_operations",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '30 days'",
			predicate: "item.status IN ('succeeded', 'failed')",
			needsMinimization: "item.last_error IS NOT NULL",
			setClause: "last_error = NULL",
		},
		delete: {
			dueAt:
				"COALESCE(item.completed_at, item.updated_at) + interval '90 days'",
			predicate: "item.status IN ('succeeded', 'failed')",
		},
	},
	{
		handlerId: "retain_idea_activity",
		table: "idea_activity",
		primaryKey: "id",
		joins:
			"JOIN ideas AS idea ON idea.id = item.idea_id AND idea.organization_id = item.organization_id",
		organizationExpression: "item.organization_id",
		scopeExpression: "idea.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.created_at + interval '90 days'",
			predicate: "TRUE",
			needsMinimization: "item.metadata IS NOT NULL",
			setClause: "metadata = NULL",
		},
		delete: {
			dueAt: "item.created_at + interval '365 days'",
			predicate: "TRUE",
		},
	},
	{
		handlerId: "retain_post_analytics",
		table: "post_analytics",
		primaryKey: "id",
		joins: "JOIN post_targets AS target ON target.id = item.post_target_id",
		organizationExpression: "target.organization_id",
		scopeExpression: "target.scope_key",
		holdScope: "organization_or_workspace",
		delete: {
			dueAt: "item.collected_at + interval '25 months'",
			predicate: "TRUE",
		},
	},
	{
		handlerId: "retain_automation_runs",
		table: "automation_runs",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status IN ('completed', 'exited', 'failed') AND item.completed_at IS NOT NULL",
			needsMinimization: "item.context <> '{}'::jsonb",
			setClause: "context = '{}'::jsonb",
		},
		delete: {
			dueAt:
				"CASE WHEN EXISTS (SELECT 1 FROM automation_conversion_events AS conversion WHERE conversion.run_id = item.id) THEN item.completed_at + interval '25 months' ELSE item.completed_at + interval '365 days' END",
			predicate:
				"item.status IN ('completed', 'exited', 'failed') AND item.completed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM automation_conversion_events AS conversion WHERE conversion.run_id = item.id) AND NOT EXISTS (SELECT 1 FROM automation_node_executions AS node WHERE node.run_id = item.id) AND NOT EXISTS (SELECT 1 FROM automation_scheduled_jobs AS job WHERE job.run_id = item.id) AND NOT EXISTS (SELECT 1 FROM automation_step_runs AS step WHERE step.run_id = item.id)",
		},
	},
	{
		handlerId: "retain_automation_conversion_events",
		table: "automation_conversion_events",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.created_at + interval '90 days'",
			predicate: "item.dispatch_status = 'succeeded'",
			needsMinimization: "item.metadata IS NOT NULL",
			setClause: "metadata = NULL",
		},
		delete: {
			dueAt: "item.created_at + interval '25 months'",
			predicate: "item.dispatch_status = 'succeeded'",
		},
	},
	{
		handlerId: "retain_automation_node_executions",
		table: "automation_node_executions",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status IN ('succeeded', 'failed', 'unknown') AND item.completed_at IS NOT NULL",
			needsMinimization: "item.result IS NOT NULL OR item.error IS NOT NULL",
			setClause: "result = NULL, error = NULL",
		},
		delete: {
			dueAt: "item.completed_at + interval '365 days'",
			predicate:
				"item.status IN ('succeeded', 'failed') AND item.completed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM automation_effects AS effect WHERE effect.node_execution_id = item.id)",
		},
		unresolved: {
			dueAt: "item.completed_at + interval '365 days'",
			predicate: "item.status = 'unknown' AND item.completed_at IS NOT NULL",
		},
	},
	{
		handlerId: "retain_automation_effects",
		table: "automation_effects",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.completed_at + interval '90 days'",
			predicate:
				"item.status IN ('succeeded', 'failed', 'unknown') AND item.completed_at IS NOT NULL",
			needsMinimization:
				"item.result IS NOT NULL OR item.last_error IS NOT NULL OR (item.status <> 'unknown' AND item.provider_reference IS NOT NULL)",
			setClause:
				"result = NULL, last_error = NULL, provider_reference = CASE WHEN status = 'unknown' THEN provider_reference ELSE NULL END",
		},
		delete: {
			dueAt: "item.completed_at + interval '365 days'",
			predicate:
				"item.status IN ('succeeded', 'failed') AND item.completed_at IS NOT NULL",
		},
		unresolved: {
			dueAt: "item.completed_at + interval '365 days'",
			predicate: "item.status = 'unknown' AND item.completed_at IS NOT NULL",
		},
	},
	{
		handlerId: "retain_automation_step_runs",
		table: "automation_step_runs",
		primaryKey: "id",
		joins: "JOIN automation_runs AS run ON run.id = item.run_id",
		organizationExpression: "run.organization_id",
		scopeExpression: "run.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.executed_at + interval '90 days'",
			predicate: "TRUE",
			needsMinimization: "item.payload IS NOT NULL OR item.error IS NOT NULL",
			setClause: "payload = NULL, error = NULL",
		},
		delete: {
			dueAt: "item.executed_at + interval '365 days'",
			predicate: "TRUE",
		},
	},
	{
		handlerId: "retain_automation_scheduled_jobs",
		table: "automation_scheduled_jobs",
		primaryKey: "id",
		organizationExpression: "item.organization_id",
		scopeExpression: "item.scope_key",
		holdScope: "organization_or_workspace",
		minimize: {
			dueAt: "item.run_at + interval '7 days'",
			predicate: "item.status IN ('done', 'failed', 'unknown')",
			needsMinimization: "item.payload IS NOT NULL OR item.error IS NOT NULL",
			setClause: "payload = NULL, error = NULL",
		},
		delete: {
			dueAt: "item.run_at + interval '30 days'",
			predicate: "item.status IN ('done', 'failed')",
		},
		unresolved: {
			dueAt: "item.run_at + interval '30 days'",
			predicate: "item.status = 'unknown'",
		},
	},
];

function raw(expression: string): SQL {
	return sql.raw(expression);
}

// Raw Drizzle SQL has no column encoder for interpolated values. Pass ISO
// strings with an explicit type so postgres.js never receives a bare Date.
function timestampParam(value: Date | string): SQL {
	const timestamp = value instanceof Date ? value.toISOString() : value;
	return sql`${timestamp}::timestamptz`;
}

function phaseDue(phase: RetentionPhase | undefined, now: Date): SQL {
	if (!phase) return sql`FALSE`;
	return sql`(${raw(phase.predicate)})
		AND (${raw(phase.dueAt)}) <= ${timestampParam(now)}`;
}

function minimizeDue(phase: MinimizePhase | undefined, now: Date): SQL {
	if (!phase) return sql`FALSE`;
	return sql`(${raw(phase.predicate)})
		AND (${raw(phase.dueAt)}) <= ${timestampParam(now)}
		AND (${raw(phase.needsMinimization)})`;
}

function activeHold(plan: RetentionSqlPlan): SQL {
	if (plan.holdScope === "none") return sql`FALSE`;
	const organization = raw(plan.organizationExpression);
	if (plan.holdScope === "organization") {
		return sql`EXISTS (
			SELECT 1
			  FROM erasure_holds AS hold
			 WHERE hold.released_at IS NULL
			   AND hold.organization_tombstone_id = ${organization}
			   AND hold.subject_kind = 'organization'
			   AND hold.subject_id = ${organization}
		)`;
	}
	if (!plan.scopeExpression) {
		throw new Error(
			`${plan.handlerId} declares workspace holds without a scope expression`,
		);
	}
	const scope = raw(plan.scopeExpression);
	return sql`EXISTS (
		SELECT 1
		  FROM erasure_holds AS hold
		 WHERE hold.released_at IS NULL
		   AND hold.organization_tombstone_id = ${organization}
		   AND (
				(hold.subject_kind = 'organization'
				 AND hold.subject_id = ${organization})
				OR (hold.subject_kind = 'workspace'
					AND ${scope} = 'ws/' || hold.subject_id)
		   )
	)`;
}

function oldestDueExpression(
	entries: readonly {
		condition: SQL;
		dueAt: string;
	}[],
): SQL {
	return sql`LEAST(${sql.join(
		entries.map(
			(entry) =>
				sql`CASE WHEN ${entry.condition}
					THEN (${raw(entry.dueAt)})
					ELSE 'infinity'::timestamptz
				END`,
		),
		sql`, `,
	)})`;
}

function afterCursor(
	dueAt: SQL,
	rowId: SQL,
	cursor: RetentionCursor | null | undefined,
): SQL {
	if (!cursor) return sql`TRUE`;
	return sql`(${dueAt}, ${rowId}) >
		(${timestampParam(cursor.dueAt)}, ${cursor.rowId})`;
}

function dueCte(
	plan: RetentionSqlPlan,
	holdTreatment: LegalHoldTreatment,
	now: Date,
	limit: number,
	includeUnresolved: boolean,
): {
	readonly joins: SQL;
	readonly hold: SQL;
	readonly minimize: SQL;
	readonly deletion: SQL;
	readonly unresolved: SQL;
	readonly processable: SQL;
	readonly visible: SQL;
	readonly dueAt: SQL;
} {
	const joins = plan.joins ? raw(plan.joins) : sql.empty();
	const hold = activeHold(plan);
	const minimizeDueNow = minimizeDue(plan.minimize, now);
	const deletionDueNow = phaseDue(plan.delete, now);
	const unresolved = phaseDue(plan.unresolved, now);
	// `pause` preserves the complete store. `minimize` still shreds/redacts raw
	// detail while a hold is active, but the minimal evidence row cannot delete.
	// `never` is reserved for ephemera whose ordinary clock a hold cannot extend.
	const minimize =
		holdTreatment === "pause"
			? sql`(${minimizeDueNow}) AND NOT (${hold})`
			: minimizeDueNow;
	const deletion =
		holdTreatment === "never"
			? deletionDueNow
			: sql`(${deletionDueNow}) AND NOT (${hold})`;
	const processable = sql`(${minimize}) OR (${deletion})`;
	const visible = includeUnresolved
		? sql`(${processable}) OR (${unresolved})`
		: processable;
	const entries = [
		...(plan.minimize
			? [{ condition: minimize, dueAt: plan.minimize.dueAt }]
			: []),
		...(plan.delete
			? [
					{
						condition: deletion,
						dueAt: plan.delete.dueAt,
					},
				]
			: []),
		...(includeUnresolved && plan.unresolved
			? [
					{
						condition: unresolved,
						dueAt: plan.unresolved.dueAt,
					},
				]
			: []),
	];
	if (entries.length === 0) {
		throw new Error(`${plan.handlerId} has no executable phase`);
	}
	const dueAt = oldestDueExpression(entries);
	void limit;
	return {
		joins,
		hold,
		minimize,
		deletion,
		unresolved,
		processable,
		visible,
		dueAt,
	};
}

function actionStatement(
	plan: RetentionSqlPlan,
	holdTreatment: LegalHoldTreatment,
	now: Date,
	limit: number,
	cursor?: RetentionCursor | null,
): SQL {
	const parts = dueCte(plan, holdTreatment, now, limit, false);
	const table = raw(plan.table);
	const itemKey = raw(`item.${plan.primaryKey}`);
	const targetKey = raw(`target.${plan.primaryKey}`);
	const organization = raw(plan.organizationExpression);

	if (plan.minimize && plan.delete) {
		return sql`
			WITH due AS (
				SELECT ${itemKey} AS row_id,
					       ${organization} AS organization_id,
					       ${parts.dueAt} AS due_at,
					       (${parts.deletion}) AS should_delete
				  FROM ${table} AS item
				  ${parts.joins}
				 WHERE (${parts.processable})
				   AND (${afterCursor(parts.dueAt, itemKey, cursor)})
				 ORDER BY ${parts.dueAt}, ${itemKey}
				 LIMIT ${limit}
				 FOR UPDATE OF item SKIP LOCKED
			),
			minimized AS (
				UPDATE ${table} AS target
				   SET ${raw(plan.minimize.setClause)}
				  FROM due
				 WHERE ${targetKey} = due.row_id
				   AND NOT due.should_delete
				RETURNING ${targetKey} AS row_id
			),
			deleted AS (
				DELETE FROM ${table} AS target
				 USING due
				 WHERE ${targetKey} = due.row_id
				   AND due.should_delete
				RETURNING ${targetKey} AS row_id
			)
			SELECT 'minimized'::text AS action,
			       due.row_id,
			       due.due_at
			  FROM minimized
			  JOIN due USING (row_id)
			UNION ALL
			SELECT 'deleted'::text AS action,
			       due.row_id,
			       due.due_at
			  FROM deleted
			  JOIN due USING (row_id)
		`;
	}

	if (plan.minimize) {
		return sql`
			WITH due AS (
				SELECT ${itemKey} AS row_id,
				       ${parts.dueAt} AS due_at
				  FROM ${table} AS item
				  ${parts.joins}
				 WHERE (${parts.minimize})
				   AND (${afterCursor(parts.dueAt, itemKey, cursor)})
				 ORDER BY ${parts.dueAt}, ${itemKey}
				 LIMIT ${limit}
				 FOR UPDATE OF item SKIP LOCKED
			),
			minimized AS (
				UPDATE ${table} AS target
				   SET ${raw(plan.minimize.setClause)}
				  FROM due
				 WHERE ${targetKey} = due.row_id
				RETURNING ${targetKey} AS row_id
			)
			SELECT 'minimized'::text AS action,
			       due.row_id,
			       due.due_at
			  FROM minimized
			  JOIN due USING (row_id)
		`;
	}

	return sql`
		WITH due AS (
			SELECT ${itemKey} AS row_id,
			       ${parts.dueAt} AS due_at
			  FROM ${table} AS item
			  ${parts.joins}
			 WHERE (${parts.deletion})
			   AND (${afterCursor(parts.dueAt, itemKey, cursor)})
			 ORDER BY ${parts.dueAt}, ${itemKey}
			 LIMIT ${limit}
			 FOR UPDATE OF item SKIP LOCKED
		),
		deleted AS (
			DELETE FROM ${table} AS target
			 USING due
			 WHERE ${targetKey} = due.row_id
			RETURNING ${targetKey} AS row_id
		)
		SELECT 'deleted'::text AS action,
		       due.row_id,
		       due.due_at
		  FROM deleted
		  JOIN due USING (row_id)
	`;
}

function probeStatement(
	plan: RetentionSqlPlan,
	holdTreatment: LegalHoldTreatment,
	now: Date,
	includeUnresolved = true,
): SQL {
	const parts = dueCte(plan, holdTreatment, now, 1, includeUnresolved);
	const table = raw(plan.table);
	const itemKey = raw(`item.${plan.primaryKey}`);
	const organization = raw(plan.organizationExpression);
	return sql`
		SELECT ${parts.dueAt} AS due_at,
		       ${organization} AS organization_id,
		       ${itemKey} AS row_id
		  FROM ${table} AS item
		  ${parts.joins}
		 WHERE ${parts.visible}
		 ORDER BY ${parts.dueAt}, ${itemKey}
		 LIMIT 1
	`;
}

function isoTimestamp(value: Date | string): string {
	if (value instanceof Date) return value.toISOString();
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error("Retention probe returned an invalid cutoff timestamp");
	}
	return parsed.toISOString();
}

function laterCursor(
	current: RetentionCursor | null,
	row: RetentionActionRow,
): RetentionCursor {
	const candidate = {
		dueAt: isoTimestamp(row.due_at),
		rowId: row.row_id,
	};
	if (!current) return candidate;
	if (candidate.dueAt > current.dueAt) return candidate;
	if (candidate.dueAt < current.dueAt) return current;
	return candidate.rowId > current.rowId ? candidate : current;
}

async function executePlan(
	plan: RetentionSqlPlan,
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	const contract = HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS.find(
		(candidate) => candidate.handler.id === plan.handlerId,
	);
	if (!contract) {
		throw new Error(`Missing executable retention contract: ${plan.handlerId}`);
	}
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	let minimized = 0;
	let deleted = 0;
	let cursor = options?.cursor ?? null;
	let finalPassWasFull = false;

	for (let pass = 0; pass < contract.batch.maxPasses; pass++) {
		const rows = (await db.execute(
			actionStatement(
				plan,
				contract.holdTreatment,
				now,
				contract.batch.rows,
				cursor,
			),
		)) as unknown as RetentionActionRow[];
		for (const row of rows) {
			if (row.action === "minimized") minimized += 1;
			else if (row.action === "deleted") deleted += 1;
			else throw new Error(`${plan.handlerId} returned an unknown action`);
			cursor = laterCursor(cursor, row);
		}
		finalPassWasFull = rows.length === contract.batch.rows;
		if (!finalPassWasFull) break;
	}

	const processable = finalPassWasFull
		? null
		: (
				(await db.execute(
					probeStatement(plan, contract.holdTreatment, now, false),
				)) as unknown as RetentionProbeRow[]
			)[0];
	const probe = (await db.execute(
		probeStatement(plan, contract.holdTreatment, now),
	)) as unknown as RetentionProbeRow[];
	const oldest = probe[0];
	const continuationRequired = finalPassWasFull || processable !== undefined;
	return {
		processed: minimized + deleted,
		minimized,
		deleted,
		moreDue: oldest !== undefined,
		oldestDueAt: oldest ? isoTimestamp(oldest.due_at) : null,
		oldestDueOrganizationId: oldest?.organization_id ?? null,
		continuationRequired,
		cursorDueAt:
			continuationRequired && finalPassWasFull ? (cursor?.dueAt ?? null) : null,
		cursorRowId:
			continuationRequired && finalPassWasFull ? (cursor?.rowId ?? null) : null,
	};
}

function plan(handlerId: string): RetentionSqlPlan {
	const match = RETENTION_SQL_PLANS.find(
		(candidate) => candidate.handlerId === handlerId,
	);
	if (!match) throw new Error(`Missing retention SQL plan: ${handlerId}`);
	return match;
}

export async function retainAccountRevocationJobs(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_account_revocation_jobs"), env, options);
}

export async function retainTokenRefreshOperations(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_token_refresh_operations"), env, options);
}

export async function retainThreadExecutions(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_thread_executions"), env, options);
}

export async function retainPublishAttempts(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_publish_attempts"), env, options);
}

export async function retainRecyclingOccurrences(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_recycling_occurrences"), env, options);
}

export async function retainConnectionLogs(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_connection_logs"), env, options);
}

export async function retainNotifications(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_notifications"), env, options);
}

export async function retainInboxEventEffects(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_inbox_event_effects"), env, options);
}

export async function retainAutoPostFeedItems(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_auto_post_feed_items"), env, options);
}

export async function retainAdCreationOperations(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_ad_creation_operations"), env, options);
}

export async function retainAdMutationOperations(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_ad_mutation_operations"), env, options);
}

export async function retainAdMetrics(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_ad_metrics"), env, options);
}

export async function retainAdSyncLogs(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_ad_sync_logs"), env, options);
}

export async function retainCrossPostActions(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_cross_post_actions"), env, options);
}

export async function retainIdeaConversionOperations(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_idea_conversion_operations"), env, options);
}

export async function retainIdeaActivity(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_idea_activity"), env, options);
}

export async function retainPostAnalytics(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_post_analytics"), env, options);
}

export async function retainAutomationRuns(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_automation_runs"), env, options);
}

export async function retainAutomationConversionEvents(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_automation_conversion_events"), env, options);
}

export async function retainAutomationNodeExecutions(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_automation_node_executions"), env, options);
}

export async function retainAutomationEffects(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_automation_effects"), env, options);
}

export async function retainAutomationStepRuns(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_automation_step_runs"), env, options);
}

export async function retainAutomationScheduledJobs(
	env: Env,
	options?: RetentionHandlerOptions,
): Promise<RetentionDrainResult> {
	return executePlan(plan("retain_automation_scheduled_jobs"), env, options);
}

export type ExecutableRetentionHandler = (
	env: Env,
	options?: RetentionHandlerOptions,
) => Promise<RetentionDrainResult>;

/**
 * This is the executable half of the DB contract registry. The companion test
 * compares ids in both directions, so a contract cannot lack a handler and a
 * handler cannot silently fall outside the freeze proof.
 */
export const EXECUTABLE_RETENTION_HANDLERS: readonly {
	readonly id: string;
	readonly run: ExecutableRetentionHandler;
}[] = [
	{
		id: "retain_account_revocation_jobs",
		run: retainAccountRevocationJobs,
	},
	{
		id: "retain_token_refresh_operations",
		run: retainTokenRefreshOperations,
	},
	{ id: "retain_thread_executions", run: retainThreadExecutions },
	{ id: "retain_publish_attempts", run: retainPublishAttempts },
	{ id: "retain_recycling_occurrences", run: retainRecyclingOccurrences },
	{ id: "retain_connection_logs", run: retainConnectionLogs },
	{ id: "retain_notifications", run: retainNotifications },
	{ id: "retain_inbox_event_effects", run: retainInboxEventEffects },
	{ id: "retain_auto_post_feed_items", run: retainAutoPostFeedItems },
	{
		id: "retain_ad_creation_operations",
		run: retainAdCreationOperations,
	},
	{
		id: "retain_ad_mutation_operations",
		run: retainAdMutationOperations,
	},
	{ id: "retain_ad_metrics", run: retainAdMetrics },
	{ id: "retain_ad_sync_logs", run: retainAdSyncLogs },
	{ id: "retain_cross_post_actions", run: retainCrossPostActions },
	{
		id: "retain_idea_conversion_operations",
		run: retainIdeaConversionOperations,
	},
	{ id: "retain_idea_activity", run: retainIdeaActivity },
	{ id: "retain_post_analytics", run: retainPostAnalytics },
	// Children drain before their parents so every 500-row page is a physical
	// bound; parent predicates require childlessness and never rely on cascade.
	{ id: "retain_automation_effects", run: retainAutomationEffects },
	{
		id: "retain_automation_conversion_events",
		run: retainAutomationConversionEvents,
	},
	{
		id: "retain_automation_node_executions",
		run: retainAutomationNodeExecutions,
	},
	{ id: "retain_automation_step_runs", run: retainAutomationStepRuns },
	{
		id: "retain_automation_scheduled_jobs",
		run: retainAutomationScheduledJobs,
	},
	{ id: "retain_automation_runs", run: retainAutomationRuns },
];

export function validateExecutableRetentionHandlerCoverage(): string[] {
	const errors: string[] = [];
	const contractIds = HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS.map(
		(contract) => contract.handler.id,
	);
	const handlerIds = EXECUTABLE_RETENTION_HANDLERS.map((handler) => handler.id);
	const planIds = RETENTION_SQL_PLANS.map((candidate) => candidate.handlerId);
	for (const [label, ids] of [
		["contract", contractIds],
		["handler", handlerIds],
		["plan", planIds],
	] as const) {
		if (new Set(ids).size !== ids.length) {
			errors.push(`duplicate ${label} retention ids`);
		}
	}
	for (const id of contractIds) {
		if (!handlerIds.includes(id)) errors.push(`missing handler: ${id}`);
		if (!planIds.includes(id)) errors.push(`missing SQL plan: ${id}`);
	}
	for (const id of handlerIds) {
		if (!contractIds.includes(id)) errors.push(`uncontracted handler: ${id}`);
	}
	for (const id of planIds) {
		if (!contractIds.includes(id)) errors.push(`uncontracted SQL plan: ${id}`);
	}
	for (const contract of HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS) {
		const sqlPlan = RETENTION_SQL_PLANS.find(
			(candidate) => candidate.handlerId === contract.handler.id,
		);
		if (sqlPlan?.holdScope !== contract.holdScope) {
			errors.push(`hold-scope mismatch: ${contract.handler.id}`);
		}
	}
	return errors;
}

export function validateRetentionDrainRunHandlerIds(
	persistedHandlerIds: readonly string[],
): string[] {
	const expected = new Set(
		EXECUTABLE_RETENTION_HANDLERS.map((handler) => handler.id),
	);
	const persisted = new Set(persistedHandlerIds);
	const errors: string[] = [];
	if (persisted.size !== persistedHandlerIds.length) {
		errors.push("duplicate persisted retention handler ids");
	}
	for (const handlerId of expected) {
		if (!persisted.has(handlerId)) {
			errors.push(`missing retention drain run: ${handlerId}`);
		}
	}
	for (const handlerId of persisted) {
		if (!expected.has(handlerId)) {
			errors.push(`unknown retention drain run: ${handlerId}`);
		}
	}
	return errors;
}

interface RetentionDrainRunClaim {
	readonly handler_id: string;
	readonly lease_token: number;
	readonly cursor_due_at: Date | string | null;
	readonly cursor_row_id: string | null;
}

interface RetentionDrainRunId {
	readonly handler_id: string;
}

type RetentionHandlerEntry = (typeof EXECUTABLE_RETENTION_HANDLERS)[number];

export interface IsolatedRetentionRun<T> {
	readonly results: T[];
	readonly errors: unknown[];
}

/**
 * A failed handler is evidence about that handler only. Later handlers still
 * run, and the caller raises one AggregateError after every eligible handler
 * has had its turn.
 */
export async function runRetentionHandlersIsolated<T>(
	handlers: readonly RetentionHandlerEntry[],
	run: (handler: RetentionHandlerEntry) => Promise<T>,
	shouldStart: () => boolean = () => true,
): Promise<IsolatedRetentionRun<T>> {
	const results: T[] = [];
	const errors: unknown[] = [];
	for (const handler of handlers) {
		if (!shouldStart()) break;
		try {
			results.push(await run(handler));
		} catch (error) {
			errors.push(error);
		}
	}
	return { results, errors };
}

function retentionHandlerValues(): SQL {
	return sql.join(
		EXECUTABLE_RETENTION_HANDLERS.map((handler) => sql`(${handler.id})`),
		sql`, `,
	);
}

async function ensureRetentionDrainRuns(db: Database): Promise<void> {
	await db.execute(sql`
		INSERT INTO ${retentionDrainRuns} (handler_id)
		VALUES ${retentionHandlerValues()}
		ON CONFLICT (handler_id) DO NOTHING
	`);
	const persisted = (await db.execute(sql`
		SELECT handler_id
		  FROM ${retentionDrainRuns}
		 ORDER BY handler_id
	`)) as unknown as RetentionDrainRunId[];
	const errors = validateRetentionDrainRunHandlerIds(
		persisted.map((row) => row.handler_id),
	);
	if (errors.length > 0) {
		throw new AggregateError(
			errors.map((message) => new Error(message)),
			"Retention drain control rows do not match executable handlers",
		);
	}
}

async function continuationHandlerIds(
	db: Database,
	now: Date,
): Promise<readonly string[]> {
	const rows = (await db.execute(sql`
		SELECT handler_id
		  FROM ${retentionDrainRuns}
		 WHERE (
				status IN ('idle', 'manual_review')
				AND (cursor_due_at IS NOT NULL OR last_error_code IS NOT NULL)
			)
		    OR (status = 'running' AND lease_expires_at <= ${timestampParam(now)})
		 ORDER BY
			CASE WHEN status = 'manual_review' THEN 0 ELSE 1 END,
			backlog_oldest_due_at NULLS LAST,
			last_finished_at NULLS FIRST,
			handler_id
		 LIMIT ${RETENTION_CONTINUATION_HANDLER_LIMIT}
	`)) as unknown as RetentionDrainRunId[];
	return rows.map((row) => row.handler_id);
}

async function claimRetentionDrainRun(
	db: Database,
	handlerId: string,
	now: Date,
): Promise<RetentionDrainRunClaim | null> {
	const rows = (await db.execute(sql`
		UPDATE ${retentionDrainRuns} AS run
		   SET status = 'running',
		       lease_token = run.lease_token + 1,
		       lease_expires_at =
		         ${timestampParam(new Date(now.getTime() + RETENTION_DRAIN_LEASE_MS))},
		       last_started_at = ${timestampParam(now)},
		       last_error_code = NULL
		 WHERE run.handler_id = ${handlerId}
		   AND (
				run.status <> 'running'
				OR run.lease_expires_at <= ${timestampParam(now)}
		   )
		RETURNING run.handler_id,
		          run.lease_token,
		          run.cursor_due_at,
		          run.cursor_row_id
	`)) as unknown as RetentionDrainRunClaim[];
	return rows[0] ?? null;
}

function claimCursor(claim: RetentionDrainRunClaim): RetentionCursor | null {
	if (claim.cursor_due_at === null || claim.cursor_row_id === null) return null;
	return {
		dueAt: isoTimestamp(claim.cursor_due_at),
		rowId: claim.cursor_row_id,
	};
}

export function retentionDrainStatus(
	result: RetentionDrainResult,
	now: Date,
): "idle" | "manual_review" {
	if (!result.moreDue || !result.oldestDueAt) return "idle";
	return now.getTime() - new Date(result.oldestDueAt).getTime() >=
		RETENTION_BACKLOG_SLO_MS
		? "manual_review"
		: "idle";
}

async function finishRetentionDrainRun(
	db: Database,
	claim: RetentionDrainRunClaim,
	result: RetentionDrainResult,
	now: Date,
): Promise<void> {
	const status = retentionDrainStatus(result, now);
	const continuationRestartRequired =
		result.continuationRequired &&
		(result.cursorDueAt === null || result.cursorRowId === null);
	const rows = (await db.execute(sql`
		UPDATE ${retentionDrainRuns} AS run
		   SET status = ${status},
		       lease_expires_at = NULL,
		       cursor_due_at =
		         ${
								result.continuationRequired && result.cursorDueAt
									? timestampParam(result.cursorDueAt)
									: sql`NULL`
},
		       cursor_row_id =
		         ${result.continuationRequired ? result.cursorRowId : null},
		       last_finished_at = ${timestampParam(now)},
		       rows_last_run = ${result.processed},
		       backlog_oldest_due_at =
		         ${
								result.oldestDueAt
									? timestampParam(result.oldestDueAt)
									: sql`NULL`
},
		       consecutive_more_due = CASE
		         WHEN ${result.moreDue}
		         THEN run.consecutive_more_due + 1
		         ELSE 0
		       END,
		       last_error_code =
		         ${
								continuationRestartRequired
									? "continuation_restart_required"
									: null
}
		 WHERE run.handler_id = ${claim.handler_id}
		   AND run.status = 'running'
		   AND run.lease_token = ${claim.lease_token}
		RETURNING run.handler_id
	`)) as unknown as RetentionDrainRunId[];
	if (rows.length !== 1) {
		throw new Error(`retention_drain_fence_lost:${claim.handler_id}`);
	}
}

async function failRetentionDrainRun(
	db: Database,
	claim: RetentionDrainRunClaim,
	now: Date,
): Promise<void> {
	const rows = (await db.execute(sql`
		UPDATE ${retentionDrainRuns} AS run
		   SET status = 'idle',
		       lease_expires_at = NULL,
		       last_finished_at = ${timestampParam(now)},
		       rows_last_run = 0,
		       last_error_code = 'handler_execution_failed'
		 WHERE run.handler_id = ${claim.handler_id}
		   AND run.status = 'running'
		   AND run.lease_token = ${claim.lease_token}
		RETURNING run.handler_id
	`)) as unknown as RetentionDrainRunId[];
	if (rows.length !== 1) {
		throw new Error(`retention_drain_failure_fence_lost:${claim.handler_id}`);
	}
}

export interface ExecutableRetentionRunOptions {
	readonly db?: Database;
	readonly now?: Date;
	readonly continuationOnly?: boolean;
	readonly wallClockBudgetMs?: number;
	readonly clock?: () => number;
}

export async function runExecutablePostgresRetention(
	env: Env,
	options?: ExecutableRetentionRunOptions,
): Promise<readonly ExecutableRetentionRunResult[]> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	const continuationOnly = options?.continuationOnly ?? false;
	if (!continuationOnly) await ensureRetentionDrainRuns(db);
	const selectedIds = continuationOnly
		? new Set(await continuationHandlerIds(db, now))
		: new Set(EXECUTABLE_RETENTION_HANDLERS.map((handler) => handler.id));
	const handlers = EXECUTABLE_RETENTION_HANDLERS.filter((handler) =>
		selectedIds.has(handler.id),
	);
	const clock = options?.clock ?? Date.now;
	const startedAt = clock();
	const wallClockBudgetMs =
		options?.wallClockBudgetMs ?? RETENTION_DRAIN_WALL_BUDGET_MS;
	const alertFailures: unknown[] = [];

	const isolated = await runRetentionHandlersIsolated(
		handlers,
		async (handler): Promise<ExecutableRetentionRunResult | null> => {
			const claim = await claimRetentionDrainRun(db, handler.id, now);
			if (!claim) return null;
			try {
				const contract = HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS.find(
					(candidate) => candidate.handler.id === handler.id,
				);
				if (!contract) {
					throw new Error(`Uncontracted retention handler: ${handler.id}`);
				}
				const result = await handler.run(env, {
					db,
					now,
					cursor: claimCursor(claim),
				});
				await finishRetentionDrainRun(db, claim, result, now);
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
								storeId: contract.storeId,
								handlerId: handler.id,
								processed: result.processed,
								hardLimit: contract.batch.rows * contract.batch.maxPasses,
								oldestDueAt: result.oldestDueAt,
								observedAt: now.toISOString(),
								occurrenceId: `retention:${handler.id}:${now
									.toISOString()
									.slice(0, 10)}`,
							},
							env,
						);
					} catch (error) {
						alertFailures.push(error);
					}
				}
				return {
					handlerId: handler.id,
					storeId: contract.storeId,
					result,
				};
			} catch (error) {
				try {
					await failRetentionDrainRun(db, claim, now);
				} catch (fenceError) {
					throw new AggregateError(
						[error, fenceError],
						`Retention handler ${handler.id} failed and its retry state could not be persisted`,
					);
				}
				throw error;
			}
		},
		() =>
			!continuationOnly || clock() - startedAt < Math.max(1, wallClockBudgetMs),
	);
	const results = isolated.results.filter(
		(result): result is ExecutableRetentionRunResult => result !== null,
	);
	const failures = [...isolated.errors, ...alertFailures];
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`${failures.length} executable retention handler or alert operation(s) failed`,
		);
	}
	return results;
}

/**
 * Every-minute continuation owner. Only handlers with a persisted cursor,
 * retry code, or expired lease are eligible; the daily pass remains the sole
 * producer of fresh handler runs.
 */
export async function continueExecutablePostgresRetention(
	env: Env,
	options?: Omit<ExecutableRetentionRunOptions, "continuationOnly">,
): Promise<readonly ExecutableRetentionRunResult[]> {
	return runExecutablePostgresRetention(env, {
		...options,
		continuationOnly: true,
	});
}
