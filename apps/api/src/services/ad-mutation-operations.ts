import {
	adAccounts,
	adCampaigns,
	adConnections,
	adMutationOperations,
	ads,
	createDb,
	type Database,
	operatorResolutionEvidence,
	organization,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import {
	type DurableCredentialAuthorityAdmission,
	type DurableCredentialAuthoritySnapshot,
	revalidateDurableCredentialAuthority,
} from "../lib/durable-credential-authority";
import {
	durableOperationHashes,
	stableOperationJson,
} from "../lib/durable-operation";
import type { Env } from "../types";
import { getAdPlatformAdapter } from "./ad-platforms";
import type {
	AdPlatform,
	AdPlatformAdapter,
	AdProviderCredentials,
	AdProviderMutationState,
	AdTargeting,
	CampaignProviderMutationState,
} from "./ad-platforms/types";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "./ad-platforms/types";
import {
	type AdProviderBoundaryContext,
	lockAdProviderBoundary,
} from "./ad-provider-boundary";
import { resolveAdProviderCredentials } from "./ad-provider-credentials";
import {
	adoptDurableUsageReservationInTransaction,
	settleLinkedDurableUsage,
	settleLinkedDurableUsageInTransaction,
} from "./durable-operation-usage";
import type { UsageReservation } from "./usage-meter";

const LEASE_MS = 2 * 60_000;
const MANUAL_REVIEW_ATTEMPTS = 5;

type Operation = typeof adMutationOperations.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface MutationBase {
	adAccountId: string;
}

export interface UpdateAdMutationPayload extends MutationBase {
	kind: "update_ad";
	adId: string;
	campaignId: string;
	platformAdId: string;
	platformCampaignId?: string;
	platformAdSetId?: string;
	changes: {
		name?: string;
		status?: "active" | "paused";
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		targeting?: AdTargeting;
	};
	expectedProviderTargeting?: Record<string, unknown>;
}

export interface CancelAdMutationPayload extends MutationBase {
	kind: "cancel_ad";
	adId: string;
	platformAdId: string;
}

export interface UpdateCampaignMutationPayload extends MutationBase {
	kind: "update_campaign";
	campaignId: string;
	platformCampaignId: string;
	platformAdSetId?: string;
	childPlatformAdIds: string[];
	changes: {
		name?: string;
		status?: "active" | "paused";
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
	};
}

export interface CancelCampaignMutationPayload extends MutationBase {
	kind: "cancel_campaign";
	campaignId: string;
	platformCampaignId: string;
}

export type AdMutationPayload =
	| UpdateAdMutationPayload
	| CancelAdMutationPayload
	| UpdateCampaignMutationPayload
	| CancelCampaignMutationPayload;

interface ClaimedMutation {
	row: Operation;
	leaseToken: number;
}

function mutationAuthoritySnapshot(
	row: Operation,
): DurableCredentialAuthoritySnapshot {
	return {
		organizationId: row.organizationId,
		keyId: row.authorityKeyId,
		principalId: row.authorityPrincipalId,
		principalType: row.authorityPrincipalType,
		userId: row.authorityUserId,
		authorityMemberId: row.authorityMemberId,
		authoritySessionId: row.authoritySessionId,
		authorityWorkspaceId: row.authorityWorkspaceId,
		authorityRequiresAllWorkspaceScope: row.authorityRequiresAllWorkspaceScope,
		credentialVersion: row.authorityCredentialVersion,
		admittedAt: row.authorityAdmittedAt,
		revision: row.authorityRevision,
	};
}

function mutationAuthorityValues(snapshot: DurableCredentialAuthoritySnapshot) {
	return {
		authorityKeyId: snapshot.keyId,
		authorityPrincipalId: snapshot.principalId,
		authorityPrincipalType: snapshot.principalType,
		authorityUserId: snapshot.userId,
		authorityMemberId: snapshot.authorityMemberId,
		authoritySessionId: snapshot.authoritySessionId,
		authorityWorkspaceId: snapshot.authorityWorkspaceId,
		authorityRequiresAllWorkspaceScope:
			snapshot.authorityRequiresAllWorkspaceScope,
		authorityCredentialVersion: snapshot.credentialVersion,
		authorityAdmittedAt: snapshot.admittedAt,
		authorityRevision: snapshot.revision,
	};
}

function sameMutationAuthority(
	row: Operation,
	snapshot: DurableCredentialAuthoritySnapshot,
): boolean {
	return (
		row.authorityKeyId === snapshot.keyId &&
		row.authorityPrincipalId === snapshot.principalId &&
		row.authorityPrincipalType === snapshot.principalType &&
		row.authorityUserId === snapshot.userId &&
		row.authorityMemberId === snapshot.authorityMemberId &&
		row.authoritySessionId === snapshot.authoritySessionId &&
		row.authorityWorkspaceId === snapshot.authorityWorkspaceId &&
		row.authorityRequiresAllWorkspaceScope ===
			snapshot.authorityRequiresAllWorkspaceScope &&
		row.authorityCredentialVersion === snapshot.credentialVersion
	);
}

function throwMutationAuthorityDenied(message: string): never {
	throw new AdAuthoritativeNotAppliedError(
		"CREDENTIAL_NO_LONGER_AUTHORIZED",
		message,
	);
}

function operationError(row: Operation): never {
	if (row.status === "cancelled") {
		throwMutationAuthorityDenied(
			"The provider mutation was cancelled because its admitting credential was revoked.",
		);
	}
	if (row.status === "revocation_pending") {
		throw new AdPlatformError(
			"AUTHORITY_REVOKED_PENDING",
			"The admitting credential was revoked after a provider effect; only correlation or spend-reducing compensation may continue.",
		);
	}
	if (row.status === "manual_review") {
		throw new AdPlatformError(
			"AD_MUTATION_MANUAL_REVIEW",
			"The provider mutation requires an operator decision before it can continue.",
		);
	}
	if (
		row.status === "unknown" ||
		row.status === "request_may_have_been_sent" ||
		row.status === "reconciling"
	) {
		throw new AdPlatformError(
			"AD_MUTATION_UNKNOWN",
			"The provider mutation outcome is ambiguous. RelayAPI is reconciling canonical provider state and will not replay the mutation.",
		);
	}
	throw new AdPlatformError(
		"AD_MUTATION_IN_PROGRESS",
		"Another fenced mutation for this provider object is still in progress.",
	);
}

async function beginMutation(options: {
	db: Database;
	organizationId: string;
	targetType: "ad" | "campaign";
	targetId: string;
	workspaceId: string | null;
	platform: AdPlatform;
	operationKey: string | undefined;
	payload: AdMutationPayload;
	usageReservation?: UsageReservation;
	authorityAdmission: DurableCredentialAuthorityAdmission;
	requiresLiveAuthority: boolean;
}): Promise<ClaimedMutation | { completed: Operation }> {
	if (!options.operationKey) {
		throw new AdPlatformError(
			"IDEMPOTENCY_KEY_REQUIRED",
			"Idempotency-Key is required for mutations of paid provider objects",
		);
	}
	const { operationKeyHash, requestHash } = await durableOperationHashes(
		options.organizationId,
		options.payload.kind,
		options.operationKey,
		options.payload,
	);
	return options.db.transaction(async (tx) => {
		const admitted = await options.authorityAdmission(tx, {
			workspaceId: options.workspaceId,
			requireAllWorkspaceScope: options.workspaceId === null,
		});
		if (!admitted.ok) throwMutationAuthorityDenied(admitted.message);
		const now = admitted.value.admittedAt;
		const [inserted] = await tx
			.insert(adMutationOperations)
			.values({
				organizationId: options.organizationId,
				usageReservationId: options.usageReservation?.id ?? null,
				targetType: options.targetType,
				targetId: options.targetId,
				kind: options.payload.kind,
				platform: options.platform,
				operationKeyHash,
				requestHash,
				requestPayload: options.payload as unknown as Record<string, unknown>,
				requiresLiveAuthority: options.requiresLiveAuthority,
				...mutationAuthorityValues(admitted.value),
				createdAt: now,
				updatedAt: now,
				nextAttemptAt: now,
			})
			.onConflictDoNothing()
			.returning();
		const [sameKey] = inserted
			? [inserted]
			: await tx
					.select()
					.from(adMutationOperations)
					.where(
						and(
							eq(adMutationOperations.organizationId, options.organizationId),
							eq(adMutationOperations.targetType, options.targetType),
							eq(adMutationOperations.targetId, options.targetId),
							eq(adMutationOperations.operationKeyHash, operationKeyHash),
						),
					)
					.for("update")
					.limit(1);
		if (!sameKey) {
			const [active] = await tx
				.select()
				.from(adMutationOperations)
				.where(
					and(
						eq(adMutationOperations.organizationId, options.organizationId),
						eq(adMutationOperations.targetType, options.targetType),
						eq(adMutationOperations.targetId, options.targetId),
						inArray(adMutationOperations.status, [
							"pending",
							"processing",
							"request_may_have_been_sent",
							"unknown",
							"reconciling",
							"revocation_pending",
							"manual_review",
						]),
					),
				)
				.for("update")
				.limit(1);
			if (active) {
				await adoptDurableUsageReservationInTransaction(
					tx,
					active.usageReservationId,
					options.usageReservation,
				);
				try {
					operationError(active);
				} catch (error) {
					if (error instanceof AdPlatformError) {
						throw new AdAuthoritativeNotAppliedError(error);
					}
					throw error;
				}
			}
			throw new Error("Failed to persist a durable ad mutation");
		}
		await adoptDurableUsageReservationInTransaction(
			tx,
			sameKey.usageReservationId,
			options.usageReservation,
		);
		if (sameKey.requestHash !== requestHash) {
			throw new AdPlatformError(
				"IDEMPOTENCY_KEY_REUSED",
				"This Idempotency-Key was already used for a different ad mutation",
			);
		}
		if (!sameMutationAuthority(sameKey, admitted.value)) {
			throwMutationAuthorityDenied(
				"This Idempotency-Key belongs to a different or revoked credential authority; use a new key.",
			);
		}

		const [terminalOperatorDecision] = await tx
			.select({ action: operatorResolutionEvidence.action })
			.from(operatorResolutionEvidence)
			.where(
				and(
					eq(operatorResolutionEvidence.targetType, "ad_mutation_operation"),
					eq(operatorResolutionEvidence.targetId, sameKey.id),
					inArray(operatorResolutionEvidence.action, [
						"mark_succeeded",
						"mark_not_applied",
					]),
				),
			)
			.orderBy(
				sql`${operatorResolutionEvidence.resolvedAt} DESC`,
				sql`${operatorResolutionEvidence.id} DESC`,
			)
			.limit(1);
		if (terminalOperatorDecision?.action === "mark_not_applied") {
			await settleLinkedDurableUsageInTransaction(tx, {
				organizationId: sameKey.organizationId,
				usageReservationId: sameKey.usageReservationId,
				committed: false,
			});
			return { completed: sameKey };
		}
		if (sameKey.status === "completed") {
			await settleLinkedDurableUsageInTransaction(tx, {
				organizationId: sameKey.organizationId,
				usageReservationId: sameKey.usageReservationId,
				committed: true,
			});
			return { completed: sameKey };
		}
		if (
			sameKey.status === "unknown" ||
			sameKey.status === "request_may_have_been_sent" ||
			sameKey.status === "reconciling" ||
			sameKey.status === "revocation_pending" ||
			sameKey.status === "cancelled" ||
			sameKey.status === "manual_review"
		) {
			operationError(sameKey);
		}

		const [claimed] = await tx
			.update(adMutationOperations)
			.set({
				status: "processing",
				leaseToken: sql`${adMutationOperations.leaseToken} + 1`,
				leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
				requestMayHaveBeenSentAt: null,
				attempts: sql`${adMutationOperations.attempts} + 1`,
				lastError: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(adMutationOperations.id, sameKey.id),
					or(
						eq(adMutationOperations.status, "pending"),
						eq(adMutationOperations.status, "failed"),
						and(
							eq(adMutationOperations.status, "processing"),
							lte(adMutationOperations.leaseExpiresAt, now),
							isNull(adMutationOperations.requestMayHaveBeenSentAt),
						),
					),
				),
			)
			.returning();
		if (!claimed) operationError(sameKey);
		return { row: claimed, leaseToken: claimed.leaseToken };
	});
}

async function resolveProviderContext(
	db: Database,
	organizationId: string,
	adAccountId: string,
	env: Env,
): Promise<{
	adapter: AdPlatformAdapter;
	accessToken: string;
	credentials: AdProviderCredentials;
	platform: AdPlatform;
}> {
	const [row] = await db
		.select({
			adAccount: adAccounts,
			adConnection: adConnections,
			socialAccount: socialAccounts,
		})
		.from(adAccounts)
		.leftJoin(
			adConnections,
			and(
				eq(adAccounts.adConnectionId, adConnections.id),
				eq(adConnections.organizationId, organizationId),
			),
		)
		.leftJoin(
			socialAccounts,
			and(
				eq(adAccounts.socialAccountId, socialAccounts.id),
				eq(socialAccounts.organizationId, organizationId),
			),
		)
		.innerJoin(organization, eq(organization.id, organizationId))
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, organizationId),
				eq(adAccounts.status, "active"),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	const authorityIsActive = row?.adConnection
		? row.adConnection.status === "active" &&
			row.adConnection.workspaceId === row.adAccount.workspaceId
		: row?.socialAccount?.lifecycleStatus === "active" &&
			row.socialAccount.workspaceId === row.adAccount.workspaceId;
	if (!row || !authorityIsActive) {
		throw new AdPlatformError(
			"MANUAL_REVIEW_REQUIRED",
			"The provider credential for this mutation is no longer available",
		);
	}
	const adapter = getAdPlatformAdapter(row.adAccount.platform);
	if (!adapter) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			"No provider adapter is available for this mutation",
		);
	}
	const credentials = await resolveAdProviderCredentials({
		platform: row.adAccount.platform,
		providerAdAccountId: row.adAccount.platformAdAccountId,
		adConnection: row.adConnection,
		legacySocialAccount: row.socialAccount,
		env,
	});
	return {
		adapter,
		accessToken: credentials.accessToken,
		credentials,
		platform: row.adAccount.platform,
	};
}

