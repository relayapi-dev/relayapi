/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	auditAppendOnlyGitTopology,
	auditOneTimeGenerationBootstrap,
	auditOneTimeManifestBootstrap,
} from "./migration-append-only-topology";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const baseSha = execFileSync(
	"git",
	["-C", repositoryRoot, "rev-parse", "HEAD"],
	{ encoding: "utf8" },
).trim();

describe("append-only migration workflow invocation", () => {
	test("resolves the protected manifest when invoked from packages/db", () => {
		const baseHasManifest =
			spawnSync(
				"git",
				[
					"-C",
					repositoryRoot,
					"cat-file",
					"-e",
					`${baseSha}:packages/db/drizzle/migration-manifest.json`,
				],
				{ stdio: "ignore" },
			).status === 0;
		const baseHasGeneration =
			spawnSync(
				"git",
				[
					"-C",
					repositoryRoot,
					"cat-file",
					"-e",
					`${baseSha}:packages/db/baseline-generation.json`,
				],
				{ stdio: "ignore" },
			).status === 0;
		const result = spawnSync(
			process.execPath,
			["run", "scripts/verify-migration-append-only.ts"],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: {
					...process.env,
					MIGRATION_BASE_SHA: baseSha,
					MIGRATION_PROTECTED_REF: "HEAD",
				},
			},
		);

		if (baseHasManifest && baseHasGeneration) {
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Append-only migration prefix verified");
		} else if (baseHasManifest) {
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"one-time generation metadata bootstrap",
			);
		} else {
			expect(result.status).not.toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(
				"Base commit has no protected migration manifest",
			);
		}
	});

	test("rejects a base that is not reachable from the declared protected ref", () => {
		const result = spawnSync(
			process.execPath,
			["run", "scripts/verify-migration-append-only.ts"],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: {
					...process.env,
					MIGRATION_BASE_SHA: baseSha,
					MIGRATION_PROTECTED_REF: "HEAD^",
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"is not reachable from protected ref HEAD^",
		);
	});

	test("rejects missing history, non-ancestors, orphans, and skipped predecessors", () => {
		const fixture = {
			baseSha: "a".repeat(40),
			headSha: "b".repeat(40),
			baseAvailable: true,
			baseIsAncestorOfHead: true,
			protectedRef: "refs/heads/main",
			baseReachableFromProtectedRef: true,
			generationChanged: false,
			firstParentSha: "a".repeat(40),
		};
		expect(
			auditAppendOnlyGitTopology({ ...fixture, baseAvailable: false }),
		).toContainEqual(expect.stringContaining("is not an available commit"));
		expect(
			auditAppendOnlyGitTopology({
				...fixture,
				baseIsAncestorOfHead: false,
			}),
		).toContainEqual(expect.stringContaining("is not an ancestor of HEAD"));
		expect(
			auditAppendOnlyGitTopology({
				...fixture,
				baseReachableFromProtectedRef: false,
			}),
		).toContainEqual(
			expect.stringContaining("is not reachable from protected ref"),
		);
		expect(
			auditAppendOnlyGitTopology({
				...fixture,
				generationChanged: true,
				firstParentSha: "c".repeat(40),
			}),
		).toContain(
			"Baseline generation transition must use the exact generation predecessor as HEAD's first parent",
		);
		expect(
			auditOneTimeManifestBootstrap({
				baseSha: fixture.baseSha,
				headSha: fixture.headSha,
				explicitBootstrap: `${fixture.baseSha}:${fixture.headSha}`,
				firstParentSha: fixture.baseSha,
				changedMigrationArtifacts: [
					"packages/db/drizzle/migration-manifest.json",
					"packages/db/drizzle/0001_orphan.sql",
				],
				manifestPath: "packages/db/drizzle/migration-manifest.json",
			}),
		).toContainEqual(
			expect.stringContaining("no protected migration manifest"),
		);
		expect(
			auditOneTimeGenerationBootstrap({
				baseSha: fixture.baseSha,
				headSha: fixture.headSha,
				explicitPreLiveReset: `${fixture.baseSha}:${fixture.headSha}`,
				firstParentSha: fixture.baseSha,
				manifestChanged: true,
				currentMigrationCount: 1,
			}),
		).toEqual([]);
		expect(
			auditOneTimeGenerationBootstrap({
				baseSha: fixture.baseSha,
				headSha: fixture.headSha,
				explicitPreLiveReset: "wrong",
				firstParentSha: fixture.baseSha,
				manifestChanged: true,
				currentMigrationCount: 1,
			}),
		).toContainEqual(expect.stringContaining("one-time generation metadata"));
	});

	test("keeps the reproduced pre-manifest 9a7db17 base closed", () => {
		const reproducedBase = "9a7db173fda41715cc99377ed50c6f953d007434";
		const available =
			spawnSync(
				"git",
				["-C", repositoryRoot, "cat-file", "-e", `${reproducedBase}^{commit}`],
				{ stdio: "ignore" },
			).status === 0;
		expect(available).toBe(true);
		const result = spawnSync(
			process.execPath,
			["run", "scripts/verify-migration-append-only.ts"],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: {
					...process.env,
					MIGRATION_BASE_SHA: reproducedBase,
					MIGRATION_PROTECTED_REF: "HEAD",
				},
			},
		);
		expect(result.status).not.toBe(0);
		expect(`${result.stdout}${result.stderr}`).toContain(
			"one-time bootstrap requires an exact base:HEAD authorization",
		);
	});
});
