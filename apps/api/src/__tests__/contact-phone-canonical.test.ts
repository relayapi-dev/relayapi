import { describe, expect, it } from "bun:test";
import { contacts } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { isContactPhone, normalizeContactPhone } from "../lib/contact-phone";
import {
	BulkCreateContactsBody,
	CreateContactBody,
	UpdateContactBody,
} from "../schemas/contacts";
import { LandingPageConversionSpec } from "../schemas/landing-pages";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("canonical contact phone identity", () => {
	it("normalizes equivalent international presentation formats to E.164", () => {
		for (const value of [
			"+1 (415) 555-2671",
			"001 415 555 2671",
			"+1-415-555-2671",
		]) {
			expect(normalizeContactPhone(value)).toBe("+14155552671");
		}
		expect(normalizeContactPhone("+44 (0) 7700-900123")).toBe("+447700900123");
		expect(
			normalizeContactPhone("14155552671", {
				allowBareInternational: true,
			}),
		).toBe("+14155552671");
	});

	it("rejects ambiguous, impossible, embedded, and extension-bearing values", () => {
		for (const value of [
			"",
			"4155552671",
			"+123",
			"+999123456789",
			"Call +1 415 555 2671",
			"+1 415 555 2671 ext 2",
		]) {
			expect(normalizeContactPhone(value)).toBeNull();
			expect(isContactPhone(value)).toBe(false);
		}
	});

	it("validates create, update, and bulk import input without replacing display formatting", () => {
		const create = CreateContactBody.safeParse({
			phone: " +1 (415) 555-2671 ",
		});
		expect(create.success).toBe(true);
		if (create.success) {
			expect(create.data.phone).toBe("+1 (415) 555-2671");
		}
		expect(UpdateContactBody.safeParse({ phone: "4155552671" }).success).toBe(
			false,
		);
		expect(
			BulkCreateContactsBody.safeParse({
				contacts: [{ phone: "+123" }],
			}).success,
		).toBe(false);
		expect(
			LandingPageConversionSpec.safeParse({
				idempotency_key: "conversion-1",
				fields: { phone: "+999123456789" },
			}).success,
		).toBe(false);
	});

	it("CHECKs the encrypted/hash tuple and scopes partial uniqueness by tenant", () => {
		const table = getTableConfig(contacts);
		expect(table.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"phone_ciphertext",
				"phone_hash",
				"phone_search_tokens",
			]),
		);
		expect(table.checks.map((constraint) => constraint.name)).toEqual(
			expect.arrayContaining([
				"contacts_phone_protected_tuple_check",
				"contacts_search_identity_key_fingerprint_check",
			]),
		);
		const identityIndex = table.indexes.find(
			(index) => index.config.name === "contacts_scope_phone_hash_uniq",
		);
		expect(identityIndex?.config.unique).toBe(true);
		expect(
			identityIndex?.config.columns.map((column) =>
				"name" in column ? column.name : undefined,
			),
		).toEqual(["organization_id", "scope_key", "phone_hash"]);
		expect(identityIndex?.config.where).toBeDefined();
		// Including organization_id means the same real-world phone can
		// legitimately exist in separate tenants; exact scope owns uniqueness.
		expect(contacts.phoneCiphertext.isUnique).toBe(false);
	});

	it("uses the shared canonical identity in every contact linker and import", async () => {
		const entrypointMarkers = [
			["apps/api/src/routes/contacts.ts", "protectContactPhone"],
			["apps/api/src/services/contact-linker.ts", "normalizeContactPhone"],
			[
				"apps/api/src/services/public-growth-events.ts",
				"normalizeContactPhone",
			],
			[
				"apps/api/src/services/automations/webhook-receiver.ts",
				"normalizeContactPhone",
			],
			[
				"apps/api/src/services/automations/actions/contact.ts",
				"normalizeContactPhone",
			],
			["apps/api/src/services/ad-audience.ts", "normalizeContactPhone"],
		] as const;
		const sources = await Promise.all(
			entrypointMarkers.map(async ([path, marker]) => {
				const source = await Bun.file(`${repoRoot}${path}`).text();
				expect(source).toContain(marker);
				return source;
			}),
		);
		const protectionSource = await Bun.file(
			`${repoRoot}apps/api/src/services/contact-protection.ts`,
		).text();
		expect(protectionSource).toContain("normalizeContactPhone");
		expect(protectionSource).toContain(
			"export async function protectContactPhone",
		);
		const joined = sources.join("\n");
		expect(joined).not.toContain("eq(contacts.phone,");
		expect(joined).not.toContain("regexp_replace(" + "$" + "{contacts.phone}");
		expect(joined).not.toContain("u.phone.replace(/\\D/g");
		expect(joined).toContain("contacts.phoneHash");
	});

	it("derives every contact insert and protected-phone writer from source", async () => {
		const insertWriters: string[] = [];
		const explicitPhoneMutationWriters: string[] = [];
		const rawPhoneColumnUsers: string[] = [];
		for await (const path of new Bun.Glob("apps/api/src/**/*.ts").scan({
			cwd: repoRoot,
		})) {
			if (path.includes("/__tests__/")) continue;
			const source = await Bun.file(`${repoRoot}${path}`).text();
			const executableSource = source
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			if (/\.insert\(\s*contacts\s*\)/.test(source)) {
				insertWriters.push(path);
				expect(source).toContain("protectContactValues");
			}
			if (
				/\.update\(\s*contacts\s*\)/.test(source) &&
				/\bphone(?:Ciphertext|Hash|SearchTokens)\s*:/.test(source)
			) {
				explicitPhoneMutationWriters.push(path);
				expect(
					source.includes("protectContactPhone") ||
						path === "apps/api/src/services/encryption-rotation.ts",
				).toBe(true);
			}
			if (
				/\bphone_(?:ciphertext|hash|search_tokens)\b/.test(executableSource)
			) {
				rawPhoneColumnUsers.push(path);
			}
		}

		expect(insertWriters.sort()).toEqual([
			"apps/api/src/routes/contacts.ts",
			"apps/api/src/services/automations/webhook-receiver.ts",
			"apps/api/src/services/contact-linker.ts",
			"apps/api/src/services/public-growth-events.ts",
		]);
		expect(explicitPhoneMutationWriters.length).toBeGreaterThan(0);
		expect(rawPhoneColumnUsers).toEqual([]);

		const rotationSource = await Bun.file(
			`${repoRoot}apps/api/src/services/encryption-rotation.ts`,
		).text();
		expect(rotationSource).toContain("{ phoneCiphertext: rotated }");
		expect(rotationSource).not.toMatch(/\bphone(?:Hash|SearchTokens)\s*:/);
	});
});
