import {
	type Database,
	generateId,
	usageBuckets,
	usageReservations,
} from "@relayapi/db";
import { and, eq, lt, sql } from "drizzle-orm";

const METRIC = "successful_mutation";
const STALE_RESERVATION_MS = 15 * 60_000;

export type UsageReservation = {
	id: string;
	bucketId: string;
	organizationId: string;
	units: number;
	state: "reserved" | "committed";
	includedUnits: number;
	committedUnits: number;
	reservedUnits: number;
	periodStart: Date;
	periodEnd: Date;
};

export type UsageReservationDecision =
	| { ok: true; reservation: UsageReservation }
	| {
			ok: false;
			includedUnits: number;
			committedUnits: number;
			reservedUnits: number;
	  };

export async function reserveMutationUsage(
	db: Database,
	input: {
		organizationId: string;
		idempotencyKey: string;
		units: number;
		includedUnits: number;
		periodStart: Date;
		periodEnd: Date;
		hardLimit: boolean;
		now?: Date;
	},
): Promise<UsageReservationDecision> {
	if (!Number.isInteger(input.units) || input.units <= 0) {
		throw new Error("Usage reservation units must be a positive integer");
	}
	const now = input.now ?? new Date();

	return db.transaction(async (tx) => {
		await tx
			.insert(usageBuckets)
			.values({
				id: generateId("ub_"),
				organizationId: input.organizationId,
				metric: METRIC,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				includedUnits: input.includedUnits,
			})
			.onConflictDoNothing({
				target: [
					usageBuckets.organizationId,
					usageBuckets.metric,
					usageBuckets.periodStart,
				],
			});

		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.organizationId, input.organizationId),
					eq(usageBuckets.metric, METRIC),
					eq(usageBuckets.periodStart, input.periodStart),
				),
			)
			.for("update")
			.limit(1);
		if (!bucket) throw new Error("Failed to create authoritative usage bucket");

		// A Worker that dies after reserving cannot permanently consume quota. The
		// next mutation reclaims a bounded bucket-local set under the same row lock.
		const stale = await tx
			.select({ id: usageReservations.id, units: usageReservations.units })
			.from(usageReservations)
			.where(
				and(
					eq(usageReservations.bucketId, bucket.id),
					eq(usageReservations.state, "reserved"),
					lt(
						usageReservations.reservedAt,
						new Date(now.getTime() - STALE_RESERVATION_MS),
					),
				),
			)
			.for("update")
			.limit(100);
		const staleUnits = stale.reduce((sum, row) => sum + row.units, 0);
		if (stale.length > 0) {
			await tx
				.update(usageReservations)
				.set({ state: "released", responseStatus: null, finalizedAt: now })
				.where(
					sql`${usageReservations.id} IN (${sql.join(
						stale.map((row) => sql`${row.id}`),
						sql`, `,
					)})`,
				);
			await tx
				.update(usageBuckets)
				.set({
					reservedUnits: sql`GREATEST(0, ${usageBuckets.reservedUnits} - ${staleUnits})`,
					revision: sql`${usageBuckets.revision} + 1`,
					updatedAt: now,
				})
				.where(eq(usageBuckets.id, bucket.id));
			bucket.reservedUnits = Math.max(0, bucket.reservedUnits - staleUnits);
		}

		const [existing] = await tx
			.select()
			.from(usageReservations)
			.where(
				and(
					eq(usageReservations.organizationId, input.organizationId),
					eq(usageReservations.idempotencyKey, input.idempotencyKey),
				),
			)
			.for("update")
			.limit(1);

		if (existing?.state === "committed") {
			return {
				ok: true,
				reservation: {
					id: existing.id,
					bucketId: bucket.id,
					organizationId: input.organizationId,
					units: existing.units,
					state: "committed",
					includedUnits: bucket.includedUnits,
					committedUnits: bucket.committedUnits,
					reservedUnits: bucket.reservedUnits,
					periodStart: bucket.periodStart,
					periodEnd: bucket.periodEnd,
				},
			};
		}
		if (existing?.state === "reserved") {
			return {
				ok: true,
				reservation: {
					id: existing.id,
					bucketId: bucket.id,
					organizationId: input.organizationId,
					units: existing.units,
					state: "reserved",
					includedUnits: bucket.includedUnits,
					committedUnits: bucket.committedUnits,
					reservedUnits: bucket.reservedUnits,
					periodStart: bucket.periodStart,
					periodEnd: bucket.periodEnd,
				},
			};
		}

		if (
			input.hardLimit &&
			bucket.committedUnits + bucket.reservedUnits + input.units >
				bucket.includedUnits
		) {
			return {
				ok: false,
				includedUnits: bucket.includedUnits,
				committedUnits: bucket.committedUnits,
				reservedUnits: bucket.reservedUnits,
			};
		}

		const reservationId = existing?.id ?? generateId("ur_");
		if (existing) {
			await tx
				.update(usageReservations)
				.set({
					bucketId: bucket.id,
					units: input.units,
					state: "reserved",
					responseStatus: null,
					reservedAt: now,
					finalizedAt: null,
				})
				.where(eq(usageReservations.id, existing.id));
		} else {
			await tx.insert(usageReservations).values({
				id: reservationId,
				organizationId: input.organizationId,
				bucketId: bucket.id,
				idempotencyKey: input.idempotencyKey,
				units: input.units,
				state: "reserved",
				source: "api",
				reservedAt: now,
			});
		}

		await tx
			.update(usageBuckets)
			.set({
				reservedUnits: sql`${usageBuckets.reservedUnits} + ${input.units}`,
				revision: sql`${usageBuckets.revision} + 1`,
				updatedAt: now,
			})
			.where(eq(usageBuckets.id, bucket.id));

		return {
			ok: true,
			reservation: {
				id: reservationId,
				bucketId: bucket.id,
				organizationId: input.organizationId,
				units: input.units,
				state: "reserved",
				includedUnits: bucket.includedUnits,
				committedUnits: bucket.committedUnits,
				reservedUnits: bucket.reservedUnits + input.units,
				periodStart: bucket.periodStart,
				periodEnd: bucket.periodEnd,
			},
		};
	});
}

