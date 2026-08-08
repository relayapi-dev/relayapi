import {
	dailyToolLimitForPlan,
	getBillingPolicy,
	PRICING,
} from "@relayapi/config";
import {
	adCreationOperations,
	adMutationOperations,
	billingPeriods,
	type Database,
	generateId,
	toolJobs,
	usageBuckets,
	usageReservationCarryovers,
	usageReservations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { ensureHostedFreeUsageAuthorityInTransaction } from "./billing-periods";
import { lockOrganizationSubscription } from "./subscription-authority";
import {
	effectiveCarryoverAllowance,
	getUsageCarryoverContribution,
} from "./usage-carryover";

const METRIC = "successful_mutation";
const DAILY_TOOL_METRIC = "tool_invocation";
const STALE_RESERVATION_MS = 15 * 60_000;
export const PARKED_USAGE_WRITE_OFF_AFTER_MS = 30 * 24 * 60 * 60_000;
export const PARKED_USAGE_WRITE_OFF_REASON =
	"provider_outcome_unresolved_after_30_days";
const PARKED_USAGE_WRITE_OFF_POLICY = "parked_usage_30_day_write_off_v1";
const DEFAULT_STALE_RECONCILIATION_BATCH_SIZE = 100;
const DEFAULT_PARKED_WRITE_OFF_BATCH_SIZE = 100;
export const MAX_SAFE_USAGE_UNITS = Number.MAX_SAFE_INTEGER;

type UsageTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

function durableOperationUsageOwnerAbsent() {
	return sql`NOT EXISTS (
			SELECT 1 FROM ${adCreationOperations} AS ad_create_owner
			 WHERE ad_create_owner.usage_reservation_id = ${usageReservations.id}
			   AND ad_create_owner.organization_id = ${usageReservations.organizationId}
		)
		AND NOT EXISTS (
			SELECT 1 FROM ${adMutationOperations} AS ad_mutation_owner
			 WHERE ad_mutation_owner.usage_reservation_id = ${usageReservations.id}
			   AND ad_mutation_owner.organization_id = ${usageReservations.organizationId}
		)
		AND NOT EXISTS (
			SELECT 1 FROM ${whatsappPhoneProvisioningOperations} AS phone_provision_owner
			 WHERE phone_provision_owner.usage_reservation_id = ${usageReservations.id}
			   AND phone_provision_owner.organization_id = ${usageReservations.organizationId}
		)
		AND NOT EXISTS (
			SELECT 1 FROM ${whatsappPhoneReleaseOperations} AS phone_release_owner
			 WHERE phone_release_owner.usage_reservation_id = ${usageReservations.id}
			   AND phone_release_owner.organization_id = ${usageReservations.organizationId}
		)`;
}

/**
 * Cost attribution is decided from durable outcome evidence, not merely the
 * final HTTP status. An ambiguous provider/local outcome stays parked at N
 * until reconciliation establishes K (or an audited write-off establishes 0).
 */
export type UsageDisposition =
	| {
			commit: false;
			reason: "pre_boundary";
			responseStatus: number;
			committedUnits?: 0;
	  }
	| {
			commit: false;
			reason: "rejected";
			responseStatus: number;
			committedUnits?: 0;
	  }
	| {
			commit: false;
			reason: "proven_not_applied";
			responseStatus: number;
			committedUnits?: 0;
	  }
	| {
			commit: true;
			reason: "settled";
			responseStatus: number | null;
			/** Defaults to the full reservation for single-unit/existing callers. */
			committedUnits?: number;
	  }
	| {
			commit: true;
			reason: "unknown";
			responseStatus: null;
	  };

export type PersistedUsageOutcome = {
	state: "parked" | "committed" | "released";
	disposition:
		| "pre_boundary"
		| "rejected"
		| "proven_not_applied"
		| "settled"
		| "unknown";
	responseStatus: number | null;
	committedUnits: number | null;
};

function assertSafeUsageUnits(
	value: number,
	label: string,
	options: { positive?: boolean } = {},
): void {
	if (
		!Number.isSafeInteger(value) ||
		(options.positive ? value <= 0 : value < 0)
	) {
		throw new Error(
			`${label} must be a ${options.positive ? "positive" : "nonnegative"} safe integer`,
		);
	}
}

function safeUsageSum(label: string, ...values: number[]): number {
	let total = 0;
	for (const value of values) {
		assertSafeUsageUnits(value, label);
		total += value;
		if (!Number.isSafeInteger(total)) {
			throw new Error(`${label} exceeds Number.MAX_SAFE_INTEGER`);
		}
	}
	return total;
}

/**
 * Durable boundary evidence always wins over request-local disposition. A
 * callback can lose its response after PostgreSQL commits, so a caller that
 * still believes it is pre-boundary must not release an armed reservation.
 */
export function persistedUsageOutcome(
	requestMayHaveBeenSentAt: Date | null,
	disposition: UsageDisposition,
	reservedUnits: number,
): PersistedUsageOutcome {
	assertSafeUsageUnits(reservedUnits, "Reserved usage units", {
		positive: true,
	});
	if (!disposition.commit && disposition.reason === "proven_not_applied") {
		if (disposition.responseStatus < 500 || disposition.responseStatus > 599) {
			throw new Error(
				"Proven-not-applied usage evidence requires a 5xx response status",
			);
		}
		return {
			state: "released",
			disposition: "proven_not_applied",
			responseStatus: disposition.responseStatus,
			committedUnits: 0,
		};
	}
	if (
		requestMayHaveBeenSentAt &&
		!disposition.commit &&
		disposition.reason === "pre_boundary"
	) {
		return {
			state: "parked",
			disposition: "unknown",
			responseStatus: null,
			committedUnits: null,
		};
	}
	if (disposition.commit && disposition.reason === "unknown") {
		return {
			state: "parked",
			disposition: "unknown",
			responseStatus: null,
			committedUnits: null,
		};
	}
	if (disposition.commit) {
		const committedUnits = disposition.committedUnits ?? reservedUnits;
		assertSafeUsageUnits(committedUnits, "Committed usage units");
		if (committedUnits > reservedUnits) {
			throw new Error("Committed usage units cannot exceed reserved units");
		}
		return {
			state: "committed",
			disposition: "settled",
			responseStatus: disposition.responseStatus,
			committedUnits,
		};
	}
	return {
		state: "released",
		disposition: disposition.reason,
		responseStatus: disposition.responseStatus,
		committedUnits: 0,
	};
}

export function staleUsageReservationOutcome(
	requestMayHaveBeenSentAt: Date | null,
): PersistedUsageOutcome {
	return requestMayHaveBeenSentAt
		? {
				state: "parked",
				disposition: "unknown",
				responseStatus: null,
				committedUnits: null,
			}
		: {
				state: "released",
				disposition: "pre_boundary",
				responseStatus: null,
				committedUnits: 0,
			};
}

export function isParkedUsageWriteOffDue(
	reservedAt: Date,
	requestMayHaveBeenSentAt: Date,
	now = new Date(),
): boolean {
	const cutoff = now.getTime() - PARKED_USAGE_WRITE_OFF_AFTER_MS;
	return (
		reservedAt.getTime() <= cutoff &&
		requestMayHaveBeenSentAt.getTime() <= cutoff
	);
}

/**
 * Globally converge crashed reservations even when their original bucket is no
 * longer selected after a plan split. Discovery is bounded and due-ordered;
 * each candidate is rechecked under the canonical bucket-before-reservation
 * lock order. Live tool jobs retain ownership of their reservation lifecycle.
 */
export async function reconcileStaleReservedUsageReservations(
	db: Database,
	batchSize = DEFAULT_STALE_RECONCILIATION_BATCH_SIZE,
	now = new Date(),
	organizationId?: string,
): Promise<{ released: number; parked: number }> {
	if (!Number.isFinite(now.getTime())) {
		throw new Error(
			"Stale usage reconciliation requires a valid application time",
		);
	}
	const normalizedBatchSize = Number.isFinite(batchSize)
		? Math.trunc(batchSize)
		: DEFAULT_STALE_RECONCILIATION_BATCH_SIZE;
	const limit = Math.min(Math.max(normalizedBatchSize, 1), 500);
	const cutoff = new Date(now.getTime() - STALE_RESERVATION_MS);
	const liveToolJobAbsent = sql`NOT EXISTS (
		SELECT 1
		  FROM ${toolJobs} AS live_tool_job
		 WHERE live_tool_job.usage_reservation_id = ${usageReservations.id}
		   AND live_tool_job.organization_id = ${usageReservations.organizationId}
		   AND live_tool_job.status IN ('pending', 'processing')
	)`;
	const durableOwnerAbsent = durableOperationUsageOwnerAbsent();
	const candidates = await db
		.select({
			id: usageReservations.id,
			organizationId: usageReservations.organizationId,
			bucketId: usageReservations.bucketId,
		})
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.state, "reserved"),
				lte(usageReservations.reservedAt, cutoff),
				liveToolJobAbsent,
				durableOwnerAbsent,
				organizationId
					? eq(usageReservations.organizationId, organizationId)
					: undefined,
			),
		)
		.orderBy(asc(usageReservations.reservedAt), asc(usageReservations.id))
		.limit(limit);

	let released = 0;
	let parked = 0;
	for (const candidate of candidates) {
		try {
			const state = await db.transaction(async (tx) => {
				const [bucket] = await tx
					.select({ id: usageBuckets.id })
					.from(usageBuckets)
					.where(
						and(
							eq(usageBuckets.id, candidate.bucketId),
							eq(usageBuckets.organizationId, candidate.organizationId),
						),
					)
					.for("update")
					.limit(1);
				if (!bucket) return null;

				const [reservation] = await tx
					.select({
						id: usageReservations.id,
						requestMayHaveBeenSentAt:
							usageReservations.requestMayHaveBeenSentAt,
					})
					.from(usageReservations)
					.where(
						and(
							eq(usageReservations.id, candidate.id),
							eq(usageReservations.organizationId, candidate.organizationId),
							eq(usageReservations.bucketId, candidate.bucketId),
							eq(usageReservations.state, "reserved"),
							lte(usageReservations.reservedAt, cutoff),
							liveToolJobAbsent,
							durableOwnerAbsent,
						),
					)
					.for("update")
					.limit(1);
				if (!reservation) return null;
				const outcome = staleUsageReservationOutcome(
					reservation.requestMayHaveBeenSentAt,
				);
				const rows = await tx
					.update(usageReservations)
					.set({
						state: outcome.state,
						disposition: outcome.disposition,
						committedUnits: outcome.committedUnits,
						responseStatus: outcome.responseStatus,
						finalizedAt: outcome.state === "released" ? now : null,
					})
					.where(
						and(
							eq(usageReservations.id, reservation.id),
							eq(usageReservations.state, "reserved"),
							lte(usageReservations.reservedAt, cutoff),
							liveToolJobAbsent,
							durableOwnerAbsent,
						),
					)
					.returning({ state: usageReservations.state });
				return rows[0]?.state ?? null;
			});
			if (state === "released") released += 1;
			if (state === "parked") parked += 1;
		} catch (error) {
			console.error("Failed to reconcile stale usage reservation", {
				reservationId: candidate.id,
				organizationId: candidate.organizationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { released, parked };
}

/**
 * Release provider-boundary reservations whose outcome stayed unknowable for
 * the full policy horizon. Discovery is bounded and due-ordered, while every
 * transition re-locks bucket then reservation and compare-and-sets the parked
 * shape. A late definitive reconciler uses the same lock order, so exactly one
 * outcome can win.
 */
export async function writeOffExpiredParkedUsageReservations(
	db: Database,
	batchSize = DEFAULT_PARKED_WRITE_OFF_BATCH_SIZE,
	now = new Date(),
	organizationId?: string,
): Promise<number> {
	if (!Number.isFinite(now.getTime())) {
		throw new Error("Parked usage write-off requires a valid application time");
	}
	const normalizedBatchSize = Number.isFinite(batchSize)
		? Math.trunc(batchSize)
		: DEFAULT_PARKED_WRITE_OFF_BATCH_SIZE;
	const limit = Math.min(Math.max(normalizedBatchSize, 1), 500);
	const cutoff = new Date(now.getTime() - PARKED_USAGE_WRITE_OFF_AFTER_MS);
	const durableOwnerAbsent = durableOperationUsageOwnerAbsent();
	const candidates = await db
		.select({
			id: usageReservations.id,
			organizationId: usageReservations.organizationId,
			bucketId: usageReservations.bucketId,
		})
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.state, "parked"),
				eq(usageReservations.disposition, "unknown"),
				lte(usageReservations.reservedAt, cutoff),
				lte(usageReservations.requestMayHaveBeenSentAt, cutoff),
				durableOwnerAbsent,
				organizationId
					? eq(usageReservations.organizationId, organizationId)
					: undefined,
			),
		)
		.orderBy(asc(usageReservations.reservedAt), asc(usageReservations.id))
		.limit(limit);

	let writtenOff = 0;
	for (const candidate of candidates) {
		try {
			const updated = await db.transaction(async (tx) => {
				const [bucket] = await tx
					.select({ id: usageBuckets.id })
					.from(usageBuckets)
					.where(
						and(
							eq(usageBuckets.id, candidate.bucketId),
							eq(usageBuckets.organizationId, candidate.organizationId),
						),
					)
					.for("update")
					.limit(1);
				if (!bucket) return false;

				const [reservation] = await tx
					.select({
						id: usageReservations.id,
						units: usageReservations.units,
						reservedAt: usageReservations.reservedAt,
						requestMayHaveBeenSentAt:
							usageReservations.requestMayHaveBeenSentAt,
					})
					.from(usageReservations)
					.where(
						and(
							eq(usageReservations.id, candidate.id),
							eq(usageReservations.organizationId, candidate.organizationId),
							eq(usageReservations.bucketId, candidate.bucketId),
							eq(usageReservations.state, "parked"),
							eq(usageReservations.disposition, "unknown"),
							lte(usageReservations.reservedAt, cutoff),
							lte(usageReservations.requestMayHaveBeenSentAt, cutoff),
							durableOwnerAbsent,
						),
					)
					.for("update")
					.limit(1);
				if (
					!reservation?.requestMayHaveBeenSentAt ||
					!isParkedUsageWriteOffDue(
						reservation.reservedAt,
						reservation.requestMayHaveBeenSentAt,
						now,
					)
				) {
					return false;
				}
				assertSafeUsageUnits(reservation.units, "Parked usage units", {
					positive: true,
				});

				const writtenOffAt = now;
				const writeOffEvidence = {
					schema_version: 1,
					policy: PARKED_USAGE_WRITE_OFF_POLICY,
					decision: "release_without_charge",
					reason_code: PARKED_USAGE_WRITE_OFF_REASON,
					minimum_age_days: 30,
					age_anchor: "request_boundary_at",
					reservation_id: reservation.id,
					reserved_units: reservation.units,
					reserved_at: reservation.reservedAt.toISOString(),
					request_boundary_at:
						reservation.requestMayHaveBeenSentAt.toISOString(),
					cutoff_at: cutoff.toISOString(),
					written_off_at: writtenOffAt.toISOString(),
				};
				const rows = await tx
					.update(usageReservations)
					.set({
						state: "released",
						disposition: "written_off",
						committedUnits: 0,
						responseStatus: null,
						writeOffReason: PARKED_USAGE_WRITE_OFF_REASON,
						writeOffEvidence,
						writtenOffAt,
						finalizedAt: writtenOffAt,
					})
					.where(
						and(
							eq(usageReservations.id, reservation.id),
							eq(usageReservations.organizationId, candidate.organizationId),
							eq(usageReservations.bucketId, candidate.bucketId),
							eq(usageReservations.state, "parked"),
							eq(usageReservations.disposition, "unknown"),
							lte(usageReservations.reservedAt, cutoff),
							lte(usageReservations.requestMayHaveBeenSentAt, cutoff),
							isNull(usageReservations.writtenOffAt),
							isNull(usageReservations.finalizedAt),
							durableOwnerAbsent,
						),
					)
					.returning({ id: usageReservations.id });
				return rows.length === 1;
			});
			writtenOff += updated ? 1 : 0;
		} catch (error) {
			console.error("Failed to write off expired parked usage reservation", {
				reservationId: candidate.id,
				organizationId: candidate.organizationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return writtenOff;
}

export function successfulMutationDisposition(
	responseStatus: number,
	committedUnits = responseStatus < 400 ? 1 : 0,
): UsageDisposition {
	assertSafeUsageUnits(committedUnits, "Committed usage units");
	return responseStatus < 400
		? { commit: true, reason: "settled", responseStatus, committedUnits }
		: {
				commit: false,
				reason: "rejected",
				responseStatus,
				committedUnits: 0,
			};
}

export type UsageReservation = {
	id: string;
	bucketId: string;
	organizationId: string;
	units: number;
	state: "reserved" | "parked" | "committed";
	quotaMode: "hard" | "metered" | "unlimited";
	includedUnits: number | null;
	committedUnits: number;
	reservedUnits: number;
	periodStart: Date;
	periodEnd: Date;
};

export type UsageReservationReference = Pick<
	UsageReservation,
	"id" | "bucketId" | "organizationId"
>;

/**
 * Durable operations can outlive the HTTP request that reserved their usage.
 * This transition is their canonical settlement path: `null` preserves N as
 * parked while the provider outcome is unresolved, and an exact K terminalizes
 * the reservation. K=0 is a successful idempotent/no-effect settlement, not an
 * unaudited release, so a retry can never be charged twice.
 */
export async function settleDurableUsageReservationInTransaction(
	tx: UsageTransaction,
	input: {
		reservationId: string;
		organizationId: string;
		committedUnits: number | null;
	},
	now = new Date(),
): Promise<"parked" | "committed" | "released"> {
	if (input.committedUnits !== null) {
		assertSafeUsageUnits(input.committedUnits, "Committed usage units");
	}
	const [candidate] = await tx
		.select({ bucketId: usageReservations.bucketId })
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.id, input.reservationId),
				eq(usageReservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!candidate) throw new Error("Durable usage reservation was not found");
	const [bucket] = await tx
		.select({ id: usageBuckets.id })
		.from(usageBuckets)
		.where(
			and(
				eq(usageBuckets.id, candidate.bucketId),
				eq(usageBuckets.organizationId, input.organizationId),
			),
		)
		.for("update")
		.limit(1);
	const [reservation] = await tx
		.select()
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.id, input.reservationId),
				eq(usageReservations.organizationId, input.organizationId),
				eq(usageReservations.bucketId, candidate.bucketId),
			),
		)
		.for("update")
		.limit(1);
	if (!bucket || !reservation) {
		throw new Error("Durable usage reservation authority disappeared");
	}
	if (
		input.committedUnits !== null &&
		input.committedUnits > reservation.units
	) {
		throw new Error("Committed usage units cannot exceed reserved units");
	}

	if (reservation.state === "committed") {
		if (
			input.committedUnits !== null &&
			reservation.committedUnits !== input.committedUnits
		) {
			throw new Error("Durable usage settlement conflicts with terminal K");
		}
		return "committed";
	}
	if (reservation.state === "released") {
		if (input.committedUnits !== null && input.committedUnits > 0) {
			throw new Error(
				"Durable operation succeeded after its usage reservation was released",
			);
		}
		return "released";
	}
	if (input.committedUnits === null) {
		if (reservation.state === "parked") return "parked";
		const [parked] = await tx
			.update(usageReservations)
			.set({
				state: "parked",
				disposition: "unknown",
				committedUnits: null,
				responseStatus: null,
				requestMayHaveBeenSentAt: reservation.requestMayHaveBeenSentAt ?? now,
				finalizedAt: null,
			})
			.where(
				and(
					eq(usageReservations.id, reservation.id),
					eq(usageReservations.state, "reserved"),
				),
			)
			.returning({ state: usageReservations.state });
		if (!parked) throw new Error("Durable usage park fence was lost");
		return "parked";
	}

	const [committed] = await tx
		.update(usageReservations)
		.set({
			state: "committed",
			disposition: "settled",
			committedUnits: input.committedUnits,
			responseStatus: 200,
			writeOffReason: null,
			writeOffEvidence: null,
			writtenOffAt: null,
			finalizedAt: now,
		})
		.where(
			and(
				eq(usageReservations.id, reservation.id),
				inArray(usageReservations.state, ["reserved", "parked"]),
			),
		)
		.returning({ state: usageReservations.state });
	if (!committed) throw new Error("Durable usage settlement fence was lost");
	return "committed";
}

