import { describe, expect, it } from "bun:test";
import { apikey, member, session } from "@relayapi/db";
import { prepareUserDeletion } from "./user-deletion";

type Row = Record<string, unknown>;

function fakeDatabase(seed: {
	memberships?: Row[];
	ownerCandidates?: Row[];
	keys?: Row[];
}) {
	let memberSelects = 0;
	const deletedTables: unknown[] = [];
	const updatedTables: Array<{ table: unknown; values: Row }> = [];
	const tx = {
		select: () => ({
			from: (table: unknown) => ({
				where: () => ({
					for: async () => {
						if (table === member) {
							memberSelects += 1;
							return memberSelects === 1
								? (seed.memberships ?? [])
								: (seed.ownerCandidates ?? []);
						}
						if (table === apikey) return seed.keys ?? [];
						return [];
					},
				}),
			}),
		}),
		execute: async () => undefined,
		delete: (table: unknown) => ({
			where: async () => {
				deletedTables.push(table);
			},
		}),
		update: (table: unknown) => ({
			set: (values: Row) => ({
				where: async () => {
					updatedTables.push({ table, values });
				},
			}),
		}),
	};
	return {
		db: {
			transaction: async <T>(callback: (transaction: typeof tx) => Promise<T>) =>
				callback(tx),
		},
		deletedTables,
		updatedTables,
	};
}

describe("user deletion preparation", () => {
	it("fails closed when cache invalidation is unavailable", async () => {
		const { db } = fakeDatabase({});
		await expect(
			prepareUserDeletion(db as never, undefined, "user_1"),
		).rejects.toMatchObject({
			status: "SERVICE_UNAVAILABLE",
			body: { code: "IDENTITY_DELETION_UNAVAILABLE" },
		});
	});

	it("blocks deletion of an organization's sole owner", async () => {
		const { db, deletedTables } = fakeDatabase({
			memberships: [{ organizationId: "org_1", role: "owner" }],
			ownerCandidates: [
				{ organizationId: "org_1", userId: "user_1", role: "owner" },
			],
		});
		const kv = { delete: async () => undefined };

		await expect(
			prepareUserDeletion(db as never, kv, "user_1"),
		).rejects.toMatchObject({
			status: "CONFLICT",
			body: {
				code: "SOLE_ORGANIZATION_OWNER",
				details: { organization_ids: ["org_1"] },
			},
		});
		expect(deletedTables).toHaveLength(0);
	});

	it("revokes user-bound keys and detaches service-key attribution", async () => {
		const { db, deletedTables, updatedTables } = fakeDatabase({
			memberships: [{ organizationId: "org_1", role: "owner" }],
			ownerCandidates: [
				{ organizationId: "org_1", userId: "user_1", role: "owner" },
				{ organizationId: "org_1", userId: "user_2", role: "owner" },
			],
			keys: [
				{
					id: "key_1",
					key: "hash_1",
					organizationId: "org_1",
					metadata: { principal_type: "dashboard_user" },
				},
				{
					id: "key_2",
					key: "hash_2",
					organizationId: "org_1",
					metadata: { principal_type: "service" },
				},
			],
		});
		const deletedCacheKeys: string[] = [];
		const kv = {
			delete: async (key: string) => {
				deletedCacheKeys.push(key);
			},
		};

		await prepareUserDeletion(db as never, kv, "user_1");

		expect(deletedTables).toContain(apikey);
		expect(deletedTables).toContain(session);
		expect(updatedTables).toContainEqual({
			table: apikey,
			values: expect.objectContaining({ referenceId: null }),
		});
		expect(deletedCacheKeys.sort()).toEqual([
			"apikey:hash_1",
			"dashboard-key:org_1:user_1",
		]);
	});
});
