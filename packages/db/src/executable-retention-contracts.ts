/**
 * Machine-checkable PostgreSQL retention contracts.
 *
 * The privacy registry explains why a store exists. This registry proves that
 * a time-bound store has a real exported handler and a scheduled, bounded,
 * indexed lifecycle. Predicates are deliberately source-reviewable so a policy
 * cannot be marked complete by prose alone.
 */

import { FINANCIAL_POSTGRES_RETENTION_CONTRACTS } from "./financial-retention-contracts";
import { postgresRetentionHoldTreatment } from "./postgres-retention-hold-policy";
import {
	getPrivacyRetentionStore,
	type LegalHoldTreatment,
} from "./privacy-retention-registry";
import { SPECIALIZED_POSTGRES_RETENTION_CONTRACTS } from "./specialized-retention-contracts";

export { SPECIALIZED_POSTGRES_RETENTION_CONTRACTS } from "./specialized-retention-contracts";

export type PostgresRetentionStoreId = `postgres:${string}`;

export type RetentionHoldScope =
	| "none"
	| "organization"
	| "organization_or_workspace";

export type RetentionDuration =
	| { readonly value: number; readonly unit: "days" | "months" }
	| { readonly value: 0; readonly unit: "at_expiry" };

export interface RetentionHorizon {
	readonly after: RetentionDuration;
	readonly predicate: string;
	readonly preserves: string;
}

export interface RetentionHandlerEvidence {
	readonly id: string;
	readonly source: `apps/api/${string}.ts`;
	readonly exportName: string;
	readonly testSource: `apps/api/${string}.test.ts`;
	readonly testMarker: string;
}

export interface RetentionCadence {
	readonly cron: string;
	readonly taskName: string;
	readonly source: `apps/api/${string}.ts`;
}

export interface ExecutablePostgresRetentionContract {
	readonly storeId: PostgresRetentionStoreId;
	readonly handler: RetentionHandlerEvidence;
	readonly cutoff: {
		readonly timestampExpression: string;
		readonly terminalPredicate: string;
		readonly unresolvedPredicate?: string;
	};
	readonly horizons: {
		readonly minimize: RetentionHorizon | null;
		readonly delete: RetentionHorizon | null;
	};
	/** Source-derived from the privacy registry; runtime policy must not drift. */
	readonly holdTreatment: LegalHoldTreatment;
	readonly holdScope: RetentionHoldScope;
	readonly batch: {
		readonly rows: number;
		readonly maxPasses: number;
		readonly orderBy: readonly [string, string, ...string[]];
		readonly indexName: string;
		/** Parent/authority table when child rows drain through its cutoff scan. */
		readonly indexStoreId?: PostgresRetentionStoreId;
		/** Additional physical clocks used by multi-phase redact/delete handlers. */
		readonly additionalIndexes?: readonly {
			readonly indexName: string;
			readonly indexStoreId?: PostgresRetentionStoreId;
		}[];
	};
	readonly cadence: RetentionCadence;
	readonly owner: string;
}

export const DAILY_POSTGRES_RETENTION_CRON = "0 9 * * *";
export const DAILY_POSTGRES_RETENTION_TASK = "executable_postgres_retention";
export const DEFAULT_POSTGRES_RETENTION_BATCH_ROWS = 500;
export const DEFAULT_POSTGRES_RETENTION_MAX_PASSES = 4;

const RUNTIME_SOURCE = "apps/api/src/services/executable-retention.ts" as const;
const RUNTIME_TEST =
	"apps/api/src/__tests__/executable-retention.test.ts" as const;
const SCHEDULE_SOURCE = "apps/api/src/scheduled/index.ts" as const;

function days(value: number): RetentionDuration {
	return { value, unit: "days" };
}

function months(value: number): RetentionDuration {
	return { value, unit: "months" };
}