async function markBoundary(
	env: Env,
	db: Database,
	claim: ClaimedMutation,
): Promise<AdProviderBoundaryContext> {
	const outcome = await db.transaction(async (tx) => {
		// Emergency pause/cancel/decrease mutations may bypass plan-entitlement
		// gates, but never credential or session revocation. Provider I/O always
		// linearizes against the exact durable admitting authority.
		const authority = await revalidateDurableCredentialAuthority(
			tx,
			mutationAuthoritySnapshot(claim.row),
			"manage_spend",
		);
		const [current] = await tx
			.select()
			.from(adMutationOperations)
			.where(eq(adMutationOperations.id, claim.row.id))
			.for("update")
			.limit(1);
		if (
			!current ||
			current.leaseToken !== claim.leaseToken ||
			!(
				["processing", "reconciling", "request_may_have_been_sent"] as const
			).includes(current.status as never) ||
			current.authorityRevision !== claim.row.authorityRevision
		) {
			return { kind: "lease_lost" } as const;
		}
		const payload = payloadOf(current);
		const providerAuthority = authority.ok
			? await lockAdProviderBoundary(tx, env, {
					organizationId: current.organizationId,
					workspaceId: current.authorityWorkspaceId,
					adAccountId: payload.adAccountId,
					platform: current.platform,
					requiresLiveEntitlement: current.requiresLiveAuthority,
				})
			: ({ ok: false, message: authority.message } as const);
		const now = new Date();
		if (!providerAuthority.ok) {
			const hasEffect =
				current.providerConfirmedAt !== null ||
				current.requestMayHaveBeenSentAt !== null ||
				current.phase !== "provider";
			const [revoked] = await tx
				.update(adMutationOperations)
				.set({
					status: hasEffect ? "manual_review" : "cancelled",
					authorityRevokedAt: hasEffect ? null : now,
					leaseExpiresAt: null,
					lastError: providerAuthority.message,
					updatedAt: now,
				})
				.where(
					and(
						eq(adMutationOperations.id, current.id),
						eq(adMutationOperations.leaseToken, claim.leaseToken),
						inArray(adMutationOperations.status, [
							"processing",
							"reconciling",
							"request_may_have_been_sent",
						]),
						eq(
							adMutationOperations.authorityRevision,
							claim.row.authorityRevision,
						),
					),
				)
				.returning({ id: adMutationOperations.id });
			if (!revoked) return { kind: "lease_lost" } as const;
			return {
				kind: hasEffect ? "manual_review" : "cancelled",
				organizationId: current.organizationId,
				usageReservationId: current.usageReservationId,
			} as const;
		}
		const changed = await tx
			.update(adMutationOperations)
			.set({
				status: "request_may_have_been_sent",
				requestMayHaveBeenSentAt: current.requestMayHaveBeenSentAt ?? now,
				leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
				updatedAt: now,
			})
			.where(
				and(
					eq(adMutationOperations.id, claim.row.id),
					inArray(adMutationOperations.status, [
						"processing",
						"reconciling",
						"request_may_have_been_sent",
					]),
					eq(adMutationOperations.leaseToken, claim.leaseToken),
					eq(
						adMutationOperations.authorityRevision,
						claim.row.authorityRevision,
					),
				),
			)
			.returning({ id: adMutationOperations.id });
		return changed.length === 1
			? ({ kind: "opened", context: providerAuthority.context } as const)
			: ({ kind: "lease_lost" } as const);
	});
	if (outcome.kind === "cancelled") {
		await settleLinkedDurableUsage(db, {
			organizationId: outcome.organizationId,
			usageReservationId: outcome.usageReservationId,
			committed: false,
		});
		throwMutationAuthorityDenied(
			"The provider mutation was cancelled because its admitting credential is no longer authorized.",
		);
	}
	if (outcome.kind === "manual_review") {
		throw new AdPlatformError(
			"AD_MUTATION_MANUAL_REVIEW",
			"Live provider authority ended after a mutation effect; the operation now requires operator review.",
		);
	}
	if (outcome.kind === "lease_lost") {
		throw new AdPlatformError(
			"OPERATION_LEASE_LOST",
			"The mutation lease was lost before the provider request",
		);
	}
	if (!outcome.context)
		throw new Error("Ad mutation provider context was not returned");
	return outcome.context;
}

