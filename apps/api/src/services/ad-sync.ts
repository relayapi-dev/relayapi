// ---------------------------------------------------------------------------
// Ad Sync Service — imports external ads + refreshes metrics
// ---------------------------------------------------------------------------

import {
	adAccounts,
	adCampaigns,
	adConnections,
	adSyncLogs,
	ads,
	createDb,
	eq,
	socialAccounts,
} from "@relayapi/db";
import { and, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
	AD_ACCOUNT_POLL,
	AD_METRICS_POLL,
	classifyProviderReadError,
	exponentialBackoffSeconds,
	type ProviderReadErrorClass,
} from "../lib/async-policy";
import type { Env } from "../types";
import { fetchAndStoreAdMetrics } from "./ad-analytics";
import { getAdPlatformAdapter } from "./ad-platforms";
import { requireAdCapability } from "./ad-platforms/unsupported";
import { resolveAdProviderCredentials } from "./ad-provider-credentials";

type SyncedCampaignObjective = (typeof adCampaigns.$inferInsert)["objective"];
type SyncedAdStatus = (typeof ads.$inferInsert)["status"];
type SyncedTargeting = (typeof ads.$inferInsert)["targeting"];

function asCampaignObjective(
	objective: string | undefined,
	fallback: SyncedCampaignObjective = "engagement",
): SyncedCampaignObjective {
	return (objective ?? fallback) as SyncedCampaignObjective;
}

function asAdStatus(status: string): SyncedAdStatus {
	return status as SyncedAdStatus;
}

function asAdTargeting(targeting: unknown): SyncedTargeting {
	return targeting as SyncedTargeting;
}

// ---------------------------------------------------------------------------
// Sync external ads for a single ad account
// ---------------------------------------------------------------------------