export async function settleDurableUsageReservation(
	db: Database,
	input: {
		reservationId: string;
		organizationId: string;
		committedUnits: number | null;
	},
	now = new Date(),
): Promise<"parked" | "committed" | "released"> {
	return db.transaction((tx) =>
		settleDurableUsageReservationInTransaction(tx, input, now),
	);
}

type UsageReservationAttemptDecision =
	| { ok: true; reservation: UsageReservation }
	| {
			ok: false;
			quotaMode: "hard" | "metered" | "unlimited";
			includedUnits: number | null;
			committedUnits: number;
			reservedUnits: number;
	  };

/**
 * `selfHealed` tells the request layer that the API-key cache carried stale
 * billing authority. PostgreSQL has already used the current authority, but
 * the derivative cache must be deleted so the next request rehydrates it.
 */
export type UsageReservationDecision = UsageReservationAttemptDecision & {
	selfHealed: boolean;
};

type MutationUsageInput = {
	organizationId: string;
	idempotencyKey: string;
	units: number;
	metric?: string;
	quotaMode: "hard" | "metered" | "unlimited";
	includedUnits: number | null;
	periodStart: Date;
	periodEnd: Date;
	/** Pre-created immutable authority for subscription-backed usage. */
	billingPeriodId?: string | null;
	/**
	 * Hosted Pro requests must carry an exact immutable period/bucket pair.
	 * `pending` is a typed fail-closed state and must never create a provisional
	 * null-billing-period bucket.
	 */
	billingAuthorityState?: "ready" | "pending";
	source?: string;
	now?: Date;
};