async function failBeforeBoundary(
	db: Database,
	claim: ClaimedMutation,
	error: unknown,
): Promise<void> {
	const now = new Date();
	const exhausted = claim.row.attempts >= MANUAL_REVIEW_ATTEMPTS;
	await db
		.update(adMutationOperations)
		.set({
			status: exhausted ? "manual_review" : "failed",
			leaseExpiresAt: null,
			requestMayHaveBeenSentAt: null,
			lastError: error instanceof Error ? error.message : String(error),
			nextAttemptAt: new Date(
				now.getTime() + reconciliationDelay(claim.row.attempts),
			),
			updatedAt: now,
		})
		.where(
			and(
				eq(adMutationOperations.id, claim.row.id),
				inArray(adMutationOperations.status, ["processing", "reconciling"]),
				eq(adMutationOperations.leaseToken, claim.leaseToken),
				isNull(adMutationOperations.requestMayHaveBeenSentAt),
			),
		);
}

async function callProvider(
	initialContext: AdProviderBoundaryContext,
	payload: AdMutationPayload,
	refreshContext: () => Promise<AdProviderBoundaryContext>,
): Promise<void> {
	let providerWrites = 0;
	const contextForWrite = async (): Promise<AdProviderBoundaryContext> => {
		const context =
			providerWrites === 0 ? initialContext : await refreshContext();
		providerWrites += 1;
		return context;
	};
	const activateHierarchy = async (
		platformCampaignId: string,
		platformAdSetId: string,
	): Promise<void> => {
		const context = await contextForWrite();
		await context.adapter.creation.activateBoost(
			context.accessToken,
			platformCampaignId,
			platformAdSetId,
			async () => {
				const refreshed = await refreshContext();
				providerWrites += 1;
				return refreshed.accessToken;
			},
			context.credentials,
		);
	};

	switch (payload.kind) {
		case "cancel_ad": {
			const context = await contextForWrite();
			await context.adapter.cancelAd(
				context.accessToken,
				payload.platformAdId,
				context.credentials,
			);
			return;
		}
		case "cancel_campaign": {
			const context = await contextForWrite();
			await context.adapter.pauseCampaign(
				context.accessToken,
				payload.platformCampaignId,
				context.credentials,
			);
			return;
		}
		case "update_ad": {
			if (payload.changes.status === "active") {
				if (!payload.platformCampaignId || !payload.platformAdSetId) {
					throw new AdPlatformError(
						"MANUAL_REVIEW_REQUIRED",
						"The provider campaign hierarchy is incomplete",
					);
				}
				await activateHierarchy(
					payload.platformCampaignId,
					payload.platformAdSetId,
				);
			}
			if (
				payload.changes.name !== undefined ||
				payload.changes.status !== undefined
			) {
				const context = await contextForWrite();
				await context.adapter.updateAd(
					context.accessToken,
					payload.platformAdId,
					{
						name: payload.changes.name,
						status: payload.changes.status,
					},
					undefined,
					context.credentials,
				);
			}
			if (
				payload.changes.dailyBudgetCents !== undefined ||
				payload.changes.lifetimeBudgetCents !== undefined ||
				payload.changes.targeting !== undefined
			) {
				const context = await contextForWrite();
				await context.adapter.updateAd(
					context.accessToken,
					payload.platformAdId,
					{
						dailyBudgetCents: payload.changes.dailyBudgetCents,
						lifetimeBudgetCents: payload.changes.lifetimeBudgetCents,
						targeting: payload.changes.targeting,
					},
					async () => {
						const refreshed = await refreshContext();
						providerWrites += 1;
						return refreshed.accessToken;
					},
					context.credentials,
				);
			}
			return;
		}
		case "update_campaign": {
			if (payload.changes.status === "paused") {
				const context = await contextForWrite();
				await context.adapter.pauseCampaign(
					context.accessToken,
					payload.platformCampaignId,
					context.credentials,
				);
			}
			if (payload.changes.name !== undefined) {
				const context = await contextForWrite();
				await context.adapter.updateCampaign(
					context.accessToken,
					payload.platformCampaignId,
					payload.platformAdSetId,
					{ name: payload.changes.name },
					context.credentials,
				);
			}
			if (
				payload.changes.dailyBudgetCents !== undefined ||
				payload.changes.lifetimeBudgetCents !== undefined
			) {
				const context = await contextForWrite();
				await context.adapter.updateCampaign(
					context.accessToken,
					payload.platformCampaignId,
					payload.platformAdSetId,
					{
						dailyBudgetCents: payload.changes.dailyBudgetCents,
						lifetimeBudgetCents: payload.changes.lifetimeBudgetCents,
					},
					context.credentials,
				);
			}
			if (payload.changes.status === "active") {
				if (payload.platformAdSetId) {
					await activateHierarchy(
						payload.platformCampaignId,
						payload.platformAdSetId,
					);
				} else {
					const context = await contextForWrite();
					await context.adapter.resumeCampaign(
						context.accessToken,
						payload.platformCampaignId,
						context.credentials,
					);
				}
				for (const platformAdId of payload.childPlatformAdIds) {
					const context = await contextForWrite();
					await context.adapter.resumeAd(
						context.accessToken,
						platformAdId,
						context.credentials,
					);
				}
			}
		}
	}
}

