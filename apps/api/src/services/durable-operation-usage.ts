import {
	adCreationOperations,
	adMutationOperations,
	createDb,
	type Database,
	usageReservations,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import {
	and,
	asc,
	eq,
	inArray,
	isNotNull,
	or,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { hasAdCreationProviderEffect } from "../lib/ad-money";
import type { Env } from "../types";
import {
	settleDurableUsageReservation,
	settleDurableUsageReservationInTransaction,
	type UsageReservation,
} from "./usage-meter";

const RECONCILIATION_BATCH_SIZE = 100;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function adoptDurableUsageReservation(
	db: Database,
	linkedReservationId: string | null,
	reservation: UsageReservation | undefined,
): Promise<void> {
	if (!reservation) return;
	await settleDurableUsageReservation(db, {
		reservationId: reservation.id,
		organizationId: reservation.organizationId,
		// A fresh request replaying an existing logical operation has K=0. The
		// operation's original reservation remains its only economic authority.
		committedUnits: linkedReservationId === reservation.id ? null : 0,
	});
}

export async function adoptDurableUsageReservationInTransaction(
	tx: Transaction,
	linkedReservationId: string | null,
	reservation: UsageReservation | undefined,
): Promise<void> {
	if (!reservation) return;
	await settleDurableUsageReservationInTransaction(tx, {
		reservationId: reservation.id,
		organizationId: reservation.organizationId,
		committedUnits: linkedReservationId === reservation.id ? null : 0,
	});
}

export async function settleLinkedDurableUsage(
	db: Database,
	input: {
		organizationId: string;
		usageReservationId: string | null;
		committed: boolean;
	},
): Promise<void> {
	if (!input.usageReservationId) return;
	const [reservation] = await db
		.select({ units: usageReservations.units })
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.id, input.usageReservationId),
				eq(usageReservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!reservation)
		throw new Error("Linked durable usage reservation is missing");
	await settleDurableUsageReservation(db, {
		reservationId: input.usageReservationId,
		organizationId: input.organizationId,
		committedUnits: input.committed ? reservation.units : 0,
	});
}

export async function settleLinkedDurableUsageInTransaction(
	tx: Transaction,
	input: {
		organizationId: string;
		usageReservationId: string | null;
		committed: boolean;
	},
): Promise<void> {
	if (!input.usageReservationId) return;
	const [reservation] = await tx
		.select({ units: usageReservations.units })
		.from(usageReservations)
		.where(
			and(
				eq(usageReservations.id, input.usageReservationId),
				eq(usageReservations.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!reservation)
		throw new Error("Linked durable usage reservation is missing");
	await settleDurableUsageReservationInTransaction(tx, {
		reservationId: input.usageReservationId,
		organizationId: input.organizationId,
		committedUnits: input.committed ? reservation.units : 0,
	});
}

type ReconciliationCandidate = {
	organizationId: string;
	usageReservationId: string;
	committed: boolean;
	terminalNoEffect?: boolean;
};

async function reconcileCandidates(
	db: Database,
	candidates: ReconciliationCandidate[],
): Promise<number> {
	let reconciled = 0;
	for (const candidate of candidates) {
		try {
			await settleLinkedDurableUsage(db, candidate);
			reconciled += 1;
		} catch (error) {
			console.error("Failed to reconcile durable operation usage", {
				organizationId: candidate.organizationId,
				usageReservationId: candidate.usageReservationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return reconciled;
}

/**
 * Backstop for process death between an operation state transition and usage
 * settlement. Nonterminal operations retain N as parked; terminal success
 * commits exactly once. Safe cancellation and append-only operator non-effect
 * evidence are the only K=0 terminals. Phone-release non-effect evidence is
 * phase-scoped and remains parked for its fenced retry.
 */
export async function reconcileDurableOperationUsage(
	db: Database,
): Promise<number> {
	const terminalOperatorOutcome = (
		targetType: string,
		targetId: SQLWrapper,
	) => sql<"mark_succeeded" | "mark_not_applied" | null>`(
		SELECT evidence.action
		  FROM operator_resolution_evidence AS evidence
		 WHERE evidence.target_type = ${targetType}
		   AND evidence.target_id = ${targetId}
		   AND evidence.action IN ('mark_succeeded', 'mark_not_applied')
		 ORDER BY evidence.resolved_at DESC, evidence.id DESC
		 LIMIT 1
	)`;
	const adCreationOperatorOutcome = terminalOperatorOutcome(
		"ad_creation_operation",
		adCreationOperations.id,
	);
	const adMutationOperatorOutcome = terminalOperatorOutcome(
		"ad_mutation_operation",
		adMutationOperations.id,
	);
	const phoneProvisioningOperatorOutcome = terminalOperatorOutcome(
		"whatsapp_phone_provisioning_operation",
		whatsappPhoneProvisioningOperations.provisioningOperationId,
	);
	// Release decisions are phase-scoped. Any confirmed-success phase is a
	// monotonic K=N boundary; a later not-applied decision only authorizes that
	// phase's safe retry and must never erase the earlier economic evidence.
	const phoneReleaseOperatorOutcome = sql<"mark_succeeded" | null>`(
		SELECT 'mark_succeeded'::text
		  FROM operator_resolution_evidence AS evidence
		 WHERE evidence.target_type = 'whatsapp_phone_release_operation'
		   AND evidence.target_id = ${whatsappPhoneReleaseOperations.releaseOperationId}
		   AND evidence.action = 'mark_succeeded'
		 LIMIT 1
	)`;
	const adCreationUsesInheritedContext = sql`COALESCE(
		${adCreationOperations.kind} = 'create_ad'
		AND jsonb_typeof(${adCreationOperations.requestPayload} -> 'campaignId') = 'string',
		false
	)`;
	const adCreationProviderEffect = or(
		isNotNull(adCreationOperations.platformCreativeId),
		isNotNull(adCreationOperations.platformAdId),
		and(
			sql`NOT ${adCreationUsesInheritedContext}`,
			or(
				isNotNull(adCreationOperations.platformCampaignId),
				isNotNull(adCreationOperations.platformAdSetId),
			),
		),
	);
	const adCreationTerminalEvidence = or(
		eq(adCreationOperations.status, "completed"),
		adCreationProviderEffect,
		sql`${adCreationOperatorOutcome} IS NOT NULL`,
	);
	const adMutationTerminalEvidence = or(
		eq(adMutationOperations.status, "completed"),
		isNotNull(adMutationOperations.providerConfirmedAt),
		sql`${adMutationOperatorOutcome} IS NOT NULL`,
	);
	const phoneProvisioningTerminalEvidence = or(
		eq(whatsappPhoneProvisioningOperations.provisioningState, "completed"),
		eq(whatsappPhoneProvisioningOperations.provisioningState, "cancelled"),
		isNotNull(whatsappPhoneProvisioningOperations.stripeCheckoutSessionId),
		inArray(whatsappPhoneProvisioningOperations.provisioningPhase, [
			"telnyx_order",
			"meta_registration",
			"completed",
		]),
		sql`${phoneProvisioningOperatorOutcome} IS NOT NULL`,
	);
	const phoneReleaseTerminalEvidence = or(
		eq(whatsappPhoneReleaseOperations.releaseState, "completed"),
		eq(whatsappPhoneReleaseOperations.releaseState, "cancelled"),
		eq(whatsappPhoneReleaseOperations.releaseMetaStatus, "confirmed"),
		eq(whatsappPhoneReleaseOperations.releaseStripeStatus, "confirmed"),
		eq(whatsappPhoneReleaseOperations.releaseTelnyxStatus, "confirmed"),
		sql`${phoneReleaseOperatorOutcome} = 'mark_succeeded'`,
	);
	const [adCreations, adMutations, phoneProvisioning, phoneReleases] =
		await Promise.all([
			db
				.select({
					organizationId: adCreationOperations.organizationId,
					usageReservationId: adCreationOperations.usageReservationId,
					status: adCreationOperations.status,
					platformCampaignId: adCreationOperations.platformCampaignId,
					platformAdSetId: adCreationOperations.platformAdSetId,
					platformCreativeId: adCreationOperations.platformCreativeId,
					platformAdId: adCreationOperations.platformAdId,
					kind: adCreationOperations.kind,
					requestPayload: adCreationOperations.requestPayload,
					operatorOutcome: adCreationOperatorOutcome,
				})
				.from(adCreationOperations)
				.innerJoin(
					usageReservations,
					and(
						eq(usageReservations.id, adCreationOperations.usageReservationId),
						eq(
							usageReservations.organizationId,
							adCreationOperations.organizationId,
						),
					),
				)
				.where(
					and(
						isNotNull(adCreationOperations.usageReservationId),
						or(
							eq(usageReservations.state, "reserved"),
							and(
								eq(usageReservations.state, "parked"),
								adCreationTerminalEvidence,
							),
						),
					),
				)
				.orderBy(
					asc(adCreationOperations.updatedAt),
					asc(adCreationOperations.id),
				)
				.limit(RECONCILIATION_BATCH_SIZE),
			db
				.select({
					organizationId: adMutationOperations.organizationId,
					usageReservationId: adMutationOperations.usageReservationId,
					status: adMutationOperations.status,
					providerConfirmedAt: adMutationOperations.providerConfirmedAt,
					operatorOutcome: adMutationOperatorOutcome,
				})
				.from(adMutationOperations)
				.innerJoin(
					usageReservations,
					and(
						eq(usageReservations.id, adMutationOperations.usageReservationId),
						eq(
							usageReservations.organizationId,
							adMutationOperations.organizationId,
						),
					),
				)
				.where(
					and(
						isNotNull(adMutationOperations.usageReservationId),
						or(
							eq(usageReservations.state, "reserved"),
							and(
								eq(usageReservations.state, "parked"),
								adMutationTerminalEvidence,
							),
						),
					),
				)
				.orderBy(
					asc(adMutationOperations.updatedAt),
					asc(adMutationOperations.id),
				)
				.limit(RECONCILIATION_BATCH_SIZE),
			db
				.select({
					organizationId: whatsappPhoneProvisioningOperations.organizationId,
					usageReservationId:
						whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
					status: whatsappPhoneProvisioningOperations.provisioningState,
					phase: whatsappPhoneProvisioningOperations.provisioningPhase,
					stripeCheckoutSessionId:
						whatsappPhoneProvisioningOperations.stripeCheckoutSessionId,
					operatorOutcome: phoneProvisioningOperatorOutcome,
				})
				.from(whatsappPhoneProvisioningOperations)
				.innerJoin(
					usageReservations,
					and(
						eq(
							usageReservations.id,
							whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
						),
						eq(
							usageReservations.organizationId,
							whatsappPhoneProvisioningOperations.organizationId,
						),
					),
				)
				.where(
					and(
						isNotNull(
							whatsappPhoneProvisioningOperations.provisioningUsageReservationId,
						),
						or(
							eq(usageReservations.state, "reserved"),
							and(
								eq(usageReservations.state, "parked"),
								phoneProvisioningTerminalEvidence,
							),
						),
					),
				)
				.orderBy(
					asc(whatsappPhoneProvisioningOperations.updatedAt),
					asc(whatsappPhoneProvisioningOperations.provisioningOperationId),
				)
				.limit(RECONCILIATION_BATCH_SIZE),
			db
				.select({
					organizationId: whatsappPhoneReleaseOperations.organizationId,
					usageReservationId:
						whatsappPhoneReleaseOperations.releaseUsageReservationId,
					status: whatsappPhoneReleaseOperations.releaseState,
					metaStatus: whatsappPhoneReleaseOperations.releaseMetaStatus,
					stripeStatus: whatsappPhoneReleaseOperations.releaseStripeStatus,
					telnyxStatus: whatsappPhoneReleaseOperations.releaseTelnyxStatus,
					operatorOutcome: phoneReleaseOperatorOutcome,
				})
				.from(whatsappPhoneReleaseOperations)
				.innerJoin(
					usageReservations,
					and(
						eq(
							usageReservations.id,
							whatsappPhoneReleaseOperations.releaseUsageReservationId,
						),
						eq(
							usageReservations.organizationId,
							whatsappPhoneReleaseOperations.organizationId,
						),
					),
				)
				.where(
					and(
						isNotNull(whatsappPhoneReleaseOperations.releaseUsageReservationId),
						or(
							eq(usageReservations.state, "reserved"),
							and(
								eq(usageReservations.state, "parked"),
								phoneReleaseTerminalEvidence,
							),
						),
					),
				)
				.orderBy(
					asc(whatsappPhoneReleaseOperations.updatedAt),
					asc(whatsappPhoneReleaseOperations.releaseOperationId),
				)
				.limit(RECONCILIATION_BATCH_SIZE),
		]);

	const candidates: ReconciliationCandidate[] = [
		...adCreations.map((row) => {
			const automaticCommit =
				row.status === "completed" || hasAdCreationProviderEffect(row);
			return {
				organizationId: row.organizationId,
				usageReservationId: row.usageReservationId as string,
				committed: automaticCommit || row.operatorOutcome === "mark_succeeded",
				terminalNoEffect:
					row.status === "cancelled" ||
					(!automaticCommit && row.operatorOutcome === "mark_not_applied"),
			};
		}),
		...adMutations.map((row) => {
			const automaticCommit =
				row.status === "completed" || row.providerConfirmedAt !== null;
			return {
				organizationId: row.organizationId,
				usageReservationId: row.usageReservationId as string,
				committed: automaticCommit || row.operatorOutcome === "mark_succeeded",
				terminalNoEffect:
					row.status === "cancelled" ||
					(!automaticCommit && row.operatorOutcome === "mark_not_applied"),
			};
		}),
		...phoneProvisioning.map((row) => {
			const automaticCommit =
				row.status === "completed" ||
				row.stripeCheckoutSessionId !== null ||
				["telnyx_order", "meta_registration", "completed"].includes(row.phase);
			return {
				organizationId: row.organizationId,
				usageReservationId: row.usageReservationId as string,
				committed: automaticCommit || row.operatorOutcome === "mark_succeeded",
				terminalNoEffect:
					!automaticCommit && row.operatorOutcome === "mark_not_applied",
			};
		}),
		...phoneReleases.map((row) => {
			const automaticCommit =
				row.status === "completed" ||
				[row.metaStatus, row.stripeStatus, row.telnyxStatus].includes(
					"confirmed",
				);
			return {
				organizationId: row.organizationId,
				usageReservationId: row.usageReservationId as string,
				committed: automaticCommit || row.operatorOutcome === "mark_succeeded",
				terminalNoEffect: row.status === "cancelled",
			};
		}),
	];

	// Nonterminal `committed: false` means keep parked, not K=0. Provisioning
	// cancellation and terminal operator non-effect evidence are definitive;
	// phase-scoped phone-release non-effect evidence deliberately remains parked.
	let reconciled = 0;
	for (const candidate of candidates) {
		const provisioning = phoneProvisioning.find(
			(row) => row.usageReservationId === candidate.usageReservationId,
		);
		if (provisioning?.status === "cancelled" || candidate.terminalNoEffect) {
			reconciled += await reconcileCandidates(db, [candidate]);
			continue;
		}
		if (candidate.committed) {
			reconciled += await reconcileCandidates(db, [candidate]);
			continue;
		}
		try {
			await settleDurableUsageReservation(db, {
				reservationId: candidate.usageReservationId,
				organizationId: candidate.organizationId,
				committedUnits: null,
			});
			reconciled += 1;
		} catch (error) {
			console.error("Failed to park durable operation usage", {
				usageReservationId: candidate.usageReservationId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return reconciled;
}

export async function reconcileDurableOperationUsageForEnv(
	env: Env,
): Promise<number> {
	return reconcileDurableOperationUsage(
		createDb(env.HYPERDRIVE.connectionString),
	);
}
