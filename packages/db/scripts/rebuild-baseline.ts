import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BASELINE_PREAMBLE_MARKER,
	REQUIRED_BASELINE_EXTENSION_SCHEMAS,
	REQUIRED_BASELINE_EXTENSIONS,
	REQUIRED_BASELINE_SCHEMAS,
	renderBaselinePreambleSql,
} from "./render-baseline-preamble-sql";
import {
	CUSTOM_MIGRATION_SQL_MARKER,
	renderCustomMigrationSql,
} from "./render-custom-migration-sql";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const SNAPSHOT_FILE = "meta/0000_snapshot.json";
const JOURNAL_FILE = "meta/_journal.json";
const MANIFEST_FILE = "migration-manifest.json";
const MIGRATION_POLICY_FILE = "migration-policy.json";
const WRITE_CONFIRMATION_FLAG = "--confirm-pre-launch-virgin-reset";
const WRITE_LOCK_DIRECTORY = ".drizzle-baseline-rebuild.lock";

export type BaselineBuildPolicy = {
	schemaVersion: 1;
	lifecycle: "pre-launch" | "sealed";
	baseline: {
		tag: "0000_baseline";
		folderMillis: number;
	};
};

type MigrationPolicy = {
	schemaVersion: 1;
	migrations: Record<
		string,
		{
			phase: "baseline" | "expand" | "contract";
			summary: string;
		}
	>;
};

type Journal = {
	version: string;
	dialect: string;
	entries: Array<{
		idx: number;
		version: string;
		when: number;
		tag: string;
		breakpoints: boolean;
	}>;
};

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

type Snapshot = Record<string, unknown> & {
	id: string;
	prevId: string;
	version: string;
	dialect: string;
};

export type BaselineArtifactSet = Record<string, string>;

export type BaselineCommandOptions = {
	mode: "write" | "dry-run" | "check";
	confirmed: boolean;
	help: boolean;
};

function fail(message: string): never {
	throw new Error(`Baseline rebuild refused: ${message}`);
}

