import { describe, expect, it } from "bun:test";
import {
	account,
	apikey,
	emailDeliveries,
	inviteTokens,
	media,
	member,
	organization,
	posts,
	session,
	user,
} from "@relayapi/db";
import type { AvatarObjectBucket } from "./avatar-object-keys";
import type { QueueRescueErasureBucket } from "./queue-rescue-erasure";
import { deleteUserAtomically } from "./user-deletion";

type Row = Record<string, unknown>;

function emptyQueueRescueBucket(): QueueRescueErasureBucket {
	return {
		list: async () => ({ objects: [], truncated: false }),
		delete: async () => undefined,
	};
}

function emptyAvatarBucket(): AvatarObjectBucket {
	return {
		list: async () => ({ objects: [], truncated: false }),
		delete: async () => undefined,
	};
}

function fakeDatabase(seed: {
	users?: Row[];
	memberships?: Row[];
	ownerCandidates?: Row[];
	activeOrganizations?: Row[];
	keys?: Row[];
}) {
	let memberSelects = 0;
	const deletedTables: unknown[] = [];
	const updatedTables: Array<{ table: unknown; values: Row }> = [];
	const rowsFor = (table: unknown): Row[] => {
		if (table === user) return seed.users ?? [{ id: "user_1" }];
		if (table === member) {
			memberSelects += 1;
			return memberSelects === 1
				? (seed.memberships ?? [])
				: (seed.ownerCandidates ?? []);
		}
		if (table === apikey) {
			return (seed.keys ?? []).filter((key) => key.principalKind === "member");
		}
		if (table === organization) {
			return (
				seed.activeOrganizations ??
				(seed.memberships ?? []).map((membership) => ({
					id: membership.organizationId,
				}))
			);
		}
		return [];
	};
	const tx = {
		select: () => ({
			from: (table: unknown) => ({
				where: () => {
					const selectedRows = rowsFor(table);
					const query = Promise.resolve(selectedRows) as Promise<Row[]> & {
						for: () => Promise<Row[]>;
						limit: () => { for: () => Promise<Row[]> };
					};
					query.for = async () => selectedRows;
					query.limit = () => ({ for: async () => selectedRows });
					return query;
				},
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
			transaction: async <T>(
				callback: (transaction: typeof tx) => Promise<T>,
			) => callback(tx),
		},
		deletedTables,
		updatedTables,
	};
}

describe("user deletion preparation", () => {
	it("fails closed when cache invalidation is unavailable", async () => {
		const { db } = fakeDatabase({});
		await expect(
			deleteUserAtomically(
				db as never,
				undefined,
				undefined,
				undefined,
				"user_1",
			),
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
			deleteUserAtomically(
				db as never,
				kv,
				emptyAvatarBucket(),
				emptyQueueRescueBucket(),
				"user_1",
			),
		).rejects.toMatchObject({
			status: "CONFLICT",
			body: {
				code: "SOLE_ORGANIZATION_OWNER",
				details: { organization_ids: ["org_1"] },
			},
		});
		expect(deletedTables).toHaveLength(0);
	});

	it("allows a sole owner to leave an organization already being erased", async () => {
		const { db, deletedTables } = fakeDatabase({
			memberships: [{ organizationId: "org_1", role: "owner" }],
			activeOrganizations: [],
		});
		const kv = { delete: async () => undefined };

		await deleteUserAtomically(
			db as never,
			kv,
			emptyAvatarBucket(),
			emptyQueueRescueBucket(),
			"user_1",
		);
		expect(deletedTables).toContain(user);
	});

	it("does not mutate the database when KV invalidation fails", async () => {
		const { db, deletedTables, updatedTables } = fakeDatabase({
			keys: [
				{
					id: "key_1",
					key: "hash_1",
					organizationId: "org_1",
					principalId: "prn_member_1",
					principalKind: "member",
				},
			],
		});
		const kv = {
			delete: async () => {
				throw new Error("KV unavailable");
			},
		};

		await expect(
			deleteUserAtomically(
				db as never,
				kv,
				emptyAvatarBucket(),
				emptyQueueRescueBucket(),
				"user_1",
			),
		).rejects.toThrow("KV unavailable");
		expect(deletedTables).toHaveLength(0);
		expect(updatedTables).toHaveLength(0);
	});

	it("atomically removes login data and preserves content attribution safely", async () => {
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
					principalId: "prn_member_1",
					principalKind: "member",
				},
				{
					id: "key_2",
					key: "hash_2",
					organizationId: "org_1",
					principalId: "prn_service_1",
					principalKind: "service",
				},
			],
		});
		const deletedCacheKeys: string[] = [];
		const kv = {
			delete: async (key: string) => {
				deletedCacheKeys.push(key);
			},
		};

		await deleteUserAtomically(
			db as never,
			kv,
			emptyAvatarBucket(),
			emptyQueueRescueBucket(),
			"user_1",
		);

		expect(deletedTables).toContain(apikey);
		expect(deletedTables).toContain(inviteTokens);
		expect(deletedTables).toContain(session);
		expect(deletedTables).toContain(account);
		expect(deletedTables).toContain(user);
		expect(deletedTables).not.toContain(member);
		expect(updatedTables).toContainEqual({
			table: apikey,
			values: expect.objectContaining({ referenceId: null }),
		});
		expect(updatedTables).toContainEqual({
			table: inviteTokens,
			values: { redeemedByUserId: null },
		});
		expect(updatedTables).toContainEqual({
			table: media,
			values: { uploadedBy: null },
		});
		expect(updatedTables).toContainEqual({
			table: posts,
			values: { createdBy: null },
		});
		expect(updatedTables).toContainEqual({
			table: emailDeliveries,
			values: expect.objectContaining({
				subjectUserId: null,
				envelopeCiphertext: null,
				envelopeKeyId: null,
				error: "recipient_identity_erased",
			}),
		});
		expect(deletedCacheKeys.sort()).toEqual([
			"apikey:hash_1",
			"dashboard-key:org_1:user_1",
		]);
	});
});
