import { describe, expect, it } from "bun:test";
import { PLANS } from "@relayapi/config";
import {
	type Database,
	HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS,
	retentionDrainRuns,
} from "@relayapi/db";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import {
	continueExecutablePostgresRetention,
	EXECUTABLE_RETENTION_HANDLERS,
	RETENTION_BACKLOG_SLO_MS,
	RETENTION_DRAIN_WALL_BUDGET_MS,
	retainAdCreationOperations,
	retainConnectionLogs,
	retainThreadExecutions,
	retentionDrainStatus,
	runRetentionHandlersIsolated,
	validateExecutableRetentionHandlerCoverage,
	validateRetentionDrainRunHandlerIds,
} from "../services/executable-retention";
import type { Env } from "../types";

function dbWithResults(results: unknown[][]): {
	db: Database;
	calls: { count: number };
	queries: { sql: string; params: unknown[] }[];
} {
	const calls = { count: 0 };
	const queries: { sql: string; params: unknown[] }[] = [];
	const dialect = new PgDialect();
	return {
		db: {
			execute: async (statement: SQL) => {
				const query = dialect.sqlToQuery(statement);
				queries.push({ sql: query.sql, params: query.params });
				const result = results[calls.count] ?? [];
				calls.count += 1;
				return result;
			},
		} as unknown as Database,
		calls,
		queries,
	};
}

