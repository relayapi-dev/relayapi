// ---------------------------------------------------------------------------
// Ad Service — orchestrates DB operations + platform adapter calls
// ---------------------------------------------------------------------------

import {
	adAccounts,
	adCampaigns,
	adCreationOperations,
	ads,
	createDb,
	eq,
	externalPosts,
	organization,
	posts,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { and, inArray, sql } from "drizzle-orm";
import { isSafeAdBudget, normalizeSupportedAdCurrency } from "../lib/ad-money";
import type { DurableCredentialAuthorityAdmission } from "../lib/durable-credential-authority";
import {
	canAccessWorkspaceScope,
	workspaceScopeSqlCondition,
} from "../lib/workspace-scope";
import type { Env } from "../types";
import { resolveAdsAccessToken } from "./ad-access-token";
import {
	beginAdCreationOperation,
	executeClaimedAdCreationOperation,
} from "./ad-creation-operations";
import {
	type CancelAdMutationPayload,
	type CancelCampaignMutationPayload,
	executeAdMutation,
	type UpdateAdMutationPayload,
	type UpdateCampaignMutationPayload,
} from "./ad-mutation-operations";
import {
	getAdPlatformAdapter,
	socialPlatformToAdPlatform,
} from "./ad-platforms";
import type {
	AdPlatform,
	AdTargeting,
	PlatformAdAccount,
	PromotablePage,
} from "./ad-platforms/types";
import {
	AdAuthoritativeNotAppliedError,
	AdPlatformError,
} from "./ad-platforms/types";
import {
	settleDurableUsageReservation,
	type UsageReservation,
} from "./usage-meter";

// Re-export for route handlers
export { AdPlatformError };

type Database = ReturnType<typeof createDb>;

interface ExistingSpendState {
	status: string;
	dailyBudgetCents: number | null;
	lifetimeBudgetCents: number | null;
}

interface RequestedSpendMutation {
	status?: "active" | "paused";
	dailyBudgetCents?: number;
	lifetimeBudgetCents?: number;
	hasNonEmergencyChanges?: boolean;
}

export interface SpendMutationAssessment {
	hasIncrease: boolean;
	hasDecrease: boolean;
	mixedStopAndIncrease: boolean;
	emergencySafe: boolean;
}

function isBudgetIncrease(
	current: number | null,
	requested: number | undefined,
): boolean {
	return requested !== undefined && (current === null || requested > current);
}

function isBudgetDecrease(
	current: number | null,
	requested: number | undefined,
): boolean {
	return requested !== undefined && current !== null && requested < current;
}

/**
 * Classify a mutation at the provider-cost boundary. A caller without an
 * eligible Pro entitlement may only stop delivery or lower an existing cap;
 * creation, activation, new caps, and unrelated edits remain blocked.
 */
export function assessSpendMutation(
	existing: ExistingSpendState,
	requested: RequestedSpendMutation,
): SpendMutationAssessment {
	const hasIncrease =
		requested.status === "active" ||
		isBudgetIncrease(existing.dailyBudgetCents, requested.dailyBudgetCents) ||
		isBudgetIncrease(
			existing.lifetimeBudgetCents,
			requested.lifetimeBudgetCents,
		);
	const hasDecrease =
		isBudgetDecrease(existing.dailyBudgetCents, requested.dailyBudgetCents) ||
		isBudgetDecrease(
			existing.lifetimeBudgetCents,
			requested.lifetimeBudgetCents,
		);
	const stopsDelivery = requested.status === "paused";
	return {
		hasIncrease,
		hasDecrease,
		mixedStopAndIncrease: stopsDelivery && hasIncrease,
		emergencySafe:
			!hasIncrease &&
			!requested.hasNonEmergencyChanges &&
			(stopsDelivery || hasDecrease),
	};
}

function requireProviderContext<T>(
	value: T | null | undefined,
	resource: string,
): T {
	if (value) return value;
	throw new AdPlatformError(
		"MANUAL_REVIEW_REQUIRED",
		`${resource} cannot be mutated because its provider credential or adapter is unavailable`,
	);
}

function authoritativeAdCurrency(
	providerCurrency: string | null | undefined,
	requestedCurrency: string | undefined,
	budgets: readonly (number | undefined)[],
): string {
	const currency = normalizeSupportedAdCurrency(providerCurrency);
	if (!currency) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_CURRENCY",
			"This ad account currency is not supported by the cents-based budget contract",
		);
	}
	if (
		requestedCurrency !== undefined &&
		requestedCurrency.trim().toUpperCase() !== currency
	) {
		throw new AdAuthoritativeNotAppliedError(
			"CURRENCY_MISMATCH",
			"The requested currency does not match the provider ad account currency",
		);
	}
	if (budgets.some((budget) => !isSafeAdBudget(budget))) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_BUDGET",
			"Ad budgets must be positive safe integers within PostgreSQL int4 minor-unit bounds",
		);
	}
	return currency;
}

