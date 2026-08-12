export type AppendOnlyGitTopology = {
	baseSha: string;
	headSha: string;
	baseAvailable: boolean;
	baseIsAncestorOfHead: boolean;
	protectedRef?: string;
	baseReachableFromProtectedRef?: boolean;
	generationChanged: boolean;
	firstParentSha?: string;
};

/**
 * Pure comparison-topology contract. Keeping these cases independent from Git
 * subprocesses gives the non-ancestor/orphan/skipped-predecessor failures
 * deterministic regression fixtures without creating synthetic Git history.
 */
export function auditAppendOnlyGitTopology(
	input: AppendOnlyGitTopology,
): string[] {
	if (!input.baseAvailable) {
		return [
			`MIGRATION_BASE_SHA ${input.baseSha} is not an available commit; fetch the comparison history before running the migration generation gate`,
		];
	}
	if (!input.baseIsAncestorOfHead) {
		return [
			`MIGRATION_BASE_SHA ${input.baseSha} is not an ancestor of HEAD ${input.headSha}`,
		];
	}
	if (input.protectedRef && input.baseReachableFromProtectedRef !== true) {
		return [
			`MIGRATION_BASE_SHA ${input.baseSha} is not reachable from protected ref ${input.protectedRef}`,
		];
	}
	if (input.generationChanged && input.firstParentSha !== input.baseSha) {
		return [
			"Baseline generation transition must use the exact generation predecessor as HEAD's first parent",
		];
	}
	return [];
}

export function auditOneTimeManifestBootstrap(input: {
	baseSha: string;
	headSha: string;
	explicitBootstrap?: string;
	firstParentSha: string;
	changedMigrationArtifacts: readonly string[];
	manifestPath: string;
}): string[] {
	const expectedBootstrap = `${input.baseSha}:${input.headSha}`;
	if (
		input.explicitBootstrap !== expectedBootstrap ||
		input.firstParentSha !== input.baseSha ||
		input.changedMigrationArtifacts.some((path) => path !== input.manifestPath)
	) {
		return [
			"Base commit has no protected migration manifest. The one-time bootstrap requires an exact base:HEAD authorization, the base as HEAD's first parent, and no changed Drizzle artifact except migration-manifest.json.",
		];
	}
	return [];
}

/**
 * Authorize the single pre-live history reset that introduces generation
 * metadata. The authorization is tied to an exact base:HEAD edge and accepts
 * only a one-entry replacement baseline; once metadata is committed this path
 * is permanently unreachable.
 */
export function auditOneTimeGenerationBootstrap(input: {
	baseSha: string;
	headSha: string;
	explicitPreLiveReset?: string;
	firstParentSha: string;
	manifestChanged: boolean;
	currentMigrationCount: number;
}): string[] {
	if (!input.manifestChanged) return [];
	const expectedAuthorization = `${input.baseSha}:${input.headSha}`;
	if (
		input.explicitPreLiveReset !== expectedAuthorization ||
		input.firstParentSha !== input.baseSha ||
		input.currentMigrationCount !== 1
	) {
		return [
			"The one-time generation metadata bootstrap may rewrite pre-live migration history only with an exact base:HEAD authorization, the base as HEAD's first parent, and exactly one replacement baseline migration.",
		];
	}
	return [];
}