async function confirmProvider(
	db: Database,
	claim: ClaimedMutation,
): Promise<void> {
	const now = new Date();
	const changed = await db
		.update(adMutationOperations)
		.set({
			status: "processing",
			phase: "projection",
			requestMayHaveBeenSentAt: null,
			providerConfirmedAt: now,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(adMutationOperations.id, claim.row.id),
				eq(adMutationOperations.status, "request_may_have_been_sent"),
				eq(adMutationOperations.leaseToken, claim.leaseToken),
			),
		)
		.returning({
			id: adMutationOperations.id,
			organizationId: adMutationOperations.organizationId,
			usageReservationId: adMutationOperations.usageReservationId,
		});
	if (changed.length !== 1) throw new Error("Ad mutation provider fence lost");
	await settleLinkedDurableUsage(db, {
		organizationId: changed[0]?.organizationId ?? claim.row.organizationId,
		usageReservationId:
			changed[0]?.usageReservationId ?? claim.row.usageReservationId,
		committed: true,
	});
}

function payloadOf(row: Operation): AdMutationPayload {
	const payload = row.requestPayload as unknown as AdMutationPayload;
	if (!payload || payload.kind !== row.kind) {
		throw new Error("Durable ad mutation payload is invalid");
	}
	return payload;
}

async function projectMutation(
	tx: Transaction,
	row: Operation,
	now: Date,
): Promise<void> {
	const payload = payloadOf(row);
	switch (payload.kind) {
		case "cancel_ad": {
			const updated = await tx
				.update(ads)
				.set({ status: "cancelled", updatedAt: now })
				.where(
					and(
						eq(ads.id, payload.adId),
						eq(ads.organizationId, row.organizationId),
					),
				)
				.returning({ id: ads.id });
			if (updated.length !== 1) throw new Error("Ad projection target missing");
			break;
		}
		case "update_ad": {
			if (payload.changes.status === "active") {
				await tx
					.update(adCampaigns)
					.set({ status: "active", updatedAt: now })
					.where(
						and(
							eq(adCampaigns.id, payload.campaignId),
							eq(adCampaigns.organizationId, row.organizationId),
						),
					);
			}
			const updated = await tx
				.update(ads)
				.set({ ...payload.changes, updatedAt: now })
				.where(
					and(
						eq(ads.id, payload.adId),
						eq(ads.organizationId, row.organizationId),
					),
				)
				.returning({ id: ads.id });
			if (updated.length !== 1) throw new Error("Ad projection target missing");
			break;
		}
		case "cancel_campaign": {
			const updated = await tx
				.update(adCampaigns)
				.set({ status: "cancelled", updatedAt: now })
				.where(
					and(
						eq(adCampaigns.id, payload.campaignId),
						eq(adCampaigns.organizationId, row.organizationId),
					),
				)
				.returning({ id: adCampaigns.id });
			if (updated.length !== 1) {
				throw new Error("Campaign projection target missing");
			}
			await tx
				.update(ads)
				.set({ status: "paused", updatedAt: now })
				.where(
					and(
						eq(ads.campaignId, payload.campaignId),
						eq(ads.organizationId, row.organizationId),
						sql`${ads.status} NOT IN ('completed', 'rejected', 'cancelled')`,
					),
				);
			break;
		}
		case "update_campaign": {
			const updated = await tx
				.update(adCampaigns)
				.set({ ...payload.changes, updatedAt: now })
				.where(
					and(
						eq(adCampaigns.id, payload.campaignId),
						eq(adCampaigns.organizationId, row.organizationId),
					),
				)
				.returning({ id: adCampaigns.id });
			if (updated.length !== 1) {
				throw new Error("Campaign projection target missing");
			}
			if (payload.changes.status !== undefined) {
				await tx
					.update(ads)
					.set({ status: payload.changes.status, updatedAt: now })
					.where(
						and(
							eq(ads.campaignId, payload.campaignId),
							eq(ads.organizationId, row.organizationId),
							sql`${ads.status} NOT IN ('completed', 'rejected', 'cancelled')`,
						),
					);
			}
			break;
		}
	}
}

