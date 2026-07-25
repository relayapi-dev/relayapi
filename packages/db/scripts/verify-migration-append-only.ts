import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Manifest = {
	schemaVersion: 2;
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

const baseSha = process.env.MIGRATION_BASE_SHA?.trim();
if (!baseSha) {
	if (process.env.CI) {
		throw new Error(
			"MIGRATION_BASE_SHA is required in CI; append-only verification must not be skipped",
		);
	}
	console.log(
		"No MIGRATION_BASE_SHA supplied; append-only comparison skipped.",
	);
	process.exit(0);
}
if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
	throw new Error("MIGRATION_BASE_SHA must be a full Git commit SHA");
}

const current = JSON.parse(
	readFileSync(
		new URL("../drizzle/migration-manifest.json", import.meta.url),
		"utf8",
	),
) as Manifest;

// Git pathspecs are relative to Git's process cwd, while this package script is
// intentionally callable from either the monorepo root or packages/db. Anchor
// every repository read so a cwd change can never turn an existing protected
// history into the one-time bootstrap path.
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

try {
	execFileSync(
		"git",
		["-C", repositoryRoot, "cat-file", "-e", `${baseSha}^{commit}`],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
} catch (error) {
	throw new Error(
		`MIGRATION_BASE_SHA ${baseSha} is not an available commit; fetch the comparison history before running the append-only gate`,
		{ cause: error },
	);
}

const manifestPath = "packages/db/drizzle/migration-manifest.json";
const baseTreePath = execFileSync(
	"git",
	["-C", repositoryRoot, "ls-tree", "--name-only", baseSha, "--", manifestPath],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
).trim();
if (!baseTreePath) {
	// The pre-launch reset introduces the first protected manifest. Once it is in
	// the base branch, every later comparison must preserve its exact prefix.
	console.log(
		"Base commit has no protected migration manifest; accepting one-time append-only policy bootstrap.",
	);
	process.exit(0);
}
if (baseTreePath !== manifestPath) {
	throw new Error(
		`Could not resolve the protected migration manifest at ${baseSha}:${manifestPath}`,
	);
}

let baseText: string;
try {
	baseText = execFileSync(
		"git",
		["-C", repositoryRoot, "show", `${baseSha}:${manifestPath}`],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
} catch (error) {
	throw new Error(
		`Could not read the protected migration manifest from ${baseSha}`,
		{ cause: error },
	);
}

const base = JSON.parse(baseText) as Manifest;
if (base.schemaVersion !== current.schemaVersion) {
	throw new Error(
		"Migration manifest schema version changed across the release",
	);
}
if (JSON.stringify(base.journal) !== JSON.stringify(current.journal)) {
	throw new Error(
		"Protected Drizzle journal format changed across the release",
	);
}
if (current.migrations.length < base.migrations.length) {
	throw new Error(
		"Migration history was shortened; migrations are append-only",
	);
}

for (const [index, expected] of base.migrations.entries()) {
	const actual = current.migrations[index];
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`Migration history changed at protected position ${index + 1} (${expected.tag})`,
		);
	}
}

console.log(
	`Append-only migration prefix verified (${base.migrations.length} protected, ${current.migrations.length - base.migrations.length} appended).`,
);
