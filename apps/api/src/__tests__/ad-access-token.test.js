import { describe, expect, it } from "bun:test";
import { encryptAccountToken } from "../lib/account-token-crypto";
import {
	mergePublicSocialAccountMetadata,
	resolveAdsAccessToken,
	sanitizeSocialAccountMetadata,
	withMetaAdsUserAccessToken,
} from "../services/ad-access-token";

const ENCRYPTION_KEY = `test=${"11".repeat(32)}`;
const ACCOUNT_ID = "acc_ads_token_test";

describe("ad-access-token", () => {
	it("prefers the saved Meta user token for Facebook ads operations", async () => {
		const pageToken = await encryptAccountToken(
			"page_token",
			ENCRYPTION_KEY,
			ACCOUNT_ID,
			"access_token",
		);
		const userToken = await encryptAccountToken(
			"user_token",
			ENCRYPTION_KEY,
			ACCOUNT_ID,
			"meta_ads_user_access_token",
		);
		const token = await resolveAdsAccessToken(
			{
				id: ACCOUNT_ID,
				platform: "facebook",
				accessToken: pageToken,
				metadata: { meta_ads_user_access_token: userToken },
			},
			{ ENCRYPTION_KEY },
		);

		expect(token).toBe("user_token");
	});

	it("falls back to the primary token for non-Facebook platforms", async () => {
		const encryptedToken = await encryptAccountToken(
			"ig_token",
			ENCRYPTION_KEY,
			ACCOUNT_ID,
			"access_token",
		);
		const token = await resolveAdsAccessToken(
			{
				id: ACCOUNT_ID,
				platform: "instagram",
				accessToken: encryptedToken,
				metadata: { meta_ads_user_access_token: "user_token" },
			},
			{ ENCRYPTION_KEY },
		);

		expect(token).toBe("ig_token");
	});

	it("rejects unwrapped primary and Meta user credentials", async () => {
		await expect(
			resolveAdsAccessToken(
				{
					id: ACCOUNT_ID,
					platform: "instagram",
					accessToken: "ig_token",
					metadata: null,
				},
				{ ENCRYPTION_KEY },
			),
		).rejects.toThrow(/account token/i);

		await expect(
			resolveAdsAccessToken(
				{
					id: ACCOUNT_ID,
					platform: "facebook",
					accessToken: null,
					metadata: { meta_ads_user_access_token: "user_token" },
				},
				{ ENCRYPTION_KEY },
			),
		).rejects.toThrow(/account token/i);
	});

	it("fails closed when the encryption key is unavailable", async () => {
		const encryptedToken = await encryptAccountToken(
			"ig_token",
			ENCRYPTION_KEY,
			ACCOUNT_ID,
			"access_token",
		);
		await expect(
			resolveAdsAccessToken(
				{
					id: ACCOUNT_ID,
					platform: "instagram",
					accessToken: encryptedToken,
					metadata: null,
				},
				{},
			),
		).rejects.toThrow(/ENCRYPTION_KEY/);
	});

	it("merges Meta ads user token into existing metadata", () => {
		const metadata = withMetaAdsUserAccessToken(
			{ existing: true, nested: { ok: true } },
			"enc_user_token",
			"user_123",
			"2026-06-01T12:00:00.000Z",
		);

		expect(metadata).toEqual({
			existing: true,
			nested: { ok: true },
			meta_ads_user_access_token: "enc_user_token",
			meta_ads_user_access_token_expires_at: "2026-06-01T12:00:00.000Z",
			facebook_user_id: "user_123",
		});
	});

	it("requires reconnect when Facebook ads access is missing", async () => {
		await expect(
			resolveAdsAccessToken(
				{
					id: ACCOUNT_ID,
					platform: "facebook",
					accessToken: "page_token",
					metadata: { default_page_id: "page_123" },
				},
				{},
			),
		).rejects.toThrow(
			"Facebook ads access is missing. Reconnect the Facebook account to restore ads features.",
		);
	});

	it("requires reconnect when Facebook ads access is expired", async () => {
		await expect(
			resolveAdsAccessToken(
				{
					id: ACCOUNT_ID,
					platform: "facebook",
					accessToken: "page_token",
					metadata: {
						meta_ads_user_access_token: "user_token",
						meta_ads_user_access_token_expires_at: "2024-01-01T00:00:00.000Z",
					},
				},
				{},
			),
		).rejects.toThrow(
			"Facebook ads access expired. Reconnect the Facebook account to refresh ads permissions.",
		);
	});

	it("strips reserved provider metadata from API responses", () => {
		expect(
			sanitizeSocialAccountMetadata({
				meta_ads_user_access_token: "enc_user_token",
				meta_ads_user_access_token_expires_at: "2026-06-01T12:00:00.000Z",
				facebook_user_id: "user_123",
				tiktok_verified_url_prefixes: ["https://media.example/"],
				instance_url: "https://social.example",
				pds_url: "https://pds.example",
				waba_id: "waba_123",
				publication_id: "publication_123",
				default_location_id: "locations/connected",
				default_page_id: "page_123",
			}),
		).toEqual({
			instance_url: "https://social.example",
			pds_url: "https://pds.example",
			waba_id: "waba_123",
			publication_id: "publication_123",
			default_location_id: "locations/connected",
			default_page_id: "page_123",
		});
	});

	it("ignores reserved provider metadata keys in public metadata updates", () => {
		const metadata = mergePublicSocialAccountMetadata(
			{
				meta_ads_user_access_token: "enc_user_token",
				meta_ads_user_access_token_expires_at: "2026-06-01T12:00:00.000Z",
				facebook_user_id: "user_123",
				tiktok_verified_url_prefixes: ["https://media.example/"],
				instance_url: "https://social.example",
				pds_url: "https://pds.example",
				waba_id: "waba_123",
				publication_id: "publication_123",
				default_location_id: "locations/connected",
				webhook_id: "discord_webhook_123",
				guild_id: "discord_guild_123",
				channel_id: "discord_channel_123",
				team_id: "T123",
				service_id: "B123",
				default_page_id: "page_123",
			},
			{
				meta_ads_user_access_token: "malicious_override",
				meta_ads_user_access_token_expires_at: "2030-01-01T00:00:00.000Z",
				facebook_user_id: "override",
				tiktok_verified_url_prefixes: ["https://attacker.example/"],
				instance_url: "https://attacker.example",
				pds_url: "https://attacker.example",
				waba_id: "waba_attacker",
				publication_id: "publication_attacker",
				default_location_id: "locations/other",
				webhook_id: "discord_webhook_attacker",
				guild_id: "discord_guild_attacker",
				channel_id: "discord_channel_attacker",
				team_id: "TATTACKER",
				service_id: "BATTACKER",
				default_page_id: "page_456",
			},
		);

		expect(metadata).toEqual({
			meta_ads_user_access_token: "enc_user_token",
			meta_ads_user_access_token_expires_at: "2026-06-01T12:00:00.000Z",
			facebook_user_id: "user_123",
			tiktok_verified_url_prefixes: ["https://media.example/"],
			instance_url: "https://social.example",
			pds_url: "https://pds.example",
			waba_id: "waba_123",
			publication_id: "publication_123",
			default_location_id: "locations/connected",
			webhook_id: "discord_webhook_123",
			guild_id: "discord_guild_123",
			channel_id: "discord_channel_123",
			team_id: "T123",
			service_id: "B123",
			default_page_id: "page_456",
		});
	});
});
