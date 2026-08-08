import { describe, expect, it } from "bun:test";
import { revokeDashboardPrincipal } from "./dashboard-principal-revocation";

function createRevocationDb(membershipExists = false) {
	const updatedTables: unknown[] = [];
	const deletedTables: unknown[] = [];
	let transactionCalls = 0;
	const tx = {
		select: () => ({
			from: () => ({
				where: async () => [
					{ key: "hashed_dashboard_key", principalId: "prn_member" },
				],
			}),
		}),
		delete: (table: unknown) => {
			deletedTables.push(table);
			return {
				where: async () => undefined,
			};
		},
		update: (table: unknown) => {
			updatedTables.push(table);
			return {
				set: () => ({ where: async () => undefined }),
			};
		},
	};
	return {
		db: {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => (membershipExists ? [{ id: "member_1" }] : []),
					}),
				}),
			}),
			transaction: async <T>(
				callback: (transaction: typeof tx) => Promise<T>,
			) => {
				transactionCalls += 1;
				return callback(tx);
			},
		},
		updatedTables,
		deletedTables,
		get transactionCalls() {
			return transactionCalls;
		},
	};
}

describe("dashboard principal membership revocation", () => {
	it("disables principal keys, clears active sessions, and evicts both KV entries", async () => {
		const { db, deletedTables, updatedTables } = createRevocationDb();
		const deleted: string[] = [];

		await revokeDashboardPrincipal(
			db as never,
			{ delete: async (key) => void deleted.push(key) },
			"org_123",
			"user_123",
		);

		expect(updatedTables).toHaveLength(3);
		expect(deletedTables).toHaveLength(1);
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

	it("leaves credentials, sessions, and caches unchanged while membership remains", async () => {
		const state = createRevocationDb(true);
		const deleted: string[] = [];

		await revokeDashboardPrincipal(
			state.db as never,
			{ delete: async (key) => void deleted.push(key) },
			"org_123",
			"user_123",
		);

		expect(state.transactionCalls).toBe(0);
		expect(state.updatedTables).toHaveLength(0);
		expect(state.deletedTables).toHaveLength(0);
		expect(deleted).toHaveLength(0);
	});
});
