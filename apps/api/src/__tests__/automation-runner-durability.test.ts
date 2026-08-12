import { describe, expect, it } from "bun:test";
import {
	AUTOMATION_STEP_FAILURE_OUTCOME,
	AUTOMATION_STEP_OUTCOMES,
	automationEffects,
	automationNodeExecutions,
	automationRuns,
	automationStepRuns,
	automations,
	type Database,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	automationEffectIdempotencyKey,
	automationExecutionRecoveryDisposition,
	deserializeAutomationHandlerResult,
	serializeAutomationHandlerResult,
	transitionRunTerminal,
} from "../services/automations/runner";

function terminalTransitionDb(options: {
	casWins: boolean;
	counterFails?: boolean;
}) {
	let state = { revision: 7, status: "active", completed: 0 };
	const tx = {
		update(table: unknown) {
			return {
				set(patch: Record<string, unknown>) {
					return {
						where() {
							if (table === automationRuns) {
								return {
									returning: async () => {
										if (!options.casWins) return [];
										state.revision += 1;
										state.status = String(patch.status);
										return [{ id: "arun_atomic" }];
									},
								};
							}
							if (table === automations) {
								return Promise.resolve().then(() => {
									if (options.counterFails) {
										throw new Error("counter write failed");
									}
									state.completed += 1;
								});
							}
							throw new Error("unexpected table update");
						},
					};
				},
			};
		},
	};
	const db = {
		async transaction<T>(callback: (transaction: typeof tx) => Promise<T>) {
			const before = { ...state };
			try {
				return await callback(tx);
			} catch (error) {
				state = before;
				throw error;
			}
		},
	} as unknown as Database;
	return { db, state: () => ({ ...state }) };
}

function uniqueIndexColumns(
	table: Parameters<typeof getTableConfig>[0],
): string[][] {
	return getTableConfig(table)
		.indexes.filter((index) => index.config.unique)
		.map((index) =>
			index.config.columns.flatMap((column) => {
				const name = (column as { name?: unknown }).name;
				return typeof name === "string" ? [name] : [];
			}),
		);
}

