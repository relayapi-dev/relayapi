import { describe, expect, it } from "bun:test";
import {
	claimOneTimeCapability,
	issueOneTimeCapability,
} from "../services/one-time-capability";

const ENCRYPTION_KEY = `test=${"a".repeat(64)}`;

function createCapabilityDb() {
	let row: Record<string, unknown> | null = null;
	return {
		db: {
			insert: () => ({
				values: async (value: Record<string, unknown>) => {
					if (row) throw new Error("duplicate capability");
					row = { ...value, claimedAt: null };
				},
			}),
			update: () => {
				let values: Record<string, unknown> = {};
				return {
					set(value: Record<string, unknown>) {
						values = value;
						return this;
					},
					where() {
						return this;
					},
					returning: async () => {
						if (
							!row ||
							row.claimedAt ||
							!(row.expiresAt instanceof Date) ||
							row.expiresAt <= new Date()
						) {
							return [];
						}
						row = { ...row, ...values };
						return [{ payloadCiphertext: row.payloadCiphertext }];
					},
				};
			},
		} as never,
		getRow: () => row,
	};
}

describe("one-time capabilities", () => {
	it("stores no raw bearer or plaintext payload and claims exactly once", async () => {
		const store = createCapabilityDb();
		const token = "01234567".repeat(4);
		await issueOneTimeCapability(store.db, ENCRYPTION_KEY, {
			kind: "websocket_ticket",
			token,
			organizationId: "org_1",
			payload: { org_id: "org_1" },
			expiresAt: new Date(Date.now() + 60_000),
		});

		const serialized = JSON.stringify(store.getRow());
		expect(serialized).not.toContain(token);
		expect(serialized).not.toContain('"org_id":"org_1"');
		expect(
			await claimOneTimeCapability<{ org_id: string }>(
				store.db,
				ENCRYPTION_KEY,
				"websocket_ticket",
				token,
			),
		).toEqual({ org_id: "org_1" });
		expect(
			await claimOneTimeCapability(
				store.db,
				ENCRYPTION_KEY,
				"websocket_ticket",
				token,
			),
		).toBeNull();
	});
});
