import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	assertNoGenerationFailures,
	auditBaselineBuildPolicy,
	auditBaselineGeneration,
	auditGenerationTransition,
	type BaselineBuildPolicy,
	type BaselineGeneration,
	type MigrationManifest,
} from "./baseline-generation-contract";
import { OLD_CHAIN_CATALOG_EVIDENCE_FILE } from "./catalog-fingerprint-contract";
import {
	auditAppendOnlyGitTopology,
	auditOneTimeGenerationBootstrap,
	auditOneTimeManifestBootstrap,
} from "./migration-append-only-topology";

const suppliedBaseSha = process.env.MIGRATION_BASE_SHA?.trim();
if (!suppliedBaseSha) {
	if (process.env.CI) {
		throw new Error(
			"MIGRATION_BASE_SHA is required in CI; migration generation verification must not be skipped",
		);
	}
	console.log(
		"No MIGRATION_BASE_SHA supplied; migration generation comparison skipped.",
	);
	process.exit(0);
}
if (!/^[0-9a-f]{40}$/i.test(suppliedBaseSha)) {
	throw new Error("MIGRATION_BASE_SHA must be a full Git commit SHA");
}
const baseSha = suppliedBaseSha;

// Git pathspecs are relative to Git's process cwd, while this package script is
// intentionally callable from either the monorepo root or packages/db.
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestPath = "packages/db/drizzle/migration-manifest.json";
const generationPath = "packages/db/baseline-generation.json";
const buildPolicyPath = "packages/db/baseline-build-policy.json";

