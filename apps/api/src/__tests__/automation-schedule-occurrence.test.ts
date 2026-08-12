import { beforeEach, describe, expect, it, mock } from "bun:test";
import { protectedContactFixture } from "./helpers/protected-contact-fixtures";

const TEST_ENCRYPTION_KEY = `test=${"41".repeat(32)},identity=${"42".repeat(32)}`;

const enrollmentArgs: Array<Record<string, unknown>> = [];
const enrollContact = mock(
	async (_db: unknown, args: Record<string, unknown>) => {
		enrollmentArgs.push(args);
		return { runId: "run_existing" };
	},
);

class EnrollmentBlockedError extends Error {
	constructor(
		public readonly reason:
			| "active_run"
			| "reentry_disabled"
			| "reentry_cooldown"
			| "daily_cap",
	) {
		super(`automation enrollment blocked: ${reason}`);
		this.name = "EnrollmentBlockedError";
	}
}

mock.module("../services/automations/runner", () => ({
	EnrollmentBlockedError,
	enrollContact,
	incrementCounter: async () => {},
	runLoop: async () => ({ status: "completed", exit_reason: "completed" }),
	transitionRunTerminal: async () => true,
	updateRunOptimistic: async () => true,
}));

const { matchAndEnroll } = await import(
	"../services/automations/trigger-matcher"
);
const {
	automationScheduleContactOccurrenceId,
	automationScheduleOccurrenceBase,
	automationScheduleOccurrenceId,
} = await import("../services/automations/scheduler");

function matcherDb(contact: Record<string, unknown>) {
	const candidate = {
		entrypoint: {
			id: "aep_1",
			automationId: "auto_1",
			kind: "schedule",
			status: "active",
			config: {},
			filters: null,
			socialAccountId: null,
			allowReentry: true,
			reentryCooldownMin: null,
			specificity: 20,
			priority: 0,
			createdAt: new Date("2026-07-13T00:00:00.000Z"),
		},
		automation: { id: "auto_1" },
	};
	const selectResults: unknown[][] = [[candidate], [], [], []];
	let selectIndex = 0;
	return {
		select: () => {
			const result = selectResults[selectIndex++] ?? [];
			const chain = {
				from: () => chain,
				innerJoin: () => chain,
				leftJoin: () => chain,
				where: () => chain,
				groupBy: () => chain,
				orderBy: () => chain,
				limit: () => chain,
				// biome-ignore lint/suspicious/noThenProperty: focused thenable Drizzle stub
				then: (resolve: (rows: unknown[]) => void) => resolve(result),
			};
			return chain;
		},
		query: {
			automationRuns: {
				findFirst: async () => null,
			},
			contacts: {
				findFirst: async () => contact,
			},
		},
	};
}

beforeEach(() => {
	enrollmentArgs.length = 0;
	enrollContact.mockClear();
});

describe("scheduled automation occurrence propagation", () => {
	it("uses one per-contact occurrence across continuation pages", () => {
		const scheduledFor = new Date("2026-07-13T12:00:00.000Z");
		const root = automationScheduleOccurrenceBase("aep_1", scheduledFor);
		const firstPage = automationScheduleOccurrenceId("aep_1", scheduledFor, 0);
		const continuation = automationScheduleOccurrenceId(
			"aep_1",
			scheduledFor,
			200,
		);

		expect(firstPage).not.toBe(continuation);
		expect(automationScheduleContactOccurrenceId(root, "ct_1")).toBe(
			"schedule:aep_1:2026-07-13T12:00:00.000Z:contact:ct_1",
		);
		expect(automationScheduleContactOccurrenceId(root, "ct_1")).not.toContain(
			":page:",
		);
		expect(automationScheduleContactOccurrenceId(root, "ct_2")).not.toBe(
			automationScheduleContactOccurrenceId(root, "ct_1"),
		);
	});

	it("passes the stable source occurrence into enrollContact", async () => {
		const triggerOccurrenceId =
			"schedule:aep_1:2026-07-13T12:00:00.000Z:contact:ct_1";
		const contact = {
			...(await protectedContactFixture(
				{
					id: "ct_1",
					organizationId: "org_1",
					name: "Scheduled contact",
				},
				TEST_ENCRYPTION_KEY,
			)),
			scopeKey: "org",
		};
		for (const page of [0, 200]) {
			const result = await matchAndEnroll(
				matcherDb(contact) as never,
				{
					kind: "schedule",
					channel: "instagram",
					organizationId: "org_1",
					socialAccountId: null,
					contactId: "ct_1",
					conversationId: null,
					triggerOccurrenceId,
					payload: {
						entrypoint_id: "aep_1",
						occurrence_id: `schedule:aep_1:page:${page}`,
					},
				},
				{ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY },
			);
			expect(result.matched).toBe(true);
		}

		expect(enrollmentArgs.map((args) => args.triggerOccurrenceId)).toEqual([
			triggerOccurrenceId,
			triggerOccurrenceId,
		]);
	});

	it("constructs the contact occurrence from the root, not the page job", async () => {
		const source = await Bun.file(
			new URL("../services/automations/scheduler.ts", import.meta.url),
		).text();
		expect(source).toContain(
			"triggerOccurrenceId: automationScheduleContactOccurrenceId(",
		);
		expect(source).toContain("rootOccurrenceId,");
	});

	it("persists the next page before idempotent contact enrollment", async () => {
		const source = await Bun.file(
			new URL("../services/automations/scheduler.ts", import.meta.url),
		).text();
		const nextOffset = source.indexOf("const nextOffset =");
		const continuation = source.indexOf("occurrenceId:", nextOffset);
		const enrollment = source.indexOf(
			"await matchAndEnrollOrBinding(db, event, env)",
			continuation,
		);

		expect(nextOffset).toBeGreaterThan(-1);
		expect(continuation).toBeGreaterThan(nextOffset);
		expect(enrollment).toBeGreaterThan(continuation);
		expect(
			source.slice(
				source.indexOf("async function dispatchScheduledTrigger"),
				source.indexOf("async function insertNextScheduledJobIfNotExists"),
			),
		).not.toContain("markEffectStarted");
	});
});
