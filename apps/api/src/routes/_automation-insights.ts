// apps/api/src/routes/_automation-insights.ts
//
// Shared insights aggregator used by the automation, entrypoint, and binding
// routes (spec §9.8, §11.x observability surface).
//
// Queries live SQL aggregates against automation_runs + automation_step_runs.
// Exposes a single response shape so consumers in the SDK / dashboard can
// render a uniform "runs over period" chart regardless of whether the scope
// is an automation, a specific entrypoint, or a binding.

import { z } from "@hono/zod-openapi";
import {
	automationEntrypoints,
	automationRuns,
	automationStepRuns,
	automations,
} from "@relayapi/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Database } from "@relayapi/db";

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

const PeriodSchema = z.enum(["24h", "7d", "30d", "90d", "custom"]).default("7d");

const BaseInsightsQuery = z.object({
	period: PeriodSchema,
	from: z
		.string()
		.datetime({ offset: true })
		.optional()
		.describe("Required when period=custom; ISO 8601"),
	to: z
		.string()
		.datetime({ offset: true })
		.optional()
		.describe("Required when period=custom; ISO 8601"),
});

export const AutomationInsightsQuery = BaseInsightsQuery;
export const GlobalInsightsQuery = BaseInsightsQuery.extend({
	created_from_template: z
		.string()
		.optional()
		.describe("Roll up across all automations with this template kind"),
	workspace_id: z.string().optional(),
});
export const EntrypointInsightsQuery = BaseInsightsQuery;
export const BindingInsightsQuery = BaseInsightsQuery;

export type InsightsPeriod = z.infer<typeof PeriodSchema>;

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const InsightsResponseSchema = z.object({
	period: z.object({ from: z.string(), to: z.string() }),
	totals: z.object({
		enrolled: z.number(),
		completed: z.number(),
		exited: z.number(),
		failed: z.number(),
		active: z.number(),
		waiting: z.number(),
		avg_duration_ms: z.number(),
	}),
	exit_reasons: z.array(z.object({ reason: z.string(), count: z.number() })),
	by_entrypoint: z.array(
		z.object({
			entrypoint_id: z.string().nullable(),
			kind: z.string().nullable(),
			runs: z.number(),
			completion_rate: z.number(),
		}),
	),
	per_node: z.array(
		z.object({
			node_key: z.string(),
			kind: z.string(),
			executions: z.number(),
			success_rate: z.number(),
			/**
			 * Breakdown of exit-port usage for this node within the period.
			 * Each key is an `exited_via_port_key` value (e.g. `"next"`,
			 * `"button.btn_large"`); the number is the count of step_runs that
			 * exited through that port. Nodes with no recorded exit ports
			 * return an empty object. Consumed by the canvas node-metric
			 * overlay's per-port popover.
			 */
			per_port: z.record(z.string(), z.number()),
		}),
	),
});

export type InsightsResponse = z.infer<typeof InsightsResponseSchema>;

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

