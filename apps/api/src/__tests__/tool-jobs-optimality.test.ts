import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { toolJobs } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

describe("durable tool job optimality", () => {
	it("uses a fenced encrypted lifecycle with due, stale-lease, and TTL indexes", () => {
		const config = getTableConfig(toolJobs);
		expect(config.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"request_ciphertext",
				"result_ciphertext",
				"error_ciphertext",
				"usage_reservation_id",
				"attempts",
				"lease_token",
				"lease_expires_at",
				"request_may_have_been_sent_at",
				"deadline_at",
				"purge_at",
			]),
		);
		expect(config.checks.map((constraint) => constraint.name)).toEqual(
			expect.arrayContaining([
				"tool_jobs_kind_check",
				"tool_jobs_counters_check",
				"tool_jobs_lease_check",
				"tool_jobs_payload_state_check",
				"tool_jobs_ciphertext_check",
				"tool_jobs_timestamps_check",
			]),
		);
		expect(config.indexes.map((index) => index.config.name)).toEqual(
			expect.arrayContaining([
				"tool_jobs_due_idx",
				"tool_jobs_pending_deadline_idx",
				"tool_jobs_stale_lease_idx",
				"tool_jobs_armed_lease_idx",
				"tool_jobs_purge_idx",
			]),
		);
	});

	it("keeps Queue identifier-only and provider egress Queue-only", () => {
		const queueSource = readFileSync(
			new URL("../queues/tools.ts", import.meta.url),
			"utf8",
		);
		const serviceSource = readFileSync(
			new URL("../services/tool-jobs.ts", import.meta.url),
			"utf8",
		);
		const routeSource = readFileSync(
			new URL("../routes/tools.ts", import.meta.url),
			"utf8",
		);
		expect(queueSource).toContain('type: "tool_job"');
		expect(queueSource).not.toContain("endpoint: string");
		expect(queueSource).not.toContain("payload: Record");
		expect(queueSource).toContain("executeClaimedToolJob(env, claim)");
		expect(serviceSource).toContain('claim.kind === "download"');
		expect(serviceSource).toContain("TOOL_JOB_PROVIDER_DEADLINE_MS");
		expect(routeSource).toContain("pollToolJobUntilTerminal");
		expect(routeSource).not.toContain("callDownloaderService");
		expect(routeSource).not.toContain("executionCtx.waitUntil");
	});

	it("removes KV job authority and schedules bounded recovery", () => {
		const routeSource = readFileSync(
			new URL("../routes/tools.ts", import.meta.url),
			"utf8",
		);
		const serviceSource = readFileSync(
			new URL("../services/tool-jobs.ts", import.meta.url),
			"utf8",
		);
		const scheduleSource = readFileSync(
			new URL("../scheduled/index.ts", import.meta.url),
			"utf8",
		);
		const middlewareSource = readFileSync(
			new URL("../middleware/tool-rate-limit.ts", import.meta.url),
			"utf8",
		);
		expect(routeSource).not.toContain("createToolJob(c.env.KV");
		expect(routeSource).not.toContain("getToolJob(c.env.KV");
		expect(serviceSource).toContain("TOOL_JOB_MAX_ATTEMPTS = 3");
		expect(serviceSource).toContain("TOOL_JOB_DEADLINE_MS");
		expect(serviceSource).toContain("nextAttemptAt: now,");
		expect(serviceSource).toContain(
			"TOOL_JOB_PROVIDER_DEADLINE_MS + TOOL_JOB_SETTLEMENT_MARGIN_MS",
		);
		expect(serviceSource).toContain(
			"HTTP waitUntil extends only 30 seconds after a response",
		);
		expect(serviceSource).toContain("armToolJobProviderBoundary");
		expect(serviceSource).toContain(
			"Tool job deadline elapsed before provider egress",
		);
		expect(serviceSource).toMatch(
			/sql`\$\{toolJobs\.deadlineAt\} > statement_timestamp\(\)`/,
		);
		expect(serviceSource).toContain(
			"leaseExpiresAt: new Date(now.getTime() + TOOL_JOB_LEASE_MS)",
		);
		expect(serviceSource).toContain("settleToolJobClaim");
		expect(serviceSource).toContain("reconcileLateDefinitiveToolJobOutcome");
		expect(serviceSource).toContain(
			"tool_job_definitive_reconciliation_failed",
		);
		expect(serviceSource).toContain('status: "manual_review"');
		expect(serviceSource).toContain(
			"isNull(toolJobs.requestMayHaveBeenSentAt)",
		);
		expect(serviceSource).toContain(
			'expectedStatus?: "pending" | "processing"',
		);
		expect(serviceSource).toContain("Failed to terminalize expired tool job");
		expect(serviceSource).toContain(
			"job.status = 'pending' OR job.lease_expires_at <=",
		);
		expect(serviceSource).toContain("pruneExpiredToolJobs");
		expect(serviceSource).toContain(
			"status IN ('completed', 'failed', 'manual_review')",
		);
		expect(serviceSource).toContain("reservation.state = 'parked'");
		expect(serviceSource).toContain("writeOffExpiredParkedUsageReservations");
		expect(serviceSource).toContain(
			"reconcileStaleReservedUsageReservations",
		);
		expect(serviceSource.indexOf("const { released: staleReleased")).toBeLessThan(
			serviceSource.indexOf("const writtenOff ="),
		);
		expect(serviceSource.indexOf("const writtenOff =")).toBeLessThan(
			serviceSource.indexOf("const pruned = await pruneExpiredToolJobs(env)"),
		);
		expect(serviceSource).toContain("ORDER BY purge_at ASC, id ASC");
		expect(serviceSource).toContain("FOR UPDATE SKIP LOCKED");
		expect(scheduleSource).toContain(
			'{ name: "tool_jobs", run: () => maintainToolJobs(env) }',
		);
		expect(serviceSource).toContain("toolJobOwnsUsageReservation");
		expect(serviceSource).toContain("tool_job_creation_commit_recovered");
		expect(middlewareSource).toContain("ownershipTransferred");
		expect(middlewareSource).not.toContain(
			"armUsageReservationProviderBoundary",
		);
	});

	it("gives Queue-first execution a one-second hosted dispatch window", () => {
		const wrangler = readFileSync(
			new URL("../../wrangler.jsonc", import.meta.url),
			"utf8",
		);
		const resources = JSON.parse(
			readFileSync(
				new URL("../../production-resources.json", import.meta.url),
				"utf8",
			),
		) as {
			queueConsumers: Array<{
				queue: string;
				maxWaitTimeMs?: number;
				maxRetries: number;
			}>;
		};
		const toolsBlock = wrangler.slice(
			wrangler.indexOf('"queue": "relayapi-tools",'),
			wrangler.indexOf('"queue": "relayapi-ads",'),
		);
		expect(toolsBlock).toContain('"max_batch_timeout": 1');
		expect(toolsBlock).toContain('"max_retries": 3');
		expect(
			resources.queueConsumers.find(
				(consumer) => consumer.queue === "relayapi-tools",
			),
		).toEqual(expect.objectContaining({ maxWaitTimeMs: 1_000, maxRetries: 3 }));
	});
});