export type DailyToolUsageInput = {
	organizationId: string;
	idempotencyKey: string;
	units: number;
	/**
	 * The edge-cached effective limit. NULL is reserved for self-hosted
	 * unlimited mode; hosted requests re-resolve authority from PostgreSQL.
	 */
	cachedLimit: number | null;
	source?: string;
	now?: Date;
};

export type SuccessfulMutationAuthority = Pick<
	MutationUsageInput,
	| "quotaMode"
	| "includedUnits"
	| "periodStart"
	| "periodEnd"
	| "billingPeriodId"
>;

export type SuccessfulMutationAuthoritySnapshot =
	SuccessfulMutationAuthority & {
		plan: "free" | "pro";
		billingSource: "stripe" | "complimentary" | "free";
		billable: boolean;
		basePriceCents: number;
		pricePerThousandUnitsCents: number | null;
		subscriptionStatus: "trialing" | "active" | "past_due" | "cancelled";
		bucketId: string | null;
		committedUnits: number;
		reservedUnits: number;
		carryoverCommittedUnits: number;
		carryoverPendingUnits: number;
	};

export type SuccessfulMutationAuthorityResolution =
	| {
			state: "ready";
			authority: SuccessfulMutationAuthoritySnapshot;
	  }
	| {
			state: "pending";
			plan: "pro";
			billingSource: "stripe" | "complimentary";
			subscriptionStatus: "trialing" | "active" | "past_due";
			reason: "missing_or_mismatched_billing_period";
	  };