async function completeProjection(
	db: Database,
	operationId: string,
	leaseToken: number,
): Promise<void> {
	await db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(adMutationOperations)
			.where(eq(adMutationOperations.id, operationId))
			.for("update")
			.limit(1);
		if (
			!row ||
			row.leaseToken !== leaseToken ||
			row.phase !== "projection" ||
			row.providerConfirmedAt === null ||
			!(row.status === "processing" || row.status === "reconciling")
		) {
			throw new Error("Ad mutation projection fence lost");
		}
		const now = new Date();
		await projectMutation(tx, row, now);
		const changed = await tx
			.update(adMutationOperations)
			.set({
				status: "completed",
				phase: "completed",
				leaseExpiresAt: null,
				requestMayHaveBeenSentAt: null,
				lastError: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(adMutationOperations.id, row.id),
					eq(adMutationOperations.leaseToken, leaseToken),
					eq(adMutationOperations.phase, "projection"),
				),
			)
			.returning({ id: adMutationOperations.id });
		if (changed.length !== 1)
			throw new Error("Ad mutation completion fence lost");
	});
}

async function deferProjection(
	db: Database,
	claim: ClaimedMutation,
	error: unknown,
): Promise<void> {
	const now = new Date();
	const exhausted = claim.row.attempts >= MANUAL_REVIEW_ATTEMPTS;
	await db
		.update(adMutationOperations)
		.set({
			status: exhausted ? "manual_review" : "pending",
			leaseExpiresAt: null,
			nextAttemptAt: new Date(
				now.getTime() + reconciliationDelay(claim.row.attempts),
			),
			lastError: error instanceof Error ? error.message : String(error),
			updatedAt: now,
		})
		.where(
			and(
				eq(adMutationOperations.id, claim.row.id),
				eq(adMutationOperations.leaseToken, claim.leaseToken),
				eq(adMutationOperations.phase, "projection"),
			),
		);
}

