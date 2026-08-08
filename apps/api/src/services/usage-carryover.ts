import {
	type Database,
	usageReservationCarryovers,
	usageReservations,
} from "@relayapi/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

type UsageTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type UsageCarryoverContribution = {
	pendingUnits: number;
	committedUnits: number;
};

function normalizeCarryoverContribution(input: {
	pendingUnits?: string | number | null;
	committedUnits?: string | number | null;
}): UsageCarryoverContribution {
	const contribution = {
		// postgres returns bigint aggregates as strings while test/in-memory
		// drivers commonly return numbers. Normalize before the safe-integer
		// guard so both paths enforce the same financial bound.
		pendingUnits: Number(input.pendingUnits ?? 0),
		committedUnits: Number(input.committedUnits ?? 0),
	};
	assertCarryoverUnits(contribution.pendingUnits, "Predecessor pending usage");
	assertCarryoverUnits(
		contribution.committedUnits,
		"Predecessor committed usage",
	);
	return contribution;
}

function assertCarryoverUnits(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a nonnegative safe integer`);
	}
}

/**
 * Immutable base allowance minus only terminal predecessor commits. Pending
 * predecessor N is a temporary quota hold, not usage and not overage.
 */
export function effectiveCarryoverAllowance(
	baseIncludedUnits: number | null,
	predecessorCommittedUnits: number,
): number | null {
	assertCarryoverUnits(
		predecessorCommittedUnits,
		"Predecessor committed usage",
	);
	if (baseIncludedUnits === null) return null;
	assertCarryoverUnits(baseIncludedUnits, "Base included usage");
	return Math.max(0, baseIncludedUnits - predecessorCommittedUnits);
}

/** Read the current terminal/pending contribution of every linked source. */
export async function getUsageCarryoverContribution(
	tx: UsageTransaction | Database,
	input: { organizationId: string; successorBucketId: string },
): Promise<UsageCarryoverContribution> {
	const [row] = await tx
		.select({
			pendingUnits: sql<
				string | number
			>`COALESCE(SUM(CASE WHEN ${usageReservations.state} IN ('reserved', 'parked') THEN ${usageReservations.units} ELSE 0 END), 0)::bigint`,
			committedUnits: sql<
				string | number
			>`COALESCE(SUM(CASE WHEN ${usageReservations.state} = 'committed' THEN ${usageReservations.committedUnits} ELSE 0 END), 0)::bigint`,
		})
		.from(usageReservationCarryovers)
		.innerJoin(
			usageReservations,
			and(
				eq(
					usageReservations.id,
					usageReservationCarryovers.sourceReservationId,
				),
				eq(
					usageReservations.organizationId,
					usageReservationCarryovers.organizationId,
				),
			),
		)
		.where(
			and(
				eq(usageReservationCarryovers.organizationId, input.organizationId),
				eq(
					usageReservationCarryovers.successorBucketId,
					input.successorBucketId,
				),
			),
		)
		.limit(1);
	return normalizeCarryoverContribution(row ?? {});
}

/** Read carryover contributions for a bounded page without an N+1 scan. */
export async function getUsageCarryoverContributions(
	tx: UsageTransaction | Database,
	input: { organizationId: string; successorBucketIds: string[] },
): Promise<Map<string, UsageCarryoverContribution>> {
	const successorBucketIds = [...new Set(input.successorBucketIds)];
	if (successorBucketIds.length === 0) return new Map();
	const rows = await tx
		.select({
			successorBucketId: usageReservationCarryovers.successorBucketId,
			pendingUnits: sql<
				string | number
			>`COALESCE(SUM(CASE WHEN ${usageReservations.state} IN ('reserved', 'parked') THEN ${usageReservations.units} ELSE 0 END), 0)::bigint`,
			committedUnits: sql<
				string | number
			>`COALESCE(SUM(CASE WHEN ${usageReservations.state} = 'committed' THEN ${usageReservations.committedUnits} ELSE 0 END), 0)::bigint`,
		})
		.from(usageReservationCarryovers)
		.innerJoin(
			usageReservations,
			and(
				eq(
					usageReservations.id,
					usageReservationCarryovers.sourceReservationId,
				),
				eq(
					usageReservations.organizationId,
					usageReservationCarryovers.organizationId,
				),
			),
		)
		.where(
			and(
				eq(usageReservationCarryovers.organizationId, input.organizationId),
				inArray(
					usageReservationCarryovers.successorBucketId,
					successorBucketIds,
				),
			),
		)
		.groupBy(usageReservationCarryovers.successorBucketId);
	return new Map(
		rows.map((row) => [
			row.successorBucketId,
			normalizeCarryoverContribution(row),
		]),
	);
}

/**
 * Link every unresolved reservation in the provider cycle to a new successor.
 * Callers hold every source bucket lock, so a source cannot terminalize between
 * this selection and edge insertion. The composite key supports a reservation
 * that remains unresolved across more than one later split.
 */
export async function createUsageReservationCarryovers(
	tx: UsageTransaction,
	input: {
		organizationId: string;
		sourceBucketIds: string[];
		successorBucketId: string;
	},
): Promise<number> {
	if (input.sourceBucketIds.length === 0) return 0;
	const sources = await tx
		.select({ id: usageReservations.id })
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.organizationId, input.organizationId),
				inArray(usageReservations.bucketId, input.sourceBucketIds),
				inArray(usageReservations.state, ["reserved", "parked"]),
			),
		)
		.orderBy(asc(usageReservations.id))
		.for("update");
	if (sources.length === 0) return 0;
	const inserted = await tx
		.insert(usageReservationCarryovers)
		.values(
			sources.map((source) => ({
				sourceReservationId: source.id,
				organizationId: input.organizationId,
				successorBucketId: input.successorBucketId,
			})),
		)
		.onConflictDoNothing()
		.returning({
			sourceReservationId: usageReservationCarryovers.sourceReservationId,
		});
	return inserted.length;
}
