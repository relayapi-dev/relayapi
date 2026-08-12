import { describe, expect, it } from "bun:test";
import {
	contactPlaintextMatchesSearch,
	ContactProtectionIdentityKeyMismatchError,
	decryptContactChannelRow,
	decryptContactRow,
	deriveContactChannelIdentifierHash,
	deriveContactEmailHash,
	deriveContactNameHash,
	deriveContactPhoneHash,
	deriveContactSearchQuery,
	protectContactChannelIdentifier,
	protectContactValues,
} from "../services/contact-protection";

const KEY = `active=${"31".repeat(32)},identity=${"41".repeat(32)}`;
const OTHER_IDENTITY_KEY =
	`active=${"31".repeat(32)},identity=${"42".repeat(32)}`;

describe("contact-protection-blind-search", () => {
	it("keeps direct identifiers and metadata out of PostgreSQL plaintext", async () => {
		const id = "ct_protection_roundtrip";
		const organizationId = "org_protection";
		const protectedValues = await protectContactValues(
			KEY,
			organizationId,
			id,
			{
				name: "Alice Example",
				email: "Alice@example.com",
				phone: "+1 (415) 555-2671",
				metadata: { company: "Secret Bakery", score: 7 },
			},
		);

		const serialized = JSON.stringify(protectedValues);
		for (const plaintext of [
			"Alice Example",
			"Alice@example.com",
			"+1 (415) 555-2671",
			"Secret Bakery",
		]) {
			expect(serialized).not.toContain(plaintext);
		}
		for (const ciphertext of [
			protectedValues.nameCiphertext,
			protectedValues.emailCiphertext,
			protectedValues.phoneCiphertext,
			protectedValues.metadataCiphertext,
		]) {
			expect(ciphertext).toStartWith("enc:v2:active:");
		}

		const plaintext = await decryptContactRow(KEY, {
			id,
			organizationId,
			...protectedValues,
		});
		expect(plaintext).toMatchObject({
			name: "Alice Example",
			email: "Alice@example.com",
			phone: "+1 (415) 555-2671",
			metadata: { company: "Secret Bakery", score: 7 },
		});
	});

	it("isolates deterministic equality projections by tenant and purpose", async () => {
		const [emailA, emailARepeat, emailB, nameA, phoneA] = await Promise.all([
			deriveContactEmailHash(KEY, "org_a", "Alice@Example.com"),
			deriveContactEmailHash(KEY, "org_a", "alice@example.com"),
			deriveContactEmailHash(KEY, "org_b", "alice@example.com"),
			deriveContactNameHash(KEY, "org_a", "alice@example.com"),
			deriveContactPhoneHash(KEY, "org_a", "001 415 555 2671"),
		]);
		expect(emailA).toBe(emailARepeat);
		expect(emailA).not.toBe(emailB);
		expect(emailA).not.toBe(nameA);
		expect(phoneA).toHaveLength(64);
	});

	it("uses blind n-gram candidates with plaintext false-positive verification", async () => {
		const protectedValues = await protectContactValues(
			KEY,
			"org_search",
			"ct_search",
			{
				name: "Alice Example",
				email: "alice@example.com",
				phone: "+14155552671",
				metadata: null,
			},
		);
		const query = await deriveContactSearchQuery(
			KEY,
			"org_search",
			"ice ex",
		);
		expect(query.tokens.length).toBeGreaterThan(0);
		expect(
			query.tokens.every((token) =>
				protectedValues.nameSearchTokens.includes(token),
			),
		).toBe(true);
		expect(
			contactPlaintextMatchesSearch(
				{
					name: "Alice Example",
					email: "alice@example.com",
					phone: "+14155552671",
				},
				"ICE EX",
			),
		).toBe(true);
		expect(
			contactPlaintextMatchesSearch(
				{ name: "Alice Example", email: null, phone: null },
				"not present",
			),
		).toBe(false);
	});

	it("fails closed when the durable identity key no longer matches", async () => {
		const id = "ct_identity_mismatch";
		const organizationId = "org_identity_mismatch";
		const protectedValues = await protectContactValues(
			KEY,
			organizationId,
			id,
			{ name: "Alice", email: null, phone: null, metadata: null },
		);
		await expect(
			decryptContactRow(OTHER_IDENTITY_KEY, {
				id,
				organizationId,
				...protectedValues,
			}),
		).rejects.toBeInstanceOf(ContactProtectionIdentityKeyMismatchError);
	});

	it("protects channel identifiers with the same tenant-isolated authority", async () => {
		const id = "cc_protected";
		const organizationId = "org_channel";
		const protectedChannel = await protectContactChannelIdentifier(KEY, {
			id,
			organizationId,
			identifier: "ig-user-42",
		});
		expect(JSON.stringify(protectedChannel)).not.toContain("ig-user-42");
		expect(protectedChannel.identifierHash).toBe(
			await deriveContactChannelIdentifierHash(
				KEY,
				organizationId,
				"ig-user-42",
			),
		);
		const plaintext = await decryptContactChannelRow(KEY, {
			id,
			organizationId,
			...protectedChannel,
		});
		expect(plaintext.identifier).toBe("ig-user-42");
	});

	it("registers every contact ciphertext in resumable CAS key rotation", async () => {
		const source = await Bun.file(
			new URL("../services/encryption-rotation.ts", import.meta.url),
		).text();
		for (const marker of [
			"contacts.nameCiphertext",
			"contacts.emailCiphertext",
			"contacts.phoneCiphertext",
			"contacts.metadataCiphertext",
			"contactChannels.identifierCiphertext",
			'"contact_name"',
			'"contact_email"',
			'"contact_phone"',
			'"contact_metadata"',
			'"contact_channel_identifier"',
		]) {
			expect(source).toContain(marker);
		}
		expect(source).toContain("eq(column, oldValue)");
		expect(source).not.toContain("searchIdentityKeyFingerprint: activeId");
	});
});
