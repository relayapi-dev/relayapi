import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	AUTHORIZED_COLLAPSE_GENERATION,
	auditCollapseBoundaryManifestEvidence,
	COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
	INITIAL_BASELINE_GENERATION,
	type MigrationManifest,
} from "./baseline-generation-contract";
import {
	auditCollapsedCatalogEvidence,
	auditPreservedOldChainCatalogEvidence,
	CANDIDATE_CATALOG_EVIDENCE_FILE,
	CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE,
	type CatalogDifferenceReview,
	type CatalogFingerprint,
	OLD_CHAIN_CATALOG_EVIDENCE_FILE,
} from "./catalog-fingerprint-contract";
import {
	readBaselineBuildPolicy,
	readBaselineGeneration,
} from "./rebuild-baseline";

type Journal = {
	entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

const policyPath = fileURLToPath(
	new URL("../baseline-build-policy.json", import.meta.url),
);
const policy = readBaselineBuildPolicy(policyPath);
const generation = readBaselineGeneration(
	fileURLToPath(new URL("../baseline-generation.json", import.meta.url)),
);
const migrationManifestText = readFileSync(
	new URL("../drizzle/migration-manifest.json", import.meta.url),
	"utf8",
);
const migrationManifest = JSON.parse(
	migrationManifestText,
) as MigrationManifest;
const oldChainCatalogUrl = new URL(
	`../${OLD_CHAIN_CATALOG_EVIDENCE_FILE}`,
	import.meta.url,
);
const candidateCatalogUrl = new URL(
	`../${CANDIDATE_CATALOG_EVIDENCE_FILE}`,
	import.meta.url,
);
const catalogReviewUrl = new URL(
	`../${CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE}`,
	import.meta.url,
);
const auditDocumentText = readFileSync(
	new URL(
		"../../../docs/SCHEMA_OPTIMALITY_AUDIT_PRE_FREEZE_2026-07-27.md",
		import.meta.url,
	),
	"utf8",
);
const boundaryManifestUrl = new URL(
	`../${COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE}`,
	import.meta.url,
);
if (
	generation.generation === AUTHORIZED_COLLAPSE_GENERATION &&
	generation.transition.kind === "collapse"
) {
	if (!existsSync(oldChainCatalogUrl)) {
		throw new Error(
			"Generation-2 collapse metadata requires preserved old-chain catalog evidence",
		);
	}
	const oldChainCatalog = JSON.parse(
		readFileSync(oldChainCatalogUrl, "utf8"),
	) as CatalogFingerprint;
	const oldChainEvidenceFailures = auditPreservedOldChainCatalogEvidence({
		fingerprint: oldChainCatalog,
		generation,
		currentManifestText: migrationManifestText,
		requiredPostgresMajor: 18,
	});
	if (oldChainEvidenceFailures.length > 0) {
		throw new Error(
			`Preserved old-chain catalog evidence is invalid:\n- ${oldChainEvidenceFailures.join("\n- ")}`,
		);
	}
	const boundaryManifestText = readFileSync(boundaryManifestUrl, "utf8");
	const boundaryManifest = JSON.parse(
		boundaryManifestText,
	) as MigrationManifest;
	const boundaryFailures = auditCollapseBoundaryManifestEvidence({
		generation,
		boundaryManifest,
		boundaryManifestText,
		currentManifest: migrationManifest,
	});
	if (boundaryFailures.length > 0) {
		throw new Error(
			`Committed collapse-boundary manifest evidence is invalid:\n- ${boundaryFailures.join("\n- ")}`,
		);
	}
	const candidateCatalog = JSON.parse(
		readFileSync(candidateCatalogUrl, "utf8"),
	) as CatalogFingerprint;
	const reviewText = readFileSync(catalogReviewUrl, "utf8");
	const review = JSON.parse(reviewText) as CatalogDifferenceReview;
	const collapsedEvidenceFailures = auditCollapsedCatalogEvidence({
		generation,
		oldChain: oldChainCatalog,
		candidate: candidateCatalog,
		review,
		reviewText,
		requiredPostgresMajor: 18,
		auditDocument: auditDocumentText,
	});
	if (collapsedEvidenceFailures.length > 0) {
		throw new Error(
			`Committed collapse catalog evidence is invalid:\n- ${collapsedEvidenceFailures.join("\n- ")}`,
		);
	}
} else if (
	existsSync(candidateCatalogUrl) ||
	existsSync(catalogReviewUrl) ||
	existsSync(boundaryManifestUrl)
) {
	throw new Error(
		"Generation-2 catalog evidence exists before the authorized collapse",
	);
}

if (policy.lifecycle !== "sealed") {
	throw new Error(
		"Production database initialization requires baseline-build-policy.json lifecycle=sealed",
	);
}

const journal = JSON.parse(
	readFileSync(
		new URL("../drizzle/meta/_journal.json", import.meta.url),
		"utf8",
	),
) as Journal;
const baselineEntry = journal.entries?.[0];
const expectedIdentity =
	generation.generation === INITIAL_BASELINE_GENERATION
		? policy.baseline
		: generation.generation === AUTHORIZED_COLLAPSE_GENERATION
			? policy.authorizedCollapse.baseline
			: undefined;
if (
	!expectedIdentity ||
	generation.lifecycle !== "sealed" ||
	baselineEntry?.idx !== 0 ||
	baselineEntry.tag !== generation.baseline.tag ||
	baselineEntry.when !== generation.baseline.folderMillis ||
	generation.baseline.tag !== expectedIdentity.tag ||
	generation.baseline.folderMillis !== expectedIdentity.folderMillis
) {
	throw new Error(
		"The sealed baseline generation does not match its authorized identity and first Drizzle journal entry",
	);
}

console.log(
	`Baseline generation ${generation.generation} is sealed and matches the migration journal.`,
);
