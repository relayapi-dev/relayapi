import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findNumberedMigrationLiterals,
	isMigrationSourceOwnershipExcluded,
	MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS,
	MIGRATION_SOURCE_OWNERSHIP_FILES,
	MIGRATION_SOURCE_OWNERSHIP_ROOTS,
} from "./migration-source-ownership-contract";

const repositoryRoot = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);
const sourceExtensions = new Set<string>(MIGRATION_SOURCE_OWNERSHIP_EXTENSIONS);

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFiles(path));
		} else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
			files.push(path);
		}
	}
	return files;
}

const failures: string[] = [];
const paths = [
	...MIGRATION_SOURCE_OWNERSHIP_ROOTS.flatMap((root) =>
		sourceFiles(join(repositoryRoot, root)),
	),
	...MIGRATION_SOURCE_OWNERSHIP_FILES.map((file) => join(repositoryRoot, file)),
];
for (const path of paths) {
	const repositoryPath = relative(repositoryRoot, path).replaceAll("\\", "/");
	if (isMigrationSourceOwnershipExcluded(repositoryPath)) {
		continue;
	}
	for (const match of findNumberedMigrationLiterals(
		readFileSync(path, "utf8"),
	)) {
		failures.push(
			`${repositoryPath}:${match.line} references ${match.literal}`,
		);
	}
}

if (failures.length > 0) {
	throw new Error(
		"Numbered migration artifacts leaked outside migration-history tooling. Depend on a schema or SQL-render contract instead:\n" +
			failures.map((failure) => `- ${failure}`).join("\n"),
	);
}

console.log(
	"Runtime, application, and automation source contains no numbered migration literals.",
);