export class BillingAuthorityPendingError extends Error {
	readonly code = "BILLING_AUTHORITY_PENDING";

	constructor(readonly organizationId: string) {
		super("Hosted Pro usage authority is pending canonical reconciliation");
		this.name = "BillingAuthorityPendingError";
	}
}

class BillingAuthorityMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BillingAuthorityMismatchError";
	}
}

function assertUsageAuthorityShape(input: MutationUsageInput): void {
	assertSafeUsageUnits(input.units, "Usage reservation units", {
		positive: true,
	});
	if ((input.quotaMode === "unlimited") !== (input.includedUnits === null)) {
		throw new Error(
			"Unlimited usage requires a null allowance; bounded usage requires an allowance",
		);
	}
	if (input.includedUnits !== null) {
		assertSafeUsageUnits(input.includedUnits, "Included usage units");
	}
}

function calendarMonth(at: Date): { periodStart: Date; periodEnd: Date } {
	return {
		periodStart: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
		periodEnd: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)),
	};
}

function utcDay(at: Date): { periodStart: Date; periodEnd: Date } {
	const periodStart = new Date(
		Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
	);
	return {
		periodStart,
		periodEnd: new Date(periodStart.getTime() + 24 * 60 * 60 * 1000),
	};
}

/**
 * Resolve usage from live subscription entitlement and an exact period/bucket
 * pair. Pro never falls through to a calendar or null-period bucket: a missing
 * or mismatched immutable authority is returned as a typed pending state.
 *
 * The resolver update-locks the subscription and performs any hosted Free
 * transition in the same transaction. A concurrent provider/admin projection
 * therefore linearizes wholly before or after this authoritative read.
 */
