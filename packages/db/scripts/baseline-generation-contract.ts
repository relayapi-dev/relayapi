import { createHash } from "node:crypto";
import {
	auditCatalogFingerprint,
	type CatalogFingerprint,
} from "./catalog-fingerprint-contract";

export const INITIAL_BASELINE_GENERATION = 1;
export const AUTHORIZED_COLLAPSE_GENERATION = 2;
export const COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE =
	"migration-manifest-generation-2-collapse-boundary.json";

export type BaselineIdentity = {
	tag: string;
	folderMillis: number;
};

export type BaselineBuildPolicy = {
	schemaVersion: 2;
	lifecycle: "pre-launch" | "sealed";
	generation: typeof INITIAL_BASELINE_GENERATION;
	baseline: BaselineIdentity;
	authorizedCollapse: {
		fromGeneration: typeof INITIAL_BASELINE_GENERATION;
		toGeneration: typeof AUTHORIZED_COLLAPSE_GENERATION;
		baseline: BaselineIdentity;
	};
};

export type InitialGenerationTransition = {
	kind: "initial-baseline";
};

export type CollapseGenerationTransition = {
	kind: "collapse";
	fromGeneration: number;
	baseCommitSha: string;
	baseManifestSha256: string;
	baseGenerationSha256: string;
	baseBuildPolicySha256: string;
	candidateManifestSha256: string;
	oldChainCatalogSha256: string;
	candidateCatalogSha256: string;
	catalogDifferenceReviewSha256: string;
};

export type BaselineGeneration = {
	schemaVersion: 1;
	generation: number;
	lifecycle: "building" | "sealed";
	baseline: BaselineIdentity;
	transition: InitialGenerationTransition | CollapseGenerationTransition;
};

export type MigrationManifest = {
	schemaVersion: number;
	journal: {
		version: string;
		dialect: string;
	};
	migrations: Array<{
		idx: number;
		tag: string;
		folderMillis: number;
		sha256: string;
		snapshotSha256: string;
		drizzleVersion: string;
		breakpoints: boolean;
	}>;
};

export function sha256Text(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function isSha256(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{64}$/i.test(value) &&
		value !== "0".repeat(64)
	);
}

function validBaselineIdentity(
	value: BaselineIdentity | undefined,
	label: string,
	failures: string[],
): void {
	if (!value || !/^\d{4}_[a-z0-9_]+$/i.test(value.tag)) {
		failures.push(`${label} baseline tag is invalid`);
	}
	if (
		!value ||
		!Number.isSafeInteger(value.folderMillis) ||
		value.folderMillis <= 0
	) {
		failures.push(`${label} baseline folderMillis must be a positive integer`);
	}
}

export function auditBaselineBuildPolicy(
	policy: BaselineBuildPolicy,
): string[] {
	const failures: string[] = [];
	if (policy.schemaVersion !== 2) {
		failures.push("baseline build policy schemaVersion must be 2");
	}
	if (policy.lifecycle !== "pre-launch" && policy.lifecycle !== "sealed") {
		failures.push(
			"baseline build policy lifecycle must be pre-launch or sealed",
		);
	}
	if (policy.generation !== INITIAL_BASELINE_GENERATION) {
		failures.push("baseline build policy must authorize source generation 1");
	}
	validBaselineIdentity(policy.baseline, "build-policy", failures);
	if (
		policy.authorizedCollapse?.fromGeneration !== INITIAL_BASELINE_GENERATION ||
		policy.authorizedCollapse?.toGeneration !== AUTHORIZED_COLLAPSE_GENERATION
	) {
		failures.push(
			"baseline build policy must authorize exactly generation 1 to generation 2",
		);
	}
	validBaselineIdentity(
		policy.authorizedCollapse?.baseline,
		"authorized-collapse",
		failures,
	);
	return failures;
}