async function markUnknown(
	db: Database,
	claim: ClaimedMutation,
	error: unknown,
): Promise<void> {
	const attempts = claim.row.attempts;
	const now = new Date();
	await db
		.update(adMutationOperations)
		.set({
			status: attempts >= MANUAL_REVIEW_ATTEMPTS ? "manual_review" : "unknown",
			leaseExpiresAt: null,
			nextAttemptAt: new Date(now.getTime() + reconciliationDelay(attempts)),
			lastError: error instanceof Error ? error.message : String(error),
			updatedAt: now,
		})
		.where(
			and(
				eq(adMutationOperations.id, claim.row.id),
				eq(adMutationOperations.leaseToken, claim.leaseToken),
				or(
					eq(adMutationOperations.status, "request_may_have_been_sent"),
					eq(adMutationOperations.status, "reconciling"),
				),
			),
		);
}

function reconciliationDelay(attempts: number): number {
	return Math.min(6 * 60 * 60_000, 2 ** Math.min(attempts, 8) * 60_000);
}

export async function executeAdMutation(options: {
	env: Env;
	db: Database;
	organizationId: string;
	targetType: "ad" | "campaign";
	targetId: string;
	workspaceId: string | null;
	platform: AdPlatform;
	operationKey: string | undefined;
	payload: AdMutationPayload;
	usageReservation?: UsageReservation;
	authorityAdmission: DurableCredentialAuthorityAdmission;
	requiresLiveAuthority: boolean;
}): Promise<void> {
	const adapter = getAdPlatformAdapter(options.platform);
	if (!adapter) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_PLATFORM",
			"No provider adapter is available for this mutation",
		);
	}
	try {
		adapter.validateMutation?.(options.payload);
	} catch (error) {
		if (error instanceof AdPlatformError) {
			throw new AdAuthoritativeNotAppliedError(error);
		}
		throw error;
	}
	const begun = await beginMutation(options);
	if ("completed" in begun) return;
	// A provider-confirmed operation can be left pending solely because its
	// local projection failed. Retrying the same idempotency key must resume the
	// fenced DB projection; sending the provider mutation again would reopen the
	// external side-effect boundary we already closed.
	if (
		begun.row.phase === "projection" &&
		begun.row.providerConfirmedAt !== null
	) {
		try {
			await completeProjection(options.db, begun.row.id, begun.leaseToken);
			return;
		} catch (error) {
			await deferProjection(options.db, begun, error).catch(() => {});
			throw new AdPlatformError(
				"AD_MUTATION_IN_PROGRESS",
				"The provider confirmed the mutation; its fenced local projection will be retried.",
				error,
			);
		}
	}
	const context = await markBoundary(options.env, options.db, begun);
	try {
		await callProvider(context, options.payload, () =>
			markBoundary(options.env, options.db, begun),
		);
	} catch (error) {
		await markUnknown(options.db, begun, error).catch(() => {});
		if (
			error instanceof AdPlatformError &&
			error.code === "AD_MUTATION_MANUAL_REVIEW"
		) {
			throw error;
		}
		throw new AdPlatformError(
			"AD_MUTATION_UNKNOWN",
			"The provider may have applied all or part of the mutation. Local state remains unchanged pending reconciliation.",
			error,
		);
	}
	try {
		await confirmProvider(options.db, begun);
	} catch (error) {
		// The provider response was definitive. The row remains discoverable as a
		// terminal mismatch until confirmation/usage settlement can be retried.
		throw new AdPlatformError(
			"AD_MUTATION_IN_PROGRESS",
			"The provider confirmed the mutation; durable settlement is being reconciled.",
			error,
		);
	}
	try {
		await completeProjection(options.db, begun.row.id, begun.leaseToken);
	} catch (error) {
		await deferProjection(options.db, begun, error).catch(() => {});
		throw new AdPlatformError(
			"AD_MUTATION_IN_PROGRESS",
			"The provider confirmed the mutation; its fenced local projection will be retried.",
			error,
		);
	}
}

