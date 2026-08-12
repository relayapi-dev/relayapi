import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	billingPeriods,
	createDb,
	eq,
	generateId,
	sql,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import postgres from "postgres";
import { shortenOpenBillingPeriod } from "../services/billing-periods";
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

const db = CONNECTION_STRING
	? createDb(CONNECTION_STRING)
	: (null as unknown as ReturnType<typeof createDb>);
const locker = CONNECTION_STRING
	? postgres(CONNECTION_STRING, { max: 1, prepare: false })
	: null;
const databaseIt = CONNECTION_STRING ? it : it.skip;

let dbAvailable = false;
const organizationId = generateId("org_");
const periodId = generateId("bp_");
const bucketId = generateId("ub_");

beforeAll(async () => {
	if (!CONNECTION_STRING) return;
	try {
		await db.execute(sql`SELECT 1 FROM public.billing_periods LIMIT 0`);
		dbAvailable = true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Configured billing-period database fixture is unavailable: ${message}`,
			{ cause: error },
		);
	}
});

afterAll(async () => {
	if (dbAvailable) {
		await db
			.delete(usageReservations)
			.where(eq(usageReservations.organizationId, organizationId));
		await db
			.delete(usageBuckets)
			.where(eq(usageBuckets.organizationId, organizationId));
		await db
			.delete(billingPeriods)
			.where(eq(billingPeriods.organizationId, organizationId));
		await deleteOwnedFixtureOrganization(db, organizationId);
	}
	await locker?.end();
});

describe("billing-period reservation boundary", () => {
	databaseIt(
		"blocks behind the reserve-path bucket lock and retains the reservation timestamp",
		async () => {
			if (!dbAvailable || !locker) {
				throw new Error("Database fixture setup did not complete");
			}

			const periodStart = new Date("2026-01-01T00:00:00.000Z");
			const requestedAt = new Date("2026-01-10T00:00:00.000Z");
			const reservedAt = new Date("2026-01-12T08:30:00.000Z");
			const originalEnd = new Date("2026-02-01T00:00:00.000Z");
			await insertOwnedFixtureOrganization(db, {
				id: organizationId,
				name: "Billing reservation boundary fixture",
				slug: `billing-boundary-${organizationId.slice(-8)}`,
			});
			await db.insert(billingPeriods).values({
				id: periodId,
				organizationId,
				source: "complimentary",
				billable: false,
				quotaMode: "hard",
				providerCycleAnchor: periodStart,
				periodStart,
				periodEnd: originalEnd,
				cycleAllowance: 100,
				includedUnits: 100,
				pricePerThousandUnitsCents: null,
				basePriceCents: 0,
				currency: "usd",
			});
			await db.insert(usageBuckets).values({
				id: bucketId,
				organizationId,
				billingPeriodId: periodId,
				metric: "successful_mutation",
				periodStart,
				periodEnd: originalEnd,
				quotaMode: "hard",
				includedUnits: 100,
			});
			await db.insert(usageReservations).values({
				id: generateId("ur_"),
				organizationId,
				bucketId,
				idempotencyKey: `boundary-${organizationId}`,
				state: "reserved",
				units: 1,
				reservedAt,
			});

			let releaseLock: (() => void) | undefined;
			let signalLocked: (() => void) | undefined;
			const locked = new Promise<void>((resolve) => {
				signalLocked = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
			const lockTransaction = locker.begin(async (transaction) => {
				await transaction`
				SELECT id
				FROM public.usage_buckets
				WHERE id = ${bucketId}
				FOR UPDATE
			`;
				signalLocked?.();
				await release;
			});
			await locked;

			let settled = false;
			const transitionResult = shortenOpenBillingPeriod(db, {
				organizationId,
				effectiveAt: requestedAt,
			}).then(
				(value) => {
					settled = true;
					return { value, error: null };
				},
				(error: unknown) => {
					settled = true;
					return { value: null, error };
				},
			);
			try {
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(settled).toBe(false);
			} finally {
				releaseLock?.();
				await lockTransaction;
			}
			const result = await transitionResult;
			expect(result.error).toBeNull();
			expect(result.value).toBe(periodId);

			const [periodRows, bucketRows] = await Promise.all([
				db
					.select({ periodEnd: billingPeriods.periodEnd })
					.from(billingPeriods)
					.where(eq(billingPeriods.id, periodId))
					.limit(1),
				db
					.select({ periodEnd: usageBuckets.periodEnd })
					.from(usageBuckets)
					.where(eq(usageBuckets.id, bucketId))
					.limit(1),
			]);
			expect(periodRows[0]?.periodEnd).toEqual(reservedAt);
			expect(bucketRows[0]?.periodEnd).toEqual(reservedAt);
		},
	);
});