export function auditBaselineGeneration(
	metadata: BaselineGeneration,
): string[] {
	const failures: string[] = [];
	if (metadata.schemaVersion !== 1) {
		failures.push("baseline generation schemaVersion must be 1");
	}
	if (
		!Number.isSafeInteger(metadata.generation) ||
		metadata.generation < INITIAL_BASELINE_GENERATION
	) {
		failures.push("baseline generation must be a positive integer");
	}
	if (metadata.lifecycle !== "building" && metadata.lifecycle !== "sealed") {
		failures.push("baseline generation lifecycle must be building or sealed");
	}
	validBaselineIdentity(metadata.baseline, "generation", failures);

	if (metadata.generation === INITIAL_BASELINE_GENERATION) {
		if (metadata.transition?.kind !== "initial-baseline") {
			failures.push("generation 1 must use the initial-baseline transition");
		}
		return failures;
	}

	if (metadata.transition?.kind !== "collapse") {
		failures.push(
			"generation 2 and later must identify their collapse transition",
		);
		return failures;
	}
	if (metadata.transition.fromGeneration !== metadata.generation - 1) {
		failures.push(
			"collapse transition must originate at the immediately preceding generation",
		);
	}
	if (!/^[0-9a-f]{40}$/i.test(metadata.transition.baseCommitSha)) {
		failures.push("collapse transition baseCommitSha must be a full Git SHA");
	}
	for (const [name, value] of [
		["baseManifestSha256", metadata.transition.baseManifestSha256],
		["baseGenerationSha256", metadata.transition.baseGenerationSha256],
		["baseBuildPolicySha256", metadata.transition.baseBuildPolicySha256],
		["candidateManifestSha256", metadata.transition.candidateManifestSha256],
		["oldChainCatalogSha256", metadata.transition.oldChainCatalogSha256],
		["candidateCatalogSha256", metadata.transition.candidateCatalogSha256],
		[
			"catalogDifferenceReviewSha256",
			metadata.transition.catalogDifferenceReviewSha256,
		],
	] as const) {
		if (!isSha256(value))
			failures.push(`collapse transition ${name} is invalid`);
	}
	return failures;
}

/**
 * Prove that the active generation-2 manifest is the exact collapse candidate
 * or an append-only descendant of it without consulting Git history.
 */
export function auditCollapseBoundaryManifestEvidence(input: {
	generation: BaselineGeneration;
	boundaryManifest: MigrationManifest;
	boundaryManifestText: string;
	currentManifest: MigrationManifest;
}): string[] {
	const failures: string[] = [];
	if (
		input.generation.generation !== AUTHORIZED_COLLAPSE_GENERATION ||
		input.generation.transition.kind !== "collapse" ||
		input.generation.transition.fromGeneration !== INITIAL_BASELINE_GENERATION
	) {
		return [
			"collapse-boundary manifest evidence requires the authorized generation-1-to-2 collapse",
		];
	}
	if (
		input.generation.transition.candidateManifestSha256 !==
		sha256Text(input.boundaryManifestText)
	) {
		failures.push(
			"collapse transition is not bound to the committed boundary manifest bytes",
		);
	}
	if (
		input.boundaryManifest.schemaVersion !==
			input.currentManifest.schemaVersion ||
		JSON.stringify(input.boundaryManifest.journal) !==
			JSON.stringify(input.currentManifest.journal)
	) {
		failures.push(
			"active migration manifest format differs from the collapse boundary",
		);
	}
	if (
		input.boundaryManifest.migrations.length !== 1 ||
		input.boundaryManifest.migrations[0]?.idx !== 0 ||
		input.boundaryManifest.migrations[0]?.tag !==
			input.generation.baseline.tag ||
		input.boundaryManifest.migrations[0]?.folderMillis !==
			input.generation.baseline.folderMillis
	) {
		failures.push(
			"collapse-boundary manifest must contain exactly its declared generation-2 baseline",
		);
	}
	if (
		input.currentManifest.migrations.length <
		input.boundaryManifest.migrations.length
	) {
		failures.push(
			"active migration history is shorter than the collapse boundary",
		);
	} else {
		for (const [
			index,
			expected,
		] of input.boundaryManifest.migrations.entries()) {
			const actual = input.currentManifest.migrations[index];
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				failures.push(
					`active migration history does not descend from the collapse boundary at position ${index + 1} (${expected.tag})`,
				);
			}
		}
	}
	return failures;
}