export async function resolveSuccessfulMutationAuthority(
	db: Database,
	organizationId: string,
	now = new Date(),
	options: { includeUsageSnapshot?: boolean } = {},
): Promise<SuccessfulMutationAuthorityResolution> {
	return db.transaction(async (tx) => {
		const subscription = await lockOrganizationSubscription(
			tx,
			organizationId,
			"update",
		);
		const policy = getBillingPolicy(subscription, now);
		if (policy.entitlement === "free") {
			await ensureHostedFreeUsageAuthorityInTransaction(
				tx,
				{ organizationId, now },
				subscription,
			);
		}
		const [currentBillingAuthority] = await tx
			.select({
				billingPeriodId: billingPeriods.id,
				source: billingPeriods.source,
				billable: billingPeriods.billable,
				providerCycleAnchor: billingPeriods.providerCycleAnchor,
				stripeSubscriptionId: billingPeriods.stripeSubscriptionId,
				periodStart: billingPeriods.periodStart,
				periodEnd: billingPeriods.periodEnd,
				quotaMode: billingPeriods.quotaMode,
				includedUnits: billingPeriods.includedUnits,
				basePriceCents: billingPeriods.basePriceCents,
				pricePerThousandUnitsCents: billingPeriods.pricePerThousandUnitsCents,
				bucketId: usageBuckets.id,
				committedUnits: usageBuckets.committedUnits,
				reservedUnits: usageBuckets.reservedUnits,
				bucketPeriodStart: usageBuckets.periodStart,
				bucketPeriodEnd: usageBuckets.periodEnd,
				bucketQuotaMode: usageBuckets.quotaMode,
				bucketIncludedUnits: usageBuckets.includedUnits,
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
					eq(billingPeriods.state, "open"),
					lte(billingPeriods.periodStart, now),
					gt(billingPeriods.periodEnd, now),
					eq(usageBuckets.metric, METRIC),
				),
			)
			.orderBy(desc(billingPeriods.periodStart))
			.for("share", { of: usageBuckets })
			.limit(1);

		if (policy.entitlement === "pro") {
			const exactStripeAuthority =
				subscription.source !== "stripe" ||
				(Boolean(subscription.stripeSubscriptionId) &&
					currentBillingAuthority?.stripeSubscriptionId ===
						subscription.stripeSubscriptionId &&
					Boolean(subscription.currentPeriodStart) &&
					currentBillingAuthority.providerCycleAnchor.getTime() ===
						subscription.currentPeriodStart?.getTime() &&
					Boolean(subscription.currentPeriodEnd) &&
					currentBillingAuthority.periodEnd.getTime() ===
						subscription.currentPeriodEnd?.getTime());
			const exactAuthority = Boolean(
				currentBillingAuthority &&
					currentBillingAuthority.source === subscription.source &&
					currentBillingAuthority.billable === policy.billable &&
					currentBillingAuthority.quotaMode === policy.quotaMode &&
					currentBillingAuthority.bucketPeriodStart.getTime() ===
						currentBillingAuthority.periodStart.getTime() &&
					currentBillingAuthority.bucketPeriodEnd.getTime() ===
						currentBillingAuthority.periodEnd.getTime() &&
					currentBillingAuthority.bucketQuotaMode ===
						currentBillingAuthority.quotaMode &&
					currentBillingAuthority.bucketIncludedUnits ===
						currentBillingAuthority.includedUnits &&
					exactStripeAuthority,
			);
			if (!currentBillingAuthority || !exactAuthority) {
				return {
					state: "pending",
					plan: "pro",
					billingSource: subscription.source,
					subscriptionStatus: subscription.status as
						| "trialing"
						| "active"
						| "past_due",
					reason: "missing_or_mismatched_billing_period",
				};
			}
			const carryover =
				options.includeUsageSnapshot === false
					? { committedUnits: 0, pendingUnits: 0 }
					: await getUsageCarryoverContribution(tx, {
							organizationId,
							successorBucketId: currentBillingAuthority.bucketId,
						});
			return {
				state: "ready",
				authority: {
					plan: "pro",
					billingSource: currentBillingAuthority.source,
					billable: currentBillingAuthority.billable,
					subscriptionStatus: subscription.status,
					billingPeriodId: currentBillingAuthority.billingPeriodId,
					periodStart: currentBillingAuthority.periodStart,
					periodEnd: currentBillingAuthority.periodEnd,
					quotaMode: currentBillingAuthority.quotaMode,
					includedUnits: currentBillingAuthority.includedUnits,
					basePriceCents: currentBillingAuthority.basePriceCents,
					pricePerThousandUnitsCents:
						currentBillingAuthority.pricePerThousandUnitsCents,
					bucketId: currentBillingAuthority.bucketId,
					committedUnits: currentBillingAuthority.committedUnits,
					reservedUnits: currentBillingAuthority.reservedUnits,
					carryoverCommittedUnits: carryover.committedUnits,
					carryoverPendingUnits: carryover.pendingUnits,
				},
			};
		}

		const month = calendarMonth(now);
		const [latestPaidBoundary] = await tx
			.select({ periodEnd: usageBuckets.periodEnd })
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.organizationId, organizationId),
					eq(usageBuckets.metric, METRIC),
					isNotNull(usageBuckets.billingPeriodId),
					gt(usageBuckets.periodEnd, month.periodStart),
					lte(usageBuckets.periodEnd, now),
				),
			)
			.orderBy(desc(usageBuckets.periodEnd))
			.limit(1);

		const [currentFreeBucket] = await tx
			.select({
				id: usageBuckets.id,
				periodStart: usageBuckets.periodStart,
				periodEnd: usageBuckets.periodEnd,
				quotaMode: usageBuckets.quotaMode,
				includedUnits: usageBuckets.includedUnits,
				committedUnits: usageBuckets.committedUnits,
				reservedUnits: usageBuckets.reservedUnits,
			})
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.organizationId, organizationId),
					eq(usageBuckets.metric, METRIC),
					isNull(usageBuckets.billingPeriodId),
					lte(usageBuckets.periodStart, now),
					gt(usageBuckets.periodEnd, now),
				),
			)
			.orderBy(desc(usageBuckets.periodStart))
			.for("update")
			.limit(1);

		let freeAuthority: SuccessfulMutationAuthority;
		let resolvedFreeBucket: typeof currentFreeBucket | null = null;
		if (
			currentFreeBucket &&
			(!latestPaidBoundary ||
				currentFreeBucket.periodStart >= latestPaidBoundary.periodEnd)
		) {
			resolvedFreeBucket = currentFreeBucket;
			if (
				currentFreeBucket.quotaMode !== "hard" ||
				currentFreeBucket.includedUnits !== PRICING.freeCallsIncluded
			) {
				await tx
					.update(usageBuckets)
					.set({
						quotaMode: "hard",
						includedUnits: PRICING.freeCallsIncluded,
						updatedAt: now,
					})
					.where(eq(usageBuckets.id, currentFreeBucket.id));
			}
			freeAuthority = {
				billingPeriodId: null,
				periodStart: currentFreeBucket.periodStart,
				periodEnd: currentFreeBucket.periodEnd,
				quotaMode: "hard",
				includedUnits: PRICING.freeCallsIncluded,
			};
		} else {
			freeAuthority = {
				billingPeriodId: null,
				quotaMode: "hard",
				includedUnits: PRICING.freeCallsIncluded,
				periodStart: latestPaidBoundary?.periodEnd ?? month.periodStart,
				periodEnd: month.periodEnd,
			};
		}

		const freeCarryover =
			resolvedFreeBucket && options.includeUsageSnapshot !== false
				? await getUsageCarryoverContribution(tx, {
						organizationId,
						successorBucketId: resolvedFreeBucket.id,
					})
				: { committedUnits: 0, pendingUnits: 0 };
		return {
			state: "ready",
			authority: {
				...freeAuthority,
				plan: "free",
				billingSource: "free",
				billable: false,
				basePriceCents: 0,
				pricePerThousandUnitsCents: null,
				subscriptionStatus: subscription.status,
				bucketId: resolvedFreeBucket?.id ?? null,
				committedUnits: resolvedFreeBucket?.committedUnits ?? 0,
				reservedUnits: resolvedFreeBucket?.reservedUnits ?? 0,
				carryoverCommittedUnits: freeCarryover.committedUnits,
				carryoverPendingUnits: freeCarryover.pendingUnits,
			},
		};
	});
}

async function resolveHostedDailyToolLimit(
	tx: UsageTransaction,
	organizationId: string,
	now: Date,
): Promise<number> {
	const subscription = await lockOrganizationSubscription(
		tx,
		organizationId,
		"share",
	);
	const plan = getBillingPolicy(
		{
			status: subscription.status,
			source: subscription.source,
			stripeSubscriptionId: subscription.stripeSubscriptionId,
			trialEndsAt: subscription.trialEndsAt,
			delinquentAt: subscription.delinquentAt,
			graceEndsAt: subscription.graceEndsAt,
			currentPeriodStart: subscription.currentPeriodStart,
			currentPeriodEnd: subscription.currentPeriodEnd,
		},
		now,
	).entitlement;
	return dailyToolLimitForPlan(plan, subscription.dailyToolLimitOverride);
}

/**
 * Reserve one cost-bearing tools invocation against fresh PostgreSQL
 * entitlement authority. The API-key cache is display/fast-path data only:
 * hosted enforcement never trusts it for a provider-cost boundary.
 *
 * The subscription row is share-locked before the daily bucket, while every
 * entitlement writer takes an UPDATE lock on that same subscription row. A
 * concurrent plan/override change therefore linearizes entirely before or
 * after this reservation. The bucket allowance is safely rebased under its row
 * lock so upgrades, downgrades, and override resets take effect on the current
 * UTC day without creating overlapping buckets or discarding usage.
 */
