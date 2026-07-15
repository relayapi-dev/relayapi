import { describe, expect, it } from "bun:test";
import type { Database, whatsappPhoneNumbers } from "@relayapi/db";
import { stagePhoneRelease } from "../services/phone-number-operations";

type PhoneRow = typeof whatsappPhoneNumbers.$inferSelect;

function sqlHasParam(value: unknown, expected: string): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) {
		return value.some((item) => sqlHasParam(item, expected));
	}
	const candidate = value as { value?: unknown; queryChunks?: unknown[] };
	if (candidate.value === expected) return true;
	return (
		candidate.queryChunks?.some((chunk) => sqlHasParam(chunk, expected)) ??
		false
	);
}

function releaseDb(phone: PhoneRow) {
	const accountLookups: unknown[] = [];
	let stagedValues: Partial<PhoneRow> | undefined;
	const accounts = [
		{
			id: "acc_source_waba_a",
			tokenVersion: 7,
			accessToken: "ciphertext-for-waba-a",
			metadata: { waba_id: "waba_a" },
		},
		{
			id: "acc_result_waba_b",
			tokenVersion: 11,
			accessToken: "ciphertext-for-waba-b",
			metadata: { waba_id: "waba_b" },
		},
	];

	const tx = {
		select: (projection?: Record<string, unknown>) => {
			let condition: unknown;
			const builder = {
				from: (_table: unknown) => builder,
				where: (next: unknown) => {
					condition = next;
					return builder;
				},
				for: (_mode: string) => builder,
				limit: async (_limit: number) => {
					if (!projection) return [phone];
					accountLookups.push(condition);
					const account = accounts.find(({ id }) => sqlHasParam(condition, id));
					return account ? [account] : [];
				},
			};
			return builder;
		},
		update: (_table: unknown) => ({
			set: (values: Partial<PhoneRow>) => {
				stagedValues = values;
				return {
					where: (_condition: unknown) => ({
						returning: async () => [{ ...phone, ...values }],
					}),
				};
			},
		}),
	};
	const db = {
		transaction: async (callback: (transaction: typeof tx) => unknown) =>
			callback(tx),
	} as unknown as Database;

	return {
		db,
		accountLookups,
		getStagedValues: () => stagedValues,
	};
}

function phoneRow(overrides: Partial<PhoneRow> = {}): PhoneRow {
	return {
		id: "wapn_1",
		organizationId: "org_1",
		status: "active",
		provisioningState: "completed",
		provisioningSourceAccountId: "acc_source_waba_a",
		provisioningRequest: {
			account_id: "acc_source_waba_a",
			waba_id: "waba_a",
			verified_name: "Source business",
			country: "US",
		},
		// Deliberately model a resulting account from a second WABA. Release must
		// not prefer this row or scan the organization for a convenient token.
		socialAccountId: "acc_result_waba_b",
		waPhoneNumberId: "wa_phone_1",
		releaseState: null,
		releaseOperationId: null,
		releaseRequestedAt: null,
		provisioningRequestMayHaveBeenSentAt: null,
		telnyxOrderId: null,
		providerNumberId: null,
		stripeSubscriptionItemId: null,
		stripeCheckoutSessionId: null,
		...overrides,
	} as PhoneRow;
}

describe("WhatsApp phone source-account isolation", () => {
	it("stages release with the exact recorded source in a two-WABA organization", async () => {
		const phone = phoneRow();
		const { db, accountLookups, getStagedValues } = releaseDb(phone);

		const staged = await stagePhoneRelease(
			db,
			phone.organizationId,
			phone.id,
			"user_requested",
		);

		expect(accountLookups).toHaveLength(1);
		expect(sqlHasParam(accountLookups[0], "acc_source_waba_a")).toBe(true);
		expect(sqlHasParam(accountLookups[0], "acc_result_waba_b")).toBe(false);
		expect(staged.releaseState).toBe("pending");
		expect(staged.releaseSourceAccountId).toBe("acc_source_waba_a");
		expect(staged.releaseSourceTokenVersion).toBe(7);
		expect(staged.releaseAccessTokenCiphertext).toBe("ciphertext-for-waba-a");
		expect(getStagedValues()?.releaseSourceAccountId).toBe("acc_source_waba_a");
	});

	it("fails closed when the recorded source is missing instead of using a compatibility fallback", async () => {
		const phone = phoneRow({ provisioningSourceAccountId: null });
		const { db, accountLookups } = releaseDb(phone);

		const staged = await stagePhoneRelease(
			db,
			phone.organizationId,
			phone.id,
			"tenant_deleted",
		);

		expect(accountLookups).toHaveLength(0);
		expect(staged.releaseState).toBe("manual_review");
		expect(staged.releaseSourceAccountId).toBeNull();
		expect(staged.releaseAccessTokenCiphertext).toBeNull();
	});

	it("does not accept a recorded account whose WABA differs from the durable request", async () => {
		const phone = phoneRow({
			provisioningRequest: {
				account_id: "acc_source_waba_a",
				waba_id: "waba_b",
				verified_name: "Mismatched business",
				country: "US",
			},
		});
		const { db, accountLookups } = releaseDb(phone);

		const staged = await stagePhoneRelease(
			db,
			phone.organizationId,
			phone.id,
			"user_requested",
		);

		expect(accountLookups).toHaveLength(1);
		expect(staged.releaseState).toBe("manual_review");
		expect(staged.releaseSourceAccountId).toBeNull();
	});
});