function exactOrIgnored<T>(
	actual: T | null | undefined,
	expected: T | undefined,
) {
	return expected === undefined || actual === expected;
}

function subsetMatches(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			stableOperationJson(actual) === stableOperationJson(expected)
		);
	}
	if (expected && typeof expected === "object") {
		if (!actual || typeof actual !== "object" || Array.isArray(actual))
			return false;
		return Object.entries(expected as Record<string, unknown>).every(
			([key, value]) =>
				subsetMatches((actual as Record<string, unknown>)[key], value),
		);
	}
	return actual === expected;
}

export function adMutationStateMatches(
	payload: UpdateAdMutationPayload | CancelAdMutationPayload,
	state: AdProviderMutationState,
	ancestor?: CampaignProviderMutationState,
): boolean {
	if (payload.kind === "cancel_ad") {
		return !state.exists || state.status === "DELETED";
	}
	if (!state.exists) return false;
	const expectedStatus =
		payload.changes.status === undefined
			? undefined
			: payload.changes.status === "active"
				? "ACTIVE"
				: "PAUSED";
	if (!exactOrIgnored(state.name, payload.changes.name)) return false;
	if (!exactOrIgnored(state.status, expectedStatus)) return false;
	if (
		!exactOrIgnored(state.dailyBudgetCents, payload.changes.dailyBudgetCents)
	) {
		return false;
	}
	if (
		!exactOrIgnored(
			state.lifetimeBudgetCents,
			payload.changes.lifetimeBudgetCents,
		)
	) {
		return false;
	}
	if (
		payload.expectedProviderTargeting &&
		!subsetMatches(state.targeting, payload.expectedProviderTargeting)
	) {
		return false;
	}
	return (
		payload.changes.status !== "active" ||
		(ancestor?.status === "ACTIVE" &&
			(!payload.platformAdSetId || ancestor.adSetStatus === "ACTIVE"))
	);
}

export function campaignMutationStateMatches(
	payload: UpdateCampaignMutationPayload | CancelCampaignMutationPayload,
	state: CampaignProviderMutationState,
	children: AdProviderMutationState[] = [],
): boolean {
	if (!state.exists) return false;
	if (payload.kind === "cancel_campaign") return state.status === "PAUSED";
	const expectedStatus =
		payload.changes.status === undefined
			? undefined
			: payload.changes.status === "active"
				? "ACTIVE"
				: "PAUSED";
	if (!exactOrIgnored(state.name, payload.changes.name)) return false;
	if (!exactOrIgnored(state.status, expectedStatus)) return false;
	if (
		payload.changes.status === "active" &&
		payload.platformAdSetId &&
		state.adSetStatus !== "ACTIVE"
	) {
		return false;
	}
	if (
		!exactOrIgnored(state.dailyBudgetCents, payload.changes.dailyBudgetCents)
	) {
		return false;
	}
	if (
		!exactOrIgnored(
			state.lifetimeBudgetCents,
			payload.changes.lifetimeBudgetCents,
		)
	) {
		return false;
	}
	return (
		payload.changes.status !== "active" ||
		children.every((child) => child.exists && child.status === "ACTIVE")
	);
}

async function providerMatches(
	adapter: AdPlatformAdapter,
	accessToken: string,
	credentials: AdProviderCredentials,
	payload: AdMutationPayload,
): Promise<boolean> {
	if (payload.kind === "update_ad" || payload.kind === "cancel_ad") {
		const state = await adapter.inspectAdMutation(
			accessToken,
			payload.platformAdId,
			credentials,
		);
		const ancestor =
			payload.kind === "update_ad" &&
			payload.changes.status === "active" &&
			payload.platformCampaignId
				? await adapter.inspectCampaignMutation(
						accessToken,
						payload.platformCampaignId,
						payload.platformAdSetId,
						credentials,
					)
				: undefined;
		return adMutationStateMatches(payload, state, ancestor);
	}
	const state = await adapter.inspectCampaignMutation(
		accessToken,
		payload.platformCampaignId,
		payload.kind === "update_campaign" ? payload.platformAdSetId : undefined,
		credentials,
	);
	const children =
		payload.kind === "update_campaign" && payload.changes.status === "active"
			? await Promise.all(
					payload.childPlatformAdIds.map((id) =>
						adapter.inspectAdMutation(accessToken, id, credentials),
					),
				)
			: [];
	return campaignMutationStateMatches(payload, state, children);
}