export async function reserveDailyToolUsage(
	db: Database,
	input: DailyToolUsageInput,
): Promise<UsageReservationDecision> {
	assertSafeUsageUnits(input.units, "Usage reservation units", {
		positive: true,
	});
	if (
		input.cachedLimit !== null &&
		(!Number.isSafeInteger(input.cachedLimit) || input.cachedLimit < 0)
	) {
		throw new Error("Cached daily tool limit must be a nonnegative integer");
	}
	const now = input.now ?? new Date();
	const period = utcDay(now);

	// Self-hosted mode is deliberately unlimited and has no hosted
	// subscription authority to resolve.
	if (input.cachedLimit === null) {
		return db.transaction(async (tx) => {
			const decision = await reserveMutationUsageInTransaction(
				tx,
				{
					organizationId: input.organizationId,
					idempotencyKey: input.idempotencyKey,
					units: input.units,
					metric: DAILY_TOOL_METRIC,
					quotaMode: "unlimited",
					includedUnits: null,
					...period,
					source: input.source,
					now,
				},
				now,
				{ allowDailyToolAuthorityRebase: true },
			);
			return { ...decision, selfHealed: false };
		});
	}

	return db.transaction(async (tx) => {
		const authoritativeLimit = await resolveHostedDailyToolLimit(
			tx,
			input.organizationId,
			now,
		);
		const decision = await reserveMutationUsageInTransaction(
			tx,
			{
				organizationId: input.organizationId,
				idempotencyKey: input.idempotencyKey,
				units: input.units,
				metric: DAILY_TOOL_METRIC,
				quotaMode: "hard",
				includedUnits: authoritativeLimit,
				...period,
				source: input.source,
				now,
			},
			now,
			{ allowDailyToolAuthorityRebase: true },
		);
		return {
			...decision,
			selfHealed: input.cachedLimit !== authoritativeLimit,
		};
	});
}

export async function reserveMutationUsage(
	db: Database,
	input: MutationUsageInput,
): Promise<UsageReservationDecision> {
	const now = input.now ?? new Date();
	assertUsageAuthorityShape(input);
	if (input.billingAuthorityState === "pending") {
		throw new BillingAuthorityPendingError(input.organizationId);
	}
	const metric = input.metric ?? METRIC;

	try {
		const decision = await reserveMutationUsageOnce(db, input, now);
		return { ...decision, selfHealed: false };
	} catch (error) {
		if (
			!(error instanceof BillingAuthorityMismatchError) ||
			metric !== METRIC
		) {
			throw error;
		}

		// The thrown mismatch rolled back the first transaction, so no stale
		// bucket lock is held while this lookup resolves the current bucket.
		const resolution = await resolveSuccessfulMutationAuthority(
			db,
			input.organizationId,
			now,
			{ includeUsageSnapshot: false },
		);
		if (resolution.state === "pending") {
			throw new BillingAuthorityPendingError(input.organizationId);
		}
		const healedInput: MutationUsageInput = {
			...input,
			...resolution.authority,
			billingAuthorityState: "ready",
		};
		assertUsageAuthorityShape(healedInput);
		// Deliberately call the one-shot function: a second concurrent authority
		// change is surfaced rather than amplified into an unbounded retry loop.
		const decision = await reserveMutationUsageOnce(db, healedInput, now);
		return { ...decision, selfHealed: true };
	}
}

async function reserveMutationUsageOnce(
	db: Database,
	input: MutationUsageInput,
	now: Date,
): Promise<UsageReservationAttemptDecision> {
	return db.transaction((tx) =>
		reserveMutationUsageInTransaction(tx, input, now),
	);
}

