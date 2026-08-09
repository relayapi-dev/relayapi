import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { verification } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

describe("Better Auth ephemeral retention", () => {
	it("indexes both expiry and the direct user-value erasure locator", () => {
		const indexes = getTableConfig(verification).indexes.map(
			(index) => index.config.name,
		);
		expect(indexes).toContain("verification_expires_idx");
		expect(indexes).toContain("verification_value_idx");
	});

	it("has a total bounded expiry drain independent of token reads", () => {
		const source = readFileSync(
			new URL("../services/operational-retention.ts", import.meta.url),
			"utf8",
		);
		const start = source.indexOf("export async function pruneExpiredAuthState");
		const end = source.indexOf("/**", start + 10);
		const implementation = source.slice(start, end);
		expect(start).toBeGreaterThan(-1);
		expect(implementation).toContain(".delete(verification)");
		expect(implementation).toContain("AUTH_EPHEMERAL_MAX_DELETE_PASSES");
		expect(implementation).toContain(".orderBy(verification.expiresAt");
		expect(implementation).toContain(".limit(AUTH_EPHEMERAL_DELETE_BATCH)");
	});

	it("removes both user-id and canonical-email capability forms during erasure", () => {
		const source = readFileSync(
			new URL("../../../app/src/lib/user-deletion.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("eq(verification.value, userId)");
		expect(source).toContain(`lower(\${verification.identifier})`);
		expect(source).toContain("canonicalDeletingEmail");
		expect(source.indexOf(".delete(verification)")).toBeLessThan(
			source.indexOf(".delete(user)"),
		);
	});
});