export type GenerationTransitionAuditInput = {
	baseSha: string;
	baseGeneration: BaselineGeneration;
	currentGeneration: BaselineGeneration;
	baseGenerationText: string;
	currentGenerationText: string;
	baseBuildPolicy: BaselineBuildPolicy;
	currentBuildPolicy: BaselineBuildPolicy;
	baseBuildPolicyText: string;
	currentBuildPolicyText: string;
	baseOldChainCatalogText?: string;
	baseManifest: MigrationManifest;
	currentManifest: MigrationManifest;
	baseManifestText: string;
	currentManifestText: string;
};

/**
 * Audit generation changes independently from Git/process concerns. Within one
 * generation the metadata and protected migration prefix are immutable. A
 * collapse is a distinct, sealed generation with an exact base-revision
 * attestation and a single replacement baseline.
 */
export function auditGenerationTransition(
	input: GenerationTransitionAuditInput,
): string[] {
	const failures = [
		...auditBaselineBuildPolicy(input.baseBuildPolicy).map(
			(message) => `base ${message}`,
		),
		...auditBaselineBuildPolicy(input.currentBuildPolicy).map(
			(message) => `current ${message}`,
		),
		...auditBaselineGeneration(input.baseGeneration).map(
			(message) => `base ${message}`,
		),
		...auditBaselineGeneration(input.currentGeneration).map(
			(message) => `current ${message}`,
		),
	];
	const baseNumber = input.baseGeneration.generation;
	const currentNumber = input.currentGeneration.generation;

	if (input.currentBuildPolicyText !== input.baseBuildPolicyText) {
		failures.push(
			"baseline build policy changed after generation protection was established",
		);
	}
	if (
		input.baseGeneration.lifecycle === "sealed" &&
		input.currentGeneration.lifecycle !== "sealed"
	) {
		failures.push("a sealed baseline generation cannot be reopened");
	}

	if (currentNumber < baseNumber) {
		failures.push(
			`baseline generation decremented from ${baseNumber} to ${currentNumber}`,
		);
		return failures;
	}

	if (currentNumber === baseNumber) {
		if (input.currentGenerationText !== input.baseGenerationText) {
			failures.push(
				"baseline generation metadata changed without a generation increment",
			);
		}
		if (
			input.baseManifest.schemaVersion !==
				input.currentManifest.schemaVersion ||
			JSON.stringify(input.baseManifest.journal) !==
				JSON.stringify(input.currentManifest.journal)
		) {
			failures.push(
				"protected Drizzle manifest format changed within a generation",
			);
		}
		if (
			input.currentManifest.migrations.length <
			input.baseManifest.migrations.length
		) {
			failures.push("migration history was shortened within a generation");
		} else {
			for (const [index, expected] of input.baseManifest.migrations.entries()) {
				const actual = input.currentManifest.migrations[index];
				if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					failures.push(
						`migration history changed at protected position ${index + 1} (${expected.tag})`,
					);
				}
			}
		}
		return failures;
	}

	if (currentNumber !== baseNumber + 1) {
		failures.push(
			`baseline generation skipped from ${baseNumber} to ${currentNumber}; increment exactly once per collapse`,
		);
		return failures;
	}
	if (
		input.baseBuildPolicy.authorizedCollapse.fromGeneration !== baseNumber ||
		input.baseBuildPolicy.authorizedCollapse.toGeneration !== currentNumber
	) {
		failures.push(
			`baseline build policy does not authorize generation ${baseNumber} to generation ${currentNumber}`,
		);
	}
	if (
		input.currentGeneration.baseline.tag !==
			input.baseBuildPolicy.authorizedCollapse.baseline.tag ||
		input.currentGeneration.baseline.folderMillis !==
			input.baseBuildPolicy.authorizedCollapse.baseline.folderMillis
	) {
		failures.push(
			"collapsed generation baseline does not match the build-policy authorized baseline",
		);
	}
	if (
		baseNumber !== INITIAL_BASELINE_GENERATION ||
		currentNumber !== AUTHORIZED_COLLAPSE_GENERATION
	) {
		failures.push(
			"this repository authorizes only the generation 1 to 2 collapse",
		);
	}
	if (input.baseGeneration.lifecycle !== "sealed") {
		failures.push("a collapse source generation must already be sealed");
	}
	if (input.currentGeneration.lifecycle !== "sealed") {
		failures.push("a collapsed generation must land sealed");
	}
	if (
		input.currentManifest.migrations.length !== 1 ||
		input.currentManifest.migrations[0]?.idx !== 0 ||
		input.currentManifest.migrations[0]?.tag !==
			input.currentGeneration.baseline.tag ||
		input.currentManifest.migrations[0]?.folderMillis !==
			input.currentGeneration.baseline.folderMillis
	) {
		failures.push(
			"a collapsed generation must contain exactly its one declared baseline",
		);
	}

	const transition = input.currentGeneration.transition;
	if (transition.kind !== "collapse") {
		failures.push(
			"a generation increment requires collapse transition metadata",
		);
		return failures;
	}
	if (transition.fromGeneration !== baseNumber) {
		failures.push("collapse transition fromGeneration does not match the base");
	}
	if (transition.baseCommitSha !== input.baseSha) {
		failures.push("collapse transition is not anchored to MIGRATION_BASE_SHA");
	}
	if (transition.baseManifestSha256 !== sha256Text(input.baseManifestText)) {
		failures.push("collapse transition base manifest fingerprint is stale");
	}
	if (
		transition.baseGenerationSha256 !== sha256Text(input.baseGenerationText)
	) {
		failures.push("collapse transition base generation fingerprint is stale");
	}
	if (
		transition.baseBuildPolicySha256 !== sha256Text(input.baseBuildPolicyText)
	) {
		failures.push("collapse transition base build-policy fingerprint is stale");
	}
	if (!input.baseOldChainCatalogText) {
		failures.push(
			"collapse transition requires old-chain catalog evidence from the base revision",
		);
	} else {
		let baseOldChainCatalog: CatalogFingerprint | undefined;
		try {
			baseOldChainCatalog = JSON.parse(
				input.baseOldChainCatalogText,
			) as CatalogFingerprint;
		} catch {
			failures.push("base old-chain catalog evidence is not valid JSON");
		}
		if (baseOldChainCatalog) {
			failures.push(
				...auditCatalogFingerprint(baseOldChainCatalog).map(
					(message) => `base old-chain ${message}`,
				),
			);
			if (baseOldChainCatalog.source !== "old-chain") {
				failures.push("base catalog evidence source is not old-chain");
			}
			if (baseOldChainCatalog.generation !== baseNumber) {
				failures.push(
					"base catalog evidence generation does not match the collapse base",
				);
			}
			if (
				baseOldChainCatalog.migrationManifestSha256 !==
				sha256Text(input.baseManifestText)
			) {
				failures.push(
					"base catalog evidence is not bound to the base manifest",
				);
			}
			if (
				transition.oldChainCatalogSha256 !== baseOldChainCatalog.catalogSha256
			) {
				failures.push(
					"collapse transition old-chain catalog fingerprint is stale",
				);
			}
		}
	}
	if (
		transition.candidateManifestSha256 !== sha256Text(input.currentManifestText)
	) {
		failures.push(
			"collapse transition candidate manifest fingerprint is stale",
		);
	}
	return failures;
}

export function assertNoGenerationFailures(
	failures: readonly string[],
	context: string,
): void {
	if (failures.length > 0) {
		throw new Error(`${context}:\n- ${failures.join("\n- ")}`);
	}
}
