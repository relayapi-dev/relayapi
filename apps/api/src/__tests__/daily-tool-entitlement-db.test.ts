import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	billingPeriods,
	createDb,
	eq,
	generateId,
	organizationSubscriptions,
	sql,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import { setComplimentaryPlan } from "../services/billing-periods";
import {
	finalizeMutationUsage,
	reserveDailyToolUsage,
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
	await db.execute(
		sql`SELECT daily_tool_limit_override FROM public.organization_subscriptions LIMIT 0`,
	);
});

afterAll(async () => {
	for (const organizationId of createdOrganizations.reverse()) {
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

async function createOrganization(
	label: string,
	dailyToolLimitOverride: number | null,
): Promise<string> {
	const organizationId = generateId("org_");
	await insertOwnedFixtureOrganization(db, {
		id: organizationId,
		name: `Daily tool entitlement ${label}`,
		slug: `daily-tool-${label}-${organizationId.slice(-8)}`,
	});
	await db.insert(organizationSubscriptions).values({
		organizationId,
		status: "active",
		source: "complimentary",
		dailyToolLimitOverride,
	});
	createdOrganizations.push(organizationId);
	return organizationId;
}

const now = new Date("2026-07-29T12:00:00.000Z");

describe("daily tool entitlement database behavior", () => {
	databaseIt(
		"rebases one current-day bucket under concurrent override reservations",
		async () => {
			const organizationId = await createOrganization("concurrent", null);
			const initial = await reserveDailyToolUsage(db, {
				organizationId,
				idempotencyKey: `tool:initial:${organizationId}`,
				units: 1,
				cachedLimit: 2,
				now,
			});
			expect(initial).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { includedUnits: 10 },
			});
			if (!initial.ok) throw new Error("Initial reservation was denied");
			await finalizeMutationUsage(db, initial.reservation, {
				commit: false,
				reason: "pre_boundary",
				responseStatus: 200,
			});

			await db
				.update(organizationSubscriptions)
				.set({ dailyToolLimitOverride: 25, updatedAt: new Date() })
				.where(eq(organizationSubscriptions.organizationId, organizationId));

			const [first, second] = await Promise.all([
				reserveDailyToolUsage(db, {
					organizationId,
					idempotencyKey: `tool:override:a:${organizationId}`,
					units: 1,
					cachedLimit: 10,
					now,
				}),
				reserveDailyToolUsage(db, {
					organizationId,
					idempotencyKey: `tool:override:b:${organizationId}`,
					units: 1,
					cachedLimit: 10,
					now,
				}),
			]);
			expect(first).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { includedUnits: 25 },
			});
			expect(second).toMatchObject({
				ok: true,
				selfHealed: true,
				reservation: { includedUnits: 25 },
			});

			const buckets = await db
				.select({
					id: usageBuckets.id,
					includedUnits: usageBuckets.includedUnits,
					reservedUnits: usageBuckets.reservedUnits,
				})
				.from(usageBuckets)
				.where(
					sql`${usageBuckets.organizationId} = ${organizationId}
						AND ${usageBuckets.metric} = 'tool_invocation'`,
				);
			expect(buckets).toHaveLength(1);
			expect(buckets[0]).toMatchObject({
				includedUnits: 25,
				reservedUnits: 2,
			});
			expect(
				first.ok && second.ok
					? first.reservation.bucketId === second.reservation.bucketId
					: false,
			).toBe(true);
		},
	);

	databaseIt(
		"applies a lower override to existing committed daily usage without resetting it",
		async () => {
			const organizationId = await createOrganization("downgrade", 3);
			const first = await reserveDailyToolUsage(db, {
				organizationId,
				idempotencyKey: `tool:commit:${organizationId}`,
				units: 1,
				cachedLimit: 3,
				now,
			});
			if (!first.ok) throw new Error("Initial reservation was denied");
			await finalizeMutationUsage(db, first.reservation, {
				commit: true,
				reason: "settled",
				responseStatus: 200,
			});

			await db
				.update(organizationSubscriptions)
				.set({ dailyToolLimitOverride: 1, updatedAt: new Date() })
				.where(eq(organizationSubscriptions.organizationId, organizationId));
			const denied = await reserveDailyToolUsage(db, {
				organizationId,
				idempotencyKey: `tool:denied:${organizationId}`,
				units: 1,
				cachedLimit: 3,
				now,
			});

			expect(denied).toEqual({
				ok: false,
				selfHealed: true,
				quotaMode: "hard",
				includedUnits: 1,
				committedUnits: 1,
				reservedUnits: 0,
			});
			const [bucket] = await db
				.select({
					includedUnits: usageBuckets.includedUnits,
					committedUnits: usageBuckets.committedUnits,
				})
				.from(usageBuckets)
				.where(
					sql`${usageBuckets.organizationId} = ${organizationId}
						AND ${usageBuckets.metric} = 'tool_invocation'`,
				)
				.limit(1);
			expect(bucket).toEqual({ includedUnits: 1, committedUnits: 1 });
		},
	);

	databaseIt(
		"serializes a first reservation with a concurrent first entitlement row",
		async () => {
			const organizationId = generateId("org_");
			await insertOwnedFixtureOrganization(db, {
				id: organizationId,
				name: "Daily tool entitlement first-row race",
				slug: `daily-tool-first-row-${organizationId.slice(-8)}`,
			});
			createdOrganizations.push(organizationId);

			const [first] = await Promise.all([
				reserveDailyToolUsage(db, {
					organizationId,
					idempotencyKey: `tool:first-row:${organizationId}`,
					units: 1,
					cachedLimit: 2,
					now,
				}),
				db
					.insert(organizationSubscriptions)
					.values({
						organizationId,
						status: "active",
						source: "complimentary",
						dailyToolLimitOverride: 30,
					})
					.onConflictDoUpdate({
						target: organizationSubscriptions.organizationId,
						set: {
							status: "active",
							source: "complimentary",
							dailyToolLimitOverride: 30,
							updatedAt: new Date(),
						},
					}),
			]);
			expect(first.ok).toBe(true);

			const converged = await reserveDailyToolUsage(db, {
				organizationId,
				idempotencyKey: `tool:first-row:converged:${organizationId}`,
				units: 1,
				cachedLimit:
					first.ok && first.reservation.includedUnits !== null
						? first.reservation.includedUnits
						: 2,
				now,
			});
			expect(converged).toMatchObject({
				ok: true,
				reservation: { includedUnits: 30 },
			});
			const buckets = await db
				.select({
					includedUnits: usageBuckets.includedUnits,
					reservedUnits: usageBuckets.reservedUnits,
				})
				.from(usageBuckets)
				.where(
					sql`${usageBuckets.organizationId} = ${organizationId}
						AND ${usageBuckets.metric} = 'tool_invocation'`,
				);
			expect(buckets).toEqual([{ includedUnits: 30, reservedUnits: 2 }]);
		},
	);

	databaseIt(
		"does not unique-fail a first complimentary grant racing tool-row materialization",
		async () => {
			const organizationId = generateId("org_");
			await insertOwnedFixtureOrganization(db, {
				id: organizationId,
				name: "Daily tool entitlement complimentary race",
				slug: `daily-tool-complimentary-${organizationId.slice(-8)}`,
			});
			createdOrganizations.push(organizationId);

			const [first] = await Promise.all([
				reserveDailyToolUsage(db, {
					organizationId,
					idempotencyKey: `tool:complimentary-race:${organizationId}`,
					units: 1,
					cachedLimit: 2,
					now,
				}),
				setComplimentaryPlan(db, {
					organizationId,
					active: true,
					effectiveAt: now,
					cycleAllowance: 10_000,
				}),
			]);
			expect(first.ok).toBe(true);

			const converged = await reserveDailyToolUsage(db, {
				organizationId,
				idempotencyKey: `tool:complimentary-converged:${organizationId}`,
				units: 1,
				cachedLimit:
					first.ok && first.reservation.includedUnits !== null
						? first.reservation.includedUnits
						: 2,
				now,
			});
			expect(converged).toMatchObject({
				ok: true,
				reservation: { includedUnits: 10 },
			});
			const [subscription] = await db
				.select({
					status: organizationSubscriptions.status,
					source: organizationSubscriptions.source,
					override: organizationSubscriptions.dailyToolLimitOverride,
				})
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.organizationId, organizationId))
				.limit(1);
			expect(subscription).toEqual({
				status: "active",
				source: "complimentary",
				override: null,
			});
		},
	);
});
