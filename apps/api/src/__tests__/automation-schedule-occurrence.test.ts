import { beforeEach, describe, expect, it, mock } from "bun:test";

const enrollmentArgs: Array<Record<string, unknown>> = [];
const enrollContact = mock(
	async (_db: unknown, args: Record<string, unknown>) => {
		enrollmentArgs.push(args);
		return { runId: "run_existing" };
	},
);

mock.module("../services/automations/runner", () => ({
	enrollContact,
	incrementCounter: async () => {},
	runLoop: async () => ({ status: "completed", exit_reason: "completed" }),
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

function matcherDb() {
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
			contacts: {
				findFirst: async () => ({ id: "ct_1", tags: [] }),
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
		for (const page of [0, 200]) {
			const result = await matchAndEnroll(
				matcherDb() as never,
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
				{},
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

	it("persists the next page before any contact effect can become unknown", async () => {
		const source = await Bun.file(
			new URL("../services/automations/scheduler.ts", import.meta.url),
		).text();
		const nextOffset = source.indexOf("const nextOffset =");
		const continuation = source.indexOf("occurrenceId:", nextOffset);
		const effectBoundary = source.indexOf(
			"await markEffectStarted();",
			continuation,
		);
		const unknownOutcome = source.indexOf(
			"scheduled contacts have an unknown enrollment outcome",
			continuation,
		);

		expect(nextOffset).toBeGreaterThan(-1);
		expect(continuation).toBeGreaterThan(nextOffset);
		expect(effectBoundary).toBeGreaterThan(continuation);
		expect(unknownOutcome).toBeGreaterThan(effectBoundary);
	});
});