describe("executable PostgreSQL retention", () => {
	it("has exactly one runtime handler and SQL plan for every owned contract", () => {
		expect(validateExecutableRetentionHandlerCoverage()).toEqual([]);
		expect(EXECUTABLE_RETENTION_HANDLERS.map(({ id }) => id).sort()).toEqual(
			HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS.map(
				({ handler }) => handler.id,
			).sort(),
		);
		expect(
			new Set(EXECUTABLE_RETENTION_HANDLERS.map(({ id }) => id)).size,
		).toBe(EXECUTABLE_RETENTION_HANDLERS.length);
	});

	it("returns the bounded drain/backlog contract and preserves oldest due age", async () => {
		const fullBatch = Array.from({ length: 500 }, (_, index) => ({
			action: "deleted",
			due_at: new Date("2026-01-01T00:00:00.000Z"),
			row_id: `log_${String(index).padStart(4, "0")}`,
		}));
		const { db, calls } = dbWithResults([
			fullBatch,
			[
				{
					action: "minimized",
					due_at: new Date("2026-01-02T00:00:00.000Z"),
					row_id: "log_0500",
				},
			],
			[],
			[
				{
					due_at: new Date("2026-01-02T03:04:05.000Z"),
					organization_id: "org_test",
					row_id: "log_manual",
				},
			],
		]);
		const result = await retainConnectionLogs({} as Env, {
			db,
			now: new Date("2026-07-28T09:00:00.000Z"),
		});

		expect(result).toEqual({
			processed: 501,
			minimized: 1,
			deleted: 500,
			moreDue: true,
			oldestDueAt: "2026-01-02T03:04:05.000Z",
			oldestDueOrganizationId: "org_test",
			continuationRequired: false,
			cursorDueAt: null,
			cursorRowId: null,
		});
		expect(calls.count).toBe(4);
	});

	it("never exceeds the per-contract hard pass bound", async () => {
		const fullBatch = Array.from({ length: 500 }, (_, index) => ({
			action: "deleted",
			due_at: new Date("2026-01-01T00:00:00.000Z"),
			row_id: `log_${String(index).padStart(4, "0")}`,
		}));
		const { db, calls } = dbWithResults([
			fullBatch,
			fullBatch,
			fullBatch,
			fullBatch,
			[],
		]);
		const result = await retainConnectionLogs({} as Env, {
			db,
			now: new Date("2026-07-28T09:00:00.000Z"),
		});

		expect(result.processed).toBe(2_000);
		expect(result.moreDue).toBe(false);
		expect(result.continuationRequired).toBe(true);
		expect(result.cursorRowId).toBe("log_0499");
		// Four mutation statements (the contract maximum), then one probe.
		expect(calls.count).toBe(5);
	});

	it("isolates a throwing handler and reports it only after later handlers run", async () => {
		const handlers = EXECUTABLE_RETENTION_HANDLERS.slice(0, 3);
		const [first, second, third] = handlers;
		if (!first || !second || !third) {
			throw new Error("expected at least three retention handlers");
		}
		const calls: string[] = [];
		const result = await runRetentionHandlersIsolated(
			handlers,
			async (handler) => {
				calls.push(handler.id);
				if (handler === second) throw new Error("injected failure");
				return handler.id;
			},
		);

		expect(calls).toEqual(handlers.map((handler) => handler.id));
		expect(result.results).toEqual([first.id, third.id]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toBeInstanceOf(Error);
	});

	it("keeps one bounded fenced control row per executable handler", () => {
		const handlerIds = EXECUTABLE_RETENTION_HANDLERS.map(({ id }) => id);
		const firstHandlerId = handlerIds[0];
		if (!firstHandlerId) throw new Error("expected retention handlers");
		expect(validateRetentionDrainRunHandlerIds(handlerIds)).toEqual([]);
		expect(
			validateRetentionDrainRunHandlerIds([
				...handlerIds.slice(1),
				"unknown_handler",
			]),
		).toEqual([
			`missing retention drain run: ${firstHandlerId}`,
			"unknown retention drain run: unknown_handler",
		]);

		const table = getTableConfig(retentionDrainRuns);
		expect(table.columns.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"handler_id",
				"lease_token",
				"lease_expires_at",
				"cursor_due_at",
				"cursor_row_id",
				"last_started_at",
				"last_finished_at",
				"rows_last_run",
				"backlog_oldest_due_at",
				"consecutive_more_due",
				"status",
				"last_error_code",
			]),
		);
		expect(table.indexes.map(({ config }) => config.name)).toEqual(
			expect.arrayContaining([
				"retention_drain_runs_continuation_idx",
				"retention_drain_runs_lease_idx",
			]),
		);
		expect(RETENTION_BACKLOG_SLO_MS).toBe(24 * 60 * 60 * 1_000);
		expect(RETENTION_DRAIN_WALL_BUDGET_MS).toBeLessThan(60_000);
		const result = {
			processed: 2_000,
			minimized: 0,
			deleted: 2_000,
			moreDue: true,
			oldestDueAt: "2026-07-27T08:59:59.999Z",
			oldestDueOrganizationId: "org_test",
			continuationRequired: true,
			cursorDueAt: "2026-07-28T08:00:00.000Z",
			cursorRowId: "row_1",
		};
		expect(
			retentionDrainStatus(result, new Date("2026-07-28T09:00:00.000Z")),
		).toBe("manual_review");
		expect(
			retentionDrainStatus(
				{ ...result, oldestDueAt: "2026-07-28T08:59:59.999Z" },
				new Date("2026-07-28T09:00:00.000Z"),
			),
		).toBe("idle");
	});

	it("encodes raw-SQL retention timestamps for postgres.js", async () => {
		const { db, calls, queries } = dbWithResults([
			[{ handler_id: "retain_connection_logs" }],
			[
				{
					handler_id: "retain_connection_logs",
					lease_token: 1,
					cursor_due_at: null,
					cursor_row_id: null,
				},
			],
			[],
			[],
			[],
			[{ handler_id: "retain_connection_logs" }],
		]);

		const results = await continueExecutablePostgresRetention({} as Env, {
			db,
			now: new Date("2026-07-28T09:00:00.000Z"),
			clock: () => 0,
		});

		expect(results).toHaveLength(1);
		expect(results[0]?.handlerId).toBe("retain_connection_logs");
		expect(calls.count).toBe(6);
		expect(
			queries
				.flatMap(({ params }) => params)
				.some((value) => value instanceof Date),
		).toBe(false);
		expect(queries.map(({ sql }) => sql).join("\n")).toContain("::timestamptz");
	});

	it("uses the thread execution schema and terminal states in retention SQL", async () => {
		const { db, queries } = dbWithResults([[], [], []]);
		await retainThreadExecutions({} as Env, {
			db,
			now: new Date("2026-07-28T09:00:00.000Z"),
		});

		const rendered = queries.map(({ sql }) => sql).join("\n");
		expect(rendered).toContain("item.status IN ('completed', 'failed')");
		expect(rendered).not.toContain("item.usage_reservation_id");
		expect(rendered).not.toContain("evidence.target_id = item.id");
	});

	it("minimizes terminal operator-resolved ad creation evidence", async () => {
		const { db, queries } = dbWithResults([[], [], []]);
		await retainAdCreationOperations({} as Env, {
			db,
			now: new Date("2026-07-28T09:00:00.000Z"),
		});

		const rendered = queries.map(({ sql }) => sql).join("\n");
		expect(rendered).toContain("item.status = 'manual_review'");
		expect(rendered).toContain(
			"evidence.target_type = 'ad_creation_operation'",
		);
		expect(rendered).toContain(
			"evidence.action IN ('mark_succeeded', 'mark_not_applied')",
		);
	});

	it("can drain at least the highest sold per-minute request admission", async () => {
		const minimumRowsPerContinuation = Math.min(
			...HIGH_GROWTH_POSTGRES_RETENTION_CONTRACTS.map(
				(contract) => contract.batch.rows * contract.batch.maxPasses,
			),
		);
		expect(minimumRowsPerContinuation).toBeGreaterThanOrEqual(
			PLANS.pro.rateLimitMax,
		);
		const scheduled = await Bun.file(
			new URL("../scheduled/index.ts", import.meta.url),
		).text();
		expect(scheduled).toContain(
			'name: "executable_postgres_retention_continuation"',
		);
		expect(scheduled).toContain("continueExecutablePostgresRetention(env)");
	});

	it("keeps lifecycle safety mechanics in the shared SQL executor", async () => {
		const source = await Bun.file(
			new URL("../services/executable-retention.ts", import.meta.url),
		).text();
		expect(source).toContain("FOR UPDATE OF item SKIP LOCKED");
		expect(source).toContain(
			["ORDER BY $", "{parts.dueAt}, $", "{itemKey}"].join(""),
		);
		expect(source).toContain("hold.released_at IS NULL");
		expect(source).toContain("hold.subject_kind = 'workspace'");
		expect(source).toContain('holdTreatment === "pause"');
		expect(source).toContain('holdTreatment === "never"');
		expect(source).toContain(
			["sql`($", "{minimizeDueNow}) AND NOT ($", "{hold})`"].join(""),
		);
		expect(source).toContain(
			["? sql`($", "{processable}) OR ($", "{unresolved})`"].join(""),
		);
		expect(source).toContain("dispatchRetentionBacklogAlert");
		expect(source).toContain("oldestDueAt");
		expect(source).toContain("RETENTION_BACKLOG_SLO_MS");
		expect(source).toContain("retentionDrainStatus");
		expect(source).toContain("cursor_due_at");
	});
});
