import { describe, expect, it } from "bun:test";
import { adAccounts, adConnections, type Database } from "@relayapi/db";
import {
	adConnectionTokenNeedsReencryption,
	decryptAdConnectionToken,
	encryptAdConnectionToken,
	reencryptAdConnectionToken,
} from "../lib/ad-connection-token-crypto";
import {
	CreateAdConnectionBody,
	RotateAdConnectionCredentialsBody,
} from "../schemas/ads";
import { createValidatedAdConnection } from "../services/ad-connection-service";
import type { Env } from "../types";

const KEY = `test=${"8a".repeat(32)}`;

function connectionDb(projectedReturnCount?: number) {
	let transactionCalls = 0;
	let storedConnection: Record<string, unknown> | undefined;
	let projectedAccounts: Array<Record<string, unknown>> = [];
	const tx = {
		update: (table: unknown) => ({
			set: (_values: Record<string, unknown>) => ({
				where: async (_condition: unknown) => {
					if (table !== adAccounts) throw new Error("unexpected update table");
					return [];
				},
			}),
		}),
		insert: (table: unknown) => ({
			values: (
				value: Record<string, unknown> | Array<Record<string, unknown>>,
			) => {
				if (table === adConnections) {
					storedConnection = value as Record<string, unknown>;
					return {
						onConflictDoNothing: () => ({
							returning: async () => [
								{
									...storedConnection,
									accessTokenExpiresAt: null,
									refreshTokenExpiresAt: null,
									credentialVersion: 1,
									refreshLeaseExpiresAt: null,
									lastRefreshAttemptAt: null,
									lastError: null,
									revokedAt: null,
									createdAt: new Date(),
									updatedAt: new Date(),
								},
							],
						}),
					};
				}
				if (table === adAccounts) {
					projectedAccounts = value as Array<Record<string, unknown>>;
					return {
						onConflictDoUpdate: () => ({
							returning: async () =>
								projectedAccounts
									.slice(0, projectedReturnCount ?? projectedAccounts.length)
									.map((_, index) => ({ id: `adacc_${index}` })),
						}),
					};
				}
				throw new Error("unexpected table");
			},
		}),
	};
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => [] }) }),
		}),
		transaction: async (callback: (value: typeof tx) => Promise<unknown>) => {
			transactionCalls += 1;
			return callback(tx);
		},
	} as unknown as Database;
	return {
		db,
		get transactionCalls() {
			return transactionCalls;
		},
		get storedConnection() {
			return storedConnection;
		},
		get projectedAccounts() {
			return projectedAccounts;
		},
	};
}

