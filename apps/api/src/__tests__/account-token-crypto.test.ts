import { describe, expect, it } from "bun:test";
import {
	accountTokenNeedsReencryption,
	decryptAccountToken,
	decryptAccountTokens,
	encryptAccountToken,
	reencryptAccountToken,
} from "../lib/account-token-crypto";
import { encryptToken } from "../lib/crypto";

const OLD_KEY = "31".repeat(32);
const NEW_KEY = "42".repeat(32);
const ACCOUNT_ID = "acc_account_crypto";

describe("account token crypto contract", () => {
	it("rejects ciphertext that is not in the account envelope", async () => {
		const keyConfig = `old=${OLD_KEY}`;
		const unwrapped = await encryptToken("connect-access", keyConfig, {
			recordId: ACCOUNT_ID,
			field: "access_token",
		});

		await expect(
			decryptAccountToken(
				unwrapped,
				keyConfig,
				ACCOUNT_ID,
				"access_token",
			),
		).rejects.toThrow(/account token/i);
	});

	it("runs connect, refresh, consumer use, key rotation, and revocation through one contract", async () => {
		const oldConfig = `old=${OLD_KEY}`;
		const rotationConfig = `new=${NEW_KEY},old=${OLD_KEY}`;
		const sealedAccess = await encryptAccountToken(
			"access-v1",
			oldConfig,
			ACCOUNT_ID,
			"access_token",
		);
		const sealedRefresh = await encryptAccountToken(
			"refresh-v1",
			oldConfig,
			ACCOUNT_ID,
			"refresh_token",
		);
		expect(sealedAccess?.startsWith("acct:v1:")).toBe(true);

		// Refresh write and normal publisher/inbox/analytics reads.
		const refreshedAccess = await encryptAccountToken(
			"access-v2",
			oldConfig,
			ACCOUNT_ID,
			"access_token",
		);
		const consumer = await decryptAccountTokens(
			{
				id: ACCOUNT_ID,
				accessToken: refreshedAccess,
				refreshToken: sealedRefresh,
			},
			oldConfig,
		);
		expect(consumer.accessToken).toBe("access-v2");
		expect(consumer.refreshToken).toBe("refresh-v1");

		// Online key rotation preserves the same account/field AAD.
		expect(accountTokenNeedsReencryption(refreshedAccess, rotationConfig)).toBe(
			true,
		);
		const rotatedAccess = await reencryptAccountToken(
			refreshedAccess,
			rotationConfig,
			ACCOUNT_ID,
			"access_token",
		);
		expect(accountTokenNeedsReencryption(rotatedAccess, rotationConfig)).toBe(
			false,
		);

		// A revocation job can decrypt the copied ciphertext with the same source id.
		expect(
			await decryptAccountToken(
				rotatedAccess,
				rotationConfig,
				ACCOUNT_ID,
				"access_token",
			),
		).toBe("access-v2");
	});

	it("never retries current ciphertext without AAD", async () => {
		const keyConfig = `active=${NEW_KEY}`;
		const ciphertext = await encryptAccountToken(
			"secret",
			keyConfig,
			ACCOUNT_ID,
			"access_token",
		);
		await expect(
			decryptAccountToken(ciphertext, keyConfig, "acc_other", "access_token"),
		).rejects.toThrow();
		await expect(
			decryptAccountToken(ciphertext, keyConfig, ACCOUNT_ID, "refresh_token"),
		).rejects.toThrow();
	});
});
