import { describe, expect, it } from "bun:test";
import {
	hostedFreeTransitionAt,
	nextComplimentaryCycleBoundary,
	remainingCycleAllowance,
	safeBillingTransitionInstant,
	shortenOpenBillingPeriod,
} from "../services/billing-periods";

interface MockQuery {
	from: () => MockQuery;
	innerJoin: () => MockQuery;
	where: () => MockQuery;
	orderBy: () => MockQuery;
	for: () => MockQuery;
	limit: () => Promise<unknown[]>;
}

function billingTransitionDb(responses: unknown[][]) {
	const updates: Array<Record<string, unknown>> = [];
	const statements: unknown[] = [];
	let selectCall = 0;
	const tx = {
		select: () => {
			const query = {} as MockQuery;
			query.from = () => query;
			query.innerJoin = () => query;
			query.where = () => query;
			query.orderBy = () => query;
			query.for = () => query;
			query.limit = async () => responses[selectCall++] ?? [];
			return query;
		},
		execute: async (statement: unknown) => {
			statements.push(statement);
		},
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					updates.push(values);
				},
			}),
		}),
	};
	return {
		db: {
			transaction: async (
				callback: (transaction: unknown) => Promise<unknown>,
			) => callback(tx),
		},
		statements,
		updates,
	};
}

