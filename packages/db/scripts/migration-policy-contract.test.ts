/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
	auditBaselinePolicyBoundary,
	findContractOnlyOperations,
	findDestructiveExpandOperations,
	findProceduralDynamicSql,
} from "./migration-policy-contract";

const journal = {
	entries: [
		{ idx: 0, tag: "0000_baseline" },
		{ idx: 1, tag: "0001_accounts" },
	],
};

describe("migration policy baseline boundary", () => {
	test("accepts one baseline followed by expand history", () => {
		expect(
			auditBaselinePolicyBoundary(journal, {
				schemaVersion: 2,
				migrations: {
					"0000_baseline": { phase: "baseline", summary: "Virgin schema" },
					"0001_accounts": { phase: "expand", summary: "Add accounts" },
				},
			}),
		).toEqual([]);
	});

	test("rejects an appended migration disguised as another baseline", () => {
		const failures = auditBaselinePolicyBoundary(journal, {
			schemaVersion: 2,
			migrations: {
				"0000_baseline": { phase: "baseline", summary: "Virgin schema" },
				"0001_accounts": { phase: "baseline", summary: "Bypass" },
			},
		});
		expect(failures).toContain(
			"0001_accounts is appended history and must be expand or contract, not baseline",
		);
		expect(failures).toContain(
			"exactly 0000_baseline may use the baseline migration phase",
		);
	});

	test("rejects a renamed or missing first baseline", () => {
		expect(
			auditBaselinePolicyBoundary(
				{ entries: [{ idx: 0, tag: "0000_other" }] },
				{
					schemaVersion: 2,
					migrations: {
						"0000_other": { phase: "baseline", summary: "Wrong tag" },
					},
				},
			),
		).toContain("migration history must start with idx 0 tag 0000_baseline");
	});

	test("rejects an unknown phase instead of bypassing SQL policy", () => {
		const failures = auditBaselinePolicyBoundary(journal, {
			schemaVersion: 2,
			migrations: {
				"0000_baseline": { phase: "baseline", summary: "Virgin schema" },
				"0001_accounts": {
					phase: "banana" as never,
					summary: "Invalid phase",
				},
			},
		});
		expect(failures).toContain(
			'0001_accounts has invalid migration phase "banana"',
		);
		expect(failures).toContain(
			"0001_accounts is appended history and must use the expand or contract phase",
		);
	});
});

describe("contract migration rollout metadata", () => {
	test("requires affected objects and a compatible release prerequisite", () => {
		const failures = auditBaselinePolicyBoundary(journal, {
			schemaVersion: 2,
			migrations: {
				"0000_baseline": { phase: "baseline", summary: "Virgin schema" },
				"0001_accounts": { phase: "contract", summary: "Remove old shape" },
			},
		});
		expect(failures).toContain(
			"0001_accounts is contract and must declare non-empty affectedObjects",
		);
		expect(failures).toContain(
			"0001_accounts is contract and must declare a compatibleReleasePrerequisite",
		);
	});

	test("classifies contract-only SQL for both policy phases", () => {
		expect(
			findContractOnlyOperations(
				"ALTER TABLE accounts DROP COLUMN legacy_name;",
			),
		).toEqual(["DROP COLUMN"]);
	});
});

describe("expand migration destructive-operation guard", () => {
	test("fails closed on computed procedural SQL that static DDL regexes cannot decode", () => {
		const source = `
			DO $body$
			BEGIN
				EXECUTE chr(68) || chr(82) || chr(79) || chr(80) ||
					chr(32) || chr(84) || chr(65) || chr(66) || chr(76) || chr(69);
			END
			$body$;
		`;
		expect(findContractOnlyOperations(source)).toEqual([]);
		expect(findProceduralDynamicSql(source)).toEqual([
			"dynamic EXECUTE in procedural body",
		]);
	});

	test("rejects contract-only object removal and enum/type renames", () => {
		const source = `
			DROP INDEX old_index;
			ALTER TABLE example DROP CONSTRAINT example_check;
			DROP FUNCTION old_function();
			DROP MATERIALIZED VIEW old_projection;
			DROP SCHEMA old_schema;
			DROP EXTENSION old_extension;
			ALTER TYPE status RENAME VALUE 'old' TO 'new';
		`;
		expect(findDestructiveExpandOperations(source)).toEqual([
			"DROP INDEX",
			"DROP CONSTRAINT",
			"DROP FUNCTION",
			"DROP VIEW",
			"DROP SCHEMA",
			"DROP EXTENSION",
			"enum value rename",
		]);
	});

	test("allows additive expand SQL", () => {
		expect(
			findDestructiveExpandOperations(
				"ALTER TABLE example ADD COLUMN new_value text; CREATE INDEX example_new_value_idx ON example(new_value);",
			),
		).toEqual([]);
	});

	test("treats PostgreSQL comments between destructive keywords as whitespace", () => {
		expect(
			findDestructiveExpandOperations(`
				DROP/* nested /* comment */ still comment */TABLE old_rows;
				ALTER TABLE example DROP/* reviewed */COLUMN old_value;
				DELETE-- comment before the second keyword
				FROM expired_rows;
			`),
		).toEqual(["DROP TABLE", "DROP COLUMN", "DELETE"]);
		expect(
			findDestructiveExpandOperations(
				"SELECT '\\'; DROP/* comment */TABLE another_old_table;",
			),
		).toContain("DROP TABLE");
		expect(
			findDestructiveExpandOperations(
				"DO $body$ BEGIN DROP/* comment */TABLE nested_old_table; END $body$;",
			),
		).toContain("DROP TABLE");
	});

	test("does not strip comment-like text inside SQL quoting forms", () => {
		expect(
			findDestructiveExpandOperations(`
				SELECT '-- DROP TABLE safe', '/* DELETE FROM safe */';
				SELECT "column--name" FROM example;
				DO $body$ BEGIN RAISE NOTICE '/* not a comment */'; END $body$;
			`),
		).toEqual(["DROP TABLE", "DELETE"]);
	});
});