function assertCampaignCurrencySnapshot(
	campaignCurrency: string | null,
	providerCurrency: string,
): void {
	if (campaignCurrency?.trim().toUpperCase() !== providerCurrency) {
		throw new AdAuthoritativeNotAppliedError(
			"CURRENCY_MISMATCH",
			"The campaign currency snapshot does not match its provider ad account",
		);
	}
}

async function getAdAccountContext(
	db: Database,
	adAccountId: string,
	orgId: string,
) {
	const [adAcc] = await db
		.select({
			adAccount: adAccounts,
			socialAccount: socialAccounts,
		})
		.from(adAccounts)
		.innerJoin(
			socialAccounts,
			and(
				eq(adAccounts.socialAccountId, socialAccounts.id),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.innerJoin(organization, eq(organization.id, socialAccounts.organizationId))
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, orgId),
				eq(adAccounts.status, "active"),
				eq(socialAccounts.lifecycleStatus, "active"),
				eq(organization.lifecycleStatus, "active"),
			),
		)
		.limit(1);

	if (!adAcc) return null;

	return {
		...adAcc,
		adPlatform: adAcc.adAccount.platform,
	};
}

// ---------------------------------------------------------------------------
// Ad Account Operations
// ---------------------------------------------------------------------------

type AdAccountUpsert = {
	pa: PlatformAdAccount;
	socialAccountId: string;
	workspaceId: string | null;
	metadata: Record<string, unknown> | null;
};

async function upsertAdAccounts(
	db: Database,
	rows: AdAccountUpsert[],
	orgId: string,
	adPlatform: AdPlatform,
) {
	if (rows.length === 0) return;
	const CHUNK = 100;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const chunk = rows.slice(i, i + CHUNK);
		await db
			.insert(adAccounts)
			.values(
				chunk.map(({ pa, socialAccountId, workspaceId, metadata }) => ({
					organizationId: orgId,
					workspaceId,
					socialAccountId,
					platform: adPlatform,
					platformAdAccountId: pa.id,
					name: pa.name,
					currency: pa.currency?.trim().toUpperCase() ?? null,
					timezone: pa.timezone,
					status: pa.status ?? "active",
					metadata,
				})),
			)
			.onConflictDoUpdate({
				target: [
					adAccounts.organizationId,
					adAccounts.platform,
					adAccounts.platformAdAccountId,
				],
				set: {
					name: sql`excluded.name`,
					currency: sql`excluded.currency`,
					timezone: sql`excluded.timezone`,
					status: sql`excluded.status`,
					socialAccountId: sql`excluded.social_account_id`,
					workspaceId: sql`excluded.workspace_id`,
					metadata: sql`excluded.metadata`,
					updatedAt: new Date(),
				},
			});
	}
}

/**
 * Remove (or neutralise) ad accounts the user can access but that don't promote
 * any connected Page/IG. Rows with no dependent campaigns, ads, or durable paid
 * operations are deleted; rows with history have their boostable set emptied so
 * the list endpoint hides them without deleting that history.
 */
async function pruneUnmatchedAdAccounts(
	db: Database,
	orgId: string,
	adPlatform: AdPlatform,
	platformAdAccountIds: string[],
) {
	const stale = await db
		.select({ id: adAccounts.id })
		.from(adAccounts)
		.where(
			and(
				eq(adAccounts.organizationId, orgId),
				eq(adAccounts.platform, adPlatform),
				inArray(adAccounts.platformAdAccountId, platformAdAccountIds),
			),
		);
	if (stale.length === 0) return;

	const staleIds = stale.map((r) => r.id);
	const [campaignRefs, adRefs, operationRefs] = await Promise.all([
		db
			.select({ adAccountId: adCampaigns.adAccountId })
			.from(adCampaigns)
			.where(inArray(adCampaigns.adAccountId, staleIds)),
		db
			.select({ adAccountId: ads.adAccountId })
			.from(ads)
			.where(inArray(ads.adAccountId, staleIds)),
		db
			.select({ adAccountId: adCreationOperations.adAccountId })
			.from(adCreationOperations)
			.where(inArray(adCreationOperations.adAccountId, staleIds)),
	]);
	const referenced = new Set<string>([
		...campaignRefs.map((r) => r.adAccountId),
		...adRefs.map((r) => r.adAccountId),
		...operationRefs.map((r) => r.adAccountId),
	]);

	const deletable = staleIds.filter((id) => !referenced.has(id));
	const neutralize = staleIds.filter((id) => referenced.has(id));

	if (deletable.length > 0) {
		await db.delete(adAccounts).where(inArray(adAccounts.id, deletable));
	}
	if (neutralize.length > 0) {
		await db
			.update(adAccounts)
			.set({
				metadata: sql`jsonb_set(coalesce(${adAccounts.metadata}, '{}'::jsonb), '{boostable_social_account_ids}', '[]'::jsonb)`,
				updatedAt: new Date(),
			})
			.where(inArray(adAccounts.id, neutralize));
	}
}