function git(args: string[]): string {
	return execFileSync("git", ["-C", repositoryRoot, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

try {
	execFileSync(
		"git",
		["-C", repositoryRoot, "cat-file", "-e", `${baseSha}^{commit}`],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
} catch (error) {
	const [failure] = auditAppendOnlyGitTopology({
		baseSha,
		headSha: "unknown",
		baseAvailable: false,
		baseIsAncestorOfHead: false,
		generationChanged: false,
	});
	throw new Error(failure, { cause: error });
}

const headSha = git(["rev-parse", "HEAD"]);
try {
	execFileSync(
		"git",
		["-C", repositoryRoot, "merge-base", "--is-ancestor", baseSha, headSha],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
} catch (error) {
	const [failure] = auditAppendOnlyGitTopology({
		baseSha,
		headSha,
		baseAvailable: true,
		baseIsAncestorOfHead: false,
		generationChanged: false,
	});
	throw new Error(failure, { cause: error });
}
const protectedRef = process.env.MIGRATION_PROTECTED_REF?.trim();
if (protectedRef) {
	try {
		execFileSync(
			"git",
			[
				"-C",
				repositoryRoot,
				"merge-base",
				"--is-ancestor",
				baseSha,
				protectedRef,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		const [failure] = auditAppendOnlyGitTopology({
			baseSha,
			headSha,
			baseAvailable: true,
			baseIsAncestorOfHead: true,
			protectedRef,
			baseReachableFromProtectedRef: false,
			generationChanged: false,
		});
		throw new Error(failure, { cause: error });
	}
}

function readCurrent(path: string): string {
	return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

function baseHasPath(path: string): boolean {
	const resolved = execFileSync(
		"git",
		["-C", repositoryRoot, "ls-tree", "--name-only", baseSha, "--", path],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
	if (resolved && resolved !== path) {
		throw new Error(`Could not resolve ${baseSha}:${path}`);
	}
	return resolved === path;
}

function readBase(path: string): string {
	if (!baseHasPath(path)) {
		throw new Error(`Required protected file is absent at ${baseSha}:${path}`);
	}
	try {
		return execFileSync(
			"git",
			["-C", repositoryRoot, "show", `${baseSha}:${path}`],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		throw new Error(`Could not read ${baseSha}:${path}`, { cause: error });
	}
}

const currentManifestText = readCurrent(manifestPath);
const currentManifest = JSON.parse(currentManifestText) as MigrationManifest;
if (!baseHasPath(manifestPath)) {
	const explicitBootstrap =
		process.env.RELAYAPI_MIGRATION_PROTECTION_BOOTSTRAP?.trim();
	const firstParent = git(["rev-parse", "HEAD^1"]);
	const changedMigrationArtifacts = git([
		"diff",
		"--name-only",
		baseSha,
		headSha,
		"--",
		"packages/db/drizzle",
	])
		.split("\n")
		.filter(Boolean);
	assertNoGenerationFailures(
		auditOneTimeManifestBootstrap({
			baseSha,
			headSha,
			explicitBootstrap,
			firstParentSha: firstParent,
			changedMigrationArtifacts,
			manifestPath,
		}),
		"Migration protection bootstrap verification failed",
	);
	console.log(
		"Base commit has no protected migration manifest; accepted the exact one-time migration protection bootstrap.",
	);
	process.exit(0);
}
const baseManifestText = readBase(manifestPath);
const baseManifest = JSON.parse(baseManifestText) as MigrationManifest;

const currentGenerationText = readCurrent(generationPath);
const currentGeneration = JSON.parse(
	currentGenerationText,
) as BaselineGeneration;
const currentBuildPolicyText = readCurrent(buildPolicyPath);
const currentBuildPolicy = JSON.parse(
	currentBuildPolicyText,
) as BaselineBuildPolicy;

if (!baseHasPath(generationPath)) {
	const failures = [
		...auditBaselineGeneration(currentGeneration),
		...auditBaselineBuildPolicy(currentBuildPolicy),
	];
	if (
		currentGeneration.generation !== 1 ||
		currentGeneration.lifecycle !== "sealed" ||
		currentGeneration.transition.kind !== "initial-baseline"
	) {
		failures.push(
			"the one-time metadata bootstrap must establish sealed generation 1",
		);
	}
	failures.push(
		...auditOneTimeGenerationBootstrap({
			baseSha,
			headSha,
			explicitPreLiveReset: process.env.RELAYAPI_PRELIVE_BASELINE_RESET?.trim(),
			firstParentSha: git(["rev-parse", "HEAD^1"]),
			manifestChanged: currentManifestText !== baseManifestText,
			currentMigrationCount: currentManifest.migrations.length,
		}),
	);
	const baseline = currentManifest.migrations[0];
	if (
		baseline?.idx !== 0 ||
		baseline.tag !== currentGeneration.baseline.tag ||
		baseline.folderMillis !== currentGeneration.baseline.folderMillis ||
		currentBuildPolicy.baseline.tag !== currentGeneration.baseline.tag ||
		currentBuildPolicy.baseline.folderMillis !==
			currentGeneration.baseline.folderMillis
	) {
		failures.push(
			"generation, build policy, and protected manifest baseline identities differ",
		);
	}
	assertNoGenerationFailures(
		failures,
		"Migration generation bootstrap verification failed",
	);
	console.log(
		currentManifestText === baseManifestText
			? "Append-only migration prefix verified; sealed generation-1 metadata bootstrap accepted."
			: "Exact one-time pre-live baseline reset and sealed generation-1 metadata bootstrap accepted.",
	);
	process.exit(0);
}

const baseGenerationText = readBase(generationPath);
const baseGeneration = JSON.parse(baseGenerationText) as BaselineGeneration;
const baseBuildPolicyText = readBase(buildPolicyPath);
const baseBuildPolicy = JSON.parse(baseBuildPolicyText) as BaselineBuildPolicy;
assertNoGenerationFailures(
	auditAppendOnlyGitTopology({
		baseSha,
		headSha,
		baseAvailable: true,
		baseIsAncestorOfHead: true,
		...(protectedRef
			? { protectedRef, baseReachableFromProtectedRef: true }
			: {}),
		generationChanged:
			currentGeneration.generation !== baseGeneration.generation,
		firstParentSha: git(["rev-parse", "HEAD^1"]),
	}),
	"Migration comparison topology verification failed",
);
const baseOldChainCatalogText =
	currentGeneration.generation === baseGeneration.generation
		? undefined
		: readBase(`packages/db/${OLD_CHAIN_CATALOG_EVIDENCE_FILE}`);
const failures = auditGenerationTransition({
	baseSha,
	baseGeneration,
	currentGeneration,
	baseGenerationText,
	currentGenerationText,
	baseBuildPolicy,
	currentBuildPolicy,
	baseBuildPolicyText,
	currentBuildPolicyText,
	baseOldChainCatalogText,
	baseManifest,
	currentManifest,
	baseManifestText,
	currentManifestText,
});
assertNoGenerationFailures(
	failures,
	"Migration generation/append-only verification failed",
);

if (currentGeneration.generation === baseGeneration.generation) {
	console.log(
		`Append-only migration prefix verified for sealed generation ${currentGeneration.generation} (${baseManifest.migrations.length} protected, ${currentManifest.migrations.length - baseManifest.migrations.length} appended).`,
	);
} else {
	console.log(
		`Authorized generation ${baseGeneration.generation} to ${currentGeneration.generation} collapse verified against ${baseSha}.`,
	);
}