function parseJson<T>(source: string, label: string): T {
	try {
		return JSON.parse(source) as T;
	} catch (error) {
		throw new Error(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function markerCount(source: string): number {
	return source.split(CUSTOM_MIGRATION_SQL_MARKER).length - 1;
}

function countOccurrences(source: string, fragment: string): number {
	return source.split(fragment).length - 1;
}

function escapeRegExp(source: string): string {
	return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function databaseObjectCreationCount(
	source: string,
	kind: "SCHEMA" | "EXTENSION",
	name: string,
): number {
	const escaped = escapeRegExp(name);
	const pattern = new RegExp(
		`\\bCREATE\\s+${kind}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:"${escaped}"|${escaped})(?=\\s|;|$)`,
		"gi",
	);
	return source.match(pattern)?.length ?? 0;
}

function requiredPreambleStatements(): string[] {
	return [
		...REQUIRED_BASELINE_SCHEMAS.map(
			(schema) => `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
		),
		...REQUIRED_BASELINE_EXTENSIONS.map(
			(extension) =>
				`CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA "${REQUIRED_BASELINE_EXTENSION_SCHEMAS[extension]}";`,
		),
	];
}

function normalizeText(source: string): string {
	return `${source.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

function contentUuid(source: string): string {
	const chars = sha256(source).slice(0, 32).split("");
	chars[12] = "5";
	const variant = Number.parseInt(chars[16] ?? "0", 16);
	chars[16] = ((variant & 0x3) | 0x8).toString(16);
	const hex = chars.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function assertDirectory(path: string, label: string): void {
	if (!existsSync(path)) fail(`${label} does not exist: ${path}`);
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		fail(`${label} must be a real directory, not a symlink: ${path}`);
	}
}

function assertExactEntries(
	directory: string,
	expected: string[],
	label: string,
): void {
	assertDirectory(directory, label);
	const entries = readdirSync(directory, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			fail(`${label} must not contain symlinks: ${entry.name}`);
		}
	}
	const actual = entries.map((entry) => entry.name).sort();
	const wanted = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
		fail(
			`${label} contains unexpected history or files (expected ${wanted.join(", ")}; found ${actual.join(", ") || "nothing"})`,
		);
	}
}

export function assertNoStaleBaselineReplacement(
	targetDirectory: string,
): void {
	const prefix = `${basename(targetDirectory)}.baseline-backup-`;
	const backups = readdirSync(dirname(targetDirectory))
		.filter((entry) => entry.startsWith(prefix))
		.sort();
	if (backups.length > 0) {
		fail(
			`stale baseline backup(s) require manual recovery review before another write: ${backups.join(", ")}`,
		);
	}
}

export function acquireBaselineWriteLock(packageDirectory: string): () => void {
	const lockDirectory = join(packageDirectory, WRITE_LOCK_DIRECTORY);
	try {
		mkdirSync(lockDirectory, { mode: 0o700 });
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EEXIST"
		) {
			fail(
				`another rebuild may be running or a stale ${WRITE_LOCK_DIRECTORY} requires manual review`,
			);
		}
		throw error;
	}
	writeFileSync(
		join(lockDirectory, "owner.json"),
		serializeJson({ pid: process.pid, startedAt: new Date().toISOString() }),
		{ encoding: "utf8", mode: 0o600 },
	);
	return () => rmSync(lockDirectory, { recursive: true, force: true });
}

export function readBaselineBuildPolicy(path: string): BaselineBuildPolicy {
	const policy = parseJson<BaselineBuildPolicy>(
		readFileSync(path, "utf8"),
		"baseline-build-policy.json",
	);
	if (policy.schemaVersion !== 1) {
		fail("baseline build policy has an unsupported schema version");
	}
	if (policy.lifecycle !== "pre-launch" && policy.lifecycle !== "sealed") {
		fail("baseline build policy lifecycle must be pre-launch or sealed");
	}
	if (policy.baseline?.tag !== "0000_baseline") {
		fail("the only supported virgin baseline tag is 0000_baseline");
	}
	if (
		!Number.isSafeInteger(policy.baseline.folderMillis) ||
		policy.baseline.folderMillis <= 0
	) {
		fail("baseline folderMillis must be a positive safe integer");
	}
	return policy;
}

function assertMigrationPolicy(
	policy: MigrationPolicy,
	expectedTag: string,
): void {
	if (policy.schemaVersion !== 1) {
		fail("migration-policy.json has an unsupported schema version");
	}
	const tags = Object.keys(policy.migrations ?? {});
	if (tags.length !== 1 || tags[0] !== expectedTag) {
		fail(
			`migration policy must contain exactly the ${expectedTag} baseline and no expand/contract history`,
		);
	}
	const entry = policy.migrations[expectedTag];
	if (entry?.phase !== "baseline" || !entry.summary?.trim()) {
		fail(`${expectedTag} must have a reviewed baseline policy entry`);
	}
}

function assertJournal(journal: Journal, expectedTag: string): void {
	if (journal.dialect !== "postgresql" || !journal.version) {
		fail(
			"Drizzle journal must use the PostgreSQL dialect and declare a version",
		);
	}
	if (journal.entries?.length !== 1) {
		fail("Drizzle journal must contain exactly one virgin baseline entry");
	}
	const entry = journal.entries[0];
	if (
		entry?.idx !== 0 ||
		entry.tag !== expectedTag ||
		entry.version !== journal.version ||
		entry.breakpoints !== true ||
		!Number.isSafeInteger(entry.when) ||
		entry.when <= 0
	) {
		fail(`Drizzle journal entry must be the breakpoint-enabled ${expectedTag}`);
	}
}

function assertSnapshot(snapshot: Snapshot, journal: Journal): void {
	if (
		snapshot.dialect !== "postgresql" ||
		snapshot.version !== journal.version ||
		!isUuid(snapshot.id) ||
		snapshot.prevId !== ZERO_UUID
	) {
		fail(
			"0000_snapshot.json must be a first PostgreSQL snapshot with a valid identity",
		);
	}
}

function deterministicSnapshot(snapshot: Snapshot): Snapshot {
	const normalized = parseJson<Snapshot>(
		JSON.stringify(snapshot),
		"generated 0000 snapshot",
	);
	normalized.id = ZERO_UUID;
	normalized.prevId = ZERO_UUID;
	normalized.id = contentUuid(serializeJson(normalized));
	return normalized;
}

type BaselineDirectoryValidationOptions = {
	requireCustomSql?: boolean;
	requirePreamble?: boolean;
	expectedFolderMillis?: number;
	requireDeterministicSnapshot?: boolean;
};

export function assertBaselineDirectory(
	directory: string,
	expectedTag: string,
	options: BaselineDirectoryValidationOptions = {},
): void {
	assertExactEntries(
		directory,
		[`${expectedTag}.sql`, "meta", MANIFEST_FILE, MIGRATION_POLICY_FILE],
		"migration directory",
	);
	assertExactEntries(
		join(directory, "meta"),
		["0000_snapshot.json", "_journal.json"],
		"migration metadata directory",
	);

	const policy = parseJson<MigrationPolicy>(
		readFileSync(join(directory, MIGRATION_POLICY_FILE), "utf8"),
		MIGRATION_POLICY_FILE,
	);
	assertMigrationPolicy(policy, expectedTag);

	const journal = parseJson<Journal>(
		readFileSync(join(directory, JOURNAL_FILE), "utf8"),
		JOURNAL_FILE,
	);
	assertJournal(journal, expectedTag);
	const entry = journal.entries[0];
	if (!entry) fail("Drizzle journal is missing its baseline entry");
	if (
		options.expectedFolderMillis !== undefined &&
		entry.when !== options.expectedFolderMillis
	) {
		fail(
			`baseline journal timestamp must be ${options.expectedFolderMillis}, found ${entry.when}`,
		);
	}

	const sql = readFileSync(join(directory, `${expectedTag}.sql`), "utf8");
	const preambleMarkerCount = countOccurrences(sql, BASELINE_PREAMBLE_MARKER);
	if (
		preambleMarkerCount > 1 ||
		(options.requirePreamble &&
			(preambleMarkerCount !== 1 ||
				!sql.startsWith(renderBaselinePreambleSql())))
	) {
		fail(
			`${expectedTag}.sql must contain ${options.requirePreamble ? "exactly" : "at most"} one generated database preamble at the start`,
		);
	}
	for (const statement of requiredPreambleStatements()) {
		const count = countOccurrences(sql, statement);
		if (count > 1 || (options.requirePreamble && count !== 1)) {
			fail(
				`${expectedTag}.sql must contain ${options.requirePreamble ? "exactly" : "at most"} one ${statement}`,
			);
		}
	}
	for (const schema of REQUIRED_BASELINE_SCHEMAS) {
		const count = databaseObjectCreationCount(sql, "SCHEMA", schema);
		if (count > 1 || (options.requirePreamble && count !== 1)) {
			fail(
				`${expectedTag}.sql must create required schema ${schema} exactly once`,
			);
		}
	}
	for (const extension of REQUIRED_BASELINE_EXTENSIONS) {
		const count = databaseObjectCreationCount(sql, "EXTENSION", extension);
		if (count > 1 || (options.requirePreamble && count !== 1)) {
			fail(
				`${expectedTag}.sql must create required extension ${extension} exactly once`,
			);
		}
	}
	const customMarkerCount = markerCount(sql);
	if (
		customMarkerCount > 1 ||
		(options.requireCustomSql && customMarkerCount !== 1)
	) {
		fail(
			`${expectedTag}.sql must contain ${options.requireCustomSql ? "exactly" : "at most"} one generated custom-SQL block`,
		);
	}

	const manifest = parseJson<Manifest>(
		readFileSync(join(directory, MANIFEST_FILE), "utf8"),
		MANIFEST_FILE,
	);
	const manifestEntry = manifest.migrations?.[0];
	if (
		manifest.schemaVersion !== 2 ||
		manifest.journal?.version !== journal.version ||
		manifest.journal?.dialect !== journal.dialect ||
		manifest.migrations.length !== 1 ||
		!manifestEntry ||
		manifestEntry.idx !== 0 ||
		manifestEntry.tag !== expectedTag ||
		manifestEntry.folderMillis !== entry.when ||
		manifestEntry.sha256 !== sha256(sql) ||
		manifestEntry.snapshotSha256 !==
			sha256(readFileSync(join(directory, SNAPSHOT_FILE), "utf8")) ||
		manifestEntry.drizzleVersion !== entry.version ||
		manifestEntry.breakpoints !== entry.breakpoints
	) {
		fail("migration manifest does not exactly hash the one journaled baseline");
	}

	const snapshot = parseJson<Snapshot>(
		readFileSync(join(directory, SNAPSHOT_FILE), "utf8"),
		SNAPSHOT_FILE,
	);
	assertSnapshot(snapshot, journal);
	if (
		options.requireDeterministicSnapshot &&
		deterministicSnapshot(snapshot).id !== snapshot.id
	) {
		fail(
			"0000_snapshot.json identity is not content-derived and deterministic",
		);
	}
}

function readGeneratedBaseline(directory: string): {
	sql: string;
	journal: Journal;
	snapshot: Snapshot;
} {
	assertDirectory(directory, "generated Drizzle directory");
	const rootEntries = readdirSync(directory, { withFileTypes: true });
	const sqlEntries = rootEntries.filter(
		(entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name),
	);
	if (sqlEntries.length !== 1) {
		fail(
			"Drizzle must generate exactly one SQL migration from an empty directory",
		);
	}
	const sqlEntry = sqlEntries[0];
	if (!sqlEntry) fail("Drizzle did not generate a SQL migration");
	assertExactEntries(
		directory,
		[sqlEntry.name, "meta"],
		"generated Drizzle directory",
	);
	assertExactEntries(
		join(directory, "meta"),
		["0000_snapshot.json", "_journal.json"],
		"generated Drizzle metadata directory",
	);

	const journal = parseJson<Journal>(
		readFileSync(join(directory, JOURNAL_FILE), "utf8"),
		"generated Drizzle journal",
	);
	const generatedTag = sqlEntry.name.replace(/\.sql$/, "");
	assertJournal(journal, generatedTag);
	const snapshot = parseJson<Snapshot>(
		readFileSync(join(directory, SNAPSHOT_FILE), "utf8"),
		"generated Drizzle snapshot",
	);
	assertSnapshot(snapshot, journal);

	return {
		sql: readFileSync(join(directory, sqlEntry.name), "utf8"),
		journal,
		snapshot,
	};
}

export function normalizeBaselineArtifacts(input: {
	generatedSql: string;
	generatedJournal: Journal;
	generatedSnapshot: Snapshot;
	preambleSql: string;
	customSql: string;
	buildPolicy: BaselineBuildPolicy;
	migrationPolicy: MigrationPolicy;
}): BaselineArtifactSet {
	const { tag, folderMillis } = input.buildPolicy.baseline;
	assertMigrationPolicy(input.migrationPolicy, tag);
	assertJournal(
		input.generatedJournal,
		input.generatedJournal.entries[0]?.tag ?? "",
	);
	assertSnapshot(input.generatedSnapshot, input.generatedJournal);

	if (
		normalizeText(input.preambleSql) !==
		normalizeText(renderBaselinePreambleSql())
	) {
		fail("the baseline preamble renderer does not match its required contract");
	}
	if (countOccurrences(input.preambleSql, BASELINE_PREAMBLE_MARKER) !== 1) {
		fail(
			"the baseline preamble renderer must emit exactly one generated marker",
		);
	}
	if (countOccurrences(input.generatedSql, BASELINE_PREAMBLE_MARKER) !== 0) {
		fail("Drizzle-generated SQL already contains the database preamble marker");
	}
	for (const statement of requiredPreambleStatements()) {
		if (countOccurrences(input.preambleSql, statement) !== 1) {
			fail(`the baseline preamble must emit exactly one ${statement}`);
		}
	}
	for (const schema of REQUIRED_BASELINE_SCHEMAS) {
		if (databaseObjectCreationCount(input.generatedSql, "SCHEMA", schema) > 0) {
			fail(`Drizzle-generated SQL already creates required schema ${schema}`);
		}
	}
	for (const extension of REQUIRED_BASELINE_EXTENSIONS) {
		if (
			databaseObjectCreationCount(input.generatedSql, "EXTENSION", extension) >
			0
		) {
			fail(
				`Drizzle-generated SQL already creates required extension ${extension}`,
			);
		}
	}
	if (markerCount(input.generatedSql) !== 0) {
		fail("Drizzle-generated SQL already contains the custom-SQL marker");
	}
	if (markerCount(input.customSql) !== 1) {
		fail("the custom SQL renderer must emit exactly one generated marker");
	}
	if (!input.customSql.trimStart().startsWith("--> statement-breakpoint")) {
		fail("custom SQL must start at a Drizzle statement breakpoint");
	}

	const baselineSql = normalizeText(
		`${input.preambleSql.trimEnd()}\n${input.generatedSql.trim()}\n${input.customSql.trim()}\n`,
	);
	if (
		countOccurrences(baselineSql, BASELINE_PREAMBLE_MARKER) !== 1 ||
		!baselineSql.startsWith(renderBaselinePreambleSql())
	) {
		fail("normalized baseline must start with exactly one database preamble");
	}
	if (markerCount(baselineSql) !== 1) {
		fail("normalized baseline must contain exactly one custom-SQL block");
	}

	const snapshot = deterministicSnapshot(input.generatedSnapshot);
	const journal: Journal = {
		version: input.generatedJournal.version,
		dialect: "postgresql",
		entries: [
			{
				idx: 0,
				version: input.generatedJournal.version,
				when: folderMillis,
				tag,
				breakpoints: true,
			},
		],
	};
	const migrationPolicy: MigrationPolicy = {
		schemaVersion: 1,
		migrations: {
			[tag]: {
				phase: "baseline",
				summary: input.migrationPolicy.migrations[tag]?.summary.trim() ?? "",
			},
		},
	};
	const serializedSnapshot = serializeJson(snapshot);
	const manifest: Manifest = {
		schemaVersion: 2,
		journal: {
			version: journal.version,
			dialect: journal.dialect,
		},
		migrations: [
			{
				idx: 0,
				tag,
				folderMillis,
				sha256: sha256(baselineSql),
				snapshotSha256: sha256(serializedSnapshot),
				drizzleVersion: journal.entries[0]?.version ?? "",
				breakpoints: journal.entries[0]?.breakpoints ?? false,
			},
		],
	};

	return {
		[`${tag}.sql`]: baselineSql,
		[SNAPSHOT_FILE]: serializedSnapshot,
		[JOURNAL_FILE]: serializeJson(journal),
		[MANIFEST_FILE]: serializeJson(manifest),
		[MIGRATION_POLICY_FILE]: serializeJson(migrationPolicy),
	};
}

export function writeArtifactSet(
	directory: string,
	artifacts: BaselineArtifactSet,
): void {
	if (existsSync(directory)) {
		fail(`replacement directory already exists: ${directory}`);
	}
	for (const [path, source] of Object.entries(artifacts)) {
		const destination = join(directory, path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, source, { encoding: "utf8", mode: 0o644 });
	}
}

export function changedArtifactPaths(
	directory: string,
	artifacts: BaselineArtifactSet,
): string[] {
	return Object.entries(artifacts)
		.filter(([path, source]) => {
			const current = join(directory, path);
			return !existsSync(current) || readFileSync(current, "utf8") !== source;
		})
		.map(([path]) => path)
		.sort();
}

export function parseBaselineCommandOptions(
	args: string[],
): BaselineCommandOptions {
	const known = new Set([
		"--dry-run",
		"--check",
		WRITE_CONFIRMATION_FLAG,
		"--help",
	]);
	const unknown = args.filter((arg) => !known.has(arg));
	if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(", ")}`);
	if (args.includes("--dry-run") && args.includes("--check")) {
		fail("--dry-run and --check are mutually exclusive");
	}
	return {
		mode: args.includes("--check")
			? "check"
			: args.includes("--dry-run")
				? "dry-run"
				: "write",
		confirmed: args.includes(WRITE_CONFIRMATION_FLAG),
		help: args.includes("--help"),
	};
}

export function assertBaselineWriteAllowed(
	policy: BaselineBuildPolicy,
	options: BaselineCommandOptions,
): void {
	if (options.mode !== "write") return;
	if (!options.confirmed) {
		fail(`write mode requires ${WRITE_CONFIRMATION_FLAG}`);
	}
	if (policy.lifecycle !== "pre-launch") {
		fail("baseline build policy is sealed; migration history is append-only");
	}
}

function runDrizzleGenerate(
	packageDirectory: string,
	generatedDirectory: string,
): void {
	const schemaPath = join(packageDirectory, "src", "schema.ts");
	const executableCandidates = [
		join(packageDirectory, "node_modules", ".bin", "drizzle-kit"),
		join(packageDirectory, "..", "..", "node_modules", ".bin", "drizzle-kit"),
	];
	const drizzleKit = executableCandidates.find((candidate) =>
		existsSync(candidate),
	);
	if (!drizzleKit) {
		fail(
			"the workspace-pinned drizzle-kit executable is missing; run bun install first",
		);
	}
	try {
		execFileSync(
			drizzleKit,
			[
				"generate",
				"--dialect=postgresql",
				`--schema=${schemaPath}`,
				`--out=${generatedDirectory}`,
				"--name=baseline",
				"--prefix=index",
				"--breakpoints",
			],
			{
				cwd: packageDirectory,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	} catch (error) {
		const stderr =
			typeof error === "object" && error !== null && "stderr" in error
				? String(error.stderr)
				: "";
		throw new Error(
			`Drizzle baseline generation failed${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
		);
	}
}

function runStaticVerifiers(packageDirectory: string): void {
	for (const script of [
		"scripts/verify-migration-history.ts",
		"scripts/verify-migration-policy.ts",
		"scripts/verify-schema-contracts.ts",
	]) {
		execFileSync(process.execPath, ["run", script], {
			cwd: packageDirectory,
			stdio: "inherit",
		});
	}
}

export function replaceDirectoryWithRollback(
	targetDirectory: string,
	replacementDirectory: string,
	verify: () => void,
): void {
	const backupDirectory = `${targetDirectory}.baseline-backup-${process.pid}`;
	if (existsSync(backupDirectory)) {
		fail(`stale baseline backup exists: ${backupDirectory}`);
	}

	renameSync(targetDirectory, backupDirectory);
	try {
		renameSync(replacementDirectory, targetDirectory);
		verify();
	} catch (error) {
		const recoveryFailures: string[] = [];
		if (existsSync(targetDirectory)) {
			try {
				rmSync(targetDirectory, { recursive: true, force: true });
			} catch (recoveryError) {
				recoveryFailures.push(
					`could not remove the unverified replacement: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
		}
		if (!existsSync(targetDirectory) && existsSync(backupDirectory)) {
			try {
				renameSync(backupDirectory, targetDirectory);
			} catch (recoveryError) {
				recoveryFailures.push(
					`could not restore the original directory: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
		}
		if (recoveryFailures.length > 0) {
			throw new Error(
				`Baseline replacement failed and automatic recovery was incomplete: ${recoveryFailures.join("; ")}. Preserve both directories for manual recovery review.`,
				{ cause: error },
			);
		}
		throw error;
	}

	// Verification is the commit boundary. A cleanup failure must never delete
	// the verified replacement or restore a backup that rm may have partially
	// removed; leave the valid target installed and require manual cleanup.
	try {
		rmSync(backupDirectory, { recursive: true, force: true });
	} catch (error) {
		throw new Error(
			`Baseline replacement was verified and installed, but backup cleanup failed at ${backupDirectory}. Keep the target directory and review/remove the backup manually.`,
			{ cause: error },
		);
	}
}

function usage(): string {
	return [
		"Usage:",
		"  bun run baseline:rebuild:dry-run",
		"  bun run baseline:rebuild:check",
		`  bun run baseline:rebuild ${WRITE_CONFIRMATION_FLAG}`,
		"",
		"The write command is accepted only while baseline-build-policy.json is pre-launch.",
	].join("\n");
}

export function rebuildBaseline(
	packageDirectory: string,
	options: BaselineCommandOptions,
): void {
	const buildPolicy = readBaselineBuildPolicy(
		join(packageDirectory, "baseline-build-policy.json"),
	);
	const targetDirectory = join(packageDirectory, "drizzle");
	const { tag, folderMillis } = buildPolicy.baseline;
	assertBaselineWriteAllowed(buildPolicy, options);
	const releaseWriteLock =
		options.mode === "write"
			? acquireBaselineWriteLock(packageDirectory)
			: undefined;
	let temporaryRoot: string | undefined;

	try {
		// Inspect crash residue only after acquiring the writer lock, and before
		// validating the target. If a process died between target -> backup and
		// replacement -> target, report the recoverable backup instead of only a
		// misleading missing-target error.
		if (options.mode === "write") {
			assertNoStaleBaselineReplacement(targetDirectory);
		}
		assertBaselineDirectory(targetDirectory, tag);
		const migrationPolicy = parseJson<MigrationPolicy>(
			readFileSync(join(targetDirectory, MIGRATION_POLICY_FILE), "utf8"),
			MIGRATION_POLICY_FILE,
		);
		temporaryRoot = mkdtempSync(
			join(dirname(targetDirectory), ".drizzle-baseline-build-"),
		);
		const generatedDirectory = join(temporaryRoot, "generated");
		const replacementDirectory = join(temporaryRoot, "replacement");
		runDrizzleGenerate(packageDirectory, generatedDirectory);
		const generated = readGeneratedBaseline(generatedDirectory);
		const artifacts = normalizeBaselineArtifacts({
			generatedSql: generated.sql,
			generatedJournal: generated.journal,
			generatedSnapshot: generated.snapshot,
			preambleSql: renderBaselinePreambleSql(),
			customSql: renderCustomMigrationSql(),
			buildPolicy,
			migrationPolicy,
		});
		writeArtifactSet(replacementDirectory, artifacts);
		assertBaselineDirectory(replacementDirectory, tag, {
			requireCustomSql: true,
			requirePreamble: true,
			expectedFolderMillis: folderMillis,
			requireDeterministicSnapshot: true,
		});

		const changed = changedArtifactPaths(targetDirectory, artifacts);
		const summary =
			changed.length === 0
				? "no artifact changes"
				: `would replace ${changed.join(", ")}`;
		if (options.mode === "dry-run") {
			console.log(
				`Virgin baseline dry run complete (${summary}; sha256 ${sha256(artifacts[`${tag}.sql`] ?? "")}).`,
			);
			return;
		}
		if (options.mode === "check") {
			if (changed.length > 0) {
				throw new Error(
					`Virgin baseline is not reproducible from schema.ts: ${changed.join(", ")}`,
				);
			}
			runStaticVerifiers(packageDirectory);
			console.log("Virgin baseline reproducibility check passed.");
			return;
		}

		if (changed.length === 0) {
			runStaticVerifiers(packageDirectory);
			console.log(
				"Virgin baseline already matches schema.ts and generated contracts.",
			);
			return;
		}

		replaceDirectoryWithRollback(targetDirectory, replacementDirectory, () => {
			assertBaselineDirectory(targetDirectory, tag, {
				requireCustomSql: true,
				requirePreamble: true,
				expectedFolderMillis: folderMillis,
				requireDeterministicSnapshot: true,
			});
			runStaticVerifiers(packageDirectory);
		});
		console.log(
			`Rebuilt ${tag} from schema.ts (${changed.join(", ")}; sha256 ${sha256(artifacts[`${tag}.sql`] ?? "")}).`,
		);
	} finally {
		if (temporaryRoot && existsSync(temporaryRoot)) {
			rmSync(temporaryRoot, { recursive: true, force: true });
		}
		releaseWriteLock?.();
	}
}

if (import.meta.main) {
	try {
		const options = parseBaselineCommandOptions(process.argv.slice(2));
		if (options.help) {
			console.log(usage());
		} else {
			const packageDirectory = resolve(
				dirname(fileURLToPath(import.meta.url)),
				"..",
			);
			rebuildBaseline(packageDirectory, options);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