export async function discoverAdAccounts(
	env: Env,
	orgId: string,
	socialAccountId: string,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	workspaceScope: "all" | string[] = "all",
): Promise<
	{
		id: string;
		name: string;
		currency?: string;
		timezone?: string;
		status?: string;
	}[]
> {
	const [socialAcc] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, socialAccountId),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);

	if (!socialAcc)
		throw new AdPlatformError("NOT_FOUND", "Social account not found");
	if (!canAccessWorkspaceScope(workspaceScope, socialAcc.workspaceId)) {
		throw new AdPlatformError("NOT_FOUND", "Social account not found");
	}

	const adPlatform = socialPlatformToAdPlatform(socialAcc.platform);
	if (!adPlatform) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`Platform "${socialAcc.platform}" does not support ads`,
		);
	}

	const adapter = getAdPlatformAdapter(adPlatform);
	if (!adapter) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform "${adPlatform}"`,
		);
	}

	const accessToken = await resolveAdsAccessToken(socialAcc, env);

	const platformAccounts = await adapter.listAdAccounts(
		accessToken,
		socialAcc.platformAccountId,
	);
	if (platformAccounts.length === 0) return platformAccounts;

	// Platforms that can't resolve which Pages an ad account promotes keep the
	// legacy behaviour (attach every discovered account to the triggering one).
	if (!adapter.listPromotablePages) {
		await upsertAdAccounts(
			db,
			platformAccounts.map((pa) => ({
				pa,
				socialAccountId,
				workspaceId: socialAcc.workspaceId,
				metadata: null,
			})),
			orgId,
			adPlatform,
		);
		return platformAccounts;
	}

	// Narrowed past the guard above: listPromotablePages is defined here.
	const listPromotablePages = adapter.listPromotablePages;

	// Match each ad account's promotable Pages/IG accounts against ALL of the
	// org's connected Meta accounts (not just the one that triggered discovery).
	const connectedConditions = [
		eq(socialAccounts.organizationId, orgId),
		inArray(socialAccounts.platform, ["facebook", "instagram"]),
		eq(socialAccounts.lifecycleStatus, "active"),
	];
	if (workspaceScope !== "all") {
		connectedConditions.push(
			workspaceScopeSqlCondition(workspaceScope, socialAccounts.workspaceId),
		);
	}
	const connected = await db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(and(...connectedConditions));

	type Connected = (typeof connected)[number];
	const pageBySocialPlatformId = new Map<string, Connected>();
	const igBySocialPlatformId = new Map<string, Connected>();
	for (const acc of connected) {
		if (acc.platform === "facebook")
			pageBySocialPlatformId.set(acc.platformAccountId, acc);
		else if (acc.platform === "instagram")
			igBySocialPlatformId.set(acc.platformAccountId, acc);
	}
	const triggering = connected.find((c) => c.id === socialAccountId);

	const syncedAt = new Date().toISOString();
	const toUpsert: AdAccountUpsert[] = [];
	const unmatchedPlatformAdAccountIds: string[] = [];

	// Resolve promotable Pages per ad account with bounded concurrency.
	const CONCURRENCY = 5;
	for (let i = 0; i < platformAccounts.length; i += CONCURRENCY) {
		const batch = platformAccounts.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map(async (pa) => {
				try {
					const promotable = await listPromotablePages(accessToken, pa.id);
					return { pa, promotable };
				} catch {
					// A throttled/unauthorized account is treated as "no matches".
					return { pa, promotable: [] as PromotablePage[] };
				}
			}),
		);

		for (const { pa, promotable } of results) {
			const matches = new Map<string, Connected>();
			for (const page of promotable) {
				const fb = pageBySocialPlatformId.get(page.pageId);
				if (fb) matches.set(fb.id, fb);
				if (page.instagramBusinessAccountId) {
					const ig = igBySocialPlatformId.get(page.instagramBusinessAccountId);
					if (ig) matches.set(ig.id, ig);
				}
			}

			if (matches.size === 0) {
				unmatchedPlatformAdAccountIds.push(pa.id);
				continue;
			}

			const matched = [...matches.values()];
			// matches.size > 0 was asserted above, so matched is non-empty.
			const firstMatch = matched[0];
			if (!firstMatch) continue;
			// Primary = a connected Facebook Page (carries the Meta ads user
			// token) when available, else the triggering account, else any match.
			const primary =
				matched.find((m) => m.platform === "facebook") ??
				triggering ??
				firstMatch;

			toUpsert.push({
				pa,
				socialAccountId: primary.id,
				workspaceId: primary.workspaceId,
				metadata: {
					boostable_social_account_ids: matched.map((m) => m.id),
					boostable_accounts: matched.map((m) => ({
						id: m.id,
						platform: m.platform,
						username: m.username ?? m.displayName ?? null,
					})),
					promote_pages_synced_at: syncedAt,
				},
			});
		}
	}

	await upsertAdAccounts(db, toUpsert, orgId, adPlatform);

	if (unmatchedPlatformAdAccountIds.length > 0) {
		await pruneUnmatchedAdAccounts(
			db,
			orgId,
			adPlatform,
			unmatchedPlatformAdAccountIds,
		);
	}

	return platformAccounts;
}

// ---------------------------------------------------------------------------
// Campaign Operations
// ---------------------------------------------------------------------------

export async function createCampaign(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		name: string;
		objective: string;
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		currency?: string;
		startDate?: string;
		endDate?: string;
		specialAdCategories?: string[];
		/** Stable request/Queue identity. Required before creating paid objects. */
		operationKey?: string;
	},
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	const ctx = await getAdAccountContext(db, params.adAccountId, orgId);
	if (!ctx) {
		throw new AdAuthoritativeNotAppliedError(
			"NOT_FOUND",
			"Ad account not found",
		);
	}

	const adapter = getAdPlatformAdapter(ctx.adPlatform);
	if (!adapter) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_PLATFORM",
			"No adapter",
		);
	}
	const currency = authoritativeAdCurrency(
		ctx.adAccount.currency,
		params.currency,
		[params.dailyBudgetCents, params.lifetimeBudgetCents],
	);
	const { operationKey, ...baseRequest } = params;
	const request = { ...baseRequest, currency };
	const operation = await beginAdCreationOperation({
		db,
		organizationId: orgId,
		workspaceId: ctx.adAccount.workspaceId,
		adAccountId: params.adAccountId,
		kind: "create_campaign",
		platform: ctx.adPlatform,
		operationKey,
		request,
		usageReservation,
		authorityAdmission,
	});
	if ("completed" in operation) {
		if (!operation.completed.localCampaignId) {
			throw new AdPlatformError(
				"OPERATION_RESULT_MISSING",
				"The campaign operation completed without a local result",
			);
		}
		const [existing] = await db
			.select()
			.from(adCampaigns)
			.where(
				and(
					eq(adCampaigns.id, operation.completed.localCampaignId),
					eq(adCampaigns.organizationId, orgId),
				),
			)
			.limit(1);
		if (existing) return existing;
		throw new AdPlatformError(
			"OPERATION_RESULT_MISSING",
			"The campaign operation result is no longer available",
		);
	}
	const result = await executeClaimedAdCreationOperation({
		env,
		db,
		claim: operation,
	});
	if (result.kind !== "create_campaign") {
		throw new Error("Campaign operation returned an ad result");
	}
	return result.campaign;
}

// ---------------------------------------------------------------------------
// Ad Operations
// ---------------------------------------------------------------------------

export async function createAd(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		campaignId?: string;
		name: string;
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
		durationDays?: number;
		startDate?: string;
		endDate?: string;
		/** Stable request/Queue identity. Required before creating paid objects. */
		operationKey?: string;
	},
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	const ctx = await getAdAccountContext(db, params.adAccountId, orgId);
	if (!ctx) {
		throw new AdAuthoritativeNotAppliedError(
			"NOT_FOUND",
			"Ad account not found",
		);
	}

	const adapter = getAdPlatformAdapter(ctx.adPlatform);
	if (!adapter) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_PLATFORM",
			"No adapter",
		);
	}
	if (params.targeting && adapter.canonicalizeTargeting) {
		// Validate the complete provider projection before the durable operation
		// can stage a request boundary.
		adapter.canonicalizeTargeting(params.targeting);
	}
	const currency = authoritativeAdCurrency(ctx.adAccount.currency, undefined, [
		params.dailyBudgetCents,
		params.lifetimeBudgetCents,
	]);
	const { operationKey, ...baseRequest } = params;
	const request = { ...baseRequest, currency };
	if (params.campaignId) {
		const [campaign] = await db
			.select({ currency: adCampaigns.currency })
			.from(adCampaigns)
			.where(
				and(
					eq(adCampaigns.id, params.campaignId),
					eq(adCampaigns.organizationId, orgId),
					eq(adCampaigns.adAccountId, params.adAccountId),
				),
			)
			.limit(1);
		if (!campaign) {
			throw new AdAuthoritativeNotAppliedError(
				"NOT_FOUND",
				"Campaign not found",
			);
		}
		assertCampaignCurrencySnapshot(campaign.currency, currency);
	}
	const operation = await beginAdCreationOperation({
		db,
		organizationId: orgId,
		workspaceId: ctx.adAccount.workspaceId,
		adAccountId: params.adAccountId,
		kind: "create_ad",
		platform: ctx.adPlatform,
		operationKey,
		request,
		usageReservation,
		authorityAdmission,
	});
	if ("completed" in operation) {
		if (!operation.completed.localAdId) {
			throw new AdPlatformError(
				"OPERATION_RESULT_MISSING",
				"The ad operation completed without a local result",
			);
		}
		const [existing] = await db
			.select()
			.from(ads)
			.where(
				and(
					eq(ads.id, operation.completed.localAdId),
					eq(ads.organizationId, orgId),
				),
			)
			.limit(1);
		if (existing) return existing;
		throw new AdPlatformError(
			"OPERATION_RESULT_MISSING",
			"The ad operation result is no longer available",
		);
	}
	const result = await executeClaimedAdCreationOperation({
		env,
		db,
		claim: operation,
	});
	if (result.kind !== "create_ad") {
		throw new Error("Ad operation returned the wrong result kind");
	}
	return result.ad;
}

export async function boostPost(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		postTargetId?: string;
		externalPostId?: string;
		name?: string;
		objective?: string;
		targeting?: AdTargeting;
		dailyBudgetCents: number;
		lifetimeBudgetCents?: number;
		currency?: string;
		durationDays: number;
		startDate?: string;
		endDate?: string;
		bidAmount?: number;
		tracking?: { pixelId?: string; urlTags?: string };
		specialAdCategories?: string[];
		/** Stable request/Queue identity. Required before creating paid objects. */
		operationKey?: string;
	},
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	// Resolve the platform post id to boost from either a RelayAPI post target
	// (post_target_id) or a natively-published post synced into external_posts
	// (external_post_id). Exactly one is provided (enforced by BoostPostBody).
	let platformPostId: string;
	let postSocialAccountId: string | null = null;
	let sourceWorkspaceId: string | null = null;

	if (params.externalPostId) {
		const [ext] = await db
			.select()
			.from(externalPosts)
			.where(
				and(
					eq(externalPosts.id, params.externalPostId),
					eq(externalPosts.organizationId, orgId),
				),
			)
			.limit(1);

		if (!ext) {
			throw new AdAuthoritativeNotAppliedError(
				"NOT_FOUND",
				"External post not found",
			);
		}
		if (!ext.platformPostId) {
			throw new AdAuthoritativeNotAppliedError(
				"INVALID_STATE",
				"Post has no platform post ID",
			);
		}
		platformPostId = ext.platformPostId;
		postSocialAccountId = ext.socialAccountId;
		sourceWorkspaceId = ext.workspaceId;
	} else {
		// Exactly one of externalPostId/postTargetId is provided (enforced by
		// BoostPostBody); in this branch postTargetId must be present.
		if (!params.postTargetId) {
			throw new AdAuthoritativeNotAppliedError(
				"NOT_FOUND",
				"Post target not found",
			);
		}
		// Verify the post target exists, is published, and belongs to this org
		const [targetRow] = await db
			.select({ target: postTargets, workspaceId: posts.workspaceId })
			.from(postTargets)
			.innerJoin(posts, eq(postTargets.postId, posts.id))
			.where(
				and(
					eq(postTargets.id, params.postTargetId),
					eq(posts.organizationId, orgId),
				),
			)
			.limit(1);
		const target = targetRow?.target;

		if (!target) {
			throw new AdAuthoritativeNotAppliedError(
				"NOT_FOUND",
				"Post target not found",
			);
		}
		if (target.status !== "published") {
			throw new AdAuthoritativeNotAppliedError(
				"INVALID_STATE",
				"Can only boost published posts",
			);
		}
		if (!target.platformPostId) {
			throw new AdAuthoritativeNotAppliedError(
				"INVALID_STATE",
				"Post has no platform post ID",
			);
		}
		platformPostId = target.platformPostId;
		postSocialAccountId = target.socialAccountId;
		sourceWorkspaceId = targetRow.workspaceId;
	}

	const ctx = await getAdAccountContext(db, params.adAccountId, orgId);
	if (!ctx) {
		throw new AdAuthoritativeNotAppliedError(
			"NOT_FOUND",
			"Ad account not found",
		);
	}
	if (sourceWorkspaceId !== ctx.adAccount.workspaceId) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_STATE",
			"The promoted post must belong to the ad account workspace",
		);
	}

	// Guard: the post's account must be one this ad account can actually promote.
	// Skip when the boostable set is unknown (legacy/non-Meta) to avoid regressions.
	const boostableIds = (
		ctx.adAccount.metadata as { boostable_social_account_ids?: unknown } | null
	)?.boostable_social_account_ids;
	if (
		Array.isArray(boostableIds) &&
		boostableIds.length > 0 &&
		postSocialAccountId &&
		!boostableIds.includes(postSocialAccountId)
	) {
		throw new AdAuthoritativeNotAppliedError(
			"INVALID_STATE",
			"This post's account cannot be promoted through the selected ad account",
		);
	}

	const adapter = getAdPlatformAdapter(ctx.adPlatform);
	if (!adapter) {
		throw new AdAuthoritativeNotAppliedError(
			"UNSUPPORTED_PLATFORM",
			"No adapter",
		);
	}
	if (params.targeting && adapter.canonicalizeTargeting) {
		// Unsupported targeting is a clean pre-boundary rejection, not an
		// ambiguous paid-object attempt.
		adapter.canonicalizeTargeting(params.targeting);
	}

	const currency = authoritativeAdCurrency(
		ctx.adAccount.currency,
		params.currency,
		[params.dailyBudgetCents, params.lifetimeBudgetCents],
	);
	const { operationKey, ...baseRequest } = params;
	const request = { ...baseRequest, currency };
	const operation = await beginAdCreationOperation({
		db,
		organizationId: orgId,
		workspaceId: ctx.adAccount.workspaceId,
		adAccountId: params.adAccountId,
		kind: "boost_post",
		platform: ctx.adPlatform,
		operationKey,
		request: { ...request, platformPostId },
		usageReservation,
		authorityAdmission,
	});
	if ("completed" in operation) {
		if (!operation.completed.localAdId) {
			throw new AdPlatformError(
				"OPERATION_RESULT_MISSING",
				"The boost operation completed without a local result",
			);
		}
		const [existing] = await db
			.select()
			.from(ads)
			.where(
				and(
					eq(ads.id, operation.completed.localAdId),
					eq(ads.organizationId, orgId),
				),
			)
			.limit(1);
		if (existing) return existing;
		throw new AdPlatformError(
			"OPERATION_RESULT_MISSING",
			"The boost operation result is no longer available",
		);
	}
	const result = await executeClaimedAdCreationOperation({
		env,
		db,
		claim: operation,
	});
	if (result.kind !== "boost_post") {
		throw new Error("Boost operation returned the wrong result kind");
	}
	return result.ad;
}

export async function updateAd(
	env: Env,
	orgId: string,
	adId: string,
	params: {
		name?: string;
		status?: "active" | "paused";
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		targeting?: AdTargeting;
		allowSpendIncrease?: boolean;
		operationKey?: string;
	},
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	const [ad] = await db
		.select()
		.from(ads)
		.where(and(eq(ads.id, adId), eq(ads.organizationId, orgId)))
		.limit(1);

	if (!ad) throw new AdPlatformError("NOT_FOUND", "Ad not found");

	if (["completed", "rejected", "cancelled"].includes(ad.status)) {
		throw new AdPlatformError(
			"INVALID_STATE",
			`Cannot update ad with status "${ad.status}"`,
		);
	}
	const assessment = assessSpendMutation(ad, {
		status: params.status,
		dailyBudgetCents: params.dailyBudgetCents,
		lifetimeBudgetCents: params.lifetimeBudgetCents,
		hasNonEmergencyChanges:
			params.name !== undefined || params.targeting !== undefined,
	});
	if (assessment.mixedStopAndIncrease) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"A single request cannot stop delivery and increase spend",
		);
	}
	if (params.allowSpendIncrease === false && !assessment.emergencySafe) {
		throw new AdPlatformError(
			"PLAN_UPGRADE_REQUIRED",
			"After Pro access ends, ads may only be paused, cancelled, or reduced in spend",
		);
	}

	const platformAdId = requireProviderContext(ad.platformAdId, "The ad");
	const ctx = requireProviderContext(
		await getAdAccountContext(db, ad.adAccountId, orgId),
		"The ad",
	);
	const adapter = requireProviderContext(
		getAdPlatformAdapter(ctx.adPlatform),
		"The ad",
	);
	const [campaign] = await db
		.select()
		.from(adCampaigns)
		.where(
			and(
				eq(adCampaigns.id, ad.campaignId),
				eq(adCampaigns.organizationId, orgId),
			),
		)
		.limit(1);
	if (!campaign) throw new AdPlatformError("NOT_FOUND", "Campaign not found");
	if (
		params.status === "active" ||
		params.dailyBudgetCents !== undefined ||
		params.lifetimeBudgetCents !== undefined
	) {
		const currency = authoritativeAdCurrency(
			ctx.adAccount.currency,
			undefined,
			[
				params.dailyBudgetCents ??
					(params.status === "active"
						? (ad.dailyBudgetCents ?? undefined)
						: undefined),
				params.lifetimeBudgetCents ??
					(params.status === "active"
						? (ad.lifetimeBudgetCents ?? undefined)
						: undefined),
			],
		);
		assertCampaignCurrencySnapshot(campaign.currency, currency);
	}
	const payload: UpdateAdMutationPayload = {
		kind: "update_ad",
		adId,
		campaignId: ad.campaignId,
		adAccountId: ad.adAccountId,
		platformAdId,
		platformCampaignId: campaign.platformCampaignId ?? undefined,
		platformAdSetId: (campaign.metadata as { platformAdSetId?: string } | null)
			?.platformAdSetId,
		changes: {
			name: params.name,
			status: params.status,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
			targeting: params.targeting,
		},
		expectedProviderTargeting:
			params.targeting && adapter.canonicalizeTargeting
				? adapter.canonicalizeTargeting(params.targeting)
				: undefined,
	};
	await executeAdMutation({
		env,
		db,
		organizationId: orgId,
		targetType: "ad",
		targetId: adId,
		workspaceId: ad.workspaceId,
		platform: ctx.adPlatform,
		operationKey: params.operationKey,
		payload,
		usageReservation,
		authorityAdmission,
		requiresLiveAuthority: !assessment.emergencySafe,
	});
	const [updated] = await db
		.select()
		.from(ads)
		.where(and(eq(ads.id, adId), eq(ads.organizationId, orgId)))
		.limit(1);
	return updated;
}

export async function cancelAd(
	env: Env,
	orgId: string,
	adId: string,
	operationKey?: string,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	const [ad] = await db
		.select()
		.from(ads)
		.where(and(eq(ads.id, adId), eq(ads.organizationId, orgId)))
		.limit(1);

	if (!ad) throw new AdPlatformError("NOT_FOUND", "Ad not found");
	if (ad.status === "cancelled") {
		if (usageReservation) {
			await settleDurableUsageReservation(db, {
				reservationId: usageReservation.id,
				organizationId: usageReservation.organizationId,
				committedUnits: 0,
			});
		}
		return;
	}

	const platformAdId = requireProviderContext(ad.platformAdId, "The ad");
	const ctx = requireProviderContext(
		await getAdAccountContext(db, ad.adAccountId, orgId),
		"The ad",
	);
	requireProviderContext(getAdPlatformAdapter(ctx.adPlatform), "The ad");
	const payload: CancelAdMutationPayload = {
		kind: "cancel_ad",
		adId,
		adAccountId: ad.adAccountId,
		platformAdId,
	};
	await executeAdMutation({
		env,
		db,
		organizationId: orgId,
		targetType: "ad",
		targetId: adId,
		workspaceId: ad.workspaceId,
		platform: ctx.adPlatform,
		operationKey,
		payload,
		usageReservation,
		authorityAdmission,
		requiresLiveAuthority: false,
	});
}

export async function updateCampaign(
	env: Env,
	orgId: string,
	campaignId: string,
	params: {
		name?: string;
		status?: "active" | "paused";
		dailyBudgetCents?: number;
		lifetimeBudgetCents?: number;
		allowSpendIncrease?: boolean;
		operationKey?: string;
	},
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	const [campaign] = await db
		.select()
		.from(adCampaigns)
		.where(
			and(
				eq(adCampaigns.id, campaignId),
				eq(adCampaigns.organizationId, orgId),
			),
		)
		.limit(1);
	if (!campaign) throw new AdPlatformError("NOT_FOUND", "Campaign not found");

	const assessment = assessSpendMutation(campaign, {
		status: params.status,
		dailyBudgetCents: params.dailyBudgetCents,
		lifetimeBudgetCents: params.lifetimeBudgetCents,
		hasNonEmergencyChanges: params.name !== undefined,
	});
	if (assessment.mixedStopAndIncrease) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"A single request cannot stop delivery and increase spend",
		);
	}
	if (params.allowSpendIncrease === false && !assessment.emergencySafe) {
		throw new AdPlatformError(
			"PLAN_UPGRADE_REQUIRED",
			"After Pro access ends, campaigns may only be paused, cancelled, or reduced in spend",
		);
	}

	const platformCampaignId = requireProviderContext(
		campaign.platformCampaignId,
		"The campaign",
	);
	const ctx = requireProviderContext(
		await getAdAccountContext(db, campaign.adAccountId, orgId),
		"The campaign",
	);
	requireProviderContext(getAdPlatformAdapter(ctx.adPlatform), "The campaign");
	const platformAdSetId = (
		campaign.metadata as { platformAdSetId?: string } | null
	)?.platformAdSetId;
	const childAds = await db
		.select({ id: ads.id, platformAdId: ads.platformAdId, status: ads.status })
		.from(ads)
		.where(and(eq(ads.campaignId, campaignId), eq(ads.organizationId, orgId)));
	if (
		params.status === "active" ||
		params.dailyBudgetCents !== undefined ||
		params.lifetimeBudgetCents !== undefined
	) {
		const currency = authoritativeAdCurrency(
			ctx.adAccount.currency,
			undefined,
			[
				params.dailyBudgetCents ??
					(params.status === "active"
						? (campaign.dailyBudgetCents ?? undefined)
						: undefined),
				params.lifetimeBudgetCents ??
					(params.status === "active"
						? (campaign.lifetimeBudgetCents ?? undefined)
						: undefined),
			],
		);
		assertCampaignCurrencySnapshot(campaign.currency, currency);
	}

	const payload: UpdateCampaignMutationPayload = {
		kind: "update_campaign",
		campaignId,
		adAccountId: campaign.adAccountId,
		platformCampaignId,
		platformAdSetId,
		childPlatformAdIds: childAds
			.filter(
				(child) =>
					child.platformAdId &&
					!["completed", "rejected", "cancelled"].includes(child.status),
			)
			.map((child) => child.platformAdId as string),
		changes: {
			name: params.name,
			status: params.status,
			dailyBudgetCents: params.dailyBudgetCents,
			lifetimeBudgetCents: params.lifetimeBudgetCents,
		},
	};
	await executeAdMutation({
		env,
		db,
		organizationId: orgId,
		targetType: "campaign",
		targetId: campaignId,
		workspaceId: campaign.workspaceId,
		platform: ctx.adPlatform,
		operationKey: params.operationKey,
		payload,
		usageReservation,
		authorityAdmission,
		requiresLiveAuthority: !assessment.emergencySafe,
	});
	const updated =
		params.status === undefined
			? 1
			: childAds.filter(
					(child) =>
						!["completed", "rejected", "cancelled"].includes(child.status),
				).length;
	return {
		updated,
		skipped: params.status === undefined ? 0 : childAds.length - updated,
	};
}

export async function updateCampaignStatus(
	env: Env,
	orgId: string,
	campaignId: string,
	status: "active" | "paused",
	operationKey?: string,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
) {
	return updateCampaign(
		env,
		orgId,
		campaignId,
		{ status, operationKey },
		db,
		usageReservation,
		authorityAdmission,
	);
}

export async function cancelCampaign(
	env: Env,
	orgId: string,
	campaignId: string,
	operationKey: string | undefined,
	db: Database = createDb(env.HYPERDRIVE.connectionString),
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
): Promise<void> {
	if (!authorityAdmission)
		throw new AdAuthoritativeNotAppliedError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"Paid operation admission requires live credential authority",
		);
	const [campaign] = await db
		.select()
		.from(adCampaigns)
		.where(
			and(
				eq(adCampaigns.id, campaignId),
				eq(adCampaigns.organizationId, orgId),
			),
		)
		.limit(1);
	if (!campaign) throw new AdPlatformError("NOT_FOUND", "Campaign not found");
	if (campaign.status === "cancelled") {
		if (usageReservation) {
			await settleDurableUsageReservation(db, {
				reservationId: usageReservation.id,
				organizationId: usageReservation.organizationId,
				committedUnits: 0,
			});
		}
		return;
	}
	const platformCampaignId = requireProviderContext(
		campaign.platformCampaignId,
		"The campaign",
	);
	const ctx = requireProviderContext(
		await getAdAccountContext(db, campaign.adAccountId, orgId),
		"The campaign",
	);
	requireProviderContext(getAdPlatformAdapter(ctx.adPlatform), "The campaign");
	const payload: CancelCampaignMutationPayload = {
		kind: "cancel_campaign",
		campaignId,
		adAccountId: campaign.adAccountId,
		platformCampaignId,
	};
	await executeAdMutation({
		env,
		db,
		organizationId: orgId,
		targetType: "campaign",
		targetId: campaignId,
		workspaceId: campaign.workspaceId,
		platform: ctx.adPlatform,
		operationKey,
		payload,
		usageReservation,
		authorityAdmission,
		requiresLiveAuthority: false,
	});
}
