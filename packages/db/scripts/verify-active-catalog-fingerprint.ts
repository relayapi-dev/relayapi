import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AUTHORIZED_COLLAPSE_GENERATION,
	auditCollapseBoundaryManifestEvidence,
	type BaselineGeneration,
	COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
	INITIAL_BASELINE_GENERATION,
	type MigrationManifest,
	sha256Text,
} from "./baseline-generation-contract";
import {
	CANDIDATE_CATALOG_EVIDENCE_FILE,
	OLD_CHAIN_CATALOG_EVIDENCE_FILE,
} from "./catalog-fingerprint-contract";
import { readBaselineGeneration } from "./rebuild-baseline";

export function activeCatalogEvidenceFile(generation: number): string {
	if (generation === INITIAL_BASELINE_GENERATION) {
		return OLD_CHAIN_CATALOG_EVIDENCE_FILE;
	}
	if (generation === AUTHORIZED_COLLAPSE_GENERATION) {
		return CANDIDATE_CATALOG_EVIDENCE_FILE;
	}
	throw new Error(
		`No reviewed catalog evidence is authorized for generation ${generation}`,
	);
}

export function activeCatalogEvidenceForManifest(
	generation: BaselineGeneration,
	currentManifestText: string,
	boundaryManifestText?: string,
): string | undefined {
	if (generation.generation === INITIAL_BASELINE_GENERATION) {
		return OLD_CHAIN_CATALOG_EVIDENCE_FILE;
	}
	if (
		generation.generation === AUTHORIZED_COLLAPSE_GENERATION &&
		generation.transition.kind === "collapse"
	) {
		if (!boundaryManifestText) {
			throw new Error(
				"Generation-2 catalog classification requires committed collapse-boundary manifest evidence",
			);
		}
		const boundaryManifest = JSON.parse(
			boundaryManifestText,
		) as MigrationManifest;
		const currentManifest = JSON.parse(
			currentManifestText,
		) as MigrationManifest;
		const boundaryFailures = auditCollapseBoundaryManifestEvidence({
			generation,
			boundaryManifest,
			boundaryManifestText,
			currentManifest,
		});
		if (boundaryFailures.length > 0) {
			throw new Error(
				`Active manifest is not a valid collapse-boundary descendant:\n- ${boundaryFailures.join("\n- ")}`,
			);
		}
		if (
			generation.transition.candidateManifestSha256 ===
			sha256Text(currentManifestText)
		) {
			return CANDIDATE_CATALOG_EVIDENCE_FILE;
		}
		if (
			currentManifest.migrations.length === boundaryManifest.migrations.length
		) {
			throw new Error(
				"The one-entry generation-2 boundary manifest does not match its immutable candidate bytes",
			);
		}
		return undefined;
	}
	throw new Error(
		`No reviewed catalog evidence is authorized for generation ${generation.generation}`,
	);
}

if (import.meta.main) {
	const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
	const generation = readBaselineGeneration(
		fileURLToPath(new URL("../baseline-generation.json", import.meta.url)),
	);
	const currentManifestText = readFileSync(
		new URL("../drizzle/migration-manifest.json", import.meta.url),
		"utf8",
	);
	const boundaryManifestText =
		generation.generation === AUTHORIZED_COLLAPSE_GENERATION
			? readFileSync(
					new URL(
						`../${COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE}`,
						import.meta.url,
					),
					"utf8",
				)
			: undefined;
	const evidenceFile = activeCatalogEvidenceForManifest(
		generation,
		currentManifestText,
		boundaryManifestText,
	);
	const evidencePath = evidenceFile
		? fileURLToPath(new URL(`../${evidenceFile}`, import.meta.url))
		: undefined;
	const generationOneEvidenceMatchesCurrentManifest =
		generation.generation !== INITIAL_BASELINE_GENERATION ||
		!evidencePath ||
		!existsSync(evidencePath)
			? false
			: (
					JSON.parse(readFileSync(evidencePath, "utf8")) as {
						migrationManifestSha256?: string;
					}
				).migrationManifestSha256 === sha256Text(currentManifestText);
	const useSchemaDerivedVerification =
		!evidenceFile ||
		(generation.generation === INITIAL_BASELINE_GENERATION &&
			!generationOneEvidenceMatchesCurrentManifest);
	if (useSchemaDerivedVerification) {
		if (process.argv.includes("--require-boundary")) {
			throw new Error(
				"Exact reviewed-boundary catalog verification was required, but no evidence is bound to the active manifest",
			);
		}
		execFileSync(process.execPath, ["run", "scripts/verify-migrations.ts"], {
			cwd: packageDirectory,
			stdio: "inherit",
			env: process.env,
		});
		console.log(
			`Active generation-${generation.generation} manifest has no reviewed catalog fingerprint bound to its current bytes; current schema-derived migration verification is authoritative.`,
		);
	} else {
		if (!evidencePath || !existsSync(evidencePath)) {
			throw new Error(
				`Reviewed catalog evidence is missing for generation ${generation.generation}`,
			);
		}
		execFileSync(
			process.execPath,
			[
				"run",
				"scripts/capture-catalog-fingerprint.ts",
				`--verify=${evidencePath}`,
			],
			{
				cwd: packageDirectory,
				stdio: "inherit",
				env: process.env,
			},
		);
		console.log(
			`Active database catalog matches reviewed generation-${generation.generation} evidence.`,
		);
	}
}