describe("automation runner durable execution fence", () => {
	it("commits a terminal CAS and its aggregate counter together", async () => {
		const fixture = terminalTransitionDb({ casWins: true });
		expect(
			await transitionRunTerminal(
				fixture.db,
				"arun_atomic",
				7,
				"auto_atomic",
				"completed",
				"completed",
			),
		).toBe(true);
		expect(fixture.state()).toEqual({
			revision: 8,
			status: "completed",
			completed: 1,
		});
	});

	it("rolls back a terminal run transition when its counter write fails", async () => {
		const fixture = terminalTransitionDb({ casWins: true, counterFails: true });
		await expect(
			transitionRunTerminal(
				fixture.db,
				"arun_atomic",
				7,
				"auto_atomic",
				"completed",
				"completed",
			),
		).rejects.toThrow("counter write failed");
		expect(fixture.state()).toEqual({
			revision: 7,
			status: "active",
			completed: 0,
		});
	});

	it("does not increment a terminal counter when the run CAS loses", async () => {
		const fixture = terminalTransitionDb({ casWins: false });
		expect(
			await transitionRunTerminal(
				fixture.db,
				"arun_atomic",
				7,
				"auto_atomic",
				"completed",
				"completed",
			),
		).toBe(false);
		expect(fixture.state()).toEqual({
			revision: 7,
			status: "active",
			completed: 0,
		});
	});

	it("has one exclusive ledger identity per run revision and node effect", () => {
		expect(uniqueIndexColumns(automationNodeExecutions)).toContainEqual([
			"run_id",
			"run_revision",
			"visit_ordinal",
		]);
		expect(uniqueIndexColumns(automationEffects)).toContainEqual([
			"node_execution_id",
			"effect_key",
		]);
		expect(uniqueIndexColumns(automationEffects)).toContainEqual([
			"provider_idempotency_key",
		]);
		expect(automationRuns.revision).toBeDefined();
		expect("requestMayHaveBeenSentAt" in automationNodeExecutions).toBe(false);
		expect(automationEffects.requestMayHaveBeenSentAt).toBeDefined();
		expect(automationEffects.kind.enumValues).toEqual([
			"message_block",
			"http_request",
			"automation_action",
		]);
		expect(AUTOMATION_STEP_FAILURE_OUTCOME).toBe("failed");
		expect(AUTOMATION_STEP_OUTCOMES).toContain(AUTOMATION_STEP_FAILURE_OUTCOME);
		expect(automationStepRuns.outcome.enumValues).toContain(
			AUTOMATION_STEP_FAILURE_OUTCOME,
		);
	});

	it("reclaims only pre-boundary claims and makes expired effects manual-safe", () => {
		const now = new Date("2026-07-15T12:00:00.000Z");
		const future = new Date(now.getTime() + 60_000);
		const past = new Date(now.getTime() - 60_000);

		expect(
			automationExecutionRecoveryDisposition(
				{
					status: "claimed",
					leaseExpiresAt: future,
					requestMayHaveBeenSentAt: null,
				},
				now,
			),
		).toBe("busy");
		expect(
			automationExecutionRecoveryDisposition(
				{
					status: "claimed",
					leaseExpiresAt: past,
					requestMayHaveBeenSentAt: null,
				},
				now,
			),
		).toBe("reclaim");
		for (const candidate of [
			{
				status: "in_flight" as const,
				leaseExpiresAt: past,
				requestMayHaveBeenSentAt: now,
			},
			{
				status: "claimed" as const,
				leaseExpiresAt: past,
				requestMayHaveBeenSentAt: now,
			},
		]) {
			expect(automationExecutionRecoveryDisposition(candidate, now)).toBe(
				"unknown",
			);
		}
		expect(
			automationExecutionRecoveryDisposition(
				{
					status: "succeeded",
					leaseExpiresAt: null,
					requestMayHaveBeenSentAt: now,
				},
				now,
			),
		).toBe("completed");
	});

	it("round-trips replayable HandlerResult timestamps and failures", () => {
		const resumeAt = new Date("2026-07-15T12:30:00.000Z");
		const waiting = deserializeAutomationHandlerResult(
			serializeAutomationHandlerResult({
				result: "wait_delay",
				resume_at: resumeAt,
				payload: { page: 2 },
			}),
		);
		expect(waiting).toEqual({
			result: "wait_delay",
			resume_at: resumeAt,
			payload: { page: 2 },
		});

		const failed = deserializeAutomationHandlerResult(
			serializeAutomationHandlerResult({
				result: "fail",
				error: new Error("provider rejected request"),
			}),
		);
		expect(failed.result).toBe("fail");
		if (failed.result === "fail") {
			expect(failed.error.message).toBe("provider rejected request");
		}
	});

	it("derives a stable provider key from the persisted execution identity", () => {
		const first = automationEffectIdempotencyKey("anx_123");
		expect(first).toBe(automationEffectIdempotencyKey("anx_123"));
		expect(first).not.toBe(automationEffectIdempotencyKey("anx_456"));
	});

	it("claims and arms before handlers, persists before CAS, and uses revisions", async () => {
		const source = await Bun.file(
			new URL("../services/automations/runner.ts", import.meta.url),
		).text();
		const runLoopStart = source.indexOf("export async function runLoop");
		const claim = source.indexOf(
			"const executionClaim = await claimNodeExecution",
			runLoopStart,
		);
		const arm = source.indexOf("await armNodeExecution", claim);
		const handler = source.indexOf("result = await handler.handle", arm);
		const completion = source.indexOf("await persistNodeCompletion", handler);
		const resultCas = source.indexOf(
			"Apply the persisted/replayed HandlerResult",
			completion,
		);

		expect(claim).toBeGreaterThan(runLoopStart);
		expect(arm).toBeGreaterThan(claim);
		expect(handler).toBeGreaterThan(arm);
		expect(completion).toBeGreaterThan(handler);
		expect(resultCas).toBeGreaterThan(completion);
		expect(source).toContain("requestMayHaveBeenSentAt: requestBoundary");
		expect(source).toContain("eq(automationRuns.revision, expectedRevision)");
		expect(source).toMatch(
			/revision: sql`\$\{automationRuns\.revision\} \+ 1`/,
		);
		expect(source).not.toContain("date_trunc('milliseconds'");
		expect(source).toContain(
			"effectiveEnv.automationEffectIdempotencyKey = effectIdempotencyKey",
		);
		expect(source).toContain("_automation_manual_reconciliation");
		expect(source).toContain("reconcileExpiredAutomationNodeExecutions");
		expect(source).toContain("node-execution-recovery:");
	});

	it("derives insights failure accounting from the schema literal", async () => {
		const source = await Bun.file(
			new URL("../routes/_automation-insights.ts", import.meta.url),
		).text();
		expect(source).toContain("AUTOMATION_STEP_FAILURE_OUTCOME");
		expect(source).toMatch(
			/automationStepRuns\.outcome} != \$\{AUTOMATION_STEP_FAILURE_OUTCOME}/,
		);
		expect(source).not.toContain('eq(automationStepRuns.outcome, "fail")');
	});
});