export async function finalizeMutationUsage(
	db: Database,
	reservation: UsageReservation,
	responseStatus: number,
	now = new Date(),
): Promise<{
	includedUnits: number;
	committedUnits: number;
	reservedUnits: number;
}> {
	return db.transaction(async (tx) => {
		// Reservation and finalization take locks in the same bucket-first order.
		// This also serializes every counter transition for a billing period.
		const [bucket] = await tx
			.select()
			.from(usageBuckets)
			.where(eq(usageBuckets.id, reservation.bucketId))
			.for("update")
			.limit(1);
		const [row] = await tx
			.select()
			.from(usageReservations)
			.where(eq(usageReservations.id, reservation.id))
			.for("update")
			.limit(1);
		if (
			!row ||
			!bucket ||
			row.organizationId !== reservation.organizationId ||
			row.bucketId !== bucket.id
		) {
			throw new Error("Usage reservation disappeared before finalization");
		}
		if (row.state !== "reserved") {
			return {
				includedUnits: bucket.includedUnits,
				committedUnits: bucket.committedUnits,
				reservedUnits: bucket.reservedUnits,
			};
		}

		const commit = responseStatus < 400;
		await tx
			.update(usageReservations)
			.set({
				state: commit ? "committed" : "released",
				responseStatus,
				finalizedAt: now,
			})
			.where(
				and(
					eq(usageReservations.id, reservation.id),
					eq(usageReservations.state, "reserved"),
				),
			);
		await tx
			.update(usageBuckets)
			.set({
				reservedUnits: sql`GREATEST(0, ${usageBuckets.reservedUnits} - ${row.units})`,
				committedUnits: commit
					? sql`${usageBuckets.committedUnits} + ${row.units}`
					: usageBuckets.committedUnits,
				revision: sql`${usageBuckets.revision} + 1`,
				updatedAt: now,
			})
			.where(eq(usageBuckets.id, bucket.id));

		return {
			includedUnits: bucket.includedUnits,
			committedUnits: bucket.committedUnits + (commit ? row.units : 0),
			reservedUnits: Math.max(0, bucket.reservedUnits - row.units),
		};
	});
}
