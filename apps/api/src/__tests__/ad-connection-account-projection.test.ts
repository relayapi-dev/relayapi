import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { adAccounts, adConnections, type Database } from "@relayapi/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { encryptAdConnectionToken } from "../lib/ad-connection-token-crypto";
import {
	discoverAdAccountsForConnection,
	rotateValidatedAdConnection,
} from "../services/ad-connection-service";
import type { Env } from "../types";

const originalFetch = globalThis.fetch;
const KEY = `test=${"8a".repeat(32)}`;
type AdConnection = typeof adConnections.$inferSelect;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function connection(overrides: Partial<AdConnection> = {}): AdConnection {
	return {
		id: "adconn_current",
		organizationId: "org_current",
		workspaceId: "ws_current",
		scopeKey: "ws_current",
		platform: "pinterest",
		providerPrincipalId: "pinterest-user",
		displayName: "Pinterest",
		accessToken: null,
		refreshToken: null,
		tokenSecret: null,
		accessTokenExpiresAt: null,
		refreshTokenExpiresAt: null,
		scopes: ["ads:read", "ads:write"],
		status: "active",
		credentialVersion: 4,
		metadata: {},
		refreshLeaseExpiresAt: null,
		lastRefreshAttemptAt: null,
		lastError: null,
		revokedAt: null,
		createdAt: new Date("2026-08-01T00:00:00.000Z"),
		updatedAt: new Date("2026-08-01T00:00:00.000Z"),
		...overrides,
	};
}

function projectionDatabase(
	current: AdConnection,
	authoritative: AdConnection = current,
) {
	let transactionCalls = 0;
	const insertedRows: Array<Record<string, unknown>> = [];
	const disabled: Array<{ values: Record<string, unknown>; where: SQL }> = [];

	const tx = {
		select: () => {
			const query = {
				from: (_table: unknown) => query,
				where: (_condition: SQL) => query,
				for: (_mode: "update") => query,
				limit: async (_limit: number) => [authoritative],
			};
			return query;
		},
		insert: (table: unknown) => ({
			values: (values: Array<Record<string, unknown>>) => {
				if (table !== adAccounts) throw new Error("Unexpected insert table");
				insertedRows.push(...values);
				return {
					onConflictDoUpdate: () => ({
						returning: async () =>
							values.map((_, index) => ({ id: `adacc_${index}` })),
					}),
				};
			},
		}),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: (where: SQL) => {
					if (table === adConnections) {
						return {
							returning: async () => [
								{
									...current,
									...values,
									credentialVersion: current.credentialVersion + 1,
								},
							],
						};
					}
					if (table !== adAccounts) throw new Error("Unexpected update table");
					disabled.push({ values, where });
					return Promise.resolve([]);
				},
			}),
		}),
	};
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [current] }),
			}),
		}),
		transaction: async <T>(run: (value: typeof tx) => Promise<T>) => {
			transactionCalls += 1;
			return run(tx);
		},
	} as unknown as Database;

	return {
		db,
		insertedRows,
		disabled,
		get transactionCalls() {
			return transactionCalls;
		},
	};
}

function env(): Env {
	return {
		ENCRYPTION_KEY: KEY,
		HYPERDRIVE: { connectionString: "postgres://unused" },
	} as Env;
}

function compiled(where: SQL) {
	const query = new PgDialect().sqlToQuery(where);
	return { ...query, sql: query.sql.replace(/\s+/g, " ") };
}