export function resolvePeriod(query: {
	period?: InsightsPeriod;
	from?: string;
	to?: string;
}): { from: Date; to: Date } {
	const now = new Date();
	const period = query.period ?? "7d";
	if (period === "custom") {
		const from = query.from ? new Date(query.from) : new Date(now.getTime() - 7 * 24 * 3600 * 1000);
		const to = query.to ? new Date(query.to) : now;
		return { from, to };
	}
	const map: Record<Exclude<InsightsPeriod, "custom">, number> = {
		"24h": 24 * 3600 * 1000,
		"7d": 7 * 24 * 3600 * 1000,
		"30d": 30 * 24 * 3600 * 1000,
		"90d": 90 * 24 * 3600 * 1000,
	};
	const delta = map[period as Exclude<InsightsPeriod, "custom">];
	return { from: new Date(now.getTime() - delta), to: now };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type AggregateScope = {
	orgId: string;
	automationId?: string;
	entrypointId?: string;
	bindingId?: string;
	createdFromTemplate?: string;
	workspaceId?: string;
};

function zero(): InsightsResponse {
	return {
		period: { from: "", to: "" },
		totals: {
			enrolled: 0,
			completed: 0,
			exited: 0,
			failed: 0,
			active: 0,
			waiting: 0,
			avg_duration_ms: 0,
		},
		exit_reasons: [],
		by_entrypoint: [],
		per_node: [],
	};
}

/**
 * Build the base WHERE clause for the runs query, applying the scope filters.
 * We always constrain by organizationId + started_at window; automation /
 * entrypoint / binding / template filters narrow further.
 */
async function resolveAutomationIds(
	db: Database,
	scope: AggregateScope,
): Promise<string[] | null> {
	// If we already have a specific automation scope, nothing to resolve.
	if (scope.automationId) return [scope.automationId];
	if (!scope.createdFromTemplate && !scope.workspaceId) return null;

	const conds: SQL[] = [eq(automations.organizationId, scope.orgId)];
	if (scope.createdFromTemplate) {
		conds.push(eq(automations.createdFromTemplate, scope.createdFromTemplate));
	}
	if (scope.workspaceId) {
		conds.push(eq(automations.workspaceId, scope.workspaceId));
	}
	const rows = await db
		.select({ id: automations.id })
		.from(automations)
		.where(and(...conds));
	return rows.map((r) => r.id);
}

export async function aggregateInsights(
	db: Database,
	query: { period?: InsightsPeriod; from?: string; to?: string },
	scope: AggregateScope,
): Promise<InsightsResponse> {
	const { from, to } = resolvePeriod(query);
	const out = zero();
	out.period = { from: from.toISOString(), to: to.toISOString() };

	const filteredAutomationIds = await resolveAutomationIds(db, scope);
	// If we narrowed to an empty automation set, there's nothing to count.
	if (filteredAutomationIds && filteredAutomationIds.length === 0) {
		return out;
	}

	// Base run filters.
	const runConds: SQL[] = [
		eq(automationRuns.organizationId, scope.orgId),
		sql`${automationRuns.startedAt} >= ${from.toISOString()}`,
		sql`${automationRuns.startedAt} <= ${to.toISOString()}`,
	];
	if (scope.automationId) {
		runConds.push(eq(automationRuns.automationId, scope.automationId));
	} else if (filteredAutomationIds && filteredAutomationIds.length > 0) {
		runConds.push(inArray(automationRuns.automationId, filteredAutomationIds));
	}
	if (scope.entrypointId) {
		runConds.push(eq(automationRuns.entrypointId, scope.entrypointId));
	}
	if (scope.bindingId) {
		runConds.push(eq(automationRuns.bindingId, scope.bindingId));
	}

	// 1. Totals by status.
	const statusRows = await db
		.select({
			status: automationRuns.status,
			count: sql<number>`count(*)::int`,
			avgMs: sql<number>`coalesce(avg(extract(epoch from (${automationRuns.completedAt} - ${automationRuns.startedAt})) * 1000), 0)::int`,
		})
		.from(automationRuns)
		.where(and(...runConds))
		.groupBy(automationRuns.status);

	let enrolled = 0;
	let durationTotalMs = 0;
	let durationCount = 0;
	for (const r of statusRows) {
		const n = Number(r.count ?? 0);
		enrolled += n;
		switch (r.status) {
			case "completed":
				out.totals.completed = n;
				break;
			case "exited":
				out.totals.exited = n;
				break;
			case "failed":
				out.totals.failed = n;
				break;
			case "active":
				out.totals.active = n;
				break;
			case "waiting":
				out.totals.waiting = n;
				break;
		}
		if (r.status === "completed" || r.status === "exited" || r.status === "failed") {
			durationTotalMs += Number(r.avgMs ?? 0) * n;
			durationCount += n;
		}
	}
	out.totals.enrolled = enrolled;
	out.totals.avg_duration_ms =
		durationCount > 0 ? Math.round(durationTotalMs / durationCount) : 0;

	// 2. Exit reasons.
	const exitRows = await db
		.select({
			reason: automationRuns.exitReason,
			count: sql<number>`count(*)::int`,
		})
		.from(automationRuns)
		.where(and(...runConds, sql`${automationRuns.exitReason} IS NOT NULL`))
		.groupBy(automationRuns.exitReason);

	out.exit_reasons = exitRows.map((r) => ({
		reason: r.reason ?? "unknown",
		count: Number(r.count ?? 0),
	}));

	// 3. By entrypoint.
	const epRows = await db
		.select({
			entrypointId: automationRuns.entrypointId,
			kind: automationEntrypoints.kind,
			runs: sql<number>`count(*)::int`,
			completed: sql<number>`sum(case when ${automationRuns.status} = 'completed' then 1 else 0 end)::int`,
		})
		.from(automationRuns)
		.leftJoin(
			automationEntrypoints,
			eq(automationRuns.entrypointId, automationEntrypoints.id),
		)
		.where(and(...runConds))
		.groupBy(automationRuns.entrypointId, automationEntrypoints.kind);

	out.by_entrypoint = epRows.map((r) => {
		const runs = Number(r.runs ?? 0);
		const completed = Number(r.completed ?? 0);
		return {
			entrypoint_id: r.entrypointId ?? null,
			kind: r.kind ?? null,
			runs,
			completion_rate: runs > 0 ? +(completed / runs).toFixed(4) : 0,
		};
	});

	// 4. Per node — group step_runs by (node_key, node_kind).
	// Because automation_step_runs has no organization_id column (it's
	// partitioned and denormalized by automation_id), we MUST scope to a
	// specific automation set — either the explicit one, the template /
	// workspace filter, OR the org's automation ids — before aggregating.
	const stepConds: SQL[] = [
		sql`${automationStepRuns.executedAt} >= ${from.toISOString()}`,
		sql`${automationStepRuns.executedAt} <= ${to.toISOString()}`,
	];
	if (scope.automationId) {
		stepConds.push(eq(automationStepRuns.automationId, scope.automationId));
	} else if (filteredAutomationIds && filteredAutomationIds.length > 0) {
		stepConds.push(
			inArray(automationStepRuns.automationId, filteredAutomationIds),
		);
	} else {
		// No explicit automation scope yet — fetch the org's full automation id
		// set so the aggregate stays tenant-bounded.
		const orgAutomationRows = await db
			.select({ id: automations.id })
			.from(automations)
			.where(eq(automations.organizationId, scope.orgId));
		const ids = orgAutomationRows.map((r) => r.id);
		if (ids.length === 0) {
			return out;
		}
		stepConds.push(inArray(automationStepRuns.automationId, ids));
	}
	// Scope step-runs to the runs whose entrypoint / binding we're filtering by.
	if (scope.entrypointId || scope.bindingId) {
		const subConds: SQL[] = [
			eq(automationRuns.organizationId, scope.orgId),
			sql`${automationRuns.startedAt} >= ${from.toISOString()}`,
			sql`${automationRuns.startedAt} <= ${to.toISOString()}`,
		];
		if (scope.entrypointId) {
			subConds.push(eq(automationRuns.entrypointId, scope.entrypointId));
		}
		if (scope.bindingId) {
			subConds.push(eq(automationRuns.bindingId, scope.bindingId));
		}
		const runIdRows = await db
			.select({ id: automationRuns.id })
			.from(automationRuns)
			.where(and(...subConds));
		const ids = runIdRows.map((r) => r.id);
		if (ids.length === 0) {
			// No runs in scope → no per-node rows, return early.
			return out;
		}
		stepConds.push(inArray(automationStepRuns.runId, ids));
	}

	const nodeRows = await db
		.select({
			nodeKey: automationStepRuns.nodeKey,
			kind: automationStepRuns.nodeKind,
			executions: sql<number>`count(*)::int`,
			successes: sql<number>`sum(case when ${automationStepRuns.outcome} != 'fail' then 1 else 0 end)::int`,
		})
		.from(automationStepRuns)
		.where(and(...stepConds))
		.groupBy(automationStepRuns.nodeKey, automationStepRuns.nodeKind)
		.orderBy(sql`count(*) DESC`)
		.limit(200);

	// Per-port exit breakdown: one row per (node_key, exited_via_port_key).
	// Skip nulls (e.g. failed steps that never chose an exit port) — they're
	// already accounted for via the success_rate on per_node.
	const portRows = await db
		.select({
			nodeKey: automationStepRuns.nodeKey,
			port: automationStepRuns.exitedViaPortKey,
			count: sql<number>`count(*)::int`,
		})
		.from(automationStepRuns)
		.where(and(...stepConds, sql`${automationStepRuns.exitedViaPortKey} IS NOT NULL`))
		.groupBy(automationStepRuns.nodeKey, automationStepRuns.exitedViaPortKey);

	const perPortByNode = new Map<string, Record<string, number>>();
	for (const r of portRows) {
		if (!r.port) continue;
		const bag = perPortByNode.get(r.nodeKey) ?? {};
		bag[r.port] = Number(r.count ?? 0);
		perPortByNode.set(r.nodeKey, bag);
	}

	out.per_node = nodeRows.map((r) => {
		const executions = Number(r.executions ?? 0);
		const successes = Number(r.successes ?? 0);
		return {
			node_key: r.nodeKey,
			kind: r.kind,
			executions,
			success_rate: executions > 0 ? +(successes / executions).toFixed(4) : 0,
			per_port: perPortByNode.get(r.nodeKey) ?? {},
		};
	});

	return out;
}