export async function syncExternalAds(
	env: Env,
	adAccountId: string,
	orgId: string,
	opts?: { windowDays?: number; syncGeneration?: number },
): Promise<{ adsCreated: number; adsUpdated: number; metricsUpdated: number }> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [ctx] = await db
		.select({
			adAccount: adAccounts,
			adConnection: adConnections,
			socialAccount: socialAccounts,
		})
		.from(adAccounts)
		.leftJoin(adConnections, eq(adAccounts.adConnectionId, adConnections.id))
		.leftJoin(socialAccounts, eq(adAccounts.socialAccountId, socialAccounts.id))
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, orgId),
				eq(adAccounts.status, "active"),
			),
		)
		.limit(1);

	if (!ctx) {
		console.error(`[Ad Sync] Ad account ${adAccountId} not found`);
		return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };
	}

	// Stable non-null reference so nested closures below don't lose the `ctx`
	// narrowing from the early `if (!ctx)` return.
	const adAccount = ctx.adAccount;
	const claimStartedAt = new Date();
	const leaseExpiresAt = new Date(
		claimStartedAt.getTime() + AD_ACCOUNT_POLL.leaseSeconds * 1000,
	);
	const [claim] = await db
		.update(adAccounts)
		.set({
			...(opts?.syncGeneration === undefined
				? {
						syncGeneration: sql`${adAccounts.syncGeneration} + 1`,
						syncLeaseExpiresAt: leaseExpiresAt,
					}
				: {}),
			syncStartedAt: claimStartedAt,
			syncAttempts: sql`${adAccounts.syncAttempts} + 1`,
			updatedAt: claimStartedAt,
		})
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, orgId),
				eq(adAccounts.status, "active"),
				...(opts?.syncGeneration === undefined
					? [
							or(
								isNull(adAccounts.syncLeaseExpiresAt),
								lte(adAccounts.syncLeaseExpiresAt, claimStartedAt),
							),
						]
					: [
							eq(adAccounts.syncGeneration, opts.syncGeneration),
							isNull(adAccounts.syncStartedAt),
							gt(adAccounts.syncLeaseExpiresAt, claimStartedAt),
						]),
			),
		)
		.returning({
			generation: adAccounts.syncGeneration,
			attempts: adAccounts.syncAttempts,
		});
	if (!claim) {
		return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };
	}

	const adapter = getAdPlatformAdapter(adAccount.platform);
	if (!adapter) {
		await finishAdAccountPollFailure(
			db,
			adAccountId,
			orgId,
			claim.generation,
			claimStartedAt,
			claim.attempts,
			new Error(`No adapter for ad platform ${adAccount.platform}`),
			"permanent",
		);
		return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };
	}
	try {
		requireAdCapability(adapter, "external_sync");
	} catch (error) {
		await finishAdAccountPollFailure(
			db,
			adAccountId,
			orgId,
			claim.generation,
			claimStartedAt,
			claim.attempts,
			error,
			"permanent",
		);
		return { adsCreated: 0, adsUpdated: 0, metricsUpdated: 0 };
	}

	let adsCreated = 0;
	let adsUpdated = 0;
	const metricsUpdated = 0;
	let error: string | undefined;

	try {
		const credentials = await resolveAdProviderCredentials({
			platform: adAccount.platform,
			providerAdAccountId: adAccount.platformAdAccountId,
			adConnection: ctx.adConnection,
			legacySocialAccount: ctx.socialAccount,
			env,
		});
		const result = await adapter.syncExternalAds(
			credentials.accessToken,
			adAccount.platformAdAccountId,
			undefined,
			credentials,
		);

		// Pre-fetch this ad account's existing remote ad IDs once for reporting.
		// Identity itself is enforced by composite unique indexes and atomic
		// ON CONFLICT upserts below, so overlapping cron/manual syncs cannot race
		// through a check-then-insert window.
		const platformAdIds = [
			...new Set(
				result.ads
					.map((a) => a.platformAdId)
					.filter((id): id is string => Boolean(id)),
			),
		];

		const existingAdRows = await (platformAdIds.length > 0
			? db
					.select({ id: ads.id, platformAdId: ads.platformAdId })
					.from(ads)
					.where(
						and(
							eq(ads.adAccountId, adAccountId),
							inArray(ads.platformAdId, platformAdIds),
						),
					)
			: Promise.resolve([] as { id: string; platformAdId: string | null }[]));

		const existingAdIds = new Set(
			existingAdRows
				.filter((a) => a.platformAdId)
				.map((a) => a.platformAdId as string),
		);

		// Resolve (upsert) the internal campaign id for a platform campaign id
		// exactly once per sync, caching the result so ads sharing a campaign
		// don't repeat the upsert.
		const resolvedCampaignId = new Map<string, string>();

		async function upsertCampaign(
			externalAd: (typeof result.ads)[number],
		): Promise<string | null> {
			const platformCampaignId = externalAd.platformCampaignId;
			const alreadyResolved = resolvedCampaignId.get(platformCampaignId);
			if (alreadyResolved !== undefined) {
				return alreadyResolved;
			}

			const campaignValues = {
				organizationId: orgId,
				workspaceId: adAccount.workspaceId,
				adAccountId,
				platform: adAccount.platform,
				platformCampaignId,
				name: externalAd.campaignName,
				objective: asCampaignObjective(externalAd.objective),
				status: asAdStatus(externalAd.status),
				dailyBudgetCents: externalAd.dailyBudgetCents,
				lifetimeBudgetCents: externalAd.lifetimeBudgetCents,
				currency: adAccount.currency,
				isExternal: true,
				metadata: { platformAdSetId: externalAd.platformAdSetId },
				updatedAt: new Date(),
			};
			const [campaign] = await db
				.insert(adCampaigns)
				.values(campaignValues)
				.onConflictDoUpdate({
					target: [adCampaigns.adAccountId, adCampaigns.platformCampaignId],
					set: {
						workspaceId: campaignValues.workspaceId,
						name: campaignValues.name,
						// Some provider sync payloads omit objective. Preserve the
						// existing campaign value instead of silently resetting it.
						objective:
							externalAd.objective === undefined
								? sql`${adCampaigns.objective}`
								: campaignValues.objective,
						status: campaignValues.status,
						dailyBudgetCents: campaignValues.dailyBudgetCents,
						lifetimeBudgetCents: campaignValues.lifetimeBudgetCents,
						currency: campaignValues.currency,
						metadata: campaignValues.metadata,
						updatedAt: campaignValues.updatedAt,
					},
				})
				.returning();

			if (!campaign) return null;
			resolvedCampaignId.set(platformCampaignId, campaign.id);
			return campaign.id;
		}

		for (const externalAd of result.ads) {
			const campaignId = await upsertCampaign(externalAd);

			if (!campaignId) {
				console.warn(
					`[Ad Sync] Skipping ad ${externalAd.platformAdId} because its campaign could not be upserted`,
				);
				continue;
			}

			const adValues = {
				organizationId: orgId,
				workspaceId: adAccount.workspaceId,
				campaignId,
				adAccountId,
				platform: adAccount.platform,
				platformAdId: externalAd.platformAdId,
				name: externalAd.adName,
				status: asAdStatus(externalAd.status),
				headline: externalAd.creative?.headline,
				body: externalAd.creative?.body,
				imageUrl: externalAd.creative?.imageUrl,
				videoUrl: externalAd.creative?.videoUrl,
				linkUrl: externalAd.creative?.linkUrl,
				callToAction: externalAd.creative?.callToAction,
				targeting: asAdTargeting(externalAd.targeting),
				dailyBudgetCents: externalAd.dailyBudgetCents,
				lifetimeBudgetCents: externalAd.lifetimeBudgetCents,
				startDate: externalAd.startDate ? new Date(externalAd.startDate) : null,
				endDate: externalAd.endDate ? new Date(externalAd.endDate) : null,
				isExternal: true,
				updatedAt: new Date(),
			};
			await db
				.insert(ads)
				.values(adValues)
				.onConflictDoUpdate({
					target: [ads.adAccountId, ads.platformAdId],
					set: {
						workspaceId: adValues.workspaceId,
						campaignId: adValues.campaignId,
						name: adValues.name,
						status: adValues.status,
						headline: adValues.headline,
						body: adValues.body,
						imageUrl: adValues.imageUrl,
						videoUrl: adValues.videoUrl,
						linkUrl: adValues.linkUrl,
						callToAction: adValues.callToAction,
						targeting: adValues.targeting,
						dailyBudgetCents: adValues.dailyBudgetCents,
						lifetimeBudgetCents: adValues.lifetimeBudgetCents,
						startDate: adValues.startDate,
						endDate: adValues.endDate,
						updatedAt: adValues.updatedAt,
					},
				});

			if (existingAdIds.has(externalAd.platformAdId)) adsUpdated++;
			else {
				adsCreated++;
				existingAdIds.add(externalAd.platformAdId);
			}
		}

		const completedAt = new Date();
		if (opts?.windowDays) {
			// A manual "full" sync makes every active metric poll due. The common
			// fair producer still claims and dispatches them, so this request does
			// not restore the old 200-call inline fan-out. A successful manual
			// account read is also the explicit operator action that reopens an
			// exhausted metric budget; do not disturb a metric claim already in
			// flight.
			await db
				.update(ads)
				.set({
					metricsNextPollAt: completedAt,
					metricsPollAttempts: 0,
					metricsPollLastError: null,
					metricsPollLastErrorClass: null,
					updatedAt: completedAt,
				})
				.where(
					and(
						eq(ads.adAccountId, adAccountId),
						eq(ads.organizationId, orgId),
						sql`${ads.status} NOT IN ('completed', 'rejected', 'cancelled')`,
						or(
							isNull(ads.metricsPollLeaseExpiresAt),
							lte(ads.metricsPollLeaseExpiresAt, completedAt),
						),
					),
				);
		}
		await db
			.update(adAccounts)
			.set({
				lastSyncAt: completedAt,
				nextSyncAt: new Date(
					completedAt.getTime() + AD_ACCOUNT_POLL.successIntervalSeconds * 1000,
				),
				syncLeaseExpiresAt: null,
				syncStartedAt: null,
				syncAttempts: 0,
				syncLastError: null,
				syncLastErrorClass: null,
				updatedAt: completedAt,
			})
			.where(
				and(
					eq(adAccounts.id, adAccountId),
					eq(adAccounts.organizationId, orgId),
					eq(adAccounts.syncGeneration, claim.generation),
					eq(adAccounts.syncStartedAt, claimStartedAt),
				),
			);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		console.error(`[Ad Sync] Failed for ad account ${adAccountId}:`, error);
		await finishAdAccountPollFailure(
			db,
			adAccountId,
			orgId,
			claim.generation,
			claimStartedAt,
			claim.attempts,
			err,
		);
	}

	// Observability is downstream of the authoritative poll transition. A log
	// insert failure must never replay provider reads.
	try {
		await db.insert(adSyncLogs).values({
			organizationId: orgId,
			adAccountId,
			platform: adAccount.platform,
			syncType: "external_listing",
			adsCreated,
			adsUpdated,
			metricsUpdated,
			error,
			completedAt: new Date(),
		});
	} catch (logError) {
		console.error("[Ad Sync] Failed to persist sync log", {
			adAccountId,
			error: logError instanceof Error ? logError.message : String(logError),
		});
	}

	return { adsCreated, adsUpdated, metricsUpdated };
}

