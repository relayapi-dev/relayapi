import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	and,
	billingOutbox,
	billingPeriods,
	createDb,
	eq,
	generateId,
	organizationSubscriptions,
	sql,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import { gt, inArray, isNull, lte } from "drizzle-orm";
import {
	ensureComplimentaryBillingAuthority,
	ensureHostedFreeUsageAuthority,
	openBillingPeriod,
	recoverStripeBillingAuthority,
	renewComplimentaryBillingAuthorities,
	setComplimentaryPlan,
	settleClosedComplimentaryBillingPeriods,
	splitBillingPeriod,
} from "../services/billing-periods";
import {
	effectiveCarryoverAllowance,
	getUsageCarryoverContribution,
} from "../services/usage-carryover";
import {
	armUsageReservationProviderBoundary,
	finalizeMutationUsage,
	reconcileStaleReservedUsageReservations,
	reserveMutationUsage,
	writeOffExpiredParkedUsageReservations,
} from "../services/usage-meter";
import {
	deleteOwnedFixtureOrganization,
	insertOwnedFixtureOrganization,
} from "./helpers/owned-organization-fixture";

const CONNECTION_STRING =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
const REQUIRE_DB_FIXTURES = process.env.RELAYAPI_REQUIRE_DB_FIXTURES === "1";

if (REQUIRE_DB_FIXTURES && !CONNECTION_STRING) {
	throw new Error(
		"RELAYAPI_REQUIRE_DB_FIXTURES=1 requires a PostgreSQL URL in HYPERDRIVE_LOCAL_CONNECTION_STRING or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
	);
}

const databaseIt = CONNECTION_STRING ? it : it.skip;
const db = CONNECTION_STRING
	? createDb(CONNECTION_STRING)
	: (null as unknown as ReturnType<typeof createDb>);
const createdOrganizations: string[] = [];

beforeAll(async () => {
	if (!CONNECTION_STRING) return;
	// A configured but unusable fixture database is a test failure, not a skip.
	await db.execute(sql`SELECT 1 FROM public.billing_periods LIMIT 0`);
});

afterAll(async () => {
	for (const organizationId of createdOrganizations.reverse()) {
		await db
			.delete(billingOutbox)
			.where(eq(billingOutbox.organizationId, organizationId));
		await db
			.delete(usageReservations)
			.where(eq(usageReservations.organizationId, organizationId));
		await db
			.delete(usageBuckets)
			.where(eq(usageBuckets.organizationId, organizationId));
		await db
			.delete(billingPeriods)
			.where(eq(billingPeriods.organizationId, organizationId));
		await db
			.delete(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, organizationId));
		await deleteOwnedFixtureOrganization(db, organizationId);
	}
});

async function createOrganization(label: string): Promise<string> {
	const organizationId = generateId("org_");
	await insertOwnedFixtureOrganization(db, {
		id: organizationId,
		name: `Usage authority ${label}`,
		slug: `usage-authority-${label}-${organizationId.slice(-8)}`,
	});
	createdOrganizations.push(organizationId);
	return organizationId;
}

const stripeTerms = {
	source: "stripe" as const,
	stripeCustomerId: "cus_usage_authority",
	stripeSubscriptionId: "sub_usage_authority",
	stripeProductId: "prod_usage_authority",
	stripePriceId: "price_usage_authority",
	stripePriceRole: "base" as const,
	rateCardVersion: "test-v1",
	taxBehavior: "unspecified" as const,
	taxCode: null,
	discountable: false,
	billable: true,
	quotaMode: "metered" as const,
	cycleAllowance: 10_000,
	pricePerThousandUnitsCents: 100,
	basePriceCents: 500,
	currency: "usd" as const,
};

