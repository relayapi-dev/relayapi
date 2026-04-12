import { maybeDecrypt } from "../lib/crypto";
import { AdPlatformError } from "./ad-platforms/types";
import type { Env } from "../types";

const META_ADS_USER_ACCESS_TOKEN_KEY = "meta_ads_user_access_token";
const META_ADS_USER_ACCESS_TOKEN_EXPIRES_AT_KEY =
	"meta_ads_user_access_token_expires_at";
const FACEBOOK_USER_ID_KEY = "facebook_user_id";
const INTERNAL_SOCIAL_ACCOUNT_METADATA_KEYS = new Set([
	META_ADS_USER_ACCESS_TOKEN_KEY,
	META_ADS_USER_ACCESS_TOKEN_EXPIRES_AT_KEY,
	FACEBOOK_USER_ID_KEY,
]);

function getMetadataObject(metadata: unknown): Record<string, unknown> | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}

	return { ...(metadata as Record<string, unknown>) };
}

function getMetadataString(metadata: unknown, key: string): string | null {
	const value = getMetadataObject(metadata)?.[key];
	return typeof value === "string" ? value : null;
}

function getMetadataDate(metadata: unknown, key: string): Date | null {
	const value = getMetadataString(metadata, key);
	if (!value) return null;

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getMetaAdsUserAccessToken(metadata: unknown): string | null {
	return getMetadataString(metadata, META_ADS_USER_ACCESS_TOKEN_KEY);
}

export function getMetaAdsUserAccessTokenExpiresAt(
	metadata: unknown,
): Date | null {
	return getMetadataDate(metadata, META_ADS_USER_ACCESS_TOKEN_EXPIRES_AT_KEY);
}

export function getFacebookAdsAccessIssue(
	account: {
		platform: string;
		metadata: unknown;
	},
	now: Date = new Date(),
): { message: string; expiresAt: Date | null } | null {
	if (account.platform !== "facebook") return null;

	if (!getMetaAdsUserAccessToken(account.metadata)) {
		return {
			message:
				"Facebook ads access is missing. Reconnect the Facebook account to restore ads features.",
			expiresAt: null,
		};
	}

	const expiresAt = getMetaAdsUserAccessTokenExpiresAt(account.metadata);
	if (expiresAt && expiresAt.getTime() <= now.getTime()) {
		return {
			message:
				"Facebook ads access expired. Reconnect the Facebook account to refresh ads permissions.",
			expiresAt,
		};
	}

	return null;
}

export function sanitizeSocialAccountMetadata(
	metadata: unknown,
): Record<string, unknown> | null {
	const nextMetadata = getMetadataObject(metadata);
	if (!nextMetadata) return null;

	for (const key of INTERNAL_SOCIAL_ACCOUNT_METADATA_KEYS) {
		delete nextMetadata[key];
	}

	return nextMetadata;
}

export function mergePublicSocialAccountMetadata(
	metadata: unknown,
	updates: unknown,
): Record<string, unknown> {
	const nextMetadata = getMetadataObject(metadata) ?? {};
	const publicUpdates = getMetadataObject(updates);
	if (!publicUpdates) return nextMetadata;

	for (const [key, value] of Object.entries(publicUpdates)) {
		if (INTERNAL_SOCIAL_ACCOUNT_METADATA_KEYS.has(key)) continue;
		nextMetadata[key] = value;
	}

	return nextMetadata;
}

export function withMetaAdsUserAccessToken(
	metadata: unknown,
	encryptedUserAccessToken: string,
	profileId?: string,
	expiresAt?: Date | string | null,
): Record<string, unknown> {
	const nextMetadata = getMetadataObject(metadata) ?? {};

	nextMetadata[META_ADS_USER_ACCESS_TOKEN_KEY] = encryptedUserAccessToken;
	if (profileId) {
		nextMetadata[FACEBOOK_USER_ID_KEY] = profileId;
	}
	if (expiresAt) {
		nextMetadata[META_ADS_USER_ACCESS_TOKEN_EXPIRES_AT_KEY] =
			expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt;
	} else {
		delete nextMetadata[META_ADS_USER_ACCESS_TOKEN_EXPIRES_AT_KEY];
	}

	return nextMetadata;
}

export async function resolveAdsAccessToken(
	account: {
		platform: string;
		accessToken: string | null;
		metadata: unknown;
	},
	env: Env,
): Promise<string> {
	const accessIssue = getFacebookAdsAccessIssue(account);
	if (accessIssue) {
		throw new AdPlatformError("INVALID_STATE", accessIssue.message);
	}

	// Facebook page connections store a Page token as the primary access token,
	// but Meta ads endpoints need the original user token captured during OAuth.
	const encryptedToken =
		(account.platform === "facebook"
			? getMetaAdsUserAccessToken(account.metadata)
			: null) ?? account.accessToken;

	if (encryptedToken && env.ENCRYPTION_KEY) {
		return (await maybeDecrypt(encryptedToken, env.ENCRYPTION_KEY)) ?? "";
	}

	return encryptedToken ?? "";
}