async function finishAdAccountPollFailure(
	db: ReturnType<typeof createDb>,
	adAccountId: string,
	organizationId: string,
	generation: number,
	claimStartedAt: Date,
	attempts: number,
	error: unknown,
	forcedClass?: ProviderReadErrorClass,
): Promise<void> {
	const failedAt = new Date();
	const errorClass = forcedClass ?? classifyProviderReadError(error);
	const delaySeconds = exponentialBackoffSeconds(
		attempts,
		AD_ACCOUNT_POLL.retry,
		`${adAccountId}:${attempts}`,
	);
	const budgetExhausted = attempts >= AD_ACCOUNT_POLL.maxAutomaticAttempts;
	const message = error instanceof Error ? error.message : String(error);
	await db
		.update(adAccounts)
		.set({
			nextSyncAt: new Date(
				failedAt.getTime() +
					(errorClass === "permanent" ? 24 * 60 * 60 : delaySeconds) * 1000,
			),
			syncLeaseExpiresAt: null,
			syncStartedAt: null,
			syncLastError: (budgetExhausted
				? `Automatic ad-list poll attempt budget reached; polling is suspended until a manual sync succeeds. ${message}`
				: message
			).slice(0, 1000),
			syncLastErrorClass: errorClass,
			updatedAt: failedAt,
		})
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, organizationId),
				eq(adAccounts.syncGeneration, generation),
				eq(adAccounts.syncStartedAt, claimStartedAt),
			),
		);
}

