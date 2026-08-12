/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type BaselineGeneration,
	sha256Text,
} from "./baseline-generation-contract";
import {
	auditCatalogDifferenceReview,
	auditCatalogFingerprint,
	auditCollapsedCatalogEvidence,
	auditPreservedOldChainCatalogEvidence,
	buildCatalogDifferenceReviewDraft,
	buildCatalogFingerprint,
	type CatalogFingerprint,
	compareCatalogFingerprints,
	normalizeCatalogObjects,
} from "./catalog-fingerprint-contract";

const objects = [
	{ kind: "table", identity: "public.posts", definition: '{"rls":true}' },
	{
		kind: "column",
		identity: "public.posts.id",
		definition: '{"type":"text"}',
	},
];

describe("catalog fingerprints", () => {
	test("normalizes ordering and detects record tampering", () => {
		const fingerprint = buildCatalogFingerprint({
			source: "old-chain",
			generation: 1,
			postgresMajor: 18,
			migrationManifestSha256: "a".repeat(64),
			objects: [...objects].reverse(),
		});
		expect(auditCatalogFingerprint(fingerprint)).toEqual([]);
		const firstObject = fingerprint.objects[0];
		if (!firstObject) throw new Error("fixture object is missing");
		firstObject.definition = "tampered";
		expect(auditCatalogFingerprint(fingerprint)).toContain(
			"catalog fingerprint checksum does not match its objects",
		);
	});

	test("normalizes only deliberately unpinned extension versions", () => {
		const observed = {
			kind: "extension",
			identity: "vector",
			definition: '{"schema": "public", "version": "0.8.5"}',
		};
		expect(normalizeCatalogObjects([observed])).toEqual([
			{
				...observed,
				definition: '{"schema":"public","versionPolicy":"provider-default"}',
			},
		]);
		expect(normalizeCatalogObjects([observed], { vector: "0.8.5" })).toEqual([
			observed,
		]);

		const otherProviderDefault = {
			...observed,
			definition: '{"schema": "public", "version": "0.8.4"}',
		};
		expect(
			buildCatalogFingerprint({
				source: "candidate",
				generation: 2,
				postgresMajor: 18,
				migrationManifestSha256: "a".repeat(64),
				objects: [observed],
			}).catalogSha256,
		).toBe(
			buildCatalogFingerprint({
				source: "candidate",
				generation: 2,
				postgresMajor: 18,
				migrationManifestSha256: "a".repeat(64),
				objects: [otherProviderDefault],
			}).catalogSha256,
		);
	});

	test("compares old-chain and candidate catalogs independently of manifests", () => {
		const oldChain = buildCatalogFingerprint({
			source: "old-chain",
			generation: 1,
			postgresMajor: 18,
			migrationManifestSha256: "a".repeat(64),
			objects,
		});
		const candidate = buildCatalogFingerprint({
			source: "candidate",
			generation: 2,
			postgresMajor: 18,
			migrationManifestSha256: "b".repeat(64),
			objects: [...objects].reverse(),
		});
		expect(compareCatalogFingerprints(oldChain, candidate)).toEqual([]);

		const firstCandidateObject = candidate.objects[0];
		if (!firstCandidateObject) throw new Error("fixture object is missing");
		candidate.objects[0] = {
			...firstCandidateObject,
			definition: '{"type":"uuid"}',
		};
		expect(compareCatalogFingerprints(oldChain, candidate)[0]?.key).toContain(
			"column:public.posts.id",
		);
	});

	test("requires every intentional catalog delta to name an audit decision", () => {
		const oldChain = buildCatalogFingerprint({
			source: "old-chain",
			generation: 1,
			postgresMajor: 18,
			migrationManifestSha256: "a".repeat(64),
			objects,
		});
		const candidate = buildCatalogFingerprint({
			source: "candidate",
			generation: 2,
			postgresMajor: 18,
			migrationManifestSha256: "b".repeat(64),
			objects: [
				...objects,
				{
					kind: "column",
					identity: "public.posts.revision",
					definition: '{"type":"integer"}',
				},
			],
		});
		const review = buildCatalogDifferenceReviewDraft(oldChain, candidate);
		expect(auditCatalogDifferenceReview(review, oldChain, candidate)).toContain(
			"catalog difference column:public.posts.revision has no reviewed decision",
		);

		review.decisions = [
			{
				id: "post_revision_fence",
				auditSection: "#specific-ddl-invariants",
				summary: "Add the selected optimistic-concurrency fence.",
			},
		];
		for (const difference of review.differences) {
			difference.decisionId = "post_revision_fence";
		}
		expect(auditCatalogDifferenceReview(review, oldChain, candidate)).toEqual(
			[],
		);
		expect(
			auditCatalogDifferenceReview(
				review,
				oldChain,
				candidate,
				"## Decisions\n### Specific DDL invariants\n",
			),
		).toEqual([]);
		const reviewedDecision = review.decisions[0];
		if (!reviewedDecision) throw new Error("review fixture decision is missing");
		review.decisions[0] = {
			...reviewedDecision,
			auditSection: "#missing-audit-decision",
		};
		expect(
			auditCatalogDifferenceReview(
				review,
				oldChain,
				candidate,
				"### Specific DDL invariants\n",
			),
		).toContain(
			"catalog decision post_revision_fence references missing audit section #missing-audit-decision",
		);
		review.decisions[0] = {
			...reviewedDecision,
			auditSection: "#specific-ddl-invariants",
		};

		const firstDifference = review.differences[0];
		if (!firstDifference)
			throw new Error("review fixture difference is missing");
		firstDifference.candidateDefinitionSha256 = "f".repeat(64);
		expect(auditCatalogDifferenceReview(review, oldChain, candidate)).toContain(
			"catalog difference review definition checksum is stale for column:public.posts.revision",
		);
	});

		test("retains the PostgreSQL 18 pre-reset replay as historical evidence only", () => {
		const fingerprint = JSON.parse(
			readFileSync(
				new URL(
					"../catalog-fingerprint-generation-1-old-chain.json",
					import.meta.url,
				),
				"utf8",
			),
		) as CatalogFingerprint;
		const generation = JSON.parse(
			readFileSync(
				new URL("../baseline-generation.json", import.meta.url),
				"utf8",
			),
		) as BaselineGeneration;
		const manifestText = readFileSync(
			new URL("../drizzle/migration-manifest.json", import.meta.url),
			"utf8",
		);

			expect(
				auditPreservedOldChainCatalogEvidence({
					fingerprint,
					generation,
					currentManifestText: manifestText,
					requiredPostgresMajor: 18,
				}),
			).toContain(
				"generation-1 catalog evidence is not bound to the active migration manifest",
			);
		});

	test("binds a collapse to both the old manifest and catalog checksum", () => {
		const fingerprint = buildCatalogFingerprint({
			source: "old-chain",
			generation: 1,
			postgresMajor: 18,
			migrationManifestSha256: "a".repeat(64),
			objects,
		});
		const collapsed: BaselineGeneration = {
			schemaVersion: 1,
			generation: 2,
			lifecycle: "sealed",
			baseline: { tag: "0000_baseline", folderMillis: 200 },
			transition: {
				kind: "collapse",
				fromGeneration: 1,
				baseCommitSha: "b".repeat(40),
				baseManifestSha256: fingerprint.migrationManifestSha256,
				baseGenerationSha256: "c".repeat(64),
				baseBuildPolicySha256: "d".repeat(64),
				candidateManifestSha256: "a".repeat(64),
				oldChainCatalogSha256: fingerprint.catalogSha256,
				candidateCatalogSha256: "e".repeat(64),
				catalogDifferenceReviewSha256: "f".repeat(64),
			},
		};

		expect(
			auditPreservedOldChainCatalogEvidence({
				fingerprint,
				generation: collapsed,
				currentManifestText: "{}",
				requiredPostgresMajor: 18,
			}),
		).toEqual([]);

		if (collapsed.transition.kind !== "collapse") {
			throw new Error("fixture transition must be collapse");
		}
		collapsed.transition.oldChainCatalogSha256 = "e".repeat(64);
		expect(
			auditPreservedOldChainCatalogEvidence({
				fingerprint,
				generation: collapsed,
				currentManifestText: "{}",
				requiredPostgresMajor: 18,
			}),
		).toContain(
			"generation-2 transition is not bound to the preserved old-chain catalog",
		);
	});

	test("keeps the candidate catalog and exact reviewed bytes re-verifiable", () => {
		const candidateManifestText = '{"generation":2}\n';
		const oldChain = buildCatalogFingerprint({
			source: "old-chain",
			generation: 1,
			postgresMajor: 18,
			migrationManifestSha256: "a".repeat(64),
			objects,
		});
		const candidate = buildCatalogFingerprint({
			source: "candidate",
			generation: 2,
			postgresMajor: 18,
			migrationManifestSha256: sha256Text(candidateManifestText),
			objects,
		});
		const review = buildCatalogDifferenceReviewDraft(oldChain, candidate);
		const reviewText = `${JSON.stringify(review, null, 2)}\n`;
		const collapsed: BaselineGeneration = {
			schemaVersion: 1,
			generation: 2,
			lifecycle: "sealed",
			baseline: { tag: "0000_baseline", folderMillis: 200 },
			transition: {
				kind: "collapse",
				fromGeneration: 1,
				baseCommitSha: "b".repeat(40),
				baseManifestSha256: oldChain.migrationManifestSha256,
				baseGenerationSha256: "c".repeat(64),
				baseBuildPolicySha256: "d".repeat(64),
				candidateManifestSha256: sha256Text(candidateManifestText),
				oldChainCatalogSha256: oldChain.catalogSha256,
				candidateCatalogSha256: candidate.catalogSha256,
				catalogDifferenceReviewSha256: sha256Text(reviewText),
			},
		};

		expect(
			auditCollapsedCatalogEvidence({
				generation: collapsed,
				oldChain,
				candidate,
				review,
				reviewText,
				requiredPostgresMajor: 18,
			}),
		).toEqual([]);
		expect(
			auditCollapsedCatalogEvidence({
				generation: collapsed,
				oldChain,
				candidate,
				review,
				reviewText: `${reviewText}\n`,
				requiredPostgresMajor: 18,
			}),
		).toContain(
			"collapse transition is not bound to the committed catalog difference review bytes",
		);

		const tamperedCandidate = {
			...candidate,
			migrationManifestSha256: "9".repeat(64),
		};
		expect(
			auditCollapsedCatalogEvidence({
				generation: collapsed,
				oldChain,
				candidate: tamperedCandidate,
				review,
				reviewText,
				requiredPostgresMajor: 18,
			}),
		).toContain(
			"committed candidate catalog is not bound to the collapse-boundary manifest",
		);
	});
});