describe("dedicated ad connection credentials", () => {
	it("uses a context-bound encrypted envelope and never stores plaintext", async () => {
		const encrypted = await encryptAdConnectionToken(
			"provider-secret-token",
			KEY,
			"adconn_test",
			"access_token",
		);
		expect(encrypted).toStartWith("adconn:v1:");
		expect(encrypted).not.toContain("provider-secret-token");
		expect(
			await decryptAdConnectionToken(
				encrypted,
				KEY,
				"adconn_test",
				"access_token",
			),
		).toBe("provider-secret-token");
		await expect(
			decryptAdConnectionToken(encrypted, KEY, "adconn_other", "access_token"),
		).rejects.toThrow();
	});

	it("rotates every dedicated-ad token without changing its AAD", async () => {
		const oldKey = `old=${"7b".repeat(32)}`;
		const keyRing = `current=${"9c".repeat(32)},old=${"7b".repeat(32)}`;
		for (const field of [
			"access_token",
			"refresh_token",
			"token_secret",
		] as const) {
			const stored = await encryptAdConnectionToken(
				`${field}-value`,
				oldKey,
				"adconn_rotate",
				field,
			);
			expect(adConnectionTokenNeedsReencryption(stored, keyRing)).toBe(true);
			const rotated = await reencryptAdConnectionToken(
				stored,
				keyRing,
				"adconn_rotate",
				field,
			);
			expect(adConnectionTokenNeedsReencryption(rotated, keyRing)).toBe(false);
			expect(
				await decryptAdConnectionToken(
					rotated,
					keyRing,
					"adconn_rotate",
					field,
				),
			).toBe(`${field}-value`);
		}
	});

	it("requires the X OAuth 1.0a token secret", () => {
		const parsed = CreateAdConnectionBody.safeParse({
			platform: "twitter",
			provider_principal_id: "x-user-1",
			access_token: "oauth-token",
			scopes: [],
		});
		expect(parsed.success).toBe(false);
	});

	it("requires TikTok OAuth advertiser_ids and strips arbitrary metadata", () => {
		expect(
			CreateAdConnectionBody.safeParse({
				platform: "tiktok",
				provider_principal_id: "business-user-1",
				access_token: "business-token",
			}).success,
		).toBe(false);
		const parsed = CreateAdConnectionBody.parse({
			platform: "tiktok",
			provider_principal_id: "business-user-1",
			access_token: "business-token",
			metadata: {
				advertiser_ids: ["123"],
				unexpected_secret: "must-not-survive",
			},
		});
		expect(parsed.metadata).toEqual({ advertiser_ids: ["123"] });
	});

	it("requires a complete access token on every explicit rotation", () => {
		expect(
			RotateAdConnectionCredentialsBody.safeParse({ scopes: [] }).success,
		).toBe(false);
	});

	it("validates provider discovery before atomically storing secrets and accounts", async () => {
		const fixture = connectionDb();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			Response.json({
				items: [{ id: "pin-ad-1", name: "Pinterest UK", currency: "GBP" }],
			})) as unknown as typeof fetch;
		try {
			const result = await createValidatedAdConnection(
				{
					ENCRYPTION_KEY: KEY,
					HYPERDRIVE: { connectionString: "postgres://unused" },
				} as Env,
				{
					organizationId: "org_1",
					workspaceId: null,
					platform: "pinterest",
					providerPrincipalId: "pin-user-1",
					accessToken: "pinterest-secret",
					scopes: ["ads:read", "ads:write"],
				},
				fixture.db,
			);
			expect(result.accounts).toHaveLength(1);
			expect(fixture.transactionCalls).toBe(1);
			expect(fixture.projectedAccounts).toHaveLength(1);
			expect(fixture.projectedAccounts[0]?.status).toBe("active");
			expect(String(fixture.storedConnection?.accessToken)).toStartWith(
				"adconn:v1:",
			);
			expect(String(fixture.storedConnection?.accessToken)).not.toContain(
				"pinterest-secret",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("refuses to reassign an ad account owned by another active authority", async () => {
		const fixture = connectionDb(0);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			Response.json({
				items: [{ id: "pin-ad-1", name: "Pinterest UK", currency: "GBP" }],
			})) as unknown as typeof fetch;
		try {
			await expect(
				createValidatedAdConnection(
					{
						ENCRYPTION_KEY: KEY,
						HYPERDRIVE: { connectionString: "postgres://unused" },
					} as Env,
					{
						organizationId: "org_1",
						workspaceId: null,
						platform: "pinterest",
						providerPrincipalId: "pin-user-2",
						accessToken: "pinterest-secret",
						scopes: ["ads:read", "ads:write"],
					},
					fixture.db,
				),
			).rejects.toMatchObject({ code: "AD_ACCOUNT_ALREADY_CONNECTED" });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not open a database transaction when provider validation fails", async () => {
		const fixture = connectionDb();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			Response.json(
				{ error: "invalid token" },
				{ status: 401 },
			)) as unknown as typeof fetch;
		try {
			await expect(
				createValidatedAdConnection(
					{
						ENCRYPTION_KEY: KEY,
						HYPERDRIVE: { connectionString: "postgres://unused" },
					} as Env,
					{
						organizationId: "org_1",
						workspaceId: null,
						platform: "pinterest",
						providerPrincipalId: "pin-user-1",
						accessToken: "invalid",
						scopes: ["ads:read", "ads:write"],
					},
					fixture.db,
				),
			).rejects.toMatchObject({ code: "ADS_CONNECTION_AUTH_FAILED" });
			expect(fixture.transactionCalls).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