async function claimForReconciliation(
	db: Database,
	row: Operation,
	now: Date,
): Promise<ClaimedMutation | null> {
	const projection = row.phase === "projection";
	const [claimed] = await db
		.update(adMutationOperations)
		.set({
			status: projection ? "processing" : "reconciling",
			leaseToken: sql`${adMutationOperations.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			attempts: sql`${adMutationOperations.attempts} + 1`,
			updatedAt: now,
		})
		.where(
			and(
				eq(adMutationOperations.id, row.id),
				eq(adMutationOperations.leaseToken, row.leaseToken),
				notExists(
					db
						.select({ id: operatorResolutionEvidence.id })
						.from(operatorResolutionEvidence)
						.where(
							and(
								eq(
									operatorResolutionEvidence.targetType,
									"ad_mutation_operation",
								),
								eq(
									operatorResolutionEvidence.targetId,
									adMutationOperations.id,
								),
								eq(operatorResolutionEvidence.action, "mark_not_applied"),
							),
						),
				),
				or(
					eq(adMutationOperations.status, "pending"),
					eq(adMutationOperations.status, "failed"),
					eq(adMutationOperations.status, "unknown"),
					and(
						inArray(adMutationOperations.status, [
							"processing",
							"request_may_have_been_sent",
							"reconciling",
						]),
						lte(adMutationOperations.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning();
	return claimed ? { row: claimed, leaseToken: claimed.leaseToken } : null;
}

export async function reconcileAdMutationOperations(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select()
		.from(adMutationOperations)
		.where(
			and(
				notExists(
					db
						.select({ id: operatorResolutionEvidence.id })
						.from(operatorResolutionEvidence)
						.where(
							and(
								eq(
									operatorResolutionEvidence.targetType,
									"ad_mutation_operation",
								),
								eq(
									operatorResolutionEvidence.targetId,
									adMutationOperations.id,
								),
								eq(operatorResolutionEvidence.action, "mark_not_applied"),
							),
						),
				),
				inArray(adMutationOperations.status, [
					"pending",
					"failed",
					"unknown",
					"processing",
					"request_may_have_been_sent",
					"reconciling",
				]),
				lte(adMutationOperations.nextAttemptAt, now),
				or(
					isNull(adMutationOperations.leaseExpiresAt),
					lte(adMutationOperations.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(adMutationOperations.nextAttemptAt, adMutationOperations.createdAt)
		.limit(10);
	for (const candidate of candidates) {
		const safeToSend =
			candidate.status === "pending" ||
			candidate.status === "failed" ||
			(candidate.status === "processing" &&
				candidate.requestMayHaveBeenSentAt === null);
		const claim = await claimForReconciliation(db, candidate, new Date());
		if (!claim) continue;
		if (claim.row.phase === "projection") {
			try {
				await completeProjection(db, claim.row.id, claim.leaseToken);
			} catch (error) {
				await deferProjection(db, claim, error);
			}
			continue;
		}
		let payload: AdMutationPayload;
		try {
			payload = payloadOf(claim.row);
		} catch (error) {
			if (safeToSend) await failBeforeBoundary(db, claim, error);
			else await markUnknown(db, claim, error);
			continue;
		}

		if (safeToSend) {
			let boundaryOpen = false;
			try {
				const context = await markBoundary(env, db, claim);
				boundaryOpen = true;
				await callProvider(context, payload, () =>
					markBoundary(env, db, claim),
				);
				await confirmProvider(db, claim);
			} catch (error) {
				if (boundaryOpen) await markUnknown(db, claim, error);
				else await failBeforeBoundary(db, claim, error);
				continue;
			}
			try {
				await completeProjection(db, claim.row.id, claim.leaseToken);
			} catch (error) {
				await deferProjection(db, claim, error);
			}
			continue;
		}

		let context: Awaited<ReturnType<typeof resolveProviderContext>>;
		try {
			context = await resolveProviderContext(
				db,
				claim.row.organizationId,
				payload.adAccountId,
				env,
			);
			if (context.platform !== claim.row.platform) {
				throw new Error(
					"The provider identity changed before reconciliation completed",
				);
			}
		} catch (error) {
			await markUnknown(db, claim, error);
			continue;
		}

		let confirmed: Operation | undefined;
		try {
			if (
				!(await providerMatches(
					context.adapter,
					context.accessToken,
					context.credentials,
					payload,
				))
			) {
				await markUnknown(
					db,
					claim,
					"Canonical provider state does not match the requested mutation",
				);
				continue;
			}
			const confirmedAt = new Date();
			[confirmed] = await db
				.update(adMutationOperations)
				.set({
					status: "reconciling",
					phase: "projection",
					requestMayHaveBeenSentAt: null,
					providerConfirmedAt: confirmedAt,
					lastError: null,
					updatedAt: confirmedAt,
				})
				.where(
					and(
						eq(adMutationOperations.id, claim.row.id),
						eq(adMutationOperations.status, "reconciling"),
						eq(adMutationOperations.leaseToken, claim.leaseToken),
					),
				)
				.returning();
			if (!confirmed) continue;
		} catch (error) {
			await markUnknown(db, claim, error);
			continue;
		}
		try {
			await completeProjection(db, confirmed.id, confirmed.leaseToken);
		} catch (error) {
			// Canonical provider confirmation closes the external mutation
			// boundary. A local projection failure is DB-only work and must never
			// be demoted back to an ambiguous provider outcome.
			await deferProjection(
				db,
				{ row: confirmed, leaseToken: confirmed.leaseToken },
				error,
			);
		}
	}
}

/** Used by the append-only operator-resolution transaction after an operator
 * has supplied evidence that the provider mutation fully succeeded. */
export async function projectOperatorConfirmedAdMutation(
	tx: Transaction,
	row: Operation,
	resolvedAt: Date,
): Promise<Operation> {
	await projectMutation(tx, row, resolvedAt);
	const [updated] = await tx
		.update(adMutationOperations)
		.set({
			status: "completed",
			phase: "completed",
			providerConfirmedAt: resolvedAt,
			requestMayHaveBeenSentAt: null,
			leaseToken: sql`${adMutationOperations.leaseToken} + 1`,
			leaseExpiresAt: null,
			lastError: null,
			completedAt: resolvedAt,
			updatedAt: resolvedAt,
		})
		.where(
			and(
				eq(adMutationOperations.id, row.id),
				eq(adMutationOperations.status, row.status),
				eq(adMutationOperations.leaseToken, row.leaseToken),
			),
		)
		.returning();
	if (!updated) throw new Error("Ad mutation operator fence lost");
	return updated;
}
