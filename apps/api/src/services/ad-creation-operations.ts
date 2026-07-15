import {
	adAccounts,
	adCampaigns,
	adCreationOperations,
	ads,
	createDb,
	type Database,
	eq,
	organization,
	socialAccounts,
} from "@relayapi/db";
import { and, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { durableOperationHashes } from "../lib/durable-operation";
import type { Env } from "../types";
import { resolveAdsAccessToken } from "./ad-access-token";
import { getAdPlatformAdapter } from "./ad-platforms";
import type {
	AdPlatform,
	AdPlatformAdapter,
	AdProviderObjectPhase,
	AdTargeting,
} from "./ad-platforms/types";
import { AdPlatformError } from "./ad-platforms/types";

const LEASE_MS = 2 * 60_000;

export type AdCreationOperationKind =
	| "create_campaign"
	| "create_ad"
	| "boost_post";

export type AdCreationOperation = typeof adCreationOperations.$inferSelect;
type Operation = AdCreationOperation;

export type AdCreationPhase = Exclude<Operation["phase"], "completed">;

export interface AdOperationProviderIds {
	platformCampaignId?: string | null;
	platformAdSetId?: string | null;
	platformCreativeId?: string | null;
	platformAdId?: string | null;
}

export interface AdOperationResultIds extends AdOperationProviderIds {
	localCampaignId?: string | null;
	localAdId?: string | null;
}

interface BeginOptions {
	db: Database;
	organizationId: string;
	workspaceId: string | null;
	adAccountId: string;
	kind: AdCreationOperationKind;
	platform: AdPlatform;
	operationKey: string | undefined;
	request: Record<string, unknown>;
}

export interface ClaimedAdOperation {
	row: Operation;
	leaseToken: number;
}

export type AdCreationReplayState =
	| "not_started"
	| "safe"
	| "lease_active"
	| "unsafe"
	| "completed";

export function classifyAdCreationReplayState(
	row:
			| Pick<
					Operation,
					| "status"
					| "leaseExpiresAt"
					| "requestMayHaveBeenSentAt"
					| "platformCampaignId"
					| "platformAdSetId"
					| "platformCreativeId"
					| "platformAdId"
		  >
		| undefined,
	now: Date = new Date(),
): AdCreationReplayState {
	if (!row) return "not_started";
	if (row.status === "completed") return "completed";
	if (row.status === "pending" || row.status === "failed") return "safe";
	if (
		row.status === "processing" &&
		!row.requestMayHaveBeenSentAt &&
		!row.platformCampaignId &&
		!row.platformAdSetId &&
		!row.platformCreativeId &&
		!row.platformAdId
	) {
		return row.leaseExpiresAt && row.leaseExpiresAt > now
			? "lease_active"
			: "safe";
	}
	return "unsafe";
}

/**
 * Classify an operator Queue replay without opening a provider boundary.
 * The operation-key hash does not depend on the request body, so this also
 * works for boost requests whose canonical payload gains a resolved post ID.
 */
export async function getAdCreationReplayState(
	db: Database,
	organizationId: string,
	kind: Extract<AdCreationOperationKind, "create_ad" | "boost_post">,
	operationKey: string,
	now: Date = new Date(),
): Promise<AdCreationReplayState> {
	const { operationKeyHash } = await durableOperationHashes(
		organizationId,
		kind,
		operationKey,
		null,
	);
	const [row] = await db
		.select({
			status: adCreationOperations.status,
			leaseExpiresAt: adCreationOperations.leaseExpiresAt,
			requestMayHaveBeenSentAt: adCreationOperations.requestMayHaveBeenSentAt,
			platformCampaignId: adCreationOperations.platformCampaignId,
			platformAdSetId: adCreationOperations.platformAdSetId,
			platformCreativeId: adCreationOperations.platformCreativeId,
			platformAdId: adCreationOperations.platformAdId,
		})
		.from(adCreationOperations)
		.where(
			and(
				eq(adCreationOperations.organizationId, organizationId),
				eq(adCreationOperations.kind, kind),
				eq(adCreationOperations.operationKeyHash, operationKeyHash),
			),
		)
		.limit(1);
	return classifyAdCreationReplayState(row, now);
}

function operationError(row: Operation): never {
	if (row.status === "completed") {
		throw new AdPlatformError(
			"OPERATION_RESULT_MISSING",
			"The paid operation completed but its local result is unavailable",
		);
	}
	if (row.status === "manual_review") {
		throw new AdPlatformError(
			"MANUAL_REVIEW_REQUIRED",
			"The provider outcome requires manual review; no automatic replay was attempted",
		);
	}
	if (
		row.status === "unknown" ||
		row.status === "request_may_have_been_sent" ||
		row.status === "reconciling"
	) {
		throw new AdPlatformError(
			"UNKNOWN_EXTERNAL_OUTCOME",
			"The provider may have created paid objects. RelayAPI is reconciling the operation and will not replay it automatically.",
		);
	}
	throw new AdPlatformError(
		"OPERATION_IN_PROGRESS",
		"This paid operation is already in progress",
	);
}

export async function beginAdCreationOperation(
	options: BeginOptions,
): Promise<ClaimedAdOperation | { completed: Operation }> {
	if (!options.operationKey) {
		throw new AdPlatformError(
			"IDEMPOTENCY_KEY_REQUIRED",
			"Idempotency-Key is required for paid-object creation",
		);
	}

	const { operationKeyHash, requestHash } = await durableOperationHashes(
		options.organizationId,
		options.kind,
		options.operationKey,
		options.request,
	);
	const now = new Date();
	const [inserted] = await options.db
		.insert(adCreationOperations)
		.values({
			organizationId: options.organizationId,
			workspaceId: options.workspaceId,
			adAccountId: options.adAccountId,
			kind: options.kind,
			operationKeyHash,
			requestHash,
			requestPayload: options.request,
			platform: options.platform,
			phase: "campaign",
			nextAttemptAt: now,
		})
		.onConflictDoNothing()
		.returning();

	const row =
		inserted ??
		(
			await options.db
				.select()
				.from(adCreationOperations)
				.where(
					and(
						eq(adCreationOperations.organizationId, options.organizationId),
						eq(adCreationOperations.kind, options.kind),
						eq(adCreationOperations.operationKeyHash, operationKeyHash),
					),
				)
				.limit(1)
		)[0];
	if (!row) throw new Error("Failed to create durable ad operation");
	if (row.requestHash !== requestHash) {
		throw new AdPlatformError(
			"IDEMPOTENCY_KEY_REUSED",
			"This Idempotency-Key was already used for a different paid operation request",
		);
	}
	if (row.status === "completed") return { completed: row };

	// A duplicate request must never steal an active provider boundary. The
	// scheduled reconciler claims it only after the durable lease expires.
	if (row.status === "request_may_have_been_sent") {
		operationError(row);
	}
	if (
		row.status === "unknown" ||
		row.status === "reconciling" ||
		row.status === "manual_review"
	) {
		operationError(row);
	}

	const [claimed] = await options.db
		.update(adCreationOperations)
		.set({
			status: "processing",
			leaseToken: sql`${adCreationOperations.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			attempts: sql`${adCreationOperations.attempts} + 1`,
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(adCreationOperations.id, row.id),
				or(
					eq(adCreationOperations.status, "pending"),
					eq(adCreationOperations.status, "failed"),
					and(
						eq(adCreationOperations.status, "processing"),
						lte(adCreationOperations.leaseExpiresAt, now),
						isNull(adCreationOperations.requestMayHaveBeenSentAt),
					),
				),
			),
		)
		.returning();
	if (!claimed) operationError(row);
	return { row: claimed, leaseToken: claimed.leaseToken };
}

export function adProviderCorrelationMarker(operationId: string): string {
	return `[relay:${operationId}]`;
}

export function correlatedAdProviderName(
	name: string,
	operationId: string,
): string {
	const marker = adProviderCorrelationMarker(operationId);
	return name.includes(marker) ? name : `${name} ${marker}`;
}

export async function markAdProviderBoundary(
	db: Database,
	claim: ClaimedAdOperation,
	phase: AdCreationPhase,
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(adCreationOperations)
		.set({
			status: "request_may_have_been_sent",
			phase,
			requestMayHaveBeenSentAt: now,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			updatedAt: now,
		})
		.where(
			and(
				eq(adCreationOperations.id, claim.row.id),
				eq(adCreationOperations.leaseToken, claim.leaseToken),
				eq(adCreationOperations.status, "processing"),
			),
		)
		.returning({ id: adCreationOperations.id });
	if (updated.length !== 1) {
		throw new AdPlatformError(
			"OPERATION_LEASE_LOST",
			"The paid operation lease was lost before the provider request",
		);
	}
}

export async function confirmAdProviderBoundary(
	db: Database,
	claim: ClaimedAdOperation,
	ids: AdOperationProviderIds,
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(adCreationOperations)
		.set({
			status: "processing",
			requestMayHaveBeenSentAt: null,
			...(ids.platformCampaignId
				? { platformCampaignId: ids.platformCampaignId }
				: {}),
			...(ids.platformAdSetId ? { platformAdSetId: ids.platformAdSetId } : {}),
			...(ids.platformCreativeId
				? { platformCreativeId: ids.platformCreativeId }
				: {}),
			...(ids.platformAdId ? { platformAdId: ids.platformAdId } : {}),
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			updatedAt: now,
		})
		.where(
			and(
				eq(adCreationOperations.id, claim.row.id),
				eq(adCreationOperations.leaseToken, claim.leaseToken),
				eq(adCreationOperations.status, "request_may_have_been_sent"),
			),
		)
		.returning({ id: adCreationOperations.id });
	if (updated.length !== 1)
		throw new Error("Paid operation provider fence lost");
}

/** Persist local/provider progress so an expired pre-boundary lease can resume
 * with DB-only work instead of creating the same paid object again. */
export async function recordAdOperationProgress(
	db: Database,
	claim: ClaimedAdOperation,
	ids: AdOperationResultIds,
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(adCreationOperations)
		.set({
			...ids,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			updatedAt: now,
		})
		.where(
			and(
				eq(adCreationOperations.id, claim.row.id),
				eq(adCreationOperations.leaseToken, claim.leaseToken),
				eq(adCreationOperations.status, "processing"),
			),
		)
		.returning({ id: adCreationOperations.id });
	if (updated.length !== 1)
		throw new Error("Paid operation progress fence lost");
}

interface PhasePlanState {
	kind: AdCreationOperationKind;
	usesExistingCampaign: boolean;
	phase: Operation["phase"];
	requestMayHaveBeenSentAt: Date | null;
	platformCampaignId: string | null;
	platformAdSetId: string | null;
	platformCreativeId: string | null;
	platformAdId: string | null;
}

/** Pure phase plan used by both request/Queue execution and crash recovery. */
export function remainingAdCreationPhases(
	state: PhasePlanState,
): AdCreationPhase[] {
	const phases: AdCreationPhase[] = [];
	if (!state.usesExistingCampaign) {
		if (!state.platformCampaignId) phases.push("campaign");
		if (!state.platformAdSetId) phases.push("ad_set");
	}
	if (state.kind === "create_campaign") return phases;
	if (!state.platformCreativeId) phases.push("creative");
	if (!state.platformAdId) phases.push("ad");
	if (
		state.kind === "boost_post" &&
		(state.phase !== "activation" || state.requestMayHaveBeenSentAt !== null)
	) {
		phases.push("activation");
	}
	return phases;
}

export async function completeAdCreationOperation(
	db: Database,
	claim: ClaimedAdOperation,
	ids: AdOperationResultIds,
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(adCreationOperations)
		.set({
			status: "completed",
			phase: "completed",
			leaseExpiresAt: null,
			requestMayHaveBeenSentAt: null,
			lastError: null,
			completedAt: now,
			updatedAt: now,
			...ids,
		})
		.where(
			and(
				eq(adCreationOperations.id, claim.row.id),
				eq(adCreationOperations.leaseToken, claim.leaseToken),
				eq(adCreationOperations.status, "processing"),
			),
		)
		.returning({ id: adCreationOperations.id });
	if (updated.length !== 1)
		throw new Error("Paid operation completion fence lost");
}

interface DurableAdRequest {
	adAccountId?: string;
	campaignId?: string;
	postTargetId?: string;
	externalPostId?: string;
	platformPostId?: string;
	name?: string;
	objective?: string;
	headline?: string;
	body?: string;
	callToAction?: string;
	linkUrl?: string;
	imageUrl?: string;
	videoUrl?: string;
	targeting?: AdTargeting;
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	currency?: string;
	durationDays?: number;
	startDate?: string;
	endDate?: string;
	bidAmount?: number;
	tracking?: { pixelId?: string; urlTags?: string };
	specialAdCategories?: string[];
}

export type AdCreationExecutionResult =
	| {
			kind: "create_campaign";
			campaign: typeof adCampaigns.$inferSelect;
	  }
	| {
			kind: "create_ad" | "boost_post";
			ad: typeof ads.$inferSelect;
	  };

interface ExecuteAdCreationOptions {
	db: Database;
	claim: ClaimedAdOperation;
	adapter: AdPlatformAdapter;
	accessToken: string;
	platformAdAccountId: string;
}

function requiredRequestString(
	value: string | undefined,
	field: string,
): string {
	if (value) return value;
	throw new AdPlatformError(
		"INVALID_STATE",
		`The durable paid operation is missing ${field}`,
	);
}

function boostEndDate(operation: Operation, request: DurableAdRequest): string {
	if (request.endDate) return request.endDate;
	const durationDays = request.durationDays ?? 0;
	return new Date(
		operation.createdAt.getTime() + durationDays * 86_400_000,
	).toISOString();
}

function providerIdsForPhase(
	phase: AdProviderObjectPhase,
	id: string,
): AdOperationProviderIds {
	switch (phase) {
		case "campaign":
			return { platformCampaignId: id };
		case "ad_set":
			return { platformAdSetId: id };
		case "creative":
			return { platformCreativeId: id };
		case "ad":
			return { platformAdId: id };
	}
}

async function createProviderObject(
	db: Database,
	claim: ClaimedAdOperation,
	phase: AdProviderObjectPhase,
	create: () => Promise<string>,
	onBoundary: () => void,
): Promise<string> {
	await markAdProviderBoundary(db, claim, phase);
	onBoundary();
	const id = await create();
	await confirmAdProviderBoundary(db, claim, providerIdsForPhase(phase, id));
	return id;
}

async function upsertOperationCampaign(
	db: Database,
	operation: Operation,
	request: DurableAdRequest,
	platformCampaignId: string,
	platformAdSetId: string,
	name: string,
): Promise<typeof adCampaigns.$inferSelect> {
	const values: typeof adCampaigns.$inferInsert = {
		organizationId: operation.organizationId,
		workspaceId: operation.workspaceId,
		adAccountId: operation.adAccountId,
		platform: operation.platform,
		platformCampaignId,
		name,
		objective: (request.objective ??
			"engagement") as typeof adCampaigns.$inferInsert.objective,
		status: "active",
		dailyBudgetCents: request.dailyBudgetCents,
		lifetimeBudgetCents: request.lifetimeBudgetCents,
		metadata: { platformAdSetId },
	};
	if (operation.kind === "create_campaign") {
		values.currency = request.currency ?? "USD";
		values.startDate = request.startDate ? new Date(request.startDate) : null;
		values.endDate = request.endDate ? new Date(request.endDate) : null;
	}

	const [campaign] = await db
		.insert(adCampaigns)
		.values(values)
		.onConflictDoUpdate({
			target: [adCampaigns.adAccountId, adCampaigns.platformCampaignId],
			set: { updatedAt: new Date() },
		})
		.returning();
	if (!campaign) throw new Error("Failed to persist created campaign");
	return campaign;
}

async function findExistingOperationCampaign(
	db: Database,
	operation: Operation,
	campaignId: string,
): Promise<typeof adCampaigns.$inferSelect> {
	const [campaign] = await db
		.select()
		.from(adCampaigns)
		.where(
			and(
				eq(adCampaigns.id, campaignId),
				eq(adCampaigns.organizationId, operation.organizationId),
			),
		)
		.limit(1);
	if (!campaign) throw new AdPlatformError("NOT_FOUND", "Campaign not found");
	if (campaign.adAccountId !== operation.adAccountId) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Campaign does not belong to the selected ad account",
		);
	}
	return campaign;
}

/**
 * Execute from the last confirmed provider ID and persist the canonical local
 * result. Every provider call is outside a DB transaction and is fenced by its
 * own durable phase checkpoint.
 */
export async function executeClaimedAdCreationOperation(
	options: ExecuteAdCreationOptions,
): Promise<AdCreationExecutionResult> {
	const { db, claim, adapter, accessToken, platformAdAccountId } = options;
	const operation = claim.row;
	const request = operation.requestPayload as DurableAdRequest;
	const usesExistingCampaign =
		operation.kind === "create_ad" && typeof request.campaignId === "string";
	let providerTouched = Boolean(
		operation.platformCreativeId ||
			operation.platformAdId ||
			(!usesExistingCampaign &&
				(operation.platformCampaignId || operation.platformAdSetId)),
	);
	const touched = () => {
		providerTouched = true;
	};

	try {
		const baseName =
			operation.kind === "boost_post"
				? (request.name ??
					`Boost - ${requiredRequestString(request.platformPostId, "platformPostId")}`)
				: requiredRequestString(request.name, "name");
		const providerName = correlatedAdProviderName(baseName, operation.id);
		let platformCampaignId = operation.platformCampaignId ?? undefined;
		let platformAdSetId = operation.platformAdSetId ?? undefined;
		let platformCreativeId = operation.platformCreativeId ?? undefined;
		let platformAdId = operation.platformAdId ?? undefined;
		let localCampaign: typeof adCampaigns.$inferSelect | undefined;

		if (usesExistingCampaign) {
			localCampaign = await findExistingOperationCampaign(
				db,
				operation,
				requiredRequestString(request.campaignId, "campaignId"),
			);
			platformCampaignId ??= localCampaign.platformCampaignId ?? undefined;
			platformAdSetId ??= (
				localCampaign.metadata as { platformAdSetId?: string } | null
			)?.platformAdSetId;
			if (!platformCampaignId || !platformAdSetId) {
				throw new AdPlatformError(
					"MISSING_CAMPAIGN",
					"Could not resolve the platform campaign and ad set",
				);
			}
			await recordAdOperationProgress(db, claim, {
				localCampaignId: localCampaign.id,
				platformCampaignId,
				platformAdSetId,
			});
		} else {
			const objective =
				request.objective ??
				(operation.kind === "boost_post" ? "engagement" : undefined);
			if (!objective) {
				throw new AdPlatformError(
					"MISSING_OBJECTIVE",
					"objective is required when campaign_id is not provided",
				);
			}
			if (!platformCampaignId) {
				platformCampaignId = await createProviderObject(
					db,
					claim,
					"campaign",
					() =>
						adapter.creation.createCampaign(accessToken, platformAdAccountId, {
							name: providerName,
							objective,
							dailyBudgetCents: request.dailyBudgetCents,
							lifetimeBudgetCents: request.lifetimeBudgetCents,
							currency: request.currency,
							startDate: request.startDate,
							endDate: request.endDate,
							specialAdCategories: request.specialAdCategories,
						}),
					touched,
				);
			}
			if (!platformAdSetId) {
				platformAdSetId = await createProviderObject(
					db,
					claim,
					"ad_set",
					() =>
						adapter.creation.createAdSet(accessToken, platformAdAccountId, {
							campaignId: requiredRequestString(
								platformCampaignId,
								"platformCampaignId",
							),
							name: providerName,
							mode: operation.kind === "boost_post" ? "boost" : "standard",
							targeting: request.targeting,
							dailyBudgetCents: request.dailyBudgetCents,
							lifetimeBudgetCents: request.lifetimeBudgetCents,
							startDate: request.startDate,
							endDate:
								operation.kind === "boost_post"
									? boostEndDate(operation, request)
									: request.endDate,
							bidAmount: request.bidAmount,
							pixelId: request.tracking?.pixelId,
						}),
					touched,
				);
			}
		}

		if (!platformCampaignId || !platformAdSetId) {
			throw new AdPlatformError(
				"MISSING_CAMPAIGN",
				"Could not resolve the platform campaign and ad set",
			);
		}

		if (operation.kind === "create_campaign") {
			localCampaign = await upsertOperationCampaign(
				db,
				operation,
				request,
				platformCampaignId,
				platformAdSetId,
				baseName,
			);
			await completeAdCreationOperation(db, claim, {
				localCampaignId: localCampaign.id,
				platformCampaignId,
				platformAdSetId,
			});
			return { kind: "create_campaign", campaign: localCampaign };
		}

		if (operation.kind === "create_ad" && !localCampaign) {
			localCampaign = await upsertOperationCampaign(
				db,
				operation,
				request,
				platformCampaignId,
				platformAdSetId,
				baseName,
			);
			await recordAdOperationProgress(db, claim, {
				localCampaignId: localCampaign.id,
				platformCampaignId,
				platformAdSetId,
			});
		}

		const phasePlan = remainingAdCreationPhases({
			kind: operation.kind,
			usesExistingCampaign,
			phase: operation.phase,
			requestMayHaveBeenSentAt: operation.requestMayHaveBeenSentAt,
			platformCampaignId,
			platformAdSetId,
			platformCreativeId: platformCreativeId ?? null,
			platformAdId: platformAdId ?? null,
		});
		if (phasePlan.includes("creative")) {
			platformCreativeId = await createProviderObject(
				db,
				claim,
				"creative",
				() =>
					adapter.creation.createCreative(accessToken, platformAdAccountId, {
						name: providerName,
						headline: request.headline,
						body: request.body,
						callToAction: request.callToAction,
						linkUrl: request.linkUrl,
						imageUrl: request.imageUrl,
						videoUrl: request.videoUrl,
						platformPostId:
							operation.kind === "boost_post"
								? requiredRequestString(
									request.platformPostId,
									"platformPostId",
								)
								: undefined,
						urlTags: request.tracking?.urlTags,
					}),
				touched,
			);
		}
		if (!platformCreativeId) {
			throw new AdPlatformError(
				"INVALID_STATE",
				"Could not resolve the platform creative",
			);
		}
		if (phasePlan.includes("ad")) {
			platformAdId = await createProviderObject(
				db,
				claim,
				"ad",
				() =>
					adapter.creation.createAd(accessToken, platformAdAccountId, {
						adSetId: platformAdSetId,
						creativeId: requiredRequestString(
							platformCreativeId,
							"platformCreativeId",
						),
						name: providerName,
						active: operation.kind === "boost_post",
					}),
				touched,
			);
		}
		if (!platformAdId) {
			throw new AdPlatformError(
				"INVALID_STATE",
				"Could not resolve the platform ad",
			);
		}

		if (phasePlan.includes("activation")) {
			await markAdProviderBoundary(db, claim, "activation");
			touched();
			await adapter.creation.activateBoost(
				accessToken,
				platformCampaignId,
				platformAdSetId,
			);
			await confirmAdProviderBoundary(db, claim, {});
		}

		if (!localCampaign) {
			localCampaign = await upsertOperationCampaign(
				db,
				operation,
				request,
				platformCampaignId,
				platformAdSetId,
				baseName,
			);
		}

		const values: typeof ads.$inferInsert = {
			organizationId: operation.organizationId,
			workspaceId: operation.workspaceId,
			campaignId: localCampaign.id,
			adAccountId: operation.adAccountId,
			platform: operation.platform,
			platformAdId,
			name: baseName,
			status: "pending_review",
			targeting: request.targeting as typeof ads.$inferInsert.targeting,
			dailyBudgetCents: request.dailyBudgetCents,
			lifetimeBudgetCents: request.lifetimeBudgetCents,
			durationDays: request.durationDays,
		};
		if (operation.kind === "boost_post") {
			values.boostPostTargetId = request.postTargetId ?? null;
			values.boostExternalPostId = request.externalPostId ?? null;
			values.boostPlatformPostId = request.platformPostId ?? null;
			values.endDate = new Date(boostEndDate(operation, request));
		} else {
			values.headline = request.headline;
			values.body = request.body;
			values.callToAction = request.callToAction;
			values.linkUrl = request.linkUrl;
			values.imageUrl = request.imageUrl;
			values.videoUrl = request.videoUrl;
			values.startDate = request.startDate ? new Date(request.startDate) : null;
			values.endDate = request.endDate ? new Date(request.endDate) : null;
		}

		const [ad] = await db
			.insert(ads)
			.values(values)
			.onConflictDoUpdate({
				target: [ads.adAccountId, ads.platformAdId],
				set: { updatedAt: new Date() },
			})
			.returning();
		if (!ad) throw new Error("Failed to persist created ad");
		await completeAdCreationOperation(db, claim, {
			localCampaignId: localCampaign.id,
			localAdId: ad.id,
			platformCampaignId,
			platformAdSetId,
			platformCreativeId,
			platformAdId,
		});
		return { kind: operation.kind, ad };
	} catch (error) {
		await failAdCreationOperation(db, claim, error, providerTouched).catch(
			() => {},
		);
		throw error;
	}
}

export async function failAdCreationOperation(
	db: Database,
	claim: ClaimedAdOperation,
	error: unknown,
	providerTouched: boolean,
): Promise<void> {
	const attempts = claim.row.attempts + 1;
	const status = providerTouched ? "unknown" : "failed";
	await db
		.update(adCreationOperations)
		.set({
			status,
			leaseExpiresAt: null,
			lastError: error instanceof Error ? error.message : String(error),
			nextAttemptAt: new Date(
				Date.now() + Math.min(60 * 60_000, 2 ** Math.min(attempts, 6) * 30_000),
			),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(adCreationOperations.id, claim.row.id),
				eq(adCreationOperations.leaseToken, claim.leaseToken),
				or(
					eq(adCreationOperations.status, "processing"),
					eq(adCreationOperations.status, "request_may_have_been_sent"),
				),
			),
		);
}

function reconciliationDelay(attempts: number): number {
	return Math.min(6 * 60 * 60_000, 2 ** Math.min(attempts, 8) * 60_000);
}

async function deferAdReconciliation(
	db: Database,
	operation: Operation,
	leaseToken: number,
	error: unknown,
): Promise<void> {
	const attempts = operation.attempts + 1;
	await db
		.update(adCreationOperations)
		.set({
			status: attempts >= 5 ? "manual_review" : "unknown",
			attempts,
			leaseExpiresAt: null,
			lastError: error instanceof Error ? error.message : String(error),
			nextAttemptAt: new Date(Date.now() + reconciliationDelay(attempts)),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(adCreationOperations.id, operation.id),
				eq(adCreationOperations.status, "reconciling"),
				eq(adCreationOperations.leaseToken, leaseToken),
			),
		);
}

function hasProviderProgress(operation: Operation): boolean {
	return Boolean(
		operation.platformCampaignId ||
			operation.platformAdSetId ||
			operation.platformCreativeId ||
			operation.platformAdId,
	);
}

async function resumeReconciledOperation(
	db: Database,
	operation: Operation,
	adapter: AdPlatformAdapter,
	accessToken: string,
	platformAdAccountId: string,
): Promise<ClaimedAdOperation | null> {
	let providerIds: AdOperationProviderIds = {};
	if (operation.requestMayHaveBeenSentAt) {
		if (operation.phase === "completed") {
			throw new Error("A completed paid-operation phase cannot be ambiguous");
		}
		if (operation.phase === "activation") {
			const platformCampaignId = requiredRequestString(
				operation.platformCampaignId ?? undefined,
				"platformCampaignId",
			);
			const platformAdSetId = requiredRequestString(
				operation.platformAdSetId ?? undefined,
				"platformAdSetId",
			);
			const activated = await adapter.creation.isBoostActivated(
				accessToken,
				platformCampaignId,
				platformAdSetId,
			);
			if (!activated) {
				// These are absolute status assignments, so replay is safe after the
				// exact read above shows the earlier activation was incomplete.
				await adapter.creation.activateBoost(
					accessToken,
					platformCampaignId,
					platformAdSetId,
				);
			}
		} else {
			const id = await adapter.creation.findCreatedObject(
				accessToken,
				platformAdAccountId,
				{
					phase: operation.phase,
					marker: adProviderCorrelationMarker(operation.id),
					platformCampaignId: operation.platformCampaignId ?? undefined,
					platformAdSetId: operation.platformAdSetId ?? undefined,
				},
			);
			if (!id) return null;
			providerIds = providerIdsForPhase(operation.phase, id);
		}
	}

	const now = new Date();
	const [resumed] = await db
		.update(adCreationOperations)
		.set({
			status: "processing",
			requestMayHaveBeenSentAt: null,
			leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
			lastError: null,
			...providerIds,
			updatedAt: now,
		})
		.where(
			and(
				eq(adCreationOperations.id, operation.id),
				eq(adCreationOperations.status, "reconciling"),
				eq(adCreationOperations.leaseToken, operation.leaseToken),
			),
		)
		.returning();
	if (!resumed) throw new Error("Ad reconciliation resume fence lost");
	return { row: resumed, leaseToken: resumed.leaseToken };
}

/**
 * Reconcile at most three due operations. Ambiguous create phases perform a
 * bounded marker lookup before any later phase is created; confirmed partial
 * operations then run through the same executor as the synchronous path.
 */
export async function reconcileAdCreationOperations(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select()
		.from(adCreationOperations)
		.where(
			and(
				inArray(adCreationOperations.status, [
					"unknown",
					"request_may_have_been_sent",
					"processing",
				]),
				lte(adCreationOperations.nextAttemptAt, now),
				or(
					eq(adCreationOperations.status, "unknown"),
					lte(adCreationOperations.leaseExpiresAt, now),
				),
			),
		)
		.orderBy(adCreationOperations.nextAttemptAt, adCreationOperations.id)
		.limit(3);

	for (const candidate of candidates) {
		// A lease that expired before a provider boundary is safe for the original
		// request/Queue delivery to reclaim. Do not spend a provider list call.
		if (
			candidate.status === "processing" &&
			!candidate.requestMayHaveBeenSentAt &&
			!hasProviderProgress(candidate)
		) {
			await db
				.update(adCreationOperations)
				.set({
					status: "failed",
					leaseExpiresAt: null,
					lastError: "Lease expired before provider boundary; safe to retry",
					updatedAt: now,
				})
				.where(
					and(
						eq(adCreationOperations.id, candidate.id),
						eq(adCreationOperations.status, "processing"),
						eq(adCreationOperations.leaseToken, candidate.leaseToken),
						lte(adCreationOperations.leaseExpiresAt, now),
					),
				);
			continue;
		}

		const claimedAt = new Date();
		const [operation] = await db
			.update(adCreationOperations)
			.set({
				status: "reconciling",
				leaseToken: sql`${adCreationOperations.leaseToken} + 1`,
				leaseExpiresAt: new Date(claimedAt.getTime() + LEASE_MS),
				updatedAt: claimedAt,
			})
			.where(
				and(
					eq(adCreationOperations.id, candidate.id),
					eq(adCreationOperations.leaseToken, candidate.leaseToken),
					inArray(adCreationOperations.status, [
						"unknown",
						"request_may_have_been_sent",
						"processing",
					]),
					or(
						eq(adCreationOperations.status, "unknown"),
						lte(adCreationOperations.leaseExpiresAt, claimedAt),
					),
				),
			)
			.returning();
		if (!operation) continue;

		try {
			const [account] = await db
				.select({ adAccount: adAccounts, socialAccount: socialAccounts })
				.from(adAccounts)
				.innerJoin(
					socialAccounts,
					and(
						eq(adAccounts.socialAccountId, socialAccounts.id),
						eq(socialAccounts.organizationId, operation.organizationId),
					),
				)
				.innerJoin(
					organization,
					eq(organization.id, socialAccounts.organizationId),
				)
				.where(
					and(
						eq(adAccounts.id, operation.adAccountId),
						eq(adAccounts.organizationId, operation.organizationId),
						eq(socialAccounts.lifecycleStatus, "active"),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.limit(1);
			if (!account) {
				await db
					.update(adCreationOperations)
					.set({
						status: "manual_review",
						leaseExpiresAt: null,
						lastError:
							"Paid operation cannot resume because its organization or social account is inactive",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(adCreationOperations.id, operation.id),
							eq(adCreationOperations.status, "reconciling"),
							eq(
								adCreationOperations.leaseToken,
								operation.leaseToken,
							),
						),
					);
				continue;
			}
			const adapter = getAdPlatformAdapter(account.adAccount.platform);
			if (!adapter)
				throw new Error("Ad adapter is unavailable for reconciliation");
			const accessToken = await resolveAdsAccessToken(
				account.socialAccount,
				env,
			);
			const resumed = await resumeReconciledOperation(
				db,
				operation,
				adapter,
				accessToken,
				account.adAccount.platformAdAccountId,
			);
			if (!resumed) {
				await deferAdReconciliation(
					db,
					operation,
					operation.leaseToken,
					`No provider ${operation.phase} matched the durable correlation marker`,
				);
				continue;
			}
			await executeClaimedAdCreationOperation({
				db,
				claim: resumed,
				adapter,
				accessToken,
				platformAdAccountId: account.adAccount.platformAdAccountId,
			});
		} catch (error) {
			await deferAdReconciliation(db, operation, operation.leaseToken, error);
		}
	}
}