type HighGrowthContractInput = Omit<
	ExecutablePostgresRetentionContract,
	"handler" | "batch" | "cadence" | "holdTreatment" | "owner"
> & {
	readonly handlerId: string;
	readonly exportName: string;
	readonly indexName: string;
	readonly orderTiebreaker?: string;
};

function highGrowthContract(
	input: HighGrowthContractInput,
): ExecutablePostgresRetentionContract {
	return {
		storeId: input.storeId,
		handler: {
			id: input.handlerId,
			source: RUNTIME_SOURCE,
			exportName: input.exportName,
			testSource: RUNTIME_TEST,
			testMarker: "validateExecutableRetentionHandlerCoverage",
		},
		cutoff: input.cutoff,
		horizons: input.horizons,
		holdTreatment: postgresRetentionHoldTreatment(input.storeId),
		holdScope: input.holdScope,
		batch: {
			rows: DEFAULT_POSTGRES_RETENTION_BATCH_ROWS,
			maxPasses: DEFAULT_POSTGRES_RETENTION_MAX_PASSES,
			orderBy: [
				input.cutoff.timestampExpression,
				input.orderTiebreaker ?? "id",
			],
			indexName: input.indexName,
		},
		cadence: {
			cron: DAILY_POSTGRES_RETENTION_CRON,
			taskName: DAILY_POSTGRES_RETENTION_TASK,
			source: SCHEDULE_SOURCE,
		},
		owner: "data-governance",
	};
}

/**
 * Non-contact, non-financial high-growth contracts implemented by the
 * canonical daily executor. Domain owners append specialized contracts to
 * `EXECUTABLE_POSTGRES_RETENTION_CONTRACTS`.
 */