export async function syncAdMetrics(
	env: Env,
	input: {
		organizationId: string;
		adId: string;
		pollGeneration?: number;
		windowDays?: number;
	},
): Promise<boolean> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const claimStartedAt = new Date();
	const leaseExpiresAt = new Date(
		claimStartedAt.getTime() + AD_METRICS_POLL.leaseSeconds * 1000,
	);
	const [claim] = await db
		.update(ads)
		.set({
			...(input.pollGeneration === undefined
				? {
						metricsPollGeneration: sql`${ads.metricsPollGeneration} + 1`,
						metricsPollLeaseExpiresAt: leaseExpiresAt,
					}
				: {}),
			metricsPollStartedAt: claimStartedAt,
			metricsPollAttempts: sql`${ads.metricsPollAttempts} + 1`,
			updatedAt: claimStartedAt,
		})
		.where(
			and(
				eq(ads.id, input.adId),
				eq(ads.organizationId, input.organizationId),
				sql`${ads.platformAdId} IS NOT NULL`,
				sql`${ads.status} NOT IN ('completed', 'rejected', 'cancelled')`,
				...(input.pollGeneration === undefined
					? [
							or(
								isNull(ads.metricsPollLeaseExpiresAt),
								lte(ads.metricsPollLeaseExpiresAt, claimStartedAt),
							),
						]
					: [
							eq(ads.metricsPollGeneration, input.pollGeneration),
							isNull(ads.metricsPollStartedAt),
							gt(ads.metricsPollLeaseExpiresAt, claimStartedAt),
						]),
			),
		)
		.returning({
			generation: ads.metricsPollGeneration,
			attempts: ads.metricsPollAttempts,
		});
	if (!claim) return false;

	const windowDays = Math.max(1, Math.min(input.windowDays ?? 3, 30));
	const now = new Date();
	const windowStart = new Date(now);
	windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);
	try {
		await fetchAndStoreAdMetrics(
			env,
			input.adId,
			windowStart.toISOString().slice(0, 10),
			now.toISOString().slice(0, 10),
			db,
		);
		await db
			.update(ads)
			.set({
				metricsUpdatedAt: now,
				metricsNextPollAt: new Date(
					now.getTime() + AD_METRICS_POLL.successIntervalSeconds * 1000,
				),
				metricsPollLeaseExpiresAt: null,
				metricsPollStartedAt: null,
				metricsPollAttempts: 0,
				metricsPollLastError: null,
				metricsPollLastErrorClass: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(ads.id, input.adId),
					eq(ads.organizationId, input.organizationId),
					eq(ads.metricsPollGeneration, claim.generation),
					eq(ads.metricsPollStartedAt, claimStartedAt),
				),
			);
		return true;
	} catch (error) {
		const failedAt = new Date();
		const errorClass = classifyProviderReadError(error);
		const delaySeconds = exponentialBackoffSeconds(
			claim.attempts,
			AD_METRICS_POLL.retry,
			`${input.adId}:${claim.attempts}`,
		);
		const budgetExhausted =
			claim.attempts >= AD_METRICS_POLL.maxAutomaticAttempts;
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(ads)
			.set({
				metricsNextPollAt: new Date(
					failedAt.getTime() +
						(errorClass === "permanent" ? 24 * 60 * 60 : delaySeconds) * 1000,
				),
				metricsPollLeaseExpiresAt: null,
				metricsPollStartedAt: null,
				metricsPollLastError: (budgetExhausted
					? `Automatic ad-metrics poll attempt budget reached; polling is suspended until a manual sync succeeds. ${message}`
					: message
				).slice(0, 1000),
				metricsPollLastErrorClass: errorClass,
				updatedAt: failedAt,
			})
			.where(
				and(
					eq(ads.id, input.adId),
					eq(ads.organizationId, input.organizationId),
					eq(ads.metricsPollGeneration, claim.generation),
					eq(ads.metricsPollStartedAt, claimStartedAt),
				),
			);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Sync all ad accounts (called by cron)
// ---------------------------------------------------------------------------

export async function syncAllExternalAds(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const accountLeaseExpiresAt = new Date(
		now.getTime() + AD_ACCOUNT_POLL.leaseSeconds * 1000,
	);
	const dueAccounts = await db
		.update(adAccounts)
		.set({
			syncGeneration: sql`${adAccounts.syncGeneration} + 1`,
			syncLeaseExpiresAt: accountLeaseExpiresAt,
			syncStartedAt: null,
			updatedAt: now,
		})
		.where(
			sql`${adAccounts.id} IN (
				SELECT ranked.id
				FROM (
					SELECT
						a.id,
						a.organization_id,
						a.next_sync_at,
						row_number() OVER (
							PARTITION BY a.organization_id
							ORDER BY a.next_sync_at, a.id
						) AS tenant_rank
					FROM ad_accounts a
					JOIN social_accounts sa
						ON sa.id = a.social_account_id
						AND sa.organization_id = a.organization_id
						AND sa.lifecycle_status = 'active'
					WHERE a.status = 'active'
						AND a.next_sync_at <= ${now}
						AND a.sync_attempts < ${AD_ACCOUNT_POLL.maxAutomaticAttempts}
						AND (
							a.sync_lease_expires_at IS NULL
							OR a.sync_lease_expires_at <= ${now}
						)
				) ranked
				WHERE ranked.tenant_rank <= ${AD_ACCOUNT_POLL.maxClaimsPerTenant}
				ORDER BY
					ranked.tenant_rank,
					ranked.next_sync_at,
					ranked.organization_id,
					ranked.id
				LIMIT ${AD_ACCOUNT_POLL.maxClaimsPerRun}
			)`,
		)
		.returning({
			id: adAccounts.id,
			organizationId: adAccounts.organizationId,
			generation: adAccounts.syncGeneration,
		});

	const metricLeaseExpiresAt = new Date(
		now.getTime() + AD_METRICS_POLL.leaseSeconds * 1000,
	);
	const dueMetrics = await db
		.update(ads)
		.set({
			metricsPollGeneration: sql`${ads.metricsPollGeneration} + 1`,
			metricsPollLeaseExpiresAt: metricLeaseExpiresAt,
			metricsPollStartedAt: null,
			updatedAt: now,
		})
		.where(
			sql`${ads.id} IN (
				SELECT ranked.id
				FROM (
					SELECT
						a.id,
						a.organization_id,
						a.metrics_next_poll_at,
						row_number() OVER (
							PARTITION BY a.organization_id
							ORDER BY a.metrics_next_poll_at, a.id
						) AS tenant_rank
					FROM ads a
					JOIN ad_accounts aa
						ON aa.id = a.ad_account_id
						AND aa.organization_id = a.organization_id
						AND aa.status = 'active'
					JOIN social_accounts sa
						ON sa.id = aa.social_account_id
						AND sa.organization_id = aa.organization_id
						AND sa.lifecycle_status = 'active'
					WHERE a.platform_ad_id IS NOT NULL
						AND a.status NOT IN ('completed', 'rejected', 'cancelled')
						AND a.metrics_next_poll_at <= ${now}
						AND a.metrics_poll_attempts < ${AD_METRICS_POLL.maxAutomaticAttempts}
						AND (
							a.metrics_poll_lease_expires_at IS NULL
							OR a.metrics_poll_lease_expires_at <= ${now}
						)
				) ranked
				WHERE ranked.tenant_rank <= ${AD_METRICS_POLL.maxClaimsPerTenant}
				ORDER BY
					ranked.tenant_rank,
					ranked.metrics_next_poll_at,
					ranked.organization_id,
					ranked.id
				LIMIT ${AD_METRICS_POLL.maxClaimsPerRun}
			)`,
		)
		.returning({
			id: ads.id,
			organizationId: ads.organizationId,
			generation: ads.metricsPollGeneration,
		});

	const messages = [
		...dueAccounts.map((account) => ({
			body: {
				type: "sync_external",
				org_id: account.organizationId,
				ad_account_id: account.id,
				sync_generation: account.generation,
			},
		})),
		...dueMetrics.map((ad) => ({
			body: {
				type: "sync_metrics",
				org_id: ad.organizationId,
				ad_id: ad.id,
				metrics_poll_generation: ad.generation,
				window_days:
					now.getUTCHours() === 0 && now.getUTCMinutes() < 30 ? 30 : 3,
			},
		})),
	];
	for (let offset = 0; offset < messages.length; offset += 100) {
		await env.ADS_QUEUE.sendBatch(messages.slice(offset, offset + 100));
	}
	console.log("[Ad Sync] Enqueued bounded fair poll work", {
		accountListings: dueAccounts.length,
		adMetrics: dueMetrics.length,
	});
}
