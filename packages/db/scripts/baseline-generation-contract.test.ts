/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
	auditGenerationTransition,
	type BaselineBuildPolicy,
	type BaselineGeneration,
	type GenerationTransitionAuditInput,
	type MigrationManifest,
	sha256Text,
} from "./baseline-generation-contract";
import { buildCatalogFingerprint } from "./catalog-fingerprint-contract";

const baseSha = "a".repeat(40);
const buildPolicy: BaselineBuildPolicy = {
	schemaVersion: 2,
	lifecycle: "sealed",
	generation: 1,
	baseline: {
		tag: "0000_baseline",
		folderMillis: 100,
	},
	authorizedCollapse: {
		fromGeneration: 1,
		toGeneration: 2,
		baseline: {
			tag: "0000_baseline",
			folderMillis: 200,
		},
	},
};
const generation1: BaselineGeneration = {
	schemaVersion: 1,
	generation: 1,
	lifecycle: "sealed",
	baseline: {
		tag: "0000_baseline",
		folderMillis: 100,
	},
	transition: { kind: "initial-baseline" },
};
const baseManifest: MigrationManifest = {
	schemaVersion: 2,
	journal: { version: "7", dialect: "postgresql" },
	migrations: [
		{
			idx: 0,
			tag: "0000_baseline",
			folderMillis: 100,
			sha256: "1".repeat(64),
			snapshotSha256: "2".repeat(64),
			drizzleVersion: "7",
			breakpoints: true,
		},
	],
};
const oldChainCatalog = buildCatalogFingerprint({
	source: "old-chain",
	generation: 1,
	postgresMajor: 18,
	migrationManifestSha256: sha256Text(text(baseManifest)),
	objects: [],
});
const baseOldChainCatalogText = text(oldChainCatalog);

