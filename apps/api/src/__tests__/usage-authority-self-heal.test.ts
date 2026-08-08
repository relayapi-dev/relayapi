import { describe, expect, it } from "bun:test";
import { type Database, organizationSubscriptions } from "@relayapi/db";
import {
	reserveMutationUsage,
	resolveSuccessfulMutationAuthority,
} from "../services/usage-meter";

type Row = Record<string, unknown>;

type Query = {
	from: (_table: unknown) => Query;
	innerJoin: (_table: unknown, _condition: unknown) => Query;
	where: (_condition: unknown) => Query;
	orderBy: (_order: unknown) => Query;
	for: (_strength: string) => Query;
	limit: (_limit: number) => Promise<Row[]>;
};

function authorityDb(
	selectResponses: Row[][],
	subscription: Row = {
		id: "sub_test",
		organizationId: "org_test",
		status: "active",
		source: "stripe",
		stripeCustomerId: "cus_test",
		stripeSubscriptionId: "sub_stripe_test",
		currentPeriodStart: new Date("2026-07-15T00:00:00.000Z"),
		currentPeriodEnd: new Date("2026-08-01T00:00:00.000Z"),
		trialEndsAt: null,
		delinquentAt: null,
		graceEndsAt: null,
		updatedAt: new Date("2026-07-15T00:00:00.000Z"),
	},
) {
	let transactionCount = 0;
	const inserts: Row[] = [];

	const select = (projection?: Row) => {
		let rows: Row[] | null = null;
		const query = {} as Query;
		query.from = (table) => {
			if (table === organizationSubscriptions) {
				rows = [subscription];
			} else if (
				projection &&
				Object.keys(projection).length === 2 &&
				"periodId" in projection &&
				"bucketId" in projection
			) {
				// No stale open Stripe authority needs closing in these unit fixtures.
				rows = [];
			} else {
				rows = selectResponses.shift() ?? [];
			}
			return query;
		};
		query.innerJoin = () => query;
		query.where = () => query;
		query.orderBy = () => query;
		query.for = () => query;
		query.limit = async () => rows ?? [];
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
	const tx = { select, insert };
	const db = {
		select,
		transaction: async <T>(
			callback: (transaction: typeof tx) => Promise<T>,
		): Promise<T> => {
			transactionCount += 1;
			return callback(tx);
		},
	} as unknown as Database;

	return {
		db,
		inserts,
		transactionCount: () => transactionCount,
		remainingResponses: () => selectResponses.length,
	};
}

function bucket(
	id: string,
	periodStart: Date,
	periodEnd: Date,
	overrides: Partial<Row> = {},
): Row {
	return {
		id,
		organizationId: "org_test",
		billingPeriodId: null,
		metric: "successful_mutation",
		periodStart,
		periodEnd,
		quotaMode: "hard",
		includedUnits: 200,
		committedUnits: 0,
		reservedUnits: 0,
		revision: 0,
		createdAt: periodStart,
		updatedAt: periodStart,
		...overrides,
	};
}

function resolvedPaidAuthority(
	id: string,
	periodStart: Date,
	periodEnd: Date,
	includedUnits: number,
	providerCycleAnchor = periodStart,
): Row {
	return {
		billingPeriodId: id,
		source: "stripe",
		billable: true,
		providerCycleAnchor,
		stripeSubscriptionId: "sub_stripe_test",
		periodStart,
		periodEnd,
		quotaMode: "metered",
		includedUnits,
		basePriceCents: 500,
		pricePerThousandUnitsCents: 100,
		bucketId: `ub_${id}`,
		committedUnits: 0,
		reservedUnits: 0,
		bucketPeriodStart: periodStart,
		bucketPeriodEnd: periodEnd,
		bucketQuotaMode: "metered",
		bucketIncludedUnits: includedUnits,
	};
}

describe("usage billing-authority self-heal", () => {
	const monthStart = new Date("2026-07-01T00:00:00.000Z");
	const splitAt = new Date("2026-07-15T00:00:00.000Z");
	const now = new Date("2026-07-20T12:00:00.000Z");
	const monthEnd = new Date("2026-08-01T00:00:00.000Z");
	const cancelledSubscription = {
		id: "sub_test",
		organizationId: "org_test",
		status: "cancelled",
		source: "stripe",
		stripeCustomerId: "cus_test",
		stripeSubscriptionId: null,
		currentPeriodStart: monthStart,
		currentPeriodEnd: monthEnd,
		trialEndsAt: null,
		delinquentAt: null,
		graceEndsAt: null,
		updatedAt: splitAt,
	};

	it("repairs a stale free cache after upgrade in one fresh transaction", async () => {
		const current = bucket("ub_paid", splitAt, monthEnd, {
			billingPeriodId: "bp_paid",
			quotaMode: "metered",
			includedUnits: 10_000,
		});
		const fixture = authorityDb([
			[bucket("ub_free", monthStart, monthEnd)],
			[{ id: "bp_paid" }],
			[resolvedPaidAuthority("bp_paid", splitAt, monthEnd, 10_000)],
			[current],
			[
				{
					id: "bp_paid",
					periodStart: splitAt,
					periodEnd: monthEnd,
					quotaMode: "metered",
					includedUnits: 10_000,
				},
			],
			[],
			[],
		]);

		const decision = await reserveMutationUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "request:free-to-pro",
			units: 1,
			quotaMode: "hard",
			includedUnits: 200,
			periodStart: monthStart,
			periodEnd: monthEnd,
			billingPeriodId: null,
			now,
		});

		expect(decision).toMatchObject({
			ok: true,
			selfHealed: true,
			reservation: {
				bucketId: "ub_paid",
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: splitAt,
			},
		});
		expect(fixture.transactionCount()).toBe(3);
		expect(fixture.remainingResponses()).toBe(0);
	});

	it("repairs a stale pre-split window against the successor authority", async () => {
		const current = bucket("ub_successor", splitAt, monthEnd, {
			billingPeriodId: "bp_successor",
			quotaMode: "metered",
			includedUnits: 9_500,
		});
		const fixture = authorityDb([
			[
				bucket("ub_old", monthStart, splitAt, {
					billingPeriodId: "bp_old",
					quotaMode: "metered",
					includedUnits: 10_000,
				}),
			],
			[resolvedPaidAuthority("bp_successor", splitAt, monthEnd, 9_500)],
			[current],
			[
				{
					id: "bp_successor",
					periodStart: splitAt,
					periodEnd: monthEnd,
					quotaMode: "metered",
					includedUnits: 9_500,
				},
			],
			[],
			[],
		]);

		const decision = await reserveMutationUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "request:stale-window",
			units: 1,
			quotaMode: "metered",
			includedUnits: 10_000,
			periodStart: monthStart,
			periodEnd: monthEnd,
			billingPeriodId: "bp_old",
			now,
		});

		expect(decision).toMatchObject({
			ok: true,
			selfHealed: true,
			reservation: {
				bucketId: "ub_successor",
				includedUnits: 9_500,
			},
		});
		expect(fixture.transactionCount()).toBe(3);
	});

	it("falls back from a stale paid cache to a deterministic free window", async () => {
		const fixture = authorityDb(
			[
				[
					bucket("ub_old", monthStart, splitAt, {
						billingPeriodId: "bp_old",
						quotaMode: "metered",
						includedUnits: 10_000,
					}),
				],
				[],
				[{ periodEnd: splitAt }],
				[],
				[
					bucket("ub_free", splitAt, monthEnd, {
						periodStart: splitAt,
					}),
				],
				[],
				[],
				[],
				[],
			],
			cancelledSubscription,
		);

		const decision = await reserveMutationUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "request:pro-to-free",
			units: 1,
			quotaMode: "metered",
			includedUnits: 10_000,
			periodStart: monthStart,
			periodEnd: monthEnd,
			billingPeriodId: "bp_old",
			now,
		});

		expect(decision).toMatchObject({
			ok: true,
			selfHealed: true,
			reservation: {
				bucketId: "ub_free",
				quotaMode: "hard",
				includedUnits: 200,
				periodStart: splitAt,
			},
		});
		expect(fixture.transactionCount()).toBe(3);
	});

	it("reports the authoritative existing Free bucket instead of zeroing its snapshot", async () => {
		const authoritativeFree = bucket("ub_free_snapshot", splitAt, monthEnd, {
			committedUnits: 37,
			reservedUnits: 2,
		});
		const fixture = authorityDb(
			[[], [], [authoritativeFree], [{ pendingUnits: 3, committedUnits: 4 }]],
			cancelledSubscription,
		);

		const resolution = await resolveSuccessfulMutationAuthority(
			fixture.db,
			"org_test",
			now,
		);

		expect(resolution).toMatchObject({
			state: "ready",
			authority: {
				plan: "free",
				bucketId: "ub_free_snapshot",
				committedUnits: 37,
				reservedUnits: 2,
				carryoverCommittedUnits: 4,
				carryoverPendingUnits: 3,
			},
		});
	});

	it("rejects a stale pre-upgrade free bucket after a paid interval ended", async () => {
		const staleFree = bucket("ub_pre_upgrade", monthStart, monthEnd);
		const successorFree = bucket("ub_post_downgrade", splitAt, monthEnd, {
			periodStart: splitAt,
		});
		const fixture = authorityDb(
			[
				[staleFree],
				[],
				[{ id: "ub_paid" }],
				[],
				[{ periodEnd: splitAt }],
				[staleFree],
				[successorFree],
				[],
				[],
				[],
				[],
			],
			cancelledSubscription,
		);

		const decision = await reserveMutationUsage(fixture.db, {
			organizationId: "org_test",
			idempotencyKey: "request:stale-free-after-paid",
			units: 1,
			quotaMode: "hard",
			includedUnits: 200,
			periodStart: monthStart,
			periodEnd: monthEnd,
			billingPeriodId: null,
			now,
		});

		expect(decision).toMatchObject({
			ok: true,
			selfHealed: true,
			reservation: {
				bucketId: "ub_post_downgrade",
				periodStart: splitAt,
			},
		});
		expect(fixture.transactionCount()).toBe(3);
		expect(fixture.remainingResponses()).toBe(0);
		expect(
			fixture.inserts.some(
				(values) =>
					values.metric === "successful_mutation" &&
					values.periodStart === splitAt,
			),
		).toBe(true);
	});

	it("bounds a second concurrent authority change to one retry", async () => {
		const fixture = authorityDb([
			[
				bucket("ub_old", monthStart, splitAt, {
					billingPeriodId: "bp_old",
					quotaMode: "metered",
					includedUnits: 10_000,
				}),
			],
			[resolvedPaidAuthority("bp_successor", splitAt, monthEnd, 9_500)],
			[
				bucket("ub_successor", splitAt, now, {
					billingPeriodId: "bp_successor",
					quotaMode: "metered",
					includedUnits: 9_500,
				}),
			],
		]);

		await expect(
			reserveMutationUsage(fixture.db, {
				organizationId: "org_test",
				idempotencyKey: "request:bounded-retry",
				units: 1,
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: monthStart,
				periodEnd: monthEnd,
				billingPeriodId: "bp_old",
				now,
			}),
		).rejects.toThrow(
			"Usage bucket does not match the requested billing authority",
		);
		expect(fixture.transactionCount()).toBe(3);
	});

	it("does not apply billing repair to daily tool buckets", async () => {
		const dayStart = new Date("2026-07-20T00:00:00.000Z");
		const dayEnd = new Date("2026-07-21T00:00:00.000Z");
		const fixture = authorityDb([
			[
				bucket("ub_tool", dayStart, dayEnd, {
					metric: "tool_invocation",
					includedUnits: 2,
				}),
			],
		]);

		await expect(
			reserveMutationUsage(fixture.db, {
				organizationId: "org_test",
				idempotencyKey: "tool:not-billing",
				units: 1,
				metric: "tool_invocation",
				quotaMode: "hard",
				includedUnits: 10,
				periodStart: dayStart,
				periodEnd: dayEnd,
				now,
			}),
		).rejects.toThrow(
			"Usage bucket does not match the requested billing authority",
		);
		expect(fixture.transactionCount()).toBe(1);
	});

	it("never materializes a provisional bucket for typed pending Pro", async () => {
		const fixture = authorityDb([]);
		await expect(
			reserveMutationUsage(fixture.db, {
				organizationId: "org_test",
				idempotencyKey: "request:pending-pro",
				units: 1,
				quotaMode: "hard",
				includedUnits: 0,
				periodStart: monthStart,
				periodEnd: monthEnd,
				billingPeriodId: null,
				billingAuthorityState: "pending",
				now,
			}),
		).rejects.toThrow("pending canonical reconciliation");
		expect(fixture.transactionCount()).toBe(0);
		expect(fixture.inserts).toHaveLength(0);
	});
});
