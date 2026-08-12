/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	findNumberedMigrationLiterals,
	isMigrationSourceOwnershipExcluded,
	MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS,
	MIGRATION_SOURCE_OWNERSHIP_FILES,
	MIGRATION_SOURCE_OWNERSHIP_ROOTS,
} from "./migration-source-ownership-contract";

test("finds numbered migration tags and filenames in application source", () => {
	expect(
		findNumberedMigrationLiterals(
			'const tag = "0004_old_shape";\nconst path = "drizzle/0005_contract.sql";',
		),
	).toEqual([
		{ literal: "0004_old_shape", line: 1 },
		{ literal: "0005_contract.sql", line: 2 },
	]);
	expect(
		findNumberedMigrationLiterals(
			'const contract = "renderAuthIdentityInvariantSql";',
		),
	).toEqual([]);
});

test("keeps runtime prerequisites scanned while migration-only lifecycle metadata stays under scripts", () => {
	const boundaryEvidence =
		"packages/db/migration-manifest-generation-2-collapse-boundary.json";
	expect(isMigrationSourceOwnershipExcluded(boundaryEvidence)).toBe(true);
	expect(
		isMigrationSourceOwnershipExcluded(
			"packages/db/src/database-prerequisites.ts",
		),
	).toBe(false);
	expect(
		isMigrationSourceOwnershipExcluded(
			"packages/db/scripts/database-extension-lifecycle.ts",
		),
	).toBe(true);
	expect(
		isMigrationSourceOwnershipExcluded(`${boundaryEvidence}.tampered`),
	).toBe(false);
	expect(
		isMigrationSourceOwnershipExcluded("apps/api/src/0001_runtime.ts"),
	).toBe(false);
	expect(
		findNumberedMigrationLiterals('const migration = "0001_runtime";'),
	).toEqual([{ literal: "0001_runtime", line: 1 }]);
});

test("covers workflow and root automation sources, not only application code", () => {
	expect(MIGRATION_SOURCE_OWNERSHIP_ROOTS).toContain(".github");
	expect(MIGRATION_SOURCE_OWNERSHIP_ROOTS).toContain("scripts");
	expect(MIGRATION_SOURCE_OWNERSHIP_FILES).toContain("package.json");
	expect(MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS).toContain(".yml");
	expect(MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS).toContain(".yaml");
	expect(MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS).toContain(".sh");
});

test("runs the ownership verifier in ordinary CI, both deploys, and cutover", () => {
	for (const workflow of [
		"ci-db-migrations.yml",
		"ci-lint.yml",
		"deploy-api.yml",
		"deploy-app.yml",
		"prelive-baseline-cutover.yml",
	]) {
		const source = readFileSync(
			new URL(`../../../.github/workflows/${workflow}`, import.meta.url),
			"utf8",
		);
		expect(source, workflow).toContain(
			"bun run --cwd packages/db migration:source-ownership",
		);
	}
});