function text(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function generation2(): BaselineGeneration {
	const baseManifestText = text(baseManifest);
	const baseGenerationText = text(generation1);
	const baseBuildPolicyText = text(buildPolicy);
	return {
		schemaVersion: 1,
		generation: 2,
		lifecycle: "sealed",
		baseline: {
			tag: "0000_baseline",
			folderMillis: 200,
		},
		transition: {
			kind: "collapse",
			fromGeneration: 1,
			baseCommitSha: baseSha,
			baseManifestSha256: sha256Text(baseManifestText),
			baseGenerationSha256: sha256Text(baseGenerationText),
			baseBuildPolicySha256: sha256Text(baseBuildPolicyText),
			candidateManifestSha256: "6".repeat(64),
			oldChainCatalogSha256: oldChainCatalog.catalogSha256,
			candidateCatalogSha256: "4".repeat(64),
			catalogDifferenceReviewSha256: "5".repeat(64),
		},
	};
}

function auditInput(
	currentGeneration = generation1,
	currentManifest = baseManifest,
): GenerationTransitionAuditInput {
	return {
		baseSha,
		baseGeneration: generation1,
		currentGeneration,
		baseGenerationText: text(generation1),
		currentGenerationText: text(currentGeneration),
		baseBuildPolicy: buildPolicy,
		currentBuildPolicy: buildPolicy,
		baseBuildPolicyText: text(buildPolicy),
		currentBuildPolicyText: text(buildPolicy),
		baseOldChainCatalogText,
		baseManifest,
		currentManifest,
		baseManifestText: text(baseManifest),
		currentManifestText: text(currentManifest),
	};
}

describe("baseline generation transition contract", () => {
	test("allows append-only history within an unchanged generation", () => {
		const appended: MigrationManifest = {
			...baseManifest,
			migrations: [
				...baseManifest.migrations,
				{
					idx: 1,
					tag: "0001_expand",
					folderMillis: 101,
					sha256: "4".repeat(64),
					snapshotSha256: "5".repeat(64),
					drizzleVersion: "7",
					breakpoints: true,
				},
			],
		};
		expect(
			auditGenerationTransition(auditInput(generation1, appended)),
		).toEqual([]);
	});

	test("allows post-collapse append-only migrations without rewriting sealed generation 2", () => {
		const originalBaseline = baseManifest.migrations[0];
		if (!originalBaseline) throw new Error("fixture baseline is missing");
		const collapsedManifest: MigrationManifest = {
			...baseManifest,
			migrations: [
				{
					...originalBaseline,
					folderMillis: 200,
					sha256: "6".repeat(64),
					snapshotSha256: "7".repeat(64),
				},
			],
		};
		const collapsedGeneration = generation2();
		if (collapsedGeneration.transition.kind !== "collapse") {
			throw new Error("fixture transition must be collapse");
		}
		collapsedGeneration.transition.candidateManifestSha256 = sha256Text(
			text(collapsedManifest),
		);
		const appendedManifest: MigrationManifest = {
			...collapsedManifest,
			migrations: [
				...collapsedManifest.migrations,
				{
					idx: 1,
					tag: "0001_expand",
					folderMillis: 201,
					sha256: "8".repeat(64),
					snapshotSha256: "9".repeat(64),
					drizzleVersion: "7",
					breakpoints: true,
				},
			],
		};
		const input = auditInput(collapsedGeneration, appendedManifest);
		input.baseGeneration = collapsedGeneration;
		input.baseGenerationText = text(collapsedGeneration);
		input.currentGenerationText = text(collapsedGeneration);
		input.baseManifest = collapsedManifest;
		input.baseManifestText = text(collapsedManifest);

		expect(auditGenerationTransition(input)).toEqual([]);
	});

	test("rejects a same-generation migration rewrite", () => {
		const rewritten = structuredClone(baseManifest);
		if (!rewritten.migrations[0]) throw new Error("fixture missing");
		rewritten.migrations[0].sha256 = "9".repeat(64);
		expect(
			auditGenerationTransition(auditInput(generation1, rewritten)),
		).toContain(
			"migration history changed at protected position 1 (0000_baseline)",
		);
	});

	test("rejects generation metadata rewrites, reopen, decrement, and skip", () => {
		const sameNumber = structuredClone(generation1);
		sameNumber.baseline.folderMillis = 101;
		expect(auditGenerationTransition(auditInput(sameNumber))).toContain(
			"baseline generation metadata changed without a generation increment",
		);

		const reopened = structuredClone(generation1);
		reopened.lifecycle = "building";
		expect(auditGenerationTransition(auditInput(reopened))).toContain(
			"a sealed baseline generation cannot be reopened",
		);

		const decrementedBase = generation2();
		const decrementInput = auditInput(generation1);
		decrementInput.baseGeneration = decrementedBase;
		decrementInput.baseGenerationText = text(decrementedBase);
		expect(auditGenerationTransition(decrementInput)).toContain(
			"baseline generation decremented from 2 to 1",
		);

		const skipped = generation2();
		skipped.generation = 3;
		if (skipped.transition.kind === "collapse") {
			skipped.transition.fromGeneration = 2;
		}
		expect(auditGenerationTransition(auditInput(skipped))).toContain(
			"baseline generation skipped from 1 to 3; increment exactly once per collapse",
		);
	});

	test("accepts only an attested sealed generation-2 replacement baseline", () => {
		const originalBaseline = baseManifest.migrations[0];
		if (!originalBaseline) throw new Error("fixture baseline is missing");
		const collapsedManifest: MigrationManifest = {
			...baseManifest,
			migrations: [
				{
					...originalBaseline,
					folderMillis: 200,
					sha256: "6".repeat(64),
					snapshotSha256: "7".repeat(64),
				},
			],
		};
		const collapsedGeneration = generation2();
		if (collapsedGeneration.transition.kind === "collapse") {
			collapsedGeneration.transition.candidateManifestSha256 = sha256Text(
				text(collapsedManifest),
			);
		}
		expect(
			auditGenerationTransition(
				auditInput(collapsedGeneration, collapsedManifest),
			),
		).toEqual([]);

		const stale = generation2();
		if (stale.transition.kind === "collapse") {
			stale.transition.baseManifestSha256 = "8".repeat(64);
			stale.transition.candidateManifestSha256 = sha256Text(
				text(collapsedManifest),
			);
		}
		expect(
			auditGenerationTransition(auditInput(stale, collapsedManifest)),
		).toContain("collapse transition base manifest fingerprint is stale");

		const missingCatalog = auditInput(collapsedGeneration, collapsedManifest);
		missingCatalog.baseOldChainCatalogText = undefined;
		expect(auditGenerationTransition(missingCatalog)).toContain(
			"collapse transition requires old-chain catalog evidence from the base revision",
		);

		const staleCatalog = generation2();
		if (staleCatalog.transition.kind === "collapse") {
			staleCatalog.transition.candidateManifestSha256 = sha256Text(
				text(collapsedManifest),
			);
			staleCatalog.transition.oldChainCatalogSha256 = "f".repeat(64);
		}
		expect(
			auditGenerationTransition(auditInput(staleCatalog, collapsedManifest)),
		).toContain("collapse transition old-chain catalog fingerprint is stale");

		const unauthorizedGeneration = generation2();
		unauthorizedGeneration.baseline.folderMillis = 201;
		const unauthorizedManifest = structuredClone(collapsedManifest);
		if (!unauthorizedManifest.migrations[0])
			throw new Error("fixture baseline is missing");
		unauthorizedManifest.migrations[0].folderMillis = 201;
		if (unauthorizedGeneration.transition.kind === "collapse") {
			unauthorizedGeneration.transition.candidateManifestSha256 = sha256Text(
				text(unauthorizedManifest),
			);
		}
		expect(
			auditGenerationTransition(
				auditInput(unauthorizedGeneration, unauthorizedManifest),
			),
		).toContain(
			"collapsed generation baseline does not match the build-policy authorized baseline",
		);
	});
});
