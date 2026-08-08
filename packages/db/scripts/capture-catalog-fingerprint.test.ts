/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeManagedRoleReferences } from "./capture-catalog-fingerprint";

describe("catalog fingerprint role and privilege evidence", () => {
	test("normalizes only migration authority while preserving runtime grants", () => {
		const definition = JSON.stringify({
			owner: "relayapi_owner",
			acl: [
				"relayapi_runtime=arwd/relayapi_owner",
				"relayapi_migrator=UC/relayapi_migrator",
			],
		});
		expect(
			JSON.parse(
				normalizeManagedRoleReferences(
					definition,
					new Set(["relayapi_owner", "relayapi_migrator"]),
				),
			),
		).toEqual({
			owner: "migration-authority",
			acl: ["relayapi_runtime=arwd/migration-authority"],
		});
	});

	test("captures owners, sorted ACLs, and every non-system schema", () => {
		const source = readFileSync(
			new URL("./capture-catalog-fingerprint.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("namespace_row.nspname !~ '^pg_'");
		expect(source).not.toContain(
			"namespace_row.nspname IN ('auth', 'public')",
		);
		expect(source.match(/'owner'/g)?.length).toBeGreaterThanOrEqual(6);
		expect(
			source.match(/array_agg\(acl_item::text ORDER BY acl_item::text\)/g)
				?.length,
		).toBeGreaterThanOrEqual(5);
	});
});
