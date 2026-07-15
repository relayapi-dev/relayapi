import { describe, expect, it } from "bun:test";
import {
	accountRevocationJobs,
	adAccounts,
	automationBindings,
	automationEntrypoints,
	autoPostRules,
	broadcasts,
	connectionLogs,
	type Database,
	socialAccounts,
} from "@relayapi/db";
import { deleteConnectedAccountGraph } from "../lib/delete-account";

const TABLE_NAMES = new Map<unknown, string>([
	[accountRevocationJobs, "account_revocation_jobs"],
	[adAccounts, "ad_accounts"],
	[autoPostRules, "auto_post_rules"],
	[automationBindings, "automation_bindings"],
	[automationEntrypoints, "automation_entrypoints"],
	[broadcasts, "broadcasts"],
	[connectionLogs, "connection_logs"],
	[socialAccounts, "social_accounts"],
]);

function createMockLifecycleDb(status = "active"): {
	db: Database;
	operations: string[];
	revocationValues: Array<Record<string, unknown>>;
} {
	const operations: string[] = [];
	const revocationValues: Array<Record<string, unknown>> = [];
	const account = {
		id: "acc_123",
		organizationId: "org_123",
		platform: "twitter",
		platformAccountId: "platform_123",
		webhookAccountId: null,
		username: "relay",
		displayName: "Relay",
		avatarUrl: null,
		accessToken: "enc:access",
		refreshToken: "enc:refresh",
		tokenVersion: 9,
		tokenExpiresAt: new Date("2026-08-01T00:00:00Z"),
		scopes: [],
		metadata: null,
		schedulingPreferences: null,
		workspaceId: "ws_123",
		lifecycleStatus: status,
		disconnectRequestedAt: null,
		disconnectedAt: null,
		disconnectReason: null,
		connectedAt: new Date(),
		updatedAt: new Date(),
	};

	const tx = {
		select: () => ({
			from: () => ({
				where: () => ({
					for: () => ({ limit: async () => [account] }),
				}),
			}),
		}),
		insert: (table: unknown) => ({
			values: (values: Record<string, unknown>) => {
				operations.push(`insert:${TABLE_NAMES.get(table)}`);
				if (table === accountRevocationJobs) revocationValues.push(values);
				return {
					onConflictDoUpdate: async () => undefined,
				};
			},
		}),
		update: (table: unknown) => ({
			set: () => ({
				where: async () => {
					operations.push(`update:${TABLE_NAMES.get(table)}`);
				},
			}),
		}),
	};

	const db = {
		transaction: async (callback: (txArg: typeof tx) => Promise<void>) =>
			callback(tx),
	} as unknown as Database;

	return { db, operations, revocationValues };
}

describe("deleteConnectedAccountGraph", () => {
	it("preserves account/history and durably stages revocation before pausing work", async () => {
		const { db, operations, revocationValues } = createMockLifecycleDb();

		await deleteConnectedAccountGraph(db, "acc_123");

		expect(operations.slice(0, 3)).toEqual([
			"insert:account_revocation_jobs",
			"insert:connection_logs",
			"update:social_accounts",
		]);
		expect(operations).toContain("update:auto_post_rules");
		expect(operations).toContain("update:broadcasts");
		expect(operations).toContain("update:automation_entrypoints");
		expect(operations).toContain("update:automation_bindings");
		expect(operations).toContain("update:ad_accounts");
		expect(revocationValues[0]?.sourceTokenVersion).toBe(9);
		expect(
			operations.some((operation) => operation.startsWith("delete:")),
		).toBe(false);
	});

	it("is idempotent once the durable identity is no longer active", async () => {
		const { db, operations } = createMockLifecycleDb("disconnected");

		await deleteConnectedAccountGraph(db, "acc_123");

		expect(operations).toEqual([]);
	});

	it("persists required follow-up work before the lifecycle transaction commits", async () => {
		const { db, operations } = createMockLifecycleDb();

		const result = await deleteConnectedAccountGraph(
			db,
			"acc_123",
			async (_tx, account) => {
				operations.push(`outbox:${account.id}`);
				return "persisted" as const;
			},
		);

		expect(result).toBe("persisted");
		expect(operations.at(-1)).toBe("outbox:acc_123");
	});
});