describe("usage authority self-heal database behavior", () => {
	databaseIt(
		"renews after settlement terminalizes the latest complimentary predecessor",
		async () => {
			const organizationId = await createOrganization(
				"complimentary-settlement-interleaving",
			);
			const grantAt = new Date("2024-01-31T12:34:56.789Z");
			const afterFirstCycle = new Date("2024-03-01T00:00:00.000Z");
			const afterMissedCycles = new Date("2024-04-01T00:00:00.000Z");
			await setComplimentaryPlan(db, {
				organizationId,
				active: true,
				effectiveAt: grantAt,
				cycleAllowance: 321,
			});

			await expect(
				settleClosedComplimentaryBillingPeriods(db, afterFirstCycle, 1),
			).resolves.toBe(1);
			await expect(
				renewComplimentaryBillingAuthorities(db, afterMissedCycles, 1),
			).resolves.toBe(1);

			const periods = await db
				.select({
					periodStart: billingPeriods.periodStart,
					periodEnd: billingPeriods.periodEnd,
					state: billingPeriods.state,
				})
				.from(billingPeriods)
				.where(eq(billingPeriods.organizationId, organizationId))
				.orderBy(billingPeriods.periodStart);
			expect(periods).toEqual([
				{
					periodStart: grantAt,
					periodEnd: new Date("2024-02-29T12:34:56.789Z"),
					state: "settled",
				},
				{
					periodStart: new Date("2024-02-29T12:34:56.789Z"),
					periodEnd: new Date("2024-03-29T12:34:56.789Z"),
					state: "closed",
				},
				{
					periodStart: new Date("2024-03-29T12:34:56.789Z"),
					periodEnd: new Date("2024-04-29T12:34:56.789Z"),
					state: "open",
				},
			]);
		},
	);

	databaseIt(
		"moves a failed complimentary renewal behind later due grants within a hard batch cap",
		async () => {
			const malformedOrganizationId = await createOrganization(
				"complimentary-fairness-malformed",
			);
			const validOrganizationId = await createOrganization(
				"complimentary-fairness-valid",
			);
			await setComplimentaryPlan(db, {
				organizationId: malformedOrganizationId,
				active: true,
				effectiveAt: new Date("2024-01-01T00:00:00.000Z"),
				cycleAllowance: 123,
			});
			await setComplimentaryPlan(db, {
				organizationId: validOrganizationId,
				active: true,
				effectiveAt: new Date("2024-01-15T00:00:00.000Z"),
				cycleAllowance: 456,
			});
			await db
				.delete(usageBuckets)
				.where(eq(usageBuckets.organizationId, malformedOrganizationId));
			await db
				.delete(billingPeriods)
				.where(eq(billingPeriods.organizationId, malformedOrganizationId));

			const now = new Date("2024-03-01T00:00:00.000Z");
			await expect(
				renewComplimentaryBillingAuthorities(db, now, 1),
			).resolves.toBe(0);
			await expect(
				renewComplimentaryBillingAuthorities(db, now, 1),
			).resolves.toBe(1);

			const current = await db
				.select({ id: billingPeriods.id })
				.from(billingPeriods)
				.where(
					and(
						eq(billingPeriods.organizationId, validOrganizationId),
						eq(billingPeriods.state, "open"),
						lte(billingPeriods.periodStart, now),
						gt(billingPeriods.periodEnd, now),
					),
				);
			expect(current).toHaveLength(1);
		},
	);

	databaseIt(
		"moves an unsettled reserved bucket behind later due complimentary periods",
		async () => {
			const blockedOrganizationId = await createOrganization(
				"complimentary-settlement-fairness-blocked",
			);
			const validOrganizationId = await createOrganization(
				"complimentary-settlement-fairness-valid",
			);
			const blockedStart = new Date("2024-01-01T00:00:00.000Z");
			const validStart = new Date("2024-01-02T00:00:00.000Z");
			await setComplimentaryPlan(db, {
				organizationId: blockedOrganizationId,
				active: true,
				effectiveAt: blockedStart,
				cycleAllowance: 123,
			});
			await setComplimentaryPlan(db, {
				organizationId: validOrganizationId,
				active: true,
				effectiveAt: validStart,
				cycleAllowance: 456,
			});
			const [blockedAuthority] = await db
				.select({
					periodId: billingPeriods.id,
					bucketId: usageBuckets.id,
					periodEnd: billingPeriods.periodEnd,
				})
				.from(billingPeriods)
				.innerJoin(
					usageBuckets,
					eq(usageBuckets.billingPeriodId, billingPeriods.id),
				)
				.where(eq(billingPeriods.organizationId, blockedOrganizationId))
				.limit(1);
			expect(blockedAuthority).toBeDefined();
			if (!blockedAuthority) {
				throw new Error("Blocked complimentary authority was not created");
			}
			const reservation = await reserveMutationUsage(db, {
				organizationId: blockedOrganizationId,
				idempotencyKey: `complimentary-settlement-blocked:${blockedOrganizationId}`,
				units: 1,
				quotaMode: "hard",
				includedUnits: 123,
				periodStart: blockedStart,
				periodEnd: blockedAuthority.periodEnd,
				billingPeriodId: blockedAuthority.periodId,
				now: new Date("2024-01-15T00:00:00.000Z"),
			});
			expect(reservation.ok).toBe(true);
			await db
				.update(usageBuckets)
				.set({ updatedAt: new Date("2024-01-01T00:00:00.000Z") })
				.where(eq(usageBuckets.id, blockedAuthority.bucketId));
			await db
				.update(usageBuckets)
				.set({ updatedAt: new Date("2024-01-02T00:00:00.000Z") })
				.where(eq(usageBuckets.organizationId, validOrganizationId));

			const now = new Date("2024-03-01T00:00:00.000Z");
			await expect(
				settleClosedComplimentaryBillingPeriods(db, now, 1),
			).resolves.toBe(0);
			await expect(
				settleClosedComplimentaryBillingPeriods(db, now, 1),
			).resolves.toBe(1);

			const states = await db
				.select({
					organizationId: billingPeriods.organizationId,
					state: billingPeriods.state,
				})
				.from(billingPeriods)
				.where(
					inArray(billingPeriods.organizationId, [
						blockedOrganizationId,
						validOrganizationId,
					]),
				)
				.orderBy(billingPeriods.organizationId);
			expect(
				states.find((period) => period.organizationId === blockedOrganizationId)
					?.state,
			).toBe("open");
			expect(
				states.find((period) => period.organizationId === validOrganizationId)
					?.state,
			).toBe("settled");
		},
	);

	databaseIt(
		"rolls inactive complimentary grants across every missed month and settles the closed periods",
		async () => {
			const organizationId = await createOrganization("complimentary-rollover");
			const grantAt = new Date("2024-01-31T12:34:56.789Z");
			const now = new Date("2024-04-01T00:00:00.000Z");
			await setComplimentaryPlan(db, {
				organizationId,
				active: true,
				effectiveAt: grantAt,
				cycleAllowance: 321,
			});

			const currentPeriodId = await ensureComplimentaryBillingAuthority(db, {
				organizationId,
				now,
			});
			expect(currentPeriodId?.startsWith("bp_")).toBe(true);
			await expect(
				settleClosedComplimentaryBillingPeriods(db, now, 1),
			).resolves.toBe(2);

			const periods = await db
				.select({
					periodStart: billingPeriods.periodStart,
					periodEnd: billingPeriods.periodEnd,
					state: billingPeriods.state,
					committedUnitsSnapshot: billingPeriods.committedUnitsSnapshot,
					effectiveIncludedUnitsSnapshot:
						billingPeriods.effectiveIncludedUnitsSnapshot,
					overageUnitsSnapshot: billingPeriods.overageUnitsSnapshot,
					amountCentsSnapshot: billingPeriods.amountCentsSnapshot,
				})
				.from(billingPeriods)
				.where(eq(billingPeriods.organizationId, organizationId))
				.orderBy(billingPeriods.periodStart);
			expect(periods).toEqual([
				{
					periodStart: grantAt,
					periodEnd: new Date("2024-02-29T12:34:56.789Z"),
					state: "settled",
					committedUnitsSnapshot: 0,
					effectiveIncludedUnitsSnapshot: 321,
					overageUnitsSnapshot: 0,
					amountCentsSnapshot: 0,
				},
				{
					periodStart: new Date("2024-02-29T12:34:56.789Z"),
					periodEnd: new Date("2024-03-29T12:34:56.789Z"),
					state: "settled",
					committedUnitsSnapshot: 0,
					effectiveIncludedUnitsSnapshot: 321,
					overageUnitsSnapshot: 0,
					amountCentsSnapshot: 0,
				},
				{
					periodStart: new Date("2024-03-29T12:34:56.789Z"),
					periodEnd: new Date("2024-04-29T12:34:56.789Z"),
					state: "open",
					committedUnitsSnapshot: null,
					effectiveIncludedUnitsSnapshot: null,
					overageUnitsSnapshot: null,
					amountCentsSnapshot: null,
				},
			]);
		},
	);

	databaseIt(
		"moves a stale free cache from its unchanged bucket to a new paid period",
		async () => {
			const organizationId = await createOrganization("free-to-pro");
			const monthStart = new Date("2026-07-01T00:00:00.000Z");
			const paidStart = new Date("2026-07-15T00:00:00.000Z");
			const now = new Date("2026-07-20T12:00:00.000Z");
			const monthEnd = new Date("2026-08-01T00:00:00.000Z");
			const freeBucketId = generateId("ub_");

			await db.insert(usageBuckets).values({
				id: freeBucketId,
				organizationId,
				billingPeriodId: null,
				metric: "successful_mutation",
				periodStart: monthStart,
				periodEnd: monthEnd,
				quotaMode: "hard",
				includedUnits: 200,
			});
			const paidPeriodId = await openBillingPeriod(db, {
				organizationId,
				providerCycleAnchor: paidStart,
				periodStart: paidStart,
				periodEnd: monthEnd,
				terms: stripeTerms,
			});
			const [paidBucket] = await db
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(eq(usageBuckets.billingPeriodId, paidPeriodId))
				.limit(1);
			expect(paidBucket).toBeDefined();

			const decision = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:free-to-pro:${organizationId}`,
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
					bucketId: paidBucket?.id,
					quotaMode: "metered",
					periodStart: paidStart,
				},
			});
			expect(decision.ok && decision.reservation.bucketId).not.toBe(
				freeBucketId,
			);
		},
	);

	databaseIt(
		"repairs a stale cached window after the canonical period split",
		async () => {
			const organizationId = await createOrganization("split");
			const periodStart = new Date("2026-09-01T00:00:00.000Z");
			const splitAt = new Date("2026-09-15T00:00:00.000Z");
			const now = new Date("2026-09-20T12:00:00.000Z");
			const periodEnd = new Date("2026-10-01T00:00:00.000Z");
			const oldPeriodId = await openBillingPeriod(db, {
				organizationId,
				providerCycleAnchor: periodStart,
				periodStart,
				periodEnd,
				terms: stripeTerms,
			});
			const split = await splitBillingPeriod(db, {
				organizationId,
				providerCycleAnchor: periodStart,
				effectiveAt: splitAt,
				terms: {
					...stripeTerms,
					cycleAllowance: 20_000,
				},
			});
			expect(split?.oldPeriodId).toBe(oldPeriodId);
			const [successorBucket] = await db
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(eq(usageBuckets.billingPeriodId, split?.successorPeriodId ?? ""))
				.limit(1);
			expect(successorBucket).toBeDefined();

			const decision = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:split:${organizationId}`,
				units: 1,
				quotaMode: "metered",
				includedUnits: stripeTerms.cycleAllowance,
				periodStart,
				periodEnd,
				billingPeriodId: oldPeriodId,
				now,
			});

			expect(decision).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: {
					bucketId: successorBucket?.id,
					includedUnits: 20_000,
					periodStart: splitAt,
				},
			});
		},
	);

	databaseIt(
		"converges concurrent stale paid requests on one deterministic free bucket",
		async () => {
			const organizationId = await createOrganization("pro-to-free");
			const periodStart = new Date("2026-11-01T00:00:00.000Z");
			const downgradeAt = new Date("2026-11-15T00:00:00.000Z");
			const now = new Date("2026-11-20T12:00:00.000Z");
			const periodEnd = new Date("2026-12-01T00:00:00.000Z");
			await setComplimentaryPlan(db, {
				organizationId,
				active: true,
				effectiveAt: periodStart,
				cycleAllowance: 10_000,
			});
			const [oldAuthority] = await db
				.select({
					billingPeriodId: billingPeriods.id,
					bucketId: usageBuckets.id,
				})
				.from(usageBuckets)
				.innerJoin(
					billingPeriods,
					and(
						eq(billingPeriods.id, usageBuckets.billingPeriodId),
						eq(billingPeriods.organizationId, usageBuckets.organizationId),
					),
				)
				.where(
					and(
						eq(billingPeriods.organizationId, organizationId),
						eq(billingPeriods.periodStart, periodStart),
					),
				)
				.limit(1);
			expect(oldAuthority).toBeDefined();
			await setComplimentaryPlan(db, {
				organizationId,
				active: false,
				effectiveAt: downgradeAt,
				cycleAllowance: 10_000,
			});

			const staleAuthority = {
				organizationId,
				units: 1,
				quotaMode: "hard" as const,
				includedUnits: 10_000,
				periodStart,
				periodEnd,
				billingPeriodId: oldAuthority?.billingPeriodId,
				now,
			};
			const [first, second] = await Promise.all([
				reserveMutationUsage(db, {
					...staleAuthority,
					idempotencyKey: `request:pro-to-free:a:${organizationId}`,
				}),
				reserveMutationUsage(db, {
					...staleAuthority,
					idempotencyKey: `request:pro-to-free:b:${organizationId}`,
				}),
			]);

			expect(first).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { periodStart: downgradeAt },
			});
			expect(second).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { periodStart: downgradeAt },
			});
			expect(
				first.ok && second.ok
					? first.reservation.bucketId === second.reservation.bucketId
					: false,
			).toBe(true);

			const freeBuckets = await db
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(
					and(
						eq(usageBuckets.organizationId, organizationId),
						eq(usageBuckets.metric, "successful_mutation"),
						isNull(usageBuckets.billingPeriodId),
					),
				);
			expect(freeBuckets).toHaveLength(1);
			expect(freeBuckets[0]?.id).not.toBe(oldAuthority?.bucketId);
		},
	);

	databaseIt(
		"routes concurrent stale pre-upgrade free caches to the post-downgrade bucket",
		async () => {
			const organizationId = await createOrganization("stale-free-after-paid");
			const monthStart = new Date("2026-07-01T00:00:00.000Z");
			const beforeUpgrade = new Date("2026-07-05T12:00:00.000Z");
			const upgradeAt = new Date("2026-07-10T00:00:00.000Z");
			const downgradeAt = new Date("2026-07-15T00:00:00.000Z");
			const now = new Date("2026-07-20T12:00:00.000Z");
			const monthEnd = new Date("2026-08-01T00:00:00.000Z");

			const initialFree = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:pre-upgrade:${organizationId}`,
				units: 1,
				quotaMode: "hard",
				includedUnits: 200,
				periodStart: monthStart,
				periodEnd: monthEnd,
				billingPeriodId: null,
				now: beforeUpgrade,
			});
			if (!initialFree.ok) {
				throw new Error("Initial free reservation was denied");
			}
			await finalizeMutationUsage(db, initialFree.reservation, {
				commit: false,
				reason: "pre_boundary",
				responseStatus: 200,
			});

			await setComplimentaryPlan(db, {
				organizationId,
				active: true,
				effectiveAt: upgradeAt,
				cycleAllowance: 10_000,
			});
			await setComplimentaryPlan(db, {
				organizationId,
				active: false,
				effectiveAt: downgradeAt,
				cycleAllowance: 10_000,
			});

			const staleFreeAuthority = {
				organizationId,
				units: 1,
				quotaMode: "hard" as const,
				includedUnits: 200,
				periodStart: monthStart,
				periodEnd: monthEnd,
				billingPeriodId: null,
				now,
			};
			const [first, second] = await Promise.all([
				reserveMutationUsage(db, {
					...staleFreeAuthority,
					idempotencyKey: `request:stale-free:a:${organizationId}`,
				}),
				reserveMutationUsage(db, {
					...staleFreeAuthority,
					idempotencyKey: `request:stale-free:b:${organizationId}`,
				}),
			]);

			expect(first).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { periodStart: downgradeAt },
			});
			expect(second).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { periodStart: downgradeAt },
			});
			expect(
				first.ok && second.ok
					? first.reservation.bucketId === second.reservation.bucketId
					: false,
			).toBe(true);

			const freeBuckets = await db
				.select({
					id: usageBuckets.id,
					periodStart: usageBuckets.periodStart,
				})
				.from(usageBuckets)
				.where(
					and(
						eq(usageBuckets.organizationId, organizationId),
						eq(usageBuckets.metric, "successful_mutation"),
						isNull(usageBuckets.billingPeriodId),
					),
				);
			expect(freeBuckets).toHaveLength(2);
			expect(
				freeBuckets.filter(
					(bucket) => bucket.periodStart.getTime() === downgradeAt.getTime(),
				),
			).toHaveLength(1);
		},
	);

	databaseIt(
		"converges stale pre-boundary and armed reservations after a nonbillable split",
		async () => {
			const organizationId = await createOrganization("stale-carryover");
			const cycleStart = new Date("2026-04-01T00:00:00.000Z");
			const reservedAt = new Date("2026-04-05T00:00:00.000Z");
			const providerBoundaryAt = new Date("2026-04-05T00:00:01.000Z");
			const splitAt = new Date("2026-04-06T00:00:00.000Z");

			await setComplimentaryPlan(db, {
				organizationId,
				active: true,
				effectiveAt: cycleStart,
				cycleAllowance: 100,
			});
			const [source] = await db
				.select({
					periodId: billingPeriods.id,
					bucketId: usageBuckets.id,
					periodEnd: billingPeriods.periodEnd,
				})
				.from(usageBuckets)
				.innerJoin(
					billingPeriods,
					and(
						eq(billingPeriods.id, usageBuckets.billingPeriodId),
						eq(billingPeriods.organizationId, usageBuckets.organizationId),
					),
				)
				.where(eq(billingPeriods.organizationId, organizationId))
				.limit(1);
			if (!source) throw new Error("Complimentary authority was not created");

			const unarmed = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:stale-unarmed:${organizationId}`,
				units: 2,
				quotaMode: "hard",
				includedUnits: 100,
				periodStart: cycleStart,
				periodEnd: source.periodEnd,
				billingPeriodId: source.periodId,
				now: reservedAt,
			});
			const armed = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:stale-armed:${organizationId}`,
				units: 3,
				quotaMode: "hard",
				includedUnits: 100,
				periodStart: cycleStart,
				periodEnd: source.periodEnd,
				billingPeriodId: source.periodId,
				now: reservedAt,
			});
			if (!unarmed.ok || !armed.ok) {
				throw new Error("Stale reservation setup was denied");
			}
			await armUsageReservationProviderBoundary(
				db,
				armed.reservation,
				providerBoundaryAt,
			);

			await setComplimentaryPlan(db, {
				organizationId,
				active: true,
				effectiveAt: splitAt,
				cycleAllowance: 120,
			});
			const [successor] = await db
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(
					and(
						eq(usageBuckets.organizationId, organizationId),
						eq(usageBuckets.periodStart, splitAt),
					),
				)
				.limit(1);
			if (!successor) throw new Error("Complimentary split was not created");
			expect(
				await getUsageCarryoverContribution(db, {
					organizationId,
					successorBucketId: successor.id,
				}),
			).toEqual({ pendingUnits: 5, committedUnits: 0 });

			expect(
				await reconcileStaleReservedUsageReservations(
					db,
					100,
					new Date("2026-04-06T00:20:00.000Z"),
					organizationId,
				),
			).toEqual({ released: 1, parked: 1 });
			const reservationStates = await db
				.select({
					id: usageReservations.id,
					state: usageReservations.state,
					disposition: usageReservations.disposition,
				})
				.from(usageReservations)
				.where(eq(usageReservations.organizationId, organizationId));
			expect(reservationStates).toEqual(
				expect.arrayContaining([
					{
						id: unarmed.reservation.id,
						state: "released",
						disposition: "pre_boundary",
					},
					{
						id: armed.reservation.id,
						state: "parked",
						disposition: "unknown",
					},
				]),
			);
			expect(
				await getUsageCarryoverContribution(db, {
					organizationId,
					successorBucketId: successor.id,
				}),
			).toEqual({ pendingUnits: 3, committedUnits: 0 });

			expect(
				await writeOffExpiredParkedUsageReservations(
					db,
					100,
					new Date("2026-05-06T00:00:02.000Z"),
					organizationId,
				),
			).toBe(1);
			expect(
				await getUsageCarryoverContribution(db, {
					organizationId,
					successorBucketId: successor.id,
				}),
			).toEqual({ pendingUnits: 0, committedUnits: 0 });
		},
	);

	databaseIt(
		"carries late paid outcomes across grace recovery and a second split without burning released units",
		async () => {
			const organizationId = await createOrganization("stripe-grace-recovery");
			const cycleStart = new Date("2026-07-01T00:00:00.000Z");
			const delinquentAt = new Date("2026-07-10T00:00:00.000Z");
			const graceEndsAt = new Date("2026-07-24T00:00:00.000Z");
			const freeUseAt = new Date("2026-07-24T12:00:00.000Z");
			const recoveryAt = new Date("2026-07-25T00:00:00.000Z");
			const secondTransitionAt = new Date("2026-07-27T00:00:00.000Z");
			const providerPeriodEnd = new Date("2026-08-01T00:00:00.000Z");
			const stripeSubscriptionId = `sub_${organizationId}`;
			const terms = {
				...stripeTerms,
				stripeCustomerId: `cus_${organizationId}`,
				stripeSubscriptionId,
			};

			await db.insert(organizationSubscriptions).values({
				organizationId,
				status: "past_due",
				source: "stripe",
				delinquentAt,
				graceEndsAt,
				trialEndsAt: null,
				currentPeriodStart: cycleStart,
				currentPeriodEnd: providerPeriodEnd,
				stripeCustomerId: terms.stripeCustomerId,
				stripeSubscriptionId,
				updatedAt: delinquentAt,
			});
			const originalPeriodId = await openBillingPeriod(db, {
				organizationId,
				providerCycleAnchor: cycleStart,
				periodStart: cycleStart,
				periodEnd: providerPeriodEnd,
				terms,
			});

			const paidUsage = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:paid-before-grace:${organizationId}`,
				units: 300,
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: cycleStart,
				periodEnd: providerPeriodEnd,
				billingPeriodId: originalPeriodId,
				now: new Date("2026-07-09T12:00:00.000Z"),
			});
			if (!paidUsage.ok) throw new Error("Paid usage reservation was denied");
			await finalizeMutationUsage(db, paidUsage.reservation, {
				commit: true,
				reason: "settled",
				responseStatus: 200,
				committedUnits: 300,
			});
			const inFlightPaidUsage = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:paid-in-flight:${organizationId}`,
				units: 7,
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: cycleStart,
				periodEnd: providerPeriodEnd,
				billingPeriodId: originalPeriodId,
				now: new Date("2026-07-23T23:59:00.000Z"),
			});
			if (!inFlightPaidUsage.ok) {
				throw new Error("In-flight paid usage reservation was denied");
			}
			const releasedPaidUsage = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:paid-released-late:${organizationId}`,
				units: 11,
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: cycleStart,
				periodEnd: providerPeriodEnd,
				billingPeriodId: originalPeriodId,
				now: new Date("2026-07-23T23:59:30.000Z"),
			});
			if (!releasedPaidUsage.ok) {
				throw new Error("Late released paid usage reservation was denied");
			}
			const multiSplitPaidUsage = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:paid-multi-split:${organizationId}`,
				units: 13,
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: cycleStart,
				periodEnd: providerPeriodEnd,
				billingPeriodId: originalPeriodId,
				now: new Date("2026-07-23T23:59:45.000Z"),
			});
			if (!multiSplitPaidUsage.ok) {
				throw new Error("Multi-split paid usage reservation was denied");
			}

			expect(
				await ensureHostedFreeUsageAuthority(db, {
					organizationId,
					now: freeUseAt,
				}),
			).toEqual(graceEndsAt);

			const freeUsage = await reserveMutationUsage(db, {
				organizationId,
				idempotencyKey: `request:free-during-lapse:${organizationId}`,
				units: 50,
				// Deliberately present the pre-grace cached authority. The ledger must
				// self-heal to a fresh Free bucket starting at the persisted boundary.
				quotaMode: "metered",
				includedUnits: 10_000,
				periodStart: cycleStart,
				periodEnd: providerPeriodEnd,
				billingPeriodId: originalPeriodId,
				now: freeUseAt,
			});
			expect(freeUsage).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: {
					quotaMode: "hard",
					includedUnits: 200,
					periodStart: graceEndsAt,
				},
			});
			if (!freeUsage.ok) throw new Error("Free usage reservation was denied");
			await finalizeMutationUsage(db, freeUsage.reservation, {
				commit: true,
				reason: "settled",
				responseStatus: 200,
				committedUnits: 50,
			});
			const recoveryProjection = {
				status: "active" as const,
				source: "stripe" as const,
				delinquentAt: null,
				graceEndsAt: null,
				stripeCustomerId: terms.stripeCustomerId,
				stripeSubscriptionId,
				trialEndsAt: null,
				cancelAtPeriodEnd: false,
				currentPeriodStart: cycleStart,
				currentPeriodEnd: providerPeriodEnd,
				updatedAt: recoveryAt,
			};
			await expect(
				recoverStripeBillingAuthority(db, {
					organizationId,
					expectedStripeSubscriptionId: stripeSubscriptionId,
					providerCycleAnchor: cycleStart,
					providerPeriodEnd: recoveryAt,
					effectiveAt: recoveryAt,
					terms,
					subscriptionProjection: recoveryProjection,
					outbox: {
						id: `test:${organizationId}:invalid-recovery`,
						payload: { source: "database_fixture" },
					},
				}),
			).rejects.toThrow("no current paid usage authority");
			const [stillPastDue] = await db
				.select({ status: organizationSubscriptions.status })
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.organizationId, organizationId))
				.limit(1);
			expect(stillPastDue?.status).toBe("past_due");

			const successorPeriodId = await recoverStripeBillingAuthority(db, {
				organizationId,
				expectedStripeSubscriptionId: stripeSubscriptionId,
				providerCycleAnchor: cycleStart,
				providerPeriodEnd,
				effectiveAt: recoveryAt,
				terms,
				subscriptionProjection: recoveryProjection,
				outbox: {
					id: `test:${organizationId}:recovery`,
					payload: { source: "database_fixture" },
				},
			});
			expect(successorPeriodId).not.toBeNull();
			if (!successorPeriodId) {
				throw new Error("Recovery did not create a successor billing period");
			}
			const [successorBucket] = await db
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(eq(usageBuckets.billingPeriodId, successorPeriodId))
				.limit(1);
			if (!successorBucket) {
				throw new Error("Recovery did not create a successor usage bucket");
			}
			const pendingCarryover = await getUsageCarryoverContribution(db, {
				organizationId,
				successorBucketId: successorBucket.id,
			});
			expect(pendingCarryover).toEqual({
				pendingUnits: 31,
				committedUnits: 0,
			});
			expect(effectiveCarryoverAllowance(9_700, 0)).toBe(9_700);
			await finalizeMutationUsage(db, inFlightPaidUsage.reservation, {
				commit: true,
				reason: "settled",
				responseStatus: 200,
				committedUnits: 7,
			});
			await finalizeMutationUsage(db, releasedPaidUsage.reservation, {
				commit: false,
				reason: "pre_boundary",
				responseStatus: 200,
			});
			const settledCarryover = await getUsageCarryoverContribution(db, {
				organizationId,
				successorBucketId: successorBucket.id,
			});
			expect(settledCarryover).toEqual({
				pendingUnits: 13,
				committedUnits: 7,
			});
			expect(
				effectiveCarryoverAllowance(9_700, settledCarryover.committedUnits),
			).toBe(9_693);
			await expect(
				reserveMutationUsage(db, {
					organizationId,
					idempotencyKey: `request:paid-released-late:${organizationId}`,
					units: 1,
					quotaMode: "metered",
					includedUnits: 9_700,
					periodStart: recoveryAt,
					periodEnd: providerPeriodEnd,
					billingPeriodId: successorPeriodId,
					now: new Date("2026-07-25T01:00:00.000Z"),
				}),
			).rejects.toThrow(
				"Carryover-linked usage reservations are terminal and cannot be reused",
			);

			const secondTerms = {
				...terms,
				stripePriceId: `${terms.stripePriceId}_successor`,
			};
			const secondSplit = await splitBillingPeriod(db, {
				organizationId,
				providerCycleAnchor: cycleStart,
				effectiveAt: secondTransitionAt,
				terms: secondTerms,
			});
			expect(secondSplit).not.toBeNull();
			if (!secondSplit) throw new Error("Second billing split was not created");
			const [secondSuccessorBucket] = await db
				.select({ id: usageBuckets.id })
				.from(usageBuckets)
				.where(eq(usageBuckets.billingPeriodId, secondSplit.successorPeriodId))
				.limit(1);
			if (!secondSuccessorBucket) {
				throw new Error("Second split did not create a usage bucket");
			}
			expect(
				await getUsageCarryoverContribution(db, {
					organizationId,
					successorBucketId: secondSuccessorBucket.id,
				}),
			).toEqual({ pendingUnits: 13, committedUnits: 0 });
			await finalizeMutationUsage(db, multiSplitPaidUsage.reservation, {
				commit: true,
				reason: "settled",
				responseStatus: 200,
				committedUnits: 5,
			});
			const [firstFinalCarryover, secondFinalCarryover] = await Promise.all([
				getUsageCarryoverContribution(db, {
					organizationId,
					successorBucketId: successorBucket.id,
				}),
				getUsageCarryoverContribution(db, {
					organizationId,
					successorBucketId: secondSuccessorBucket.id,
				}),
			]);
			expect(firstFinalCarryover).toEqual({
				pendingUnits: 0,
				committedUnits: 12,
			});
			expect(secondFinalCarryover).toEqual({
				pendingUnits: 0,
				committedUnits: 5,
			});
			expect(effectiveCarryoverAllowance(9_700, 12)).toBe(9_688);
			expect(effectiveCarryoverAllowance(9_693, 5)).toBe(9_688);

			const periods = await db
				.select({
					id: billingPeriods.id,
					periodStart: billingPeriods.periodStart,
					periodEnd: billingPeriods.periodEnd,
					includedUnits: billingPeriods.includedUnits,
				})
				.from(billingPeriods)
				.where(eq(billingPeriods.organizationId, organizationId))
				.orderBy(billingPeriods.periodStart);
			expect(periods).toEqual([
				{
					id: originalPeriodId,
					periodStart: cycleStart,
					periodEnd: graceEndsAt,
					includedUnits: 10_000,
				},
				{
					id: successorPeriodId,
					periodStart: recoveryAt,
					periodEnd: secondTransitionAt,
					includedUnits: 9_700,
				},
				{
					id: secondSplit.successorPeriodId,
					periodStart: secondTransitionAt,
					periodEnd: providerPeriodEnd,
					includedUnits: 9_693,
				},
			]);

			const [freeBucket] = await db
				.select({
					periodStart: usageBuckets.periodStart,
					periodEnd: usageBuckets.periodEnd,
					committedUnits: usageBuckets.committedUnits,
				})
				.from(usageBuckets)
				.where(
					and(
						eq(usageBuckets.organizationId, organizationId),
						isNull(usageBuckets.billingPeriodId),
					),
				)
				.limit(1);
			expect(freeBucket).toEqual({
				periodStart: graceEndsAt,
				periodEnd: recoveryAt,
				committedUnits: 50,
			});
		},
	);
});
