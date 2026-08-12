import { getBillingPolicy } from "@relayapi/config";
import {
	adAccounts,
	adConnections,
	type Database,
	eq,
	socialAccounts,
} from "@relayapi/db";
import { and } from "drizzle-orm";
import { isSelfHosted } from "../lib/deployment-mode";
import type { Env } from "../types";
import { getAdPlatformAdapter } from "./ad-platforms";
import type {
	AdPlatform,
	AdPlatformAdapter,
	AdProviderCredentials,
} from "./ad-platforms/types";
import { resolveAdProviderCredentials } from "./ad-provider-credentials";
import { lockOrganizationSubscription } from "./subscription-authority";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface AdProviderBoundaryContext {
	adapter: AdPlatformAdapter;
	accessToken: string;
	credentials: AdProviderCredentials;
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

	// Discover without a lock so the revocation-safe lock order remains provider
	// credential first, ad account second. The locked ad row rechecks the exact
	// relationship and fails closed if it changed in between.
	const [discovered] = await tx
		.select({
			socialAccountId: adAccounts.socialAccountId,
			adConnectionId: adAccounts.adConnectionId,
		})
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

	const [adConnection] = discovered.adConnectionId
		? await tx
				.select()
				.from(adConnections)
				.where(
					and(
						eq(adConnections.id, discovered.adConnectionId),
						eq(adConnections.organizationId, input.organizationId),
					),
				)
				.for("share")
				.limit(1)
		: [];
	const [socialAccount] = discovered.socialAccountId
		? await tx
				.select()
				.from(socialAccounts)
				.where(
					and(
						eq(socialAccounts.id, discovered.socialAccountId),
						eq(socialAccounts.organizationId, input.organizationId),
					),
				)
				.for("share")
				.limit(1)
		: [];
	const accountAuthorityCondition = discovered.adConnectionId
		? eq(adAccounts.adConnectionId, discovered.adConnectionId)
		: discovered.socialAccountId
			? eq(adAccounts.socialAccountId, discovered.socialAccountId)
			: undefined;
	const [adAccount] = accountAuthorityCondition
		? await tx
				.select()
				.from(adAccounts)
				.where(
					and(
						eq(adAccounts.id, input.adAccountId),
						eq(adAccounts.organizationId, input.organizationId),
						accountAuthorityCondition,
					),
				)
				.for("share")
				.limit(1)
		: [];

	if (
		!adAccount ||
		(!adConnection && !socialAccount) ||
		(adConnection
			? adConnection.status !== "active" ||
				adConnection.workspaceId !== input.workspaceId ||
				adConnection.platform !== input.platform
			: socialAccount?.lifecycleStatus !== "active" ||
				socialAccount.workspaceId !== input.workspaceId) ||
		adAccount.status !== "active" ||
		adAccount.workspaceId !== input.workspaceId ||
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
		const credentials = await resolveAdProviderCredentials({
			platform: adAccount.platform,
			providerAdAccountId: adAccount.platformAdAccountId,
			adConnection,
			legacySocialAccount: socialAccount,
			env,
		});
		if (!credentials.accessToken) {
			return {
				ok: false,
				message: "The exact provider credential is no longer available",
			};
		}
		return {
			ok: true,
			context: {
				adapter,
				accessToken: credentials.accessToken,
				credentials,
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
