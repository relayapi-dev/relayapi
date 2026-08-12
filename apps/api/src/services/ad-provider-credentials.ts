import type { adConnections } from "@relayapi/db";
import { decryptAdConnectionToken } from "../lib/ad-connection-token-crypto";
import type { Env } from "../types";
import { resolveAdsAccessToken } from "./ad-access-token";
import { getAdPlatformAdapter } from "./ad-platforms";
import type { AdPlatform, AdProviderCredentials } from "./ad-platforms/types";
import { AdPlatformError } from "./ad-platforms/types";

type AdConnection = typeof adConnections.$inferSelect;

type LegacySocialAccount = {
	id: string;
	platform: string;
	accessToken: string | null;
	metadata: unknown;
	lifecycleStatus?: string;
};

function metadataObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

export function assertRequiredAdScopes(
	platform: AdPlatform,
	grantedScopes: readonly string[],
): void {
	const adapter = getAdPlatformAdapter(platform);
	if (!adapter) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform ${platform}`,
		);
	}
	const missing = adapter.capabilities.requiredScopes.filter(
		(scope) => !grantedScopes.includes(scope),
	);
	if (missing.length > 0) {
		throw new AdPlatformError(
			"ADS_SCOPE_MISSING",
			`The ${platform} ad connection is missing required scopes: ${missing.join(", ")}`,
		);
	}
}

export async function resolveDedicatedAdCredentials(
	connection: AdConnection,
	providerAdAccountId: string | undefined,
	env: Env,
	now: Date = new Date(),
): Promise<AdProviderCredentials> {
	if (connection.status !== "active") {
		throw new AdPlatformError(
			connection.status === "revoked"
				? "ADS_CONNECTION_REVOKED"
				: "ADS_CONNECTION_REQUIRED",
			`The ${connection.platform} ad connection is ${connection.status}`,
		);
	}
	if (
		connection.accessTokenExpiresAt &&
		connection.accessTokenExpiresAt.getTime() <= now.getTime() + 60_000
	) {
		throw new AdPlatformError(
			"ADS_CONNECTION_EXPIRED",
			`The ${connection.platform} ad connection must be refreshed`,
		);
	}
	assertRequiredAdScopes(connection.platform, connection.scopes);
	const [accessToken, tokenSecret] = await Promise.all([
		decryptAdConnectionToken(
			connection.accessToken,
			env.ENCRYPTION_KEY,
			connection.id,
			"access_token",
		),
		decryptAdConnectionToken(
			connection.tokenSecret,
			env.ENCRYPTION_KEY,
			connection.id,
			"token_secret",
		),
	]);
	if (!accessToken) {
		throw new AdPlatformError(
			"ADS_CONNECTION_REQUIRED",
			`The ${connection.platform} ad connection has no access token`,
		);
	}
	if (connection.platform === "google" && !env.GOOGLE_ADS_DEVELOPER_TOKEN) {
		throw new AdPlatformError(
			"ADS_PROVIDER_NOT_CONFIGURED",
			"GOOGLE_ADS_DEVELOPER_TOKEN is not configured",
		);
	}
	if (
		connection.platform === "twitter" &&
		(!env.TWITTER_ADS_CONSUMER_KEY ||
			!env.TWITTER_ADS_CONSUMER_SECRET ||
			!tokenSecret)
	) {
		throw new AdPlatformError(
			"ADS_PROVIDER_NOT_CONFIGURED",
			"X Ads requires TWITTER_ADS_CONSUMER_KEY, TWITTER_ADS_CONSUMER_SECRET, and an OAuth1 token secret",
		);
	}
	const metadata = metadataObject(connection.metadata);
	return {
		accessToken,
		grantedScopes: [...connection.scopes],
		tokenSecret: tokenSecret ?? undefined,
		developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
		clientId:
			connection.platform === "twitter"
				? env.TWITTER_ADS_CONSUMER_KEY
				: connection.platform === "tiktok"
					? env.TIKTOK_ADS_APP_ID
					: undefined,
		clientSecret:
			connection.platform === "twitter"
				? env.TWITTER_ADS_CONSUMER_SECRET
				: connection.platform === "tiktok"
					? env.TIKTOK_ADS_APP_SECRET
					: undefined,
		loginCustomerId:
			connection.platform === "google"
				? typeof metadata.login_customer_id === "string"
					? metadata.login_customer_id
					: undefined
				: undefined,
		providerAdAccountId,
		metadata,
	};
}

/**
 * Resolve a dedicated ads credential. The only compatibility fallback is the
 * existing Meta ads user token; publishing credentials are never reused for a
 * non-Meta provider.
 */
export async function resolveAdProviderCredentials(input: {
	platform: AdPlatform;
	providerAdAccountId?: string;
	adConnection?: AdConnection | null;
	legacySocialAccount?: LegacySocialAccount | null;
	env: Env;
}): Promise<AdProviderCredentials> {
	if (input.adConnection) {
		if (input.adConnection.platform !== input.platform) {
			throw new AdPlatformError(
				"INVALID_STATE",
				"Ad connection platform does not match the ad account",
			);
		}
		return resolveDedicatedAdCredentials(
			input.adConnection,
			input.providerAdAccountId,
			input.env,
		);
	}
	if (
		input.platform === "meta" &&
		input.legacySocialAccount &&
		input.legacySocialAccount.lifecycleStatus !== "disconnected" &&
		input.legacySocialAccount.lifecycleStatus !== "revoked"
	) {
		const accessToken = await resolveAdsAccessToken(
			input.legacySocialAccount,
			input.env,
		);
		if (accessToken) {
			return {
				accessToken,
				providerAdAccountId: input.providerAdAccountId,
				metadata: {},
			};
		}
	}
	throw new AdPlatformError(
		"ADS_CONNECTION_REQUIRED",
		`Connect a dedicated ${input.platform} advertising account before using this operation`,
	);
}
