import { expect, test } from "bun:test";
import {
	decryptDashboardApiKey,
	decryptDashboardCredential,
	encryptDashboardApiKey,
} from "./dashboard-key-envelope";

const secret = `test-dashboard-secret-${"b".repeat(32)}`;
const pointer = "dashboard-key:org_1:user_1";

test("dashboard bearer pointers are authenticated ciphertext bound to their KV key", async () => {
	const rawKey = `rlay_live_${"c".repeat(58)}`;
	const envelope = await encryptDashboardApiKey(rawKey, secret, pointer);

	expect(envelope).toStartWith("v2.");
	expect(envelope).not.toContain(rawKey);
	expect(await decryptDashboardApiKey(envelope, secret, pointer)).toBe(rawKey);
	expect(await decryptDashboardCredential(envelope, secret, pointer)).toEqual({
		apiKey: rawKey,
		credentialVersion: "legacy-v1",
	});
	await expect(
		decryptDashboardApiKey(
			envelope,
			secret,
			"dashboard-key:org_2:user_1",
		),
	).rejects.toThrow();
	await expect(
		decryptDashboardApiKey(envelope, `${secret}-wrong`, pointer),
	).rejects.toThrow();
});

test("legacy v1 raw-key pointers normalize to the legacy credential generation", async () => {
	const rawKey = `rlay_live_${"d".repeat(58)}`;
	const encoder = new TextEncoder();
	const material = await crypto.subtle.digest(
		"SHA-256",
		encoder.encode(`relayapi:dashboard-credential-envelope:v1:${secret}`),
	);
	const key = await crypto.subtle.importKey(
		"raw",
		material,
		"AES-GCM",
		false,
		["encrypt"],
	);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv,
				additionalData: encoder.encode(pointer),
			},
			key,
			encoder.encode(rawKey),
		),
	);
	const encode = (bytes: Uint8Array) => {
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
	};
	const legacyEnvelope = `v1.${encode(iv)}.${encode(encrypted)}`;

	expect(await decryptDashboardCredential(legacyEnvelope, secret, pointer)).toEqual(
		{
			apiKey: rawKey,
			credentialVersion: "legacy-v1",
		},
	);
});
