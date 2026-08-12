import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import { reserveDailyToolUsage } from "../services/usage-meter";

type Row = Record<string, unknown>;

type Query = {
	from: (_table: unknown) => Query;
	innerJoin: (_table: unknown, _condition: unknown) => Query;
	where: (_condition: unknown) => Query;
	orderBy: (_order: unknown) => Query;
	for: (_strength: string) => Query;
	limit: (_limit: number) => Promise<Row[]>;
};

function dailyToolDb(selectResponses: Row[][]) {
	const inserts: Row[] = [];
	const updates: Row[] = [];

	const select = () => {
		const rows = selectResponses.shift() ?? [];
		const query = {} as Query;
		query.from = () => query;
		query.innerJoin = () => query;
		query.where = () => query;
		query.orderBy = () => query;
		query.for = () => query;
		query.limit = async () => rows;
		return query;
	};
	const insert = () => {
		let values: Row = {};
		const query = {
			values(next: Row) {
				values = next;
				return query;
			},
			onConflictDoNothing() {
				return query;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable
			then(resolve: (value: undefined) => void) {
				inserts.push(values);
				resolve(undefined);
			},
		};
		return query;
	};
	const update = () => {
		let values: Row = {};
		const query = {
			set(next: Row) {
				values = next;
				return query;
			},
			where() {
				return query;
			},
			// biome-ignore lint/suspicious/noThenProperty: intentional Drizzle thenable
			then(resolve: (value: undefined) => void) {
				updates.push(values);
				resolve(undefined);
			},
		};
		return query;
	};
	const tx = { select, insert, update };
	const db = {
		transaction: async <T>(
			callback: (transaction: typeof tx) => Promise<T>,
		): Promise<T> => callback(tx),
	} as unknown as Database;

	return { db, inserts, updates, remaining: () => selectResponses.length };
}

function toolBucket(
	includedUnits: number | null,
	overrides: Partial<Row> = {},
): Row {
	const periodStart = new Date("2026-07-29T00:00:00.000Z");
	return {
		id: "ub_tool",
		organizationId: "org_test",
		billingPeriodId: null,
		metric: "tool_invocation",
		periodStart,
		periodEnd: new Date("2026-07-30T00:00:00.000Z"),
		quotaMode: includedUnits === null ? "unlimited" : "hard",
		includedUnits,
		committedUnits: 0,
		reservedUnits: 0,
		revision: 0,
		createdAt: periodStart,
		updatedAt: periodStart,
		...overrides,
	};
}

const now = new Date("2026-07-29T12:00:00.000Z");

describe("daily tool entitlement authority", () => {
	it("ignores a stale free cache and rebases the current bucket to the Pro default", async () => {
		const fixture = dailyToolDb([
			[
				{
					status: "active",
					source: "stripe",
					stripeSubscriptionId: "sub_stripe",
					dailyToolLimitOverride: null,
				},
			],
			[toolBucket(2)],
			[],
			[],
		]);

		const decision = await reserveDailyToolUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "tool:upgrade",
			units: 1,
			cachedLimit: 2,
			source: "tool",
			now,
		});

		expect(decision).toMatchObject({
			ok: true,
			selfHealed: true,
			reservation: {
				includedUnits: 10,
				quotaMode: "hard",
				reservedUnits: 1,
			},
		});
		expect(fixture.updates).toEqual([
			expect.objectContaining({ includedUnits: 10 }),
		]);
		expect(
			fixture.inserts.some(
				(values) => values.idempotencyKey === "tool:upgrade",
			),
		).toBe(true);
		expect(fixture.remaining()).toBe(0);
	});

	it("treats zero as a real override and denies against already consumed usage", async () => {
		const fixture = dailyToolDb([
			[
				{
					status: "active",
					source: "complimentary",
					dailyToolLimitOverride: 0,
				},
			],
			[toolBucket(10, { committedUnits: 1 })],
			[],
			[],
		]);

		const decision = await reserveDailyToolUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "tool:disable",
			units: 1,
			cachedLimit: 10,
			now,
		});

		expect(decision).toEqual({
			ok: false,
			selfHealed: true,
			quotaMode: "hard",
			includedUnits: 0,
			committedUnits: 1,
			reservedUnits: 0,
		});
		expect(fixture.updates).toEqual([
			expect.objectContaining({ includedUnits: 0 }),
		]);
		expect(
			fixture.inserts.some(
				(values) => values.idempotencyKey === "tool:disable",
			),
		).toBe(false);
	});

	it("keeps self-hosted tool usage explicitly unlimited without hosted lookup", async () => {
		const fixture = dailyToolDb([[toolBucket(2)], [], []]);
		const decision = await reserveDailyToolUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "tool:self-hosted",
			units: 1,
			cachedLimit: null,
			now,
		});

		expect(decision).toMatchObject({
			ok: true,
			selfHealed: false,
			reservation: { quotaMode: "unlimited", includedUnits: null },
		});
		expect(fixture.updates).toEqual([
			expect.objectContaining({
				quotaMode: "unlimited",
				includedUnits: null,
			}),
		]);
		expect(fixture.remaining()).toBe(0);
	});
});
