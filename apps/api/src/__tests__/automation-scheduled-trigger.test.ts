// apps/api/src/__tests__/automation-scheduled-trigger.test.ts
//
// Plan 4 / Unit RR4 / Task 6 — verifies the scheduler's `scheduled_trigger`
// dispatch: tag/segment filter enumeration, required-filter guard, cron
// rescheduling, and unsupported-cron error.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	automationEntrypoints,
	automationRuns,
	automationScheduledJobs,
	automations,
	contactSegmentMemberships,
	contacts,
	createDb,
	generateId,
	organization,
	segments,
	socialAccounts,
	workspaces,
} from "@relayapi/db";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Graph } from "../schemas/automation-graph";
import {
	armAllScheduleEntrypointsForAutomation,
	armScheduleEntrypoint,
	computeNextCronRun,
	processScheduledJobs,
} from "../services/automations/scheduler";

const CONN =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE ??
	"postgres://relayapi:z9scNsSByxEn8QC6Z6PDQLLSKLum3F@localhost:5433/relayapi?sslmode=disable";

const db = createDb(CONN);

let dbAvailable = false;
let orgId = "";
let workspaceId = "";

async function seedFixture() {
	orgId = generateId("org_");
	await db.insert(organization).values({
		id: orgId,
		name: "sched-trigger-org",
		slug: `st-${orgId.slice(-8)}`,
	});
	const [ws] = await db
		.insert(workspaces)
		.values({ organizationId: orgId, name: "st-ws" })
		.returning();
	if (!ws) throw new Error("ws insert failed");
	workspaceId = ws.id;
}

async function teardownFixture() {
	if (!orgId) return;
	await db
		.delete(automationRuns)
		.where(eq(automationRuns.organizationId, orgId));
	await db
		.delete(automationScheduledJobs)
		.where(
			sql`${automationScheduledJobs.automationId} IN (
				SELECT id FROM automations WHERE organization_id = ${orgId}
			)`,
		);
	await db
		.delete(automations)
		.where(eq(automations.organizationId, orgId));
	await db
		.delete(contactSegmentMemberships)
		.where(eq(contactSegmentMemberships.organizationId, orgId));
	await db.delete(segments).where(eq(segments.organizationId, orgId));
	await db.delete(contacts).where(eq(contacts.organizationId, orgId));
	await db
		.delete(socialAccounts)
		.where(eq(socialAccounts.organizationId, orgId));
	await db.delete(workspaces).where(eq(workspaces.organizationId, orgId));
	await db.delete(organization).where(eq(organization.id, orgId));
}

const END_GRAPH: Graph = {
	schema_version: 1,
	root_node_key: "stop",
	nodes: [
		{
			key: "stop",
			kind: "end",
			config: {},
			ports: [{ key: "in", direction: "input" }],
		},
	],
	edges: [],
};

async function makeAutomation(name: string) {
	const [auto] = await db
		.insert(automations)
		.values({
			organizationId: orgId,
			workspaceId,
			name,
			channel: "instagram",
			status: "active",
			graph: END_GRAPH as never,
		})
		.returning();
	if (!auto) throw new Error("auto insert failed");
	return auto;
}

async function makeEntrypoint(
	automationId: string,
	config: Record<string, unknown>,
	filters: Record<string, unknown> | null,
) {
	const [ep] = await db
		.insert(automationEntrypoints)
		.values({
			automationId,
			channel: "instagram",
			kind: "schedule",
			status: "active",
			socialAccountId: null,
			config,
			filters,
			specificity: 20,
		})
		.returning();
	if (!ep) throw new Error("ep insert failed");
	return ep;
}

async function makeTaggedContact(tag: string) {
	const [ct] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId,
			name: `tagged-${tag}`,
			tags: [tag],
		})
		.returning();
	if (!ct) throw new Error("contact insert failed");
	return ct;
}

beforeAll(async () => {
	try {
		await seedFixture();
		dbAvailable = true;
	} catch (err) {
		console.warn(
			"[automation-scheduled-trigger.test] DB unavailable — tests will skip.",
			err instanceof Error ? err.message : err,
		);
	}
});

afterAll(async () => {
	if (dbAvailable) await teardownFixture();
});

