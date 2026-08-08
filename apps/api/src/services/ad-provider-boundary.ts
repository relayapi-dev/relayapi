import { getBillingPolicy } from "@relayapi/config";
import { adAccounts, type Database, eq, socialAccounts } from "@relayapi/db";
import { and } from "drizzle-orm";
import { isSelfHosted } from "../lib/deployment-mode";
import type { Env } from "../types";
import { resolveAdsAccessToken } from "./ad-access-token";
import { getAdPlatformAdapter } from "./ad-platforms";
import type { AdPlatform, AdPlatformAdapter } from "./ad-platforms/types";
import { lockOrganizationSubscription } from "./subscription-authority";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AdProviderBoundaryContext {
	adapter: AdPlatformAdapter;
	accessToken: string;
	platform: AdPlatform;
	platformAdAccountId: string;
}

export type AdProviderBoundaryDecision =
	| { ok: true; context: AdProviderBoundaryContext }
	| { ok: false; message: string };

/**
 * Lock the live billing and exact provider-account capabilities consumed by an
 * ad provider write. The caller opens its durable request marker in the same
 * transaction, so disconnect/entitlement changes linearize either before the
 * marker (deny) or after it (the already-open provider attempt may finish).
 */
export async function lockAdProviderBoundary(
	tx: Transaction,
	env: Env,
	input: {
		organizationId: string;
		workspaceId: string | null;
		adAccountId: string;
		platform: AdPlatform;
		requiresLiveEntitlement: boolean;
	},
): Promise<AdProviderBoundaryDecision> {
	let subscription:
		| Awaited<ReturnType<typeof lockOrganizationSubscription>>
		| undefined;
	if (input.requiresLiveEntitlement && !isSelfHosted(env)) {
		subscription = await lockOrganizationSubscription(
			tx,
			input.organizationId,
			"share",
		);
	}

	// Discover without a lock so the revocation-safe lock order remains social
	// account first, ad account second. The locked ad row below rechecks this
	// exact relationship and fails closed if it changed in between.
	const [discovered] = await tx
		.select({ socialAccountId: adAccounts.socialAccountId })
		.from(adAccounts)
		.where(
			and(
				eq(adAccounts.id, input.adAccountId),
				eq(adAccounts.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!discovered) {
		return {
			ok: false,
			message: "The exact provider ad account no longer exists",
		};
	}

	const [socialAccount] = await tx
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, discovered.socialAccountId),
				eq(socialAccounts.organizationId, input.organizationId),
			),
		)
		.for("share")
		.limit(1);
	const [adAccount] = await tx
		.select()
		.from(adAccounts)
		.where(
			and(
				eq(adAccounts.id, input.adAccountId),
				eq(adAccounts.organizationId, input.organizationId),
				eq(adAccounts.socialAccountId, discovered.socialAccountId),
			),
		)
		.for("share")
		.limit(1);

	if (
		!socialAccount ||
		!adAccount ||
		socialAccount.lifecycleStatus !== "active" ||
		adAccount.status !== "active" ||
		adAccount.workspaceId !== input.workspaceId ||
		socialAccount.workspaceId !== input.workspaceId ||
		adAccount.platform !== input.platform
	) {
		return {
			ok: false,
			message:
				"The exact provider social/ad-account authority is no longer active",
		};
	}

	if (input.requiresLiveEntitlement && !isSelfHosted(env)) {
		const finalNow = new Date();
		const billing = getBillingPolicy(
			subscription ?? { status: null },
			finalNow,
		);
		const source = subscription?.source;
		const eligible =
			billing.entitlement === "pro" &&
			(source === "complimentary" || (source === "stripe" && billing.billable));
		if (!eligible) {
			return {
				ok: false,
				message:
					"Creating, resuming, or increasing ad spend requires current eligible Pro billing authority",
			};
		}
	}

	const adapter = getAdPlatformAdapter(adAccount.platform);
	if (!adapter) {
		return {
			ok: false,
			message: "The exact provider adapter is no longer available",
		};
	}
	try {
		const accessToken = await resolveAdsAccessToken(socialAccount, env);
		if (!accessToken) {
			return {
				ok: false,
				message: "The exact provider credential is no longer available",
			};
		}
		return {
			ok: true,
			context: {
				adapter,
				accessToken,
				platform: adAccount.platform,
				platformAdAccountId: adAccount.platformAdAccountId,
			},
		};
	} catch (error) {
		return {
			ok: false,
			message:
				error instanceof Error
					? error.message
					: "The exact provider credential could not be resolved",
		};
	}
}
