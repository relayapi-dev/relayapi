import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

function argument(name: string): string {
	const prefix = `${name}=`;
	const value = process.argv
		.slice(2)
		.find((candidate) => candidate.startsWith(prefix))
		?.slice(prefix.length);
	if (!value) throw new Error(`${name}=<path> is required`);
	return resolve(value);
}

const candidate = argument("--candidate");
const catalogOutput = argument("--catalog-output");
if (existsSync(catalogOutput)) {
	throw new Error(
		`Refusing to overwrite existing candidate catalog ${catalogOutput}`,
	);
}
const drizzleDirectory = join(candidate, "drizzle");
const generationPath = join(candidate, "baseline-generation.json");
for (const path of [
	generationPath,
	join(drizzleDirectory, "migration-manifest.json"),
	join(drizzleDirectory, "meta", "_journal.json"),
]) {
	if (!existsSync(path)) {
		throw new Error(`Candidate replay artifact is missing ${path}`);
	}
}
const candidateGeneration = JSON.parse(readFileSync(generationPath, "utf8")) as {
	generation?: number;
	lifecycle?: string;
	transition?: { kind?: string; fromGeneration?: number };
};
if (
	candidateGeneration.generation !== 2 ||
	!["building", "sealed"].includes(candidateGeneration.lifecycle ?? "") ||
	candidateGeneration.transition?.kind !== "collapse" ||
	candidateGeneration.transition.fromGeneration !== 1
) {
	throw new Error(
		"Candidate replay requires generation-2 collapse metadata derived from generation 1",
	);
}

const connectionString =
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
	throw new Error(
		"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required",
	);
}
const parsed = new URL(connectionString);
if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
	throw new Error("Candidate replay URL must use PostgreSQL");
}
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHosts.has(parsed.hostname)) {
	throw new Error("Candidate replay is restricted to a loopback PostgreSQL host");
}
const expectedDatabase = process.env.RELAYAPI_CANDIDATE_EXPECTED_DATABASE?.trim();
if (
	!expectedDatabase ||
	!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(expectedDatabase)
) {
	throw new Error("RELAYAPI_CANDIDATE_EXPECTED_DATABASE is required");
}
const urlDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
if (urlDatabase !== expectedDatabase) {
	throw new Error(
		`Candidate URL database ${urlDatabase || "missing"} does not equal RELAYAPI_CANDIDATE_EXPECTED_DATABASE ${expectedDatabase}`,
	);
}

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const sql = postgres(connectionString, {
	max: 1,
	prepare: false,
	connect_timeout: 10,
});
try {
	const [state] = await sql<
		Array<{ ledger_exists: boolean; user_relation_count: number }>
	>`
		SELECT
			to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ledger_exists,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_class relation_row
				JOIN pg_catalog.pg_namespace namespace_row
					ON namespace_row.oid = relation_row.relnamespace
				WHERE namespace_row.nspname !~ '^pg_'
					AND namespace_row.nspname <> 'information_schema'
					AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
					AND NOT EXISTS (
						SELECT 1
						FROM pg_catalog.pg_depend dependency
						WHERE dependency.classid = 'pg_class'::regclass
							AND dependency.objid = relation_row.oid
							AND dependency.deptype = 'e'
					)
			) AS user_relation_count
	`;
	if (!state || state.ledger_exists || state.user_relation_count !== 0) {
		throw new Error(
			"Candidate replay database must be virgin: no Drizzle ledger or non-extension user relations",
		);
	}
} finally {
	await sql.end({ timeout: 5 });
}

const candidateEnvironment = {
	...process.env,
	CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: connectionString,
	RELAYAPI_CANDIDATE_REPLAY: "1",
	RELAYAPI_MIGRATION_DIRECTORY: drizzleDirectory,
	RELAYAPI_MIGRATION_GENERATION: generationPath,
	RELAYAPI_VERIFY_MIGRATION_DIRECTORY: drizzleDirectory,
	RELAYAPI_VERIFY_BASELINE_GENERATION: generationPath,
};

function run(script: string, args: string[] = []): void {
	execFileSync(process.execPath, ["run", script, ...args], {
		cwd: packageDirectory,
		env: candidateEnvironment,
		stdio: "inherit",
	});
}

run("scripts/migrate.ts");
run("scripts/migrate.ts");
run("scripts/verify-schema-contracts.ts");
run("scripts/verify-migrations.ts");
run("scripts/verify-migration-history.ts", ["--live", "--require-current"]);
run("scripts/capture-catalog-fingerprint.ts", [
	`--output=${catalogOutput}`,
	"--source=candidate",
	"--generation=2",
	`--manifest=${join(drizzleDirectory, "migration-manifest.json")}`,
]);
run("scripts/capture-catalog-fingerprint.ts", [
	`--verify=${catalogOutput}`,
]);

console.log(
	`Candidate ${basename(candidate)} replayed twice and fingerprinted at ${catalogOutput}.`,
);