describe("dedicated ad account discovery projection", () => {
	it("keeps disabled discovery projections outside audience and interest provider authority", () => {
		const audienceService = readFileSync(
			new URL("../services/ad-audience.ts", import.meta.url),
			"utf8",
		);
		const adsRoute = readFileSync(
			new URL("../routes/ads.ts", import.meta.url),
			"utf8",
		);
		expect(audienceService).toContain('eq(adAccounts.status, "active")');
		expect(adsRoute).toContain('eq(adAccounts.status, "active")');
	});

	it("atomically upserts returned accounts and disables only missing rows on the exact connection", async () => {
		const current = connection();
		const fixture = projectionDatabase(current);
		globalThis.fetch = (async () =>
			Response.json({
				items: [
					{
						id: "pin-kept",
						name: "Kept account",
						currency: "usd",
						status: "ACTIVE",
					},
				],
			})) as unknown as typeof fetch;

		await rotateValidatedAdConnection(
			env(),
			current,
			{
				accessToken: "new-pinterest-token",
				scopes: ["ads:read", "ads:write"],
			},
			fixture.db,
		);

		expect(fixture.transactionCalls).toBe(1);
		expect(fixture.insertedRows).toHaveLength(1);
		expect(fixture.insertedRows[0]).toMatchObject({
			adConnectionId: "adconn_current",
			organizationId: "org_current",
			workspaceId: "ws_current",
			platform: "pinterest",
			platformAdAccountId: "pin-kept",
			status: "active",
		});
		expect(fixture.disabled).toHaveLength(1);
		expect(fixture.disabled[0]?.values).toMatchObject({
			status: "disabled",
			syncLeaseExpiresAt: null,
			syncStartedAt: null,
		});

		const disable = fixture.disabled[0];
		if (!disable) throw new Error("Missing stale-account disable query");
		const query = compiled(disable.where);
		expect(query.sql).toContain('"ad_accounts"."ad_connection_id" =');
		expect(query.sql).toContain('"ad_accounts"."organization_id" =');
		expect(query.sql).toContain('"ad_accounts"."workspace_id" =');
		expect(query.sql).toContain('"ad_accounts"."platform" =');
		expect(query.sql).toContain(
			'"ad_accounts"."platform_ad_account_id" not in',
		);
		for (const exactAuthority of [
			"adconn_current",
			"org_current",
			"ws_current",
			"pinterest",
			"pin-kept",
		]) {
			expect(query.params).toContain(exactAuthority);
		}
	});

	it("accepts a validated empty rotation and disables every row for that connection only", async () => {
		const current = connection({ workspaceId: null, scopeKey: "__org__" });
		const fixture = projectionDatabase(current);
		globalThis.fetch = (async () =>
			Response.json({ items: [] })) as unknown as typeof fetch;

		const result = await rotateValidatedAdConnection(
			env(),
			current,
			{
				accessToken: "valid-token-without-accounts",
				scopes: ["ads:read", "ads:write"],
			},
			fixture.db,
		);

		expect(result.accounts).toEqual([]);
		expect(fixture.transactionCalls).toBe(1);
		expect(fixture.insertedRows).toEqual([]);
		const disable = fixture.disabled[0];
		if (!disable) throw new Error("Missing empty-discovery disable query");
		const query = compiled(disable.where);
		expect(query.sql).toContain('"ad_accounts"."workspace_id" IS NULL');
		expect(query.sql).not.toContain("not in");
		expect(query.params).toContain("adconn_current");
		expect(query.params).toContain("org_current");
		expect(query.params).toContain("pinterest");
	});

	it("reconciles manual rediscovery inside one transaction, including an empty set", async () => {
		const current = connection({
			accessToken: await encryptAdConnectionToken(
				"stored-pinterest-token",
				KEY,
				"adconn_current",
				"access_token",
			),
		});
		const fixture = projectionDatabase(current);
		globalThis.fetch = (async () =>
			Response.json({ items: [] })) as unknown as typeof fetch;

		const result = await discoverAdAccountsForConnection(
			env(),
			"org_current",
			"adconn_current",
			["ws_current"],
			fixture.db,
		);

		expect(result).toEqual([]);
		expect(fixture.transactionCalls).toBe(1);
		expect(fixture.disabled).toHaveLength(1);
		const disable = fixture.disabled[0];
		if (!disable) throw new Error("Missing rediscovery disable query");
		const query = compiled(disable.where);
		expect(query.params).toContain("adconn_current");
		expect(query.params).toContain("org_current");
		expect(query.params).toContain("ws_current");
	});

	it("refuses to apply a discovery snapshot after the credential authority changes", async () => {
		const current = connection({
			accessToken: await encryptAdConnectionToken(
				"stored-pinterest-token",
				KEY,
				"adconn_current",
				"access_token",
			),
		});
		const fixture = projectionDatabase(
			current,
			connection({ credentialVersion: current.credentialVersion + 1 }),
		);
		globalThis.fetch = (async () =>
			Response.json({ items: [] })) as unknown as typeof fetch;

		await expect(
			discoverAdAccountsForConnection(
				env(),
				"org_current",
				"adconn_current",
				["ws_current"],
				fixture.db,
			),
		).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS" });
		expect(fixture.transactionCalls).toBe(1);
		expect(fixture.insertedRows).toEqual([]);
		expect(fixture.disabled).toEqual([]);
	});
});
