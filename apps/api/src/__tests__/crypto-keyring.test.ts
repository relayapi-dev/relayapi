import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	activeEncryptionKeyId,
	decryptToken,
	encryptToken,
	encryptionKeyId,
	needsReencryption,
} from "../lib/crypto";

const OLD_KEY = "11".repeat(32);
const NEW_KEY = "22".repeat(32);

describe("versioned encryption key ring", () => {
	it("writes with the active key and reads retained key versions", async () => {
		const oldCiphertext = await encryptToken("secret", `old=${OLD_KEY}`);
		const ring = `new=${NEW_KEY},old=${OLD_KEY}`;

		expect(encryptionKeyId(oldCiphertext)).toBe("old");
		expect(needsReencryption(oldCiphertext, ring)).toBe(true);
		expect(await decryptToken(oldCiphertext, ring)).toBe("secret");

		const newCiphertext = await encryptToken("secret", ring);
		expect(encryptionKeyId(newCiphertext)).toBe("new");
		expect(needsReencryption(newCiphertext, ring)).toBe(false);
		expect(activeEncryptionKeyId(ring)).toBe("new");
	});

	it("binds ciphertext to record and field when AAD is supplied", async () => {
		const context = { recordId: "acc_1", field: "access_token" };
		const ciphertext = await encryptToken("token", `active=${NEW_KEY}`, context);

		expect(await decryptToken(ciphertext, `active=${NEW_KEY}`, context)).toBe("token");
		await expect(
			decryptToken(ciphertext, `active=${NEW_KEY}`, {
				recordId: "acc_2",
				field: "access_token",
			}),
		).rejects.toThrow();
		await expect(
			decryptToken(ciphertext, `active=${NEW_KEY}`, {
				recordId: "acc_1",
				field: "refresh_token",
			}),
		).rejects.toThrow();
	});

	it("treats underscore key IDs literally in rotation selectors", async () => {
		const oldCiphertext = await encryptToken(
			"secret",
			`prodXkey=${OLD_KEY}`,
		);
		const ring = `prod_key=${NEW_KEY},prodXkey=${OLD_KEY}`;
		expect(needsReencryption(oldCiphertext, ring)).toBe(true);

		const rotationSource = readFileSync(
			new URL("../services/encryption-rotation.ts", import.meta.url),
			"utf8",
		);
		expect(rotationSource).toContain("function doesNotStartWith");
		expect(rotationSource).toMatch(
			/left\(\$\{value\}, char_length\(\$\{prefix\}\)\)/,
		);
		expect(rotationSource).not.toContain("notLike(");
	});

	it("rejects malformed and non-256-bit key material", async () => {
		await expect(encryptToken("x", "abcd")).rejects.toThrow(/64-hex/i);
		await expect(encryptToken("x", NEW_KEY)).rejects.toThrow(/key-id=64-hex/i);
		await expect(encryptToken("x", `active=${"z".repeat(64)}`)).rejects.toThrow(
			/64 hex/i,
		);
		await expect(
			encryptToken("x", `bad id=${NEW_KEY}`),
		).rejects.toThrow(/key id/i);
		await expect(decryptToken("plaintext", `active=${NEW_KEY}`)).rejects.toThrow(
			/enc:v2/i,
		);
	});
});
