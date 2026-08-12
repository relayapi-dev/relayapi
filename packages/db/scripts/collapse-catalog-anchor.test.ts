import { describe, expect, test } from "bun:test";
import {
	assertOldChainCatalogEvidenceMatchesAnchor,
	readCommittedOldChainCatalogEvidence,
} from "./rebuild-baseline";

describe("collapse old-chain catalog anchor", () => {
	test("reads the canonical evidence path from the exact base revision", () => {
		const calls: Array<{
			repositoryRoot: string;
			baseSha: string;
			path: string;
		}> = [];
		const baseSha = "a".repeat(40);
		const evidence = readCommittedOldChainCatalogEvidence(
			"/repository",
			baseSha,
			(repositoryRoot, revision, path) => {
				calls.push({ repositoryRoot, baseSha: revision, path });
				return "committed catalog bytes\n";
			},
		);

		expect(evidence).toBe("committed catalog bytes\n");
		expect(calls).toEqual([
			{
				repositoryRoot: "/repository",
				baseSha,
				path: "packages/db/catalog-fingerprint-generation-1-old-chain.json",
			},
		]);
	});

	test("rejects supplied evidence that differs from the committed anchor", () => {
		expect(() =>
			assertOldChainCatalogEvidenceMatchesAnchor(
				"committed catalog bytes\n",
				"modified working-copy bytes\n",
			),
		).toThrow("not byte-identical");
		expect(() =>
			assertOldChainCatalogEvidenceMatchesAnchor(
				"committed catalog bytes\n",
				"committed catalog bytes\n",
			),
		).not.toThrow();
	});
});
