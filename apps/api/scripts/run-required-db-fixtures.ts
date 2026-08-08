/**
 * Protected acceptance gate for the database-backed lifecycle fixtures that
 * require a fully migrated PostgreSQL 18 database.
 *
 * Each file runs in its own Bun process so module mocks cannot cross-contaminate
 * the real database client. JUnit reports provide a machine-readable execution
 * count: adding, removing, skipping, or failing a case makes this gate fail.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";

const API_ROOT = join(import.meta.dir, "..");
const TEST_ROOT = join(API_ROOT, "src", "__tests__");
const DATABASE_FIXTURE_MARKER =
	"const databaseIt = CONNECTION_STRING ? it : it.skip;";
const fixtures = [
	{
		file: "src/__tests__/authority-revocation-races-db.test.ts",
		expectedCases: 20,
	},
	{
		file: "src/__tests__/billing-period-reservation-boundary.test.ts",
		expectedCases: 1,
	},
	{
		file: "src/__tests__/byos-lifecycle-db.test.ts",
		expectedCases: 2,
	},
	{
		file: "src/__tests__/email-delivery-owner-deletion.test.ts",
		expectedCases: 2,
	},
	{
		file: "src/__tests__/tool-job-lifecycle-db.test.ts",
		expectedCases: 7,
	},
	{
		file: "src/__tests__/usage-authority-self-heal-db.test.ts",
		expectedCases: 10,
	},
	{
		file: "src/__tests__/daily-tool-entitlement-db.test.ts",
		expectedCases: 4,
	},
] as const;
const EXPECTED_TOTAL_CASES = 46;
const registeredTotalCases = fixtures.reduce(
	(total, fixture) => total + fixture.expectedCases,
	0,
);
if (registeredTotalCases !== EXPECTED_TOTAL_CASES) {
	throw new Error(
		`Required database fixture inventory drifted: expected ${EXPECTED_TOTAL_CASES}, registered ${registeredTotalCases}`,
	);
}

for (const fixture of fixtures) {
	const source = readFileSync(join(API_ROOT, fixture.file), "utf8");
	const registeredCases = source.match(/\bdatabaseIt\s*\(/g)?.length ?? 0;
	if (registeredCases !== fixture.expectedCases) {
		throw new Error(
			`${fixture.file} declares ${fixture.expectedCases} required cases but contains ${registeredCases} databaseIt registrations`,
		);
	}
}

const discoveredDatabaseFixtures = [
	...new Bun.Glob("**/*.test.ts").scanSync({
		cwd: TEST_ROOT,
		onlyFiles: true,
	}),
]
	.filter((relativePath) =>
		readFileSync(join(TEST_ROOT, relativePath), "utf8").includes(
			DATABASE_FIXTURE_MARKER,
		),
	)
	.map((relativePath) => `src/__tests__/${relativePath}`)
	.sort();
const registeredDatabaseFixtures = fixtures
	.map((fixture) => fixture.file)
	.sort();
if (
	JSON.stringify(discoveredDatabaseFixtures) !==
	JSON.stringify(registeredDatabaseFixtures)
) {
	throw new Error(
		`Required database fixture registration drifted: discovered=${JSON.stringify(discoveredDatabaseFixtures)}, registered=${JSON.stringify(registeredDatabaseFixtures)}`,
	);
}

if (process.env.RELAYAPI_REQUIRE_DB_FIXTURES !== "1") {
	throw new Error(
		"Required database fixture gate must run with RELAYAPI_REQUIRE_DB_FIXTURES=1",
	);
}

const connectionString =
	process.env.HYPERDRIVE_LOCAL_CONNECTION_STRING ??
	process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
if (!connectionString) {
	throw new Error(
		"Required database fixture gate needs a PostgreSQL URL in HYPERDRIVE_LOCAL_CONNECTION_STRING or CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
	);
}

const reportDirectory = mkdtempSync(
	join(tmpdir(), "relayapi-required-db-fixtures-"),
);
const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
});

function exactNonNegativeInteger(
	summary: Record<string, unknown>,
	key: string,
	reportPath: string,
): number {
	const value = Number(summary[key] ?? 0);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`Invalid JUnit ${key} value in ${reportPath}: ${String(summary[key])}`,
		);
	}
	return value;
}

let executedCases = 0;

try {
	for (const [index, fixture] of fixtures.entries()) {
		const reportPath = join(reportDirectory, `${index}.xml`);
		const child = Bun.spawnSync(
			[
				process.execPath,
				"test",
				fixture.file,
				"--reporter=junit",
				`--reporter-outfile=${reportPath}`,
			],
			{
				cwd: API_ROOT,
				env: process.env,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		process.stdout.write(child.stdout);
		process.stderr.write(child.stderr);
		if (child.exitCode !== 0) {
			throw new Error(
				`Required database fixture failed: ${fixture.file} (exit ${child.exitCode})`,
			);
		}

		const parsed = parser.parse(readFileSync(reportPath, "utf8")) as {
			testsuites?: Record<string, unknown>;
		};
		if (!parsed.testsuites) {
			throw new Error(`Missing JUnit testsuites summary in ${reportPath}`);
		}
		const tests = exactNonNegativeInteger(
			parsed.testsuites,
			"tests",
			reportPath,
		);
		const failures = exactNonNegativeInteger(
			parsed.testsuites,
			"failures",
			reportPath,
		);
		const skipped = exactNonNegativeInteger(
			parsed.testsuites,
			"skipped",
			reportPath,
		);
		if (tests !== fixture.expectedCases || failures !== 0 || skipped !== 0) {
			throw new Error(
				`${fixture.file} must execute exactly ${fixture.expectedCases} cases with no failures or skips; observed tests=${tests}, failures=${failures}, skipped=${skipped}`,
			);
		}
		executedCases += tests;
	}
} finally {
	rmSync(reportDirectory, { force: true, recursive: true });
}

if (executedCases !== EXPECTED_TOTAL_CASES) {
	throw new Error(
		`Required database fixture execution drifted: expected ${EXPECTED_TOTAL_CASES}, observed ${executedCases}`,
	);
}

console.log(
	`Required database fixture gate passed: ${executedCases} cases across ${fixtures.length} isolated files`,
);
