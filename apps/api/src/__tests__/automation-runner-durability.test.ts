import { describe, expect, it } from "bun:test";
import {
	automationEffects,
	automationNodeExecutions,
	automationRuns,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	automationEffectIdempotencyKey,
	automationExecutionRecoveryDisposition,
	deserializeAutomationHandlerResult,
	serializeAutomationHandlerResult,
} from "../services/automations/runner";

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
		expect(automationNodeExecutions.requestMayHaveBeenSentAt).toBeDefined();
		expect(automationEffects.requestMayHaveBeenSentAt).toBeDefined();
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
		expect(source).toContain("requestMayHaveBeenSentAt: startedAt");
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
});