describe("computeNextCronRun", () => {
	const anchor = new Date("2026-04-20T12:00:00.000Z");

	it("parses daily `0 9 * * *` to 9:00 UTC next day when already past", () => {
		const next = computeNextCronRun("0 9 * * *", anchor);
		expect(next).not.toBeNull();
		expect(next!.toISOString()).toBe("2026-04-21T09:00:00.000Z");
	});

	it("parses daily `30 15 * * *` to 15:30 UTC today when still future", () => {
		const next = computeNextCronRun("30 15 * * *", anchor);
		expect(next).not.toBeNull();
		expect(next!.toISOString()).toBe("2026-04-20T15:30:00.000Z");
	});

	it("parses hourly `0 * * * *`", () => {
		const next = computeNextCronRun("0 * * * *", anchor);
		expect(next).not.toBeNull();
		expect(next!.toISOString()).toBe("2026-04-20T13:00:00.000Z");
	});

	it("parses every-15-minutes `*/15 * * * *`", () => {
		const next = computeNextCronRun(
			"*/15 * * * *",
			new Date("2026-04-20T12:07:00.000Z"),
		);
		expect(next).not.toBeNull();
		expect(next!.toISOString()).toBe("2026-04-20T12:15:00.000Z");
	});

	it("returns null for unsupported patterns", () => {
		expect(computeNextCronRun("0 0 1 * 0", anchor)).toBeNull();
		expect(computeNextCronRun("not a cron", anchor)).toBeNull();
		expect(computeNextCronRun("0 0 * * 5", anchor)).toBeNull();
	});

	// ---------------------------------------------------------------------------
	// Timezone support (F4)
	// ---------------------------------------------------------------------------

	it("preserves UTC behavior when timezone is 'UTC' or omitted", () => {
		const fromUtc = new Date("2026-04-22T12:00:00.000Z");
		const a = computeNextCronRun("0 9 * * *", fromUtc);
		const b = computeNextCronRun("0 9 * * *", fromUtc, "UTC");
		expect(a!.toISOString()).toBe("2026-04-23T09:00:00.000Z");
		expect(b!.toISOString()).toBe("2026-04-23T09:00:00.000Z");
	});

	it("resolves `0 9 * * *` in America/New_York to 13:00 UTC during EDT", () => {
		// 2026-04-22 is in DST — ET = UTC-4.
		const from = new Date("2026-04-22T12:00:00.000Z");
		const next = computeNextCronRun("0 9 * * *", from, "America/New_York");
		expect(next).not.toBeNull();
		// 9am NY on 2026-04-22 is 13:00 UTC; since that's still after `from`
		// (12:00 UTC), it's today rather than tomorrow.
		expect(next!.toISOString()).toBe("2026-04-22T13:00:00.000Z");
	});

	it("resolves `0 10 * * *` in Europe/London on a spring-forward day", () => {
		// In 2026 UK DST starts at 2026-03-29 01:00 UTC (clocks jump to 02:00
		// local). After that day, 10:00 London = 09:00 UTC. Compute from
		// 2026-04-01T05:00:00Z → next 10:00 local = 2026-04-01T09:00:00Z.
		const from = new Date("2026-04-01T05:00:00.000Z");
		const next = computeNextCronRun("0 10 * * *", from, "Europe/London");
		expect(next).not.toBeNull();
		expect(next!.toISOString()).toBe("2026-04-01T09:00:00.000Z");
	});

	it("returns null for an unknown IANA timezone", () => {
		const from = new Date("2026-04-22T12:00:00.000Z");
		expect(
			computeNextCronRun("0 9 * * *", from, "Not/A_Real_Zone"),
		).toBeNull();
	});
});

