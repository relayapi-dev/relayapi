export const NUMBERED_MIGRATION_LITERAL =
	/\b[0-9]{4}_[a-z][a-z0-9_]{2,}(?:\.sql)?\b/gi;

export const MIGRATION_SOURCE_OWNERSHIP_ROOTS = [
	".github",
	"apps",
	"packages",
	"scripts",
] as const;

export const MIGRATION_SOURCE_OWNERSHIP_FILES = ["package.json"] as const;

export const MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS = [
	".astro",
	".cjs",
	".js",
	".json",
	".jsonc",
	".jsx",
	".mjs",
	".sh",
	".ts",
	".tsx",
	".yaml",
	".yml",
] as const;

export const MIGRATION_SOURCE_OWNERSHIP_EXCLUDED_PREFIXES = [
	"packages/db/baseline-build-policy.json",
	"packages/db/baseline-generation.json",
	"packages/db/catalog-difference-review-generation-",
	"packages/db/catalog-fingerprint-generation-",
	"packages/db/drizzle/",
	"packages/db/migration-manifest-generation-2-collapse-boundary.json",
	"packages/db/scripts/",
	"packages/sdk/",
] as const;

export function isMigrationSourceOwnershipExcluded(
	repositoryPath: string,
): boolean {
	return MIGRATION_SOURCE_OWNERSHIP_EXCLUDED_PREFIXES.some((exclusion) =>
		exclusion.endsWith("/") || exclusion.endsWith("-")
			? repositoryPath.startsWith(exclusion)
			: repositoryPath === exclusion,
	);
}

/**
 * Runtime, application, and automation contracts must depend on schema/render
 * contracts, never a numbered migration artifact. Migration history tooling,
 * its tests, and generated SDK source are the only caller-selected exclusions.
 */
export function findNumberedMigrationLiterals(
	source: string,
): Array<{ literal: string; line: number }> {
	const matches: Array<{ literal: string; line: number }> = [];
	for (const match of source.matchAll(NUMBERED_MIGRATION_LITERAL)) {
		const index = match.index ?? 0;
		matches.push({
			literal: match[0],
			line: source.slice(0, index).split("\n").length,
		});
	}
	return matches;
}
