import { describe, expect, it } from "bun:test";
import { revokeDashboardPrincipal } from "./dashboard-principal-revocation";

function createRevocationDb() {
	const updatedTables: unknown[] = [];
	const tx = {
		select: () => ({
			from: () => ({
				where: async () => [{ key: "hashed_dashboard_key" }],
			}),
		}),
		update: (table: unknown) => {
			updatedTables.push(table);
			return {
				set: () => ({ where: async () => undefined }),
			};
		},
	};
	return {
		db: {
			transaction: async <T>(
				callback: (transaction: typeof tx) => Promise<T>,
			) => callback(tx),
		},
		updatedTables,
	};
}

describe("dashboard principal membership revocation", () => {
	it("disables principal keys, clears active sessions, and evicts both KV entries", async () => {
		const { db, updatedTables } = createRevocationDb();
		const deleted: string[] = [];

		await revokeDashboardPrincipal(
			db as never,
			{ delete: async (key) => void deleted.push(key) },
			"org_123",
			"user_123",
		);

		expect(updatedTables).toHaveLength(2);
		expect(deleted).toEqual([
			"dashboard-key:org_123:user_123",
			"apikey:hashed_dashboard_key",
		]);
	});

	it("fails the removal hook when cache revocation cannot be confirmed", async () => {
		const { db } = createRevocationDb();
		await expect(
			revokeDashboardPrincipal(
				db as never,
				{
					delete: async () => {
						throw new Error("KV unavailable");
					},
				},
				"org_123",
				"user_123",
			),
		).rejects.toThrow("KV unavailable");
	});
});