export const HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS = [
	highGrowthContract({
		storeId: "postgres:public.account_revocation_jobs",
		handlerId: "retain_account_revocation_jobs",
		exportName: "retainAccountRevocationJobs",
		indexName: "account_revocation_jobs_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('succeeded', 'abandoned')",
			unresolvedPredicate: "status = 'manual_required'",
		},
		horizons: {
			minimize: {
				after: days(7),
				predicate:
					"status IN ('succeeded', 'abandoned', 'manual_required') AND completed_at IS NOT NULL",
				preserves:
					"status, provider operation identity, timestamps, and a sanitized outcome",
			},
			delete: {
				after: days(90),
				predicate: "status IN ('succeeded', 'abandoned')",
				preserves: "the social-account lifecycle projection",
			},
		},
		holdScope: "organization",
	}),
	highGrowthContract({
		storeId: "postgres:public.token_refresh_operations",
		handlerId: "retain_token_refresh_operations",
		exportName: "retainTokenRefreshOperations",
		indexName: "token_refresh_operations_retention_idx",
		orderTiebreaker: "account_id",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, updated_at)",
			terminalPredicate: "state = 'succeeded'",
			unresolvedPredicate: "state = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "state = 'unknown'",
				preserves:
					"account id, source token-version fence, state, and timestamps",
			},
			delete: {
				after: days(30),
				predicate: "succeeded at 30 days OR superseded unknown at 90 days",
				preserves: "the social-account token-version/lifecycle authority",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.thread_executions",
		handlerId: "retain_thread_executions",
		exportName: "retainThreadExecutions",
		indexName: "thread_executions_retention_idx",
		orderTiebreaker: "thread_group_id",
		cutoff: {
			timestampExpression: "updated_at",
			terminalPredicate: "status IN ('completed', 'failed')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "status IN ('completed', 'failed', 'unknown')",
				preserves:
					"thread revision fence, state, timestamps, and sanitized failure class",
			},
			delete: {
				after: days(90),
				predicate: "status IN ('completed', 'failed')",
				preserves: "the authoritative post/thread projections",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.publish_attempts",
		handlerId: "retain_publish_attempts",
		exportName: "retainPublishAttempts",
		indexName: "publish_attempts_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "state IN ('succeeded', 'failed')",
			unresolvedPredicate: "state = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "state IN ('succeeded', 'failed', 'unknown')",
				preserves:
					"attempt fence, outcome, completion time, and unresolved provider identity",
			},
			delete: {
				after: days(90),
				predicate:
					"superseded attempt and (resolved state OR parent post target is no longer unknown)",
				preserves:
					"the post_targets delivery projection and its exact current-attempt anchor",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.recycling_occurrences",
		handlerId: "retain_recycling_occurrences",
		exportName: "retainRecyclingOccurrences",
		indexName: "recycling_occurrences_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('committed', 'terminal_failure')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "status IN ('committed', 'terminal_failure', 'unknown')",
				preserves:
					"occurrence/config identity, state, post identity, and timestamps",
			},
			delete: {
				after: days(90),
				predicate: "status IN ('committed', 'terminal_failure')",
				preserves: "the recycling config and created post",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.connection_logs",
		handlerId: "retain_connection_logs",
		exportName: "retainConnectionLogs",
		indexName: "connection_logs_retention_idx",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate: "TRUE",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "message IS NOT NULL OR snapshot IS NOT NULL",
				preserves: "organization/account, closed event code, and timestamp",
			},
			delete: {
				after: days(90),
				predicate: "TRUE",
				preserves: "current social-account lifecycle state",
			},
		},
		holdScope: "organization",
	}),
	highGrowthContract({
		storeId: "postgres:public.notifications",
		handlerId: "retain_notifications",
		exportName: "retainNotifications",
		indexName: "notifications_retention_idx",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate: "read = TRUE OR age >= 180 days",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "(read AND age >= 90 days) OR age >= 180 days",
				preserves:
					"user/organization, type, occurrence id, read state, and timestamp",
			},
			delete: {
				after: days(365),
				predicate: "TRUE",
				preserves: "notification preferences",
			},
		},
		holdScope: "organization",
	}),
	highGrowthContract({
		storeId: "postgres:public.inbox_event_effects",
		handlerId: "retain_inbox_event_effects",
		exportName: "retainInboxEventEffects",
		indexName: "inbox_event_effects_retention_idx",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, updated_at)",
			terminalPredicate: "status = 'completed'",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "status IN ('completed', 'unknown')",
				preserves:
					"event/effect idempotency identity, state, counters, and timestamps",
			},
			delete: {
				after: days(90),
				predicate: "status = 'completed'",
				preserves: "the authoritative inbox projection",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.auto_post_feed_items",
		handlerId: "retain_auto_post_feed_items",
		exportName: "retainAutoPostFeedItems",
		indexName: "auto_post_feed_items_retention_idx",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, created_at)",
			terminalPredicate:
				"status IN ('ignored', 'committed', 'transient_failure', 'terminal_failure')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate:
					"status IN ('ignored', 'committed', 'transient_failure', 'terminal_failure', 'unknown')",
				preserves:
					"rule/canonical-feed-item dedupe identity, outcome, and timestamps",
			},
			delete: null,
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.ad_creation_operations",
		handlerId: "retain_ad_creation_operations",
		exportName: "retainAdCreationOperations",
		indexName: "ad_creation_operations_retention_idx",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, updated_at)",
			terminalPredicate: "status = 'completed'",
			unresolvedPredicate: "status IN ('unknown', 'manual_review')",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate:
					"status = 'completed' or terminal operator-resolved, and linked usage reservation is terminal when present",
				preserves:
					"idempotency/fence identity, status, provider operation id, and timestamps",
			},
			delete: {
				after: days(90),
				predicate:
					"status = 'completed' and linked usage reservation is terminal when present",
				preserves: "authoritative ad entities",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.ad_mutation_operations",
		handlerId: "retain_ad_mutation_operations",
		exportName: "retainAdMutationOperations",
		indexName: "ad_mutation_operations_retention_idx",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, updated_at)",
			terminalPredicate: "status = 'completed'",
			unresolvedPredicate: "status IN ('unknown', 'manual_review')",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate:
					"status = 'completed' or terminal operator-resolved no-effect, and linked usage reservation is terminal when present",
				preserves:
					"idempotency/fence identity, target, status, and provider-confirmation timestamp",
			},
			delete: null,
		},
		holdScope: "organization",
	}),
	highGrowthContract({
		storeId: "postgres:public.ad_metrics",
		handlerId: "retain_ad_metrics",
		exportName: "retainAdMetrics",
		indexName: "ad_metrics_retention_idx",
		cutoff: {
			timestampExpression: "date",
			terminalPredicate: "TRUE",
		},
		horizons: {
			minimize: null,
			delete: {
				after: months(25),
				predicate: "TRUE",
				preserves: "the ad and in-window analytics",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.ad_sync_logs",
		handlerId: "retain_ad_sync_logs",
		exportName: "retainAdSyncLogs",
		indexName: "ad_sync_logs_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "completed_at IS NOT NULL",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "completed_at IS NOT NULL AND error IS NOT NULL",
				preserves: "account, status, counters, and start/completion timestamps",
			},
			delete: {
				after: days(90),
				predicate: "completed_at IS NOT NULL",
				preserves: "current ads and account sync state",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.cross_post_actions",
		handlerId: "retain_cross_post_actions",
		exportName: "retainCrossPostActions",
		indexName: "cross_post_actions_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('executed', 'failed', 'cancelled')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "status IN ('executed', 'failed', 'cancelled', 'unknown')",
				preserves:
					"source/target identity, action type, outcome, and timestamps",
			},
			delete: null,
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.idea_conversion_operations",
		handlerId: "retain_idea_conversion_operations",
		exportName: "retainIdeaConversionOperations",
		indexName: "idea_conversion_operations_retention_idx",
		cutoff: {
			timestampExpression: "COALESCE(completed_at, updated_at)",
			terminalPredicate: "status IN ('succeeded', 'failed')",
		},
		horizons: {
			minimize: {
				after: days(30),
				predicate: "status IN ('succeeded', 'failed')",
				preserves: "idea/post/idempotency identity, outcome, and timestamps",
			},
			delete: {
				after: days(90),
				predicate: "status IN ('succeeded', 'failed')",
				preserves: "ideas.converted_to_post_id authority",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.idea_activity",
		handlerId: "retain_idea_activity",
		exportName: "retainIdeaActivity",
		indexName: "idea_activity_retention_idx",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate: "TRUE",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "metadata IS NOT NULL",
				preserves:
					"idea, pseudonymous principal, closed action code, and timestamp",
			},
			delete: {
				after: days(365),
				predicate: "TRUE",
				preserves: "current idea state and comments",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.post_analytics",
		handlerId: "retain_post_analytics",
		exportName: "retainPostAnalytics",
		indexName: "post_analytics_retention_idx",
		cutoff: {
			timestampExpression: "collected_at",
			terminalPredicate: "TRUE",
		},
		horizons: {
			minimize: null,
			delete: {
				after: months(25),
				predicate: "TRUE",
				preserves: "the current post-target aggregate snapshot",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.automation_runs",
		handlerId: "retain_automation_runs",
		exportName: "retainAutomationRuns",
		indexName: "automation_runs_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('completed', 'exited', 'failed')",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "status IN ('completed', 'exited', 'failed')",
				preserves:
					"run/automation/contact identity, outcome, graph position, and timestamps",
			},
			delete: {
				after: days(365),
				predicate: "no conversion facts at 1 year; otherwise 25 months",
				preserves: "the configured conversion-analysis window",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.automation_conversion_events",
		handlerId: "retain_automation_conversion_events",
		exportName: "retainAutomationConversionEvents",
		indexName: "automation_conversion_events_retention_idx",
		cutoff: {
			timestampExpression: "created_at",
			terminalPredicate: "dispatch_status = 'succeeded'",
			unresolvedPredicate: "dispatch_status = 'manual_review'",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "dispatch_status = 'succeeded' AND metadata IS NOT NULL",
				preserves: "conversion identity, name/value/currency, and timestamp",
			},
			delete: {
				after: months(25),
				predicate: "dispatch_status = 'succeeded'",
				preserves: "in-window conversion analytics",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.automation_node_executions",
		handlerId: "retain_automation_node_executions",
		exportName: "retainAutomationNodeExecutions",
		indexName: "automation_node_executions_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('succeeded', 'failed')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "status IN ('succeeded', 'failed', 'unknown')",
				preserves:
					"run/revision/visit/node identity, state, fence, and timestamps",
			},
			delete: {
				after: days(365),
				predicate: "status IN ('succeeded', 'failed')",
				preserves: "the minimized parent run outcome",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.automation_effects",
		handlerId: "retain_automation_effects",
		exportName: "retainAutomationEffects",
		indexName: "automation_effects_retention_idx",
		cutoff: {
			timestampExpression: "completed_at",
			terminalPredicate: "status IN ('succeeded', 'failed')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "status IN ('succeeded', 'failed', 'unknown')",
				preserves:
					"node/effect/occurrence identity, state, fence, and unresolved provider reference",
			},
			delete: {
				after: days(365),
				predicate: "status IN ('succeeded', 'failed')",
				preserves: "the minimized node/run outcome",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.automation_step_runs",
		handlerId: "retain_automation_step_runs",
		exportName: "retainAutomationStepRuns",
		indexName: "automation_step_runs_retention_idx",
		cutoff: {
			timestampExpression: "executed_at",
			terminalPredicate: "TRUE",
		},
		horizons: {
			minimize: {
				after: days(90),
				predicate: "payload IS NOT NULL OR error IS NOT NULL",
				preserves: "run/node/step identity, status, and timestamp",
			},
			delete: {
				after: days(365),
				predicate: "TRUE",
				preserves: "the minimized parent run outcome",
			},
		},
		holdScope: "organization_or_workspace",
	}),
	highGrowthContract({
		storeId: "postgres:public.automation_scheduled_jobs",
		handlerId: "retain_automation_scheduled_jobs",
		exportName: "retainAutomationScheduledJobs",
		indexName: "automation_scheduled_jobs_retention_idx",
		cutoff: {
			timestampExpression: "run_at",
			terminalPredicate: "status IN ('done', 'failed')",
			unresolvedPredicate: "status = 'unknown'",
		},
		horizons: {
			minimize: {
				after: days(7),
				predicate: "status IN ('done', 'failed', 'unknown')",
				preserves:
					"run/job idempotency identity, state, fence, schedule, and timestamps",
			},
			delete: {
				after: days(30),
				predicate: "status IN ('done', 'failed')",
				preserves: "the automation run/step outcome",
			},
		},
		holdScope: "organization_or_workspace",
	}),
] as const satisfies readonly ExecutablePostgresRetentionContract[];

/**
 * Shared append point. Specialized financial, contact/consent,
 * broadcast/audience, auth/erasure, and queue drains are registered by their
 * owning implementation changes.
 */
export const EXECUTABLE_POSTGRES_RETENTION_CONTRACTS: readonly ExecutablePostgresRetentionContract[] =
	[
		...HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS,
		...SPECIALIZED_POSTGRES_RETENTION_CONTRACTS,
		...FINANCIAL_POSTGRES_RETENTION_CONTRACTS,
	];

export function getExecutablePostgresRetentionContract(
	storeId: string,
): ExecutablePostgresRetentionContract | undefined {
	return EXECUTABLE_POSTGRES_RETENTION_CONTRACTS.find(
		(contract) => contract.storeId === storeId,
	);
}

export function validateExecutablePostgresRetentionContracts(
	contracts: readonly ExecutablePostgresRetentionContract[] = EXECUTABLE_POSTGRES_RETENTION_CONTRACTS,
): string[] {
	const errors: string[] = [];
	const storeIds = new Set<string>();
	const handlerIds = new Set<string>();

	for (const contract of contracts) {
		if (storeIds.has(contract.storeId)) {
			errors.push(`duplicate retention store: ${contract.storeId}`);
		}
		storeIds.add(contract.storeId);
		if (handlerIds.has(contract.handler.id)) {
			errors.push(`duplicate retention handler: ${contract.handler.id}`);
		}
		handlerIds.add(contract.handler.id);
		if (!contract.storeId.startsWith("postgres:")) {
			errors.push(`${contract.storeId} is not a PostgreSQL store`);
		}
		const privacyStore = getPrivacyRetentionStore(contract.storeId);
		if (!privacyStore) {
			errors.push(`${contract.storeId} has no privacy retention store`);
		} else if (contract.holdTreatment !== privacyStore.legalHold) {
			errors.push(
				`${contract.storeId} hold treatment ${contract.holdTreatment} does not match privacy registry ${privacyStore.legalHold}`,
			);
		}
		if (contract.holdTreatment === "pause" && contract.holdScope === "none") {
			errors.push(`${contract.storeId} pauses for holds but has no hold scope`);
		}
		if (contract.holdTreatment === "never" && contract.holdScope !== "none") {
			errors.push(
				`${contract.storeId} ignores holds but declares ${contract.holdScope} scope`,
			);
		}
		if (!contract.handler.exportName.trim()) {
			errors.push(`${contract.storeId} has no exported handler symbol`);
		}
		if (!contract.cutoff.timestampExpression.trim()) {
			errors.push(`${contract.storeId} has no cutoff expression`);
		}
		if (!contract.cutoff.terminalPredicate.trim()) {
			errors.push(`${contract.storeId} has no terminal predicate`);
		}
		if (!contract.horizons.minimize && !contract.horizons.delete) {
			errors.push(`${contract.storeId} has no retention horizon`);
		}
		for (const [action, horizon] of [
			["minimize", contract.horizons.minimize],
			["delete", contract.horizons.delete],
		] as const) {
			if (horizon && horizon.after.value < 0) {
				errors.push(`${contract.storeId} has a negative ${action} horizon`);
			}
			if (horizon && !horizon.predicate.trim()) {
				errors.push(`${contract.storeId} has no ${action} predicate`);
			}
			if (horizon && !horizon.preserves.trim()) {
				errors.push(`${contract.storeId} has no ${action} preservation rule`);
			}
		}
		if (
			!Number.isInteger(contract.batch.rows) ||
			contract.batch.rows < 1 ||
			!Number.isInteger(contract.batch.maxPasses) ||
			contract.batch.maxPasses < 1
		) {
			errors.push(`${contract.storeId} has an unbounded/invalid batch`);
		}
		if (contract.batch.orderBy.length < 2) {
			errors.push(`${contract.storeId} lacks a stable oldest-first order`);
		}
		if (!contract.batch.indexName.trim()) {
			errors.push(`${contract.storeId} has no supporting index`);
		}
		for (const index of contract.batch.additionalIndexes ?? []) {
			if (!index.indexName.trim()) {
				errors.push(`${contract.storeId} has an empty supporting index`);
			}
		}
		if (
			!contract.cadence.cron.trim() ||
			!contract.cadence.taskName.trim() ||
			!contract.cadence.source.trim()
		) {
			errors.push(`${contract.storeId} has no scheduled cadence`);
		}
		if (!contract.handler.testSource.trim()) {
			errors.push(`${contract.storeId} has no executable test evidence`);
		}
		if (!contract.handler.testMarker.trim()) {
			errors.push(`${contract.storeId} has no executable test assertion`);
		}
	}

	return errors;
}