describe("billing period splits", () => {
	it("clamps complimentary month ends instead of overflowing into March", () => {
		expect(
			nextComplimentaryCycleBoundary(new Date("2025-01-31T12:34:56.789Z")),
		).toEqual(new Date("2025-02-28T12:34:56.789Z"));
		expect(
			nextComplimentaryCycleBoundary(new Date("2024-01-31T12:34:56.789Z")),
		).toEqual(new Date("2024-02-29T12:34:56.789Z"));
	});

	it("hard-bounds due-only complimentary sweeps with a durable fairness cursor", async () => {
		const source = await Bun.file(
			new URL("../services/billing-periods.ts", import.meta.url),
		).text();
		const claim = source.slice(
			source.indexOf("async function claimDueComplimentaryRenewals"),
			source.indexOf(
				"export async function renewComplimentaryBillingAuthorities",
			),
		);
		const renewal = source.slice(
			source.indexOf(
				"export async function renewComplimentaryBillingAuthorities",
			),
			source.indexOf("async function settleClosedComplimentaryBillingPeriod"),
		);
		expect(claim).toContain("SELECT MAX(newer.period_start)");
		expect(claim).toContain("lte(billingPeriods.periodEnd, now)");
		expect(claim).toContain("asc(organizationSubscriptions.updatedAt)");
		expect(claim).toContain("skipLocked: true");
		expect(claim).toContain("CURRENT_TIMESTAMP");
		expect(claim).toContain(".limit(limit)");
		expect(renewal).toContain("claimDueComplimentaryRenewals(db, now, limit)");
		expect(renewal).not.toContain("while (true)");
	});

	it("claims complimentary settlements bucket-first and advances failed attempts", async () => {
		const source = await Bun.file(
			new URL("../services/billing-periods.ts", import.meta.url),
		).text();
		const claim = source.slice(
			source.indexOf("async function claimDueComplimentarySettlements"),
			source.indexOf(
				"export async function settleClosedComplimentaryBillingPeriods",
			),
		);
		const settlement = source.slice(
			source.indexOf(
				"export async function settleClosedComplimentaryBillingPeriods",
			),
			source.indexOf(
				"export async function renewComplimentaryBillingAuthoritiesForEnv",
			),
		);
		const lockLoop = claim.slice(claim.indexOf("for (const candidate"));
		expect(claim).toContain(
			"orderBy(asc(usageBuckets.updatedAt), asc(usageBuckets.id))",
		);
		expect(claim).toContain("CURRENT_TIMESTAMP");
		expect(claim).toContain(".limit(limit)");
		expect(lockLoop.indexOf("const [bucket]")).toBeLessThan(
			lockLoop.indexOf("const [period]"),
		);
		expect(lockLoop.match(/skipLocked: true/g)).toHaveLength(2);
		expect(settlement).toContain(
			"claimDueComplimentarySettlements(db, now, limit)",
		);
		expect(settlement).not.toContain("while (true)");
	});

	it("ends hosted grace at the exact persisted boundary", () => {
		const graceEndsAt = new Date("2026-01-15T00:00:00.000Z");
		const subscription = {
			source: "stripe" as const,
			status: "past_due" as const,
			stripeSubscriptionId: "sub_grace",
			trialEndsAt: null,
			delinquentAt: new Date("2026-01-01T00:00:00.000Z"),
			graceEndsAt,
			currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
			currentPeriodEnd: new Date("2026-02-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		expect(
			hostedFreeTransitionAt(
				subscription,
				new Date("2026-01-14T23:59:59.999Z"),
			),
		).toBeNull();
		expect(hostedFreeTransitionAt(subscription, graceEndsAt)).toEqual(
			graceEndsAt,
		);
	});

	it("selects and removes a later Stripe cycle after the original grace expired", async () => {
		const source = await Bun.file(
			new URL("../services/billing-periods.ts", import.meta.url),
		).text();
		const transition = source.slice(
			source.indexOf(
				"export async function ensureHostedFreeUsageAuthorityInTransaction",
			),
			source.indexOf("export async function ensureHostedFreeUsageAuthority("),
		);
		expect(transition).toContain("lte(billingPeriods.periodStart, now)");
		expect(transition).not.toContain(
			"lte(billingPeriods.periodStart, requestedAt)",
		);
		expect(transition).toContain("period.periodStart >= requestedAt");
	});

	it("grants only the unconsumed cycle allowance to a successor", () => {
		expect(remainingCycleAllowance("metered", 10_000, 3_250)).toBe(6_750);
		expect(remainingCycleAllowance("hard", 10_000, 12_000)).toBe(0);
	});

	it("represents unlimited authority explicitly without an integer sentinel", () => {
		expect(remainingCycleAllowance("unlimited", null, 9_999_999)).toBeNull();
	});

	it("rejects malformed bounded allowance inputs", () => {
		expect(() => remainingCycleAllowance("hard", null, 0)).toThrow();
		expect(() => remainingCycleAllowance("hard", 10, -1)).toThrow();
	});

	it("moves a delayed transition forward to retain old-bucket reservations", () => {
		const requestedAt = new Date("2026-01-10T00:00:00.000Z");
		const latestReservationAt = new Date("2026-01-12T08:30:00.000Z");
		expect(
			safeBillingTransitionInstant(
				requestedAt,
				latestReservationAt,
				new Date("2026-01-01T00:00:00.000Z"),
				new Date("2026-02-01T00:00:00.000Z"),
			),
		).toEqual(latestReservationAt);
	});

	it("rejects a transition when retained reservation evidence leaves no successor", () => {
		expect(() =>
			safeBillingTransitionInstant(
				new Date("2026-01-10T00:00:00.000Z"),
				new Date("2026-02-01T00:00:00.000Z"),
				new Date("2026-01-01T00:00:00.000Z"),
				new Date("2026-02-01T00:00:00.000Z"),
			),
		).toThrow(
			"Billing-period transition cannot preserve the existing reservation window",
		);
	});

	it("shortens the exact period and bucket at the reservation-safe instant", async () => {
		const requestedAt = new Date("2026-01-10T00:00:00.000Z");
		const latestReservationAt = new Date("2026-01-12T08:30:00.000Z");
		const fixture = billingTransitionDb([
			[{ periodId: "bp_old", bucketId: "ub_old" }],
			[{ id: "ub_old" }],
			[
				{
					id: "bp_old",
					periodStart: new Date("2026-01-01T00:00:00.000Z"),
					periodEnd: new Date("2026-02-01T00:00:00.000Z"),
				},
			],
			[{ reservedAt: latestReservationAt }],
		]);

		await expect(
			shortenOpenBillingPeriod(fixture.db as never, {
				organizationId: "org_test",
				effectiveAt: requestedAt,
			}),
		).resolves.toBe("bp_old");
		expect(fixture.statements).toHaveLength(1);
		expect(fixture.updates).toEqual([
			{ periodEnd: latestReservationAt },
			{ periodEnd: latestReservationAt },
		]);
	});

	it("makes an unsafe delayed transition fail before either authority is changed", async () => {
		const periodEnd = new Date("2026-02-01T00:00:00.000Z");
		const fixture = billingTransitionDb([
			[{ periodId: "bp_old", bucketId: "ub_old" }],
			[{ id: "ub_old" }],
			[
				{
					id: "bp_old",
					periodStart: new Date("2026-01-01T00:00:00.000Z"),
					periodEnd,
				},
			],
			[{ reservedAt: periodEnd }],
		]);

		await expect(
			shortenOpenBillingPeriod(fixture.db as never, {
				organizationId: "org_test",
				effectiveAt: new Date("2026-01-10T00:00:00.000Z"),
			}),
		).rejects.toThrow(
			"Billing-period transition cannot preserve the existing reservation window",
		);
		expect(fixture.statements).toEqual([]);
		expect(fixture.updates).toEqual([]);
	});

	it("keeps period splitting transactional and defers the exact-window FK", async () => {
		const source = await Bun.file(
			new URL("../services/billing-periods.ts", import.meta.url),
		).text();
		const transition = source.slice(
			source.indexOf("async function transitionOpenBillingPeriodBoundary"),
			source.indexOf("export async function setComplimentaryPlan"),
		);
		const complimentary = source.slice(
			source.indexOf("export async function setComplimentaryPlan"),
			source.indexOf("export async function openBillingPeriod"),
		);
		const split = source.slice(
			source.indexOf("export async function splitBillingPeriod"),
			source.indexOf("export async function shortenOpenBillingPeriod"),
		);
		expect(split).toContain("db.transaction");
		expect(transition).toContain(
			"SET CONSTRAINTS usage_buckets_billing_period_window_fk DEFERRED",
		);
		expect(split).toContain('.for("update")');
		expect(split).toContain("providerCycleAnchor");
		expect(split).toContain("transitionOpenBillingPeriodBoundary");
		expect(
			complimentary.match(/transitionOpenBillingPeriodBoundary/g),
		).toHaveLength(2);
		expect(complimentary).not.toContain("periodEnd: effectiveAt");
		expect(complimentary).not.toContain("stripeCustomerId: null");
		expect(complimentary).toContain(
			"Customer identity is historical financial attribution",
		);
		expect(transition).toContain("usageReservations.reservedAt");
		expect(transition).toContain("orderBy(desc(usageReservations.reservedAt))");
	});

	it("preserves final settlement eligibility when cancellation shortens a period", async () => {
		const source = await Bun.file(
			new URL("../services/billing-periods.ts", import.meta.url),
		).text();
		const cancellation = source.slice(
			source.indexOf("export async function shortenOpenBillingPeriod"),
			source.indexOf(
				"export async function ensureHostedFreeUsageAuthorityInTransaction",
			),
		);
		expect(cancellation).toContain("db.transaction");
		expect(cancellation).toContain('eq(billingPeriods.state, "open")');
		expect(cancellation).toContain("transitionOpenBillingPeriodBoundary");
		expect(cancellation).not.toContain('state: "void"');
	});

	it("serializes expiry and recovery against subscription authority", async () => {
		const source = await Bun.file(
			new URL("../services/billing-periods.ts", import.meta.url),
		).text();
		const expiryTransition = source.slice(
			source.indexOf(
				"export async function ensureHostedFreeUsageAuthorityInTransaction",
			),
			source.indexOf("export async function ensureHostedFreeUsageAuthority("),
		);
		const expiryWrapper = source.slice(
			source.indexOf("export async function ensureHostedFreeUsageAuthority("),
			source.indexOf(
				"export async function transitionExpiredHostedBillingAuthorities",
			),
		);
		const recovery = source.slice(
			source.indexOf("async function resumeStripeBillingPeriodInTransaction"),
		);
		expect(expiryWrapper).toContain("lockOrganizationSubscription");
		expect(expiryWrapper).toContain(
			"ensureHostedFreeUsageAuthorityInTransaction",
		);
		expect(expiryTransition).toContain("transitionOpenBillingPeriodBoundary");
		expect(expiryTransition).toContain('kind: "auth_cache.refresh"');
		expect(recovery).toContain("safeBillingTransitionInstant");
		expect(recovery).toContain("remainingCycleAllowance");
		expect(recovery).toContain("expectedStripeSubscriptionId");
		expect(recovery).toContain("createUsageReservationCarryovers");
		expect(recovery).toContain(
			"sourceBucketIds: cycleBuckets.map((bucket) => bucket.id)",
		);
		expect(recovery).toContain(
			"Existing open billing authority does not match recovered Stripe terms",
		);
		const atomicRecovery = source.slice(
			source.indexOf("export async function recoverStripeBillingAuthority"),
		);
		expect(atomicRecovery).toContain("db.transaction");
		expect(
			atomicRecovery.indexOf("ensureHostedFreeUsageAuthorityInTransaction"),
		).toBeLessThan(
			atomicRecovery.indexOf(".update(organizationSubscriptions)"),
		);
		expect(
			atomicRecovery.indexOf(".update(organizationSubscriptions)"),
		).toBeLessThan(
			atomicRecovery.indexOf("resumeStripeBillingPeriodInTransaction"),
		);
		expect(atomicRecovery).toContain("if (!periodId)");
	});
});
