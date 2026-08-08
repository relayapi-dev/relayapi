/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type BaselineGeneration,
	type MigrationManifest,
	sha256Text,
} from "./baseline-generation-contract";
import {
	CANDIDATE_CATALOG_EVIDENCE_FILE,
	OLD_CHAIN_CATALOG_EVIDENCE_FILE,
} from "./catalog-fingerprint-contract";
import {
	activeCatalogEvidenceFile,
	activeCatalogEvidenceForManifest,
} from "./verify-active-catalog-fingerprint";

test("selects exact reviewed catalog evidence for both authorized generations", () => {
	expect(activeCatalogEvidenceFile(1)).toBe(OLD_CHAIN_CATALOG_EVIDENCE_FILE);
	expect(activeCatalogEvidenceFile(2)).toBe(CANDIDATE_CATALOG_EVIDENCE_FILE);
	expect(() => activeCatalogEvidenceFile(3)).toThrow(
		"No reviewed catalog evidence is authorized",
	);
});

test("compares candidate catalog only at the generation-2 collapse boundary", () => {
	const candidateManifest: MigrationManifest = {
		schemaVersion: 2,
		journal: { version: "7", dialect: "postgresql" },
		migrations: [
			{
				idx: 0,
				tag: "0000_baseline",
				folderMillis: 200,
				sha256: "1".repeat(64),
				snapshotSha256: "2".repeat(64),
				drizzleVersion: "7",
				breakpoints: true,
			},
		],
	};
	const candidateManifestText = `${JSON.stringify(candidateManifest, null, 2)}\n`;
	const generation: BaselineGeneration = {
		schemaVersion: 1,
		generation: 2,
		lifecycle: "sealed",
		baseline: { tag: "0000_baseline", folderMillis: 200 },
		transition: {
			kind: "collapse",
			fromGeneration: 1,
			baseCommitSha: "a".repeat(40),
			baseManifestSha256: "b".repeat(64),
			baseGenerationSha256: "c".repeat(64),
			baseBuildPolicySha256: "d".repeat(64),
			candidateManifestSha256: sha256Text(candidateManifestText),
			oldChainCatalogSha256: "e".repeat(64),
			candidateCatalogSha256: "f".repeat(64),
			catalogDifferenceReviewSha256: "1".repeat(64),
		},
	};

	expect(
		activeCatalogEvidenceForManifest(
			generation,
			candidateManifestText,
			candidateManifestText,
		),
	).toBe(CANDIDATE_CATALOG_EVIDENCE_FILE);
	const appendedManifest: MigrationManifest = {
		...candidateManifest,
		migrations: [
			...candidateManifest.migrations,
			{
				idx: 1,
				tag: "0001_expand",
				folderMillis: 201,
				sha256: "3".repeat(64),
				snapshotSha256: "4".repeat(64),
				drizzleVersion: "7",
				breakpoints: true,
			},
		],
	};
	expect(
		activeCatalogEvidenceForManifest(
			generation,
			`${JSON.stringify(appendedManifest, null, 2)}\n`,
			candidateManifestText,
		),
	).toBeUndefined();

	const rewrittenBoundary = structuredClone(appendedManifest);
	const firstMigration = rewrittenBoundary.migrations[0];
	if (!firstMigration) throw new Error("fixture baseline is missing");
	firstMigration.sha256 = "9".repeat(64);
	expect(() =>
		activeCatalogEvidenceForManifest(
			generation,
			`${JSON.stringify(rewrittenBoundary, null, 2)}\n`,
			candidateManifestText,
		),
	).toThrow("does not descend from the collapse boundary");

	expect(() =>
		activeCatalogEvidenceForManifest(
			generation,
			candidateManifestText.replace(/\n/g, "\r\n"),
			candidateManifestText,
		),
	).toThrow("does not match its immutable candidate bytes");
});

test("re-verifies reviewed evidence after replay in CI, deploy, and cutover", () => {
	for (const workflow of [
		"ci-db-migrations.yml",
		"deploy-api.yml",
		"prelive-baseline-cutover.yml",
	]) {
		const source = readFileSync(
			new URL(`../../../.github/workflows/${workflow}`, import.meta.url),
			"utf8",
		);
		expect(source, workflow).toContain(
			"bun run --cwd packages/db catalog:fingerprint:verify-active",
		);
	}
	const cutover = readFileSync(
		new URL(
			"../../../.github/workflows/prelive-baseline-cutover.yml",
			import.meta.url,
		),
		"utf8",
	);
	expect(cutover).toContain(
		"catalog:fingerprint:verify-active --require-boundary",
	);
	expect(
		cutover.match(/catalog:fingerprint:verify-active(?! --require-boundary)/g),
	).toBeNull();
});