async function reserveMutationUsageInTransaction(
	tx: UsageTransaction,
	input: MutationUsageInput,
	now: Date,
	options: { allowDailyToolAuthorityRebase?: boolean } = {},
): Promise<UsageReservationAttemptDecision> {
	assertUsageAuthorityShape(input);
	const billingPeriodId = input.billingPeriodId ?? null;
	const metric = input.metric ?? METRIC;
	if (input.quotaMode === "metered" && !billingPeriodId) {
		throw new Error(
			"Metered usage requires a pre-created billing-period authority",
		);
	}
	if (!billingPeriodId) {
		await tx
			.insert(usageBuckets)
			.values({
				id: generateId("ub_"),
				organizationId: input.organizationId,
				billingPeriodId: null,
				metric,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				quotaMode: input.quotaMode,
				includedUnits: input.includedUnits,
			})
			.onConflictDoNothing({
				target: [
					usageBuckets.organizationId,
					usageBuckets.metric,
					usageBuckets.periodStart,
				],
			});
	}

	const [bucket] = await tx
		.select()
		.from(usageBuckets)
		.where(
			and(
				eq(usageBuckets.organizationId, input.organizationId),
				eq(usageBuckets.metric, metric),
				eq(usageBuckets.periodStart, input.periodStart),
			),
		)
		.for("update")
		.limit(1);
	if (!bucket) {
		throw new BillingAuthorityMismatchError(
			"Failed to find the requested authoritative usage bucket",
		);
	}
	assertSafeUsageUnits(bucket.committedUnits, "Bucket committed usage units");
	assertSafeUsageUnits(bucket.reservedUnits, "Bucket reserved usage units");
	if (bucket.includedUnits !== null) {
		assertSafeUsageUnits(bucket.includedUnits, "Bucket included usage units");
	}
	if (
		options.allowDailyToolAuthorityRebase &&
		metric === DAILY_TOOL_METRIC &&
		billingPeriodId === null &&
		bucket.billingPeriodId === null &&
		bucket.periodEnd.getTime() === input.periodEnd.getTime() &&
		(bucket.quotaMode !== input.quotaMode ||
			bucket.includedUnits !== input.includedUnits) &&
		now >= bucket.periodStart &&
		now < bucket.periodEnd
	) {
		await tx
			.update(usageBuckets)
			.set({
				quotaMode: input.quotaMode,
				includedUnits: input.includedUnits,
				updatedAt: now,
			})
			.where(
				and(
					eq(usageBuckets.id, bucket.id),
					eq(usageBuckets.organizationId, input.organizationId),
					eq(usageBuckets.metric, DAILY_TOOL_METRIC),
				),
			);
		bucket.quotaMode = input.quotaMode;
		bucket.includedUnits = input.includedUnits;
		bucket.updatedAt = now;
	}
	if (
		bucket.billingPeriodId !== billingPeriodId ||
		bucket.periodEnd.getTime() !== input.periodEnd.getTime() ||
		bucket.quotaMode !== input.quotaMode ||
		bucket.includedUnits !== input.includedUnits ||
		now < bucket.periodStart ||
		now >= bucket.periodEnd
	) {
		throw new BillingAuthorityMismatchError(
			"Usage bucket does not match the requested billing authority",
		);
	}
	if (billingPeriodId) {
		const [lockedPeriod] = await tx
			.select({
				id: billingPeriods.id,
				periodStart: billingPeriods.periodStart,
				periodEnd: billingPeriods.periodEnd,
				quotaMode: billingPeriods.quotaMode,
				includedUnits: billingPeriods.includedUnits,
			})
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.id, billingPeriodId),
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					lte(billingPeriods.periodStart, now),
					gt(billingPeriods.periodEnd, now),
				),
			)
			.for("share")
			.limit(1);
		if (
			!lockedPeriod ||
			lockedPeriod.periodStart.getTime() !== input.periodStart.getTime() ||
			lockedPeriod.periodEnd.getTime() !== input.periodEnd.getTime() ||
			lockedPeriod.quotaMode !== input.quotaMode ||
			lockedPeriod.includedUnits !== input.includedUnits
		) {
			throw new BillingAuthorityMismatchError(
				"Usage request does not match the authoritative billing period",
			);
		}
	} else if (metric === METRIC) {
		// A cached free entitlement can still match its old bucket after an
		// upgrade. Detect the new period without locking its bucket; resolution
		// happens only after this transaction (and the old bucket lock) rolls back.
		const [currentBillingPeriod] = await tx
			.select({ id: billingPeriods.id })
			.from(billingPeriods)
			.where(
				and(
					eq(billingPeriods.organizationId, input.organizationId),
					eq(billingPeriods.state, "open"),
					lte(billingPeriods.periodStart, now),
					gt(billingPeriods.periodEnd, now),
				),
			)
			.limit(1);
		if (currentBillingPeriod) {
			throw new BillingAuthorityMismatchError(
				"A current billing period supersedes the cached free authority",
			);
		}
		const [supersedingFreeBoundary] = await tx
			.select({ id: usageBuckets.id })
			.from(usageBuckets)
			.where(
				and(
					eq(usageBuckets.organizationId, input.organizationId),
					eq(usageBuckets.metric, METRIC),
					or(
						and(
							isNotNull(usageBuckets.billingPeriodId),
							gt(usageBuckets.periodEnd, input.periodStart),
							lte(usageBuckets.periodEnd, now),
						),
						and(
							isNull(usageBuckets.billingPeriodId),
							gt(usageBuckets.periodStart, input.periodStart),
							lte(usageBuckets.periodStart, now),
							gt(usageBuckets.periodEnd, now),
						),
					),
				),
			)
			.limit(1);
		if (supersedingFreeBoundary) {
			throw new BillingAuthorityMismatchError(
				"A later usage boundary supersedes the cached free authority",
			);
		}
	}

	// A Worker that dies after reserving cannot permanently consume quota. The
	// next mutation reclaims a bounded bucket-local set under the same row lock.
	const stale = await tx
		.select({
			id: usageReservations.id,
			units: usageReservations.units,
			requestMayHaveBeenSentAt: usageReservations.requestMayHaveBeenSentAt,
		})
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.bucketId, bucket.id),
				eq(usageReservations.state, "reserved"),
				lt(
					usageReservations.reservedAt,
					new Date(now.getTime() - STALE_RESERVATION_MS),
				),
				// Async tool jobs own their reservation until their fenced
				// terminal transition. Generic quota recovery must not race the
				// tool-job deadline/attempt state machine.
				sql`NOT EXISTS (
						SELECT 1
						  FROM ${toolJobs} AS live_tool_job
						 WHERE live_tool_job.usage_reservation_id = ${usageReservations.id}
						   AND live_tool_job.organization_id = ${usageReservations.organizationId}
						   AND live_tool_job.status IN ('pending', 'processing')
					)`,
			),
		)
		.for("update")
		.limit(100);
	const staleKnownNotStarted = stale.filter(
		(row) => row.requestMayHaveBeenSentAt === null,
	);
	const staleUnknown = stale.filter(
		(row) => row.requestMayHaveBeenSentAt !== null,
	);
	const staleKnownUnits = safeUsageSum(
		"Stale released usage units",
		...staleKnownNotStarted.map((row) => row.units),
	);
	if (staleKnownNotStarted.length > 0) {
		await tx
			.update(usageReservations)
			.set({
				state: "released",
				disposition: "pre_boundary",
				committedUnits: 0,
				responseStatus: null,
				finalizedAt: now,
			})
			.where(
				sql`${usageReservations.id} IN (${sql.join(
					staleKnownNotStarted.map((row) => sql`${row.id}`),
					sql`, `,
				)})`,
			);
	}
	if (staleUnknown.length > 0) {
		await tx
			.update(usageReservations)
			.set({
				state: "parked",
				disposition: "unknown",
				committedUnits: null,
				responseStatus: null,
				finalizedAt: null,
			})
			.where(
				sql`${usageReservations.id} IN (${sql.join(
					staleUnknown.map((row) => sql`${row.id}`),
					sql`, `,
				)})`,
			);
	}
	bucket.reservedUnits = Math.max(0, bucket.reservedUnits - staleKnownUnits);

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
	if (existing) {
		assertSafeUsageUnits(existing.units, "Reserved usage units", {
			positive: true,
		});
		if (existing.committedUnits !== null) {
			assertSafeUsageUnits(existing.committedUnits, "Committed usage units");
			if (existing.committedUnits > existing.units) {
				throw new Error("Committed usage units cannot exceed reserved units");
			}
		}
	}

	if (existing?.state === "committed") {
		const carryover = await getUsageCarryoverContribution(tx, {
			organizationId: input.organizationId,
			successorBucketId: bucket.id,
		});
		return {
			ok: true,
			reservation: {
				id: existing.id,
				bucketId: bucket.id,
				organizationId: input.organizationId,
				units: existing.units,
				state: "committed",
				quotaMode: bucket.quotaMode,
				includedUnits: effectiveCarryoverAllowance(
					bucket.includedUnits,
					carryover.committedUnits,
				),
				committedUnits: bucket.committedUnits,
				reservedUnits: safeUsageSum(
					"Reserved usage units",
					bucket.reservedUnits,
					carryover.pendingUnits,
				),
				periodStart: bucket.periodStart,
				periodEnd: bucket.periodEnd,
			},
		};
	}
	if (existing?.state === "reserved") {
		const carryover = await getUsageCarryoverContribution(tx, {
			organizationId: input.organizationId,
			successorBucketId: bucket.id,
		});
		return {
			ok: true,
			reservation: {
				id: existing.id,
				bucketId: bucket.id,
				organizationId: input.organizationId,
				units: existing.units,
				state: "reserved",
				quotaMode: bucket.quotaMode,
				includedUnits: effectiveCarryoverAllowance(
					bucket.includedUnits,
					carryover.committedUnits,
				),
				committedUnits: bucket.committedUnits,
				reservedUnits: safeUsageSum(
					"Reserved usage units",
					bucket.reservedUnits,
					carryover.pendingUnits,
				),
				periodStart: bucket.periodStart,
				periodEnd: bucket.periodEnd,
			},
		};
	}
	if (existing?.state === "parked") {
		throw new Error(
			"Usage reservation outcome is parked pending durable reconciliation",
		);
	}
	if (
		existing?.state === "released" &&
		existing.disposition === "written_off"
	) {
		throw new Error(
			"Written-off usage reservations are terminal audited records",
		);
	}
	if (existing?.state === "released") {
		const [carryoverEdge] = await tx
			.select({
				sourceReservationId: usageReservationCarryovers.sourceReservationId,
			})
			.from(usageReservationCarryovers)
			.where(
				and(
					eq(usageReservationCarryovers.sourceReservationId, existing.id),
					eq(usageReservationCarryovers.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (carryoverEdge) {
			throw new Error(
				"Carryover-linked usage reservations are terminal and cannot be reused",
			);
		}
	}
	const carryover = await getUsageCarryoverContribution(tx, {
		organizationId: input.organizationId,
		successorBucketId: bucket.id,
	});
	const effectiveIncludedUnits = effectiveCarryoverAllowance(
		bucket.includedUnits,
		carryover.committedUnits,
	);
	const effectiveReservedUnits = safeUsageSum(
		"Reserved usage units",
		bucket.reservedUnits,
		carryover.pendingUnits,
	);

	if (
		bucket.quotaMode === "hard" &&
		effectiveIncludedUnits !== null &&
		safeUsageSum(
			"Projected usage units",
			bucket.committedUnits,
			effectiveReservedUnits,
			input.units,
		) > effectiveIncludedUnits
	) {
		return {
			ok: false,
			quotaMode: bucket.quotaMode,
			includedUnits: effectiveIncludedUnits,
			committedUnits: bucket.committedUnits,
			reservedUnits: effectiveReservedUnits,
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
				disposition: "pending",
				committedUnits: null,
				responseStatus: null,
				reservedAt: now,
				requestMayHaveBeenSentAt: null,
				writeOffReason: null,
				writeOffEvidence: null,
				writtenOffAt: null,
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
			source: input.source ?? "api",
			reservedAt: now,
		});
	}

	return {
		ok: true,
		reservation: {
			id: reservationId,
			bucketId: bucket.id,
			organizationId: input.organizationId,
			units: input.units,
			state: "reserved",
			quotaMode: bucket.quotaMode,
			includedUnits: effectiveIncludedUnits,
			committedUnits: bucket.committedUnits,
			reservedUnits: safeUsageSum(
				"Reserved usage units",
				effectiveReservedUnits,
				input.units,
			),
			periodStart: bucket.periodStart,
			periodEnd: bucket.periodEnd,
		},
	};
}

/**
 * Persist the external request boundary before egress. The compare-and-set is
 * deliberately one-way: if reclaim or another finalizer won the race, the
 * provider request must not start.
 */
export async function armUsageReservationProviderBoundary(
	db: Database,
	reservation: UsageReservationReference,
	now = new Date(),
): Promise<Date> {
	const rows = await db
		.update(usageReservations)
		.set({ requestMayHaveBeenSentAt: now })
		.where(
			and(
				eq(usageReservations.id, reservation.id),
				eq(usageReservations.organizationId, reservation.organizationId),
				eq(usageReservations.bucketId, reservation.bucketId),
				eq(usageReservations.state, "reserved"),
				sql`${usageReservations.requestMayHaveBeenSentAt} IS NULL`,
			),
		)
		.returning({
			requestMayHaveBeenSentAt: usageReservations.requestMayHaveBeenSentAt,
		});
	const armed = rows[0]?.requestMayHaveBeenSentAt;
	if (!armed) {
		throw new Error(
			"Usage reservation is no longer eligible for provider egress",
		);
	}
	return armed;
}

export async function finalizeUsageReservation(
	db: Database,
	reservation: UsageReservationReference,
	disposition: UsageDisposition,
	now = new Date(),
): Promise<{
	quotaMode: "hard" | "metered" | "unlimited";
	includedUnits: number | null;
	committedUnits: number;
	reservationCommittedUnits: number;
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
		assertSafeUsageUnits(row.units, "Reserved usage units", { positive: true });
		assertSafeUsageUnits(bucket.committedUnits, "Bucket committed usage units");
		assertSafeUsageUnits(bucket.reservedUnits, "Bucket reserved usage units");
		if (bucket.includedUnits !== null) {
			assertSafeUsageUnits(bucket.includedUnits, "Bucket included usage units");
		}
		const carryover = await getUsageCarryoverContribution(tx, {
			organizationId: reservation.organizationId,
			successorBucketId: bucket.id,
		});
		const effectiveIncludedUnits = effectiveCarryoverAllowance(
			bucket.includedUnits,
			carryover.committedUnits,
		);
		const predecessorPendingUnits = carryover.pendingUnits;
		if (row.state !== "reserved") {
			return {
				quotaMode: bucket.quotaMode,
				includedUnits: effectiveIncludedUnits,
				committedUnits: bucket.committedUnits,
				reservationCommittedUnits: row.committedUnits ?? 0,
				reservedUnits: safeUsageSum(
					"Reserved usage units",
					bucket.reservedUnits,
					predecessorPendingUnits,
				),
			};
		}

		const outcome = persistedUsageOutcome(
			row.requestMayHaveBeenSentAt,
			disposition,
			row.units,
		);
		await tx
			.update(usageReservations)
			.set({
				state: outcome.state,
				disposition: outcome.disposition,
				committedUnits: outcome.committedUnits,
				responseStatus: outcome.responseStatus,
				requestMayHaveBeenSentAt:
					outcome.state === "parked"
						? (row.requestMayHaveBeenSentAt ?? now)
						: row.requestMayHaveBeenSentAt,
				finalizedAt: outcome.state === "parked" ? null : now,
			})
			.where(
				and(
					eq(usageReservations.id, reservation.id),
					eq(usageReservations.state, "reserved"),
				),
			);

		if (outcome.state === "parked") {
			return {
				quotaMode: bucket.quotaMode,
				includedUnits: effectiveIncludedUnits,
				committedUnits: bucket.committedUnits,
				reservationCommittedUnits: 0,
				reservedUnits: safeUsageSum(
					"Reserved usage units",
					bucket.reservedUnits,
					predecessorPendingUnits,
				),
			};
		}
		const committedDelta = outcome.committedUnits ?? 0;
		return {
			quotaMode: bucket.quotaMode,
			includedUnits: effectiveIncludedUnits,
			committedUnits: safeUsageSum(
				"Committed usage units",
				bucket.committedUnits,
				committedDelta,
			),
			reservationCommittedUnits: committedDelta,
			reservedUnits: safeUsageSum(
				"Reserved usage units",
				Math.max(0, bucket.reservedUnits - row.units),
				predecessorPendingUnits,
			),
		};
	});
}

export async function finalizeMutationUsage(
	db: Database,
	reservation: UsageReservation,
	disposition: UsageDisposition,
	now = new Date(),
) {
	return finalizeUsageReservation(db, reservation, disposition, now);
}