describe("scheduled_trigger dispatch", () => {
	it("enrolls contacts matching a tag filter", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("sched-tag");
		const ep = await makeEntrypoint(
			auto.id,
			{ cron: "0 9 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);
		const matchCt = await makeTaggedContact("vip");
		const skipCt = await makeTaggedContact("regular");

		await db.insert(automationScheduledJobs).values({
			jobType: "scheduled_trigger",
			automationId: auto.id,
			entrypointId: ep.id,
			runAt: new Date(Date.now() - 60_000),
			status: "pending",
		});

		const result = await processScheduledJobs(db, {});
		expect(result.processed).toBeGreaterThanOrEqual(1);

		const runs = await db
			.select({ contactId: automationRuns.contactId })
			.from(automationRuns)
			.where(eq(automationRuns.automationId, auto.id));
		const contactIds = new Set(runs.map((r) => r.contactId));
		expect(contactIds.has(matchCt.id)).toBe(true);
		expect(contactIds.has(skipCt.id)).toBe(false);
	});

	it("fails when the entrypoint has no filter", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("sched-no-filter");
		const ep = await makeEntrypoint(auto.id, { cron: "0 9 * * *" }, null);

		const [job] = await db
			.insert(automationScheduledJobs)
			.values({
				jobType: "scheduled_trigger",
				automationId: auto.id,
				entrypointId: ep.id,
				runAt: new Date(Date.now() - 60_000),
				status: "pending",
			})
			.returning();
		if (!job) throw new Error("job insert failed");

		await processScheduledJobs(db, {});

		const row = await db.query.automationScheduledJobs.findFirst({
			where: eq(automationScheduledJobs.id, job.id),
		});
		expect(row?.status).toBe("failed");
		expect(row?.error ?? "").toMatch(/requires filters/i);
	});

	it("reschedules the next run on success", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("sched-reschedule");
		const ep = await makeEntrypoint(
			auto.id,
			{ cron: "0 9 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);

		await db.insert(automationScheduledJobs).values({
			jobType: "scheduled_trigger",
			automationId: auto.id,
			entrypointId: ep.id,
			runAt: new Date(Date.now() - 60_000),
			status: "pending",
		});

		await processScheduledJobs(db, {});

		const pending = await db
			.select({ runAt: automationScheduledJobs.runAt })
			.from(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.entrypointId, ep.id),
					eq(automationScheduledJobs.status, "pending"),
				),
			)
			.orderBy(desc(automationScheduledJobs.runAt))
			.limit(1);
		expect(pending.length).toBe(1);
		expect(pending[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("fails with unsupported cron pattern", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("sched-bad-cron");
		const ep = await makeEntrypoint(
			auto.id,
			{ cron: "0 0 1 1 1" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);

		const [job] = await db
			.insert(automationScheduledJobs)
			.values({
				jobType: "scheduled_trigger",
				automationId: auto.id,
				entrypointId: ep.id,
				runAt: new Date(Date.now() - 60_000),
				status: "pending",
			})
			.returning();
		if (!job) throw new Error("job insert failed");

		await processScheduledJobs(db, {});
		const row = await db.query.automationScheduledJobs.findFirst({
			where: eq(automationScheduledJobs.id, job.id),
		});
		expect(row?.status).toBe("failed");
		expect(row?.error ?? "").toMatch(/unsupported cron/i);
	});

	it(
		"queues the next run BEFORE enrollment, so the schedule survives a failure (§B4)",
		async () => {
			if (!dbAvailable) return;

			// A valid tag filter — enumeration will succeed (0 contacts) and the
			// enrollment loop is a no-op. The key property: the next-run job is
			// inserted before the loop runs, so even a wholesale enrollment
			// failure can't kill the schedule.
			const auto = await makeAutomation("sched-survive-failure");
			const ep = await makeEntrypoint(
				auto.id,
				{ cron: "*/15 * * * *" },
				{ all: [{ field: "tags", op: "contains", value: "never-matches" }] },
			);

			await db.insert(automationScheduledJobs).values({
				jobType: "scheduled_trigger",
				automationId: auto.id,
				entrypointId: ep.id,
				runAt: new Date(Date.now() - 60_000),
				status: "pending",
			});

			await processScheduledJobs(db, {});

			// The next-run job must exist regardless of enrollment outcome.
			const pending = await db
				.select({ runAt: automationScheduledJobs.runAt })
				.from(automationScheduledJobs)
				.where(
					and(
						eq(automationScheduledJobs.entrypointId, ep.id),
						eq(automationScheduledJobs.status, "pending"),
					),
				);
			expect(pending.length).toBe(1);
			expect(pending[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
		},
	);

	it(
		"is idempotent — running the same scheduled_trigger twice doesn't double-queue the next run (§B4)",
		async () => {
			if (!dbAvailable) return;

			const auto = await makeAutomation("sched-idempotent");
			const ep = await makeEntrypoint(
				auto.id,
				{ cron: "*/15 * * * *" },
				{ all: [{ field: "tags", op: "contains", value: "vip" }] },
			);

			// Seed two due jobs for the SAME entrypoint. Both will fire against
			// the same cron, computing the same nextRunAt — the insert-if-not-
			// exists guard must skip the second insert.
			await db.insert(automationScheduledJobs).values([
				{
					jobType: "scheduled_trigger",
					automationId: auto.id,
					entrypointId: ep.id,
					runAt: new Date(Date.now() - 120_000),
					status: "pending",
				},
				{
					jobType: "scheduled_trigger",
					automationId: auto.id,
					entrypointId: ep.id,
					runAt: new Date(Date.now() - 60_000),
					status: "pending",
				},
			]);

			await processScheduledJobs(db, {});

			const pending = await db
				.select({ runAt: automationScheduledJobs.runAt })
				.from(automationScheduledJobs)
				.where(
					and(
						eq(automationScheduledJobs.entrypointId, ep.id),
						eq(automationScheduledJobs.status, "pending"),
					),
				);
			// Exactly one pending successor — not two.
			expect(pending.length).toBe(1);
		},
	);
});

// ---------------------------------------------------------------------------
// armScheduleEntrypoint / armAllScheduleEntrypointsForAutomation (F1)
// ---------------------------------------------------------------------------

describe("armScheduleEntrypoint (F1)", () => {
	it("queues one pending job for a fresh active schedule entrypoint", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("arm-fresh");
		const ep = await makeEntrypoint(
			auto.id,
			{ cron: "0 9 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);

		const result = await armScheduleEntrypoint(db, ep.id);
		expect(result.queued).toBe(true);
		expect(result.runAt).toBeInstanceOf(Date);

		const pending = await db
			.select({ runAt: automationScheduledJobs.runAt })
			.from(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.entrypointId, ep.id),
					eq(automationScheduledJobs.status, "pending"),
					eq(automationScheduledJobs.jobType, "scheduled_trigger"),
				),
			);
		expect(pending.length).toBe(1);
		expect(pending[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
	});

	it("skips arming when the entrypoint's automation is not active", async () => {
		if (!dbAvailable) return;

		const [auto] = await db
			.insert(automations)
			.values({
				organizationId: orgId,
				workspaceId,
				name: "arm-paused-auto",
				channel: "instagram",
				status: "paused",
				graph: END_GRAPH as never,
			})
			.returning();
		if (!auto) throw new Error("auto insert failed");

		const ep = await makeEntrypoint(
			auto.id,
			{ cron: "0 9 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);

		const result = await armScheduleEntrypoint(db, ep.id);
		expect(result.queued).toBe(false);
		expect(result.reason).toBe("automation_not_active");

		const pending = await db
			.select({ id: automationScheduledJobs.id })
			.from(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.entrypointId, ep.id),
					eq(automationScheduledJobs.status, "pending"),
				),
			);
		expect(pending.length).toBe(0);
	});

	it("is idempotent — arming twice doesn't double-queue", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("arm-idempotent");
		const ep = await makeEntrypoint(
			auto.id,
			{ cron: "0 9 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);

		await armScheduleEntrypoint(db, ep.id);
		await armScheduleEntrypoint(db, ep.id);

		const pending = await db
			.select({ id: automationScheduledJobs.id })
			.from(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.entrypointId, ep.id),
					eq(automationScheduledJobs.status, "pending"),
				),
			);
		expect(pending.length).toBe(1);
	});
});

describe("armAllScheduleEntrypointsForAutomation (F1)", () => {
	it("arms every active schedule entrypoint on the automation", async () => {
		if (!dbAvailable) return;

		const auto = await makeAutomation("arm-all");
		const ep1 = await makeEntrypoint(
			auto.id,
			{ cron: "0 9 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);
		const ep2 = await makeEntrypoint(
			auto.id,
			{ cron: "0 10 * * *" },
			{ all: [{ field: "tags", op: "contains", value: "vip" }] },
		);

		const result = await armAllScheduleEntrypointsForAutomation(
			db,
			auto.id,
		);
		expect(result.armed).toBe(2);

		const pending = await db
			.select({
				id: automationScheduledJobs.id,
				entrypointId: automationScheduledJobs.entrypointId,
			})
			.from(automationScheduledJobs)
			.where(
				and(
					eq(automationScheduledJobs.automationId, auto.id),
					eq(automationScheduledJobs.status, "pending"),
				),
			);
		const arm1 = pending.find((p) => p.entrypointId === ep1.id);
		const arm2 = pending.find((p) => p.entrypointId === ep2.id);
		expect(arm1).toBeTruthy();
		expect(arm2).toBeTruthy();
	});
});
