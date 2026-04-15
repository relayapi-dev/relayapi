import { describe, expect, it } from "bun:test";
import {
	adAccounts,
	adAudiences,
	adCampaigns,
	adSyncLogs,
	ads,
	type Database,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { deleteConnectedAccountGraph } from "../lib/delete-account";

const TABLE_NAMES = new Map<unknown, string>([
	[postTargets, "post_targets"],
	[adSyncLogs, "ad_sync_logs"],
	[ads, "ads"],
	[adCampaigns, "ad_campaigns"],
	[adAudiences, "ad_audiences"],
	[adAccounts, "ad_accounts"],
	[socialAccounts, "social_accounts"],
]);

function createMockDeletionDb(adAccountIds: string[]): {
	db: Database;
	deletedTables: string[];
} {
	const deletedTables: string[] = [];

	const tx = {
		select: () => ({
			from: () => ({
				where: async () => adAccountIds.map((id) => ({ id })),
			}),
		}),
		delete: (table: unknown) => ({
			where: async () => {
				deletedTables.push(TABLE_NAMES.get(table) ?? String(table));
			},
		}),
	};

	const db = {
		transaction: async (callback: (tx: any) => Promise<void>): Promise<void> =>
			callback(tx),
	} as Database;

	return { db, deletedTables };
}

describe("deleteConnectedAccountGraph", () => {
	it("deletes ad dependencies before removing the social account", async () => {
		const { db, deletedTables } = createMockDeletionDb(["adacc_1", "adacc_2"]);

		await deleteConnectedAccountGraph(db, "acc_123");

		expect(deletedTables).toEqual([
			"post_targets",
			"ad_sync_logs",
			"ads",
			"ad_campaigns",
			"ad_audiences",
			"ad_accounts",
			"social_accounts",
		]);
	});

	it("skips ad cleanup when the account has no ad accounts", async () => {
		const { db, deletedTables } = createMockDeletionDb([]);

		await deleteConnectedAccountGraph(db, "acc_123");

		expect(deletedTables).toEqual(["post_targets", "social_accounts"]);
	});
});
