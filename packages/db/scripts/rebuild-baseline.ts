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
	assertNoGenerationFailures,
	auditBaselineBuildPolicy,
	auditBaselineGeneration,
	auditGenerationTransition,
	type BaselineBuildPolicy,
	type BaselineGeneration,
	COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
	type MigrationManifest as GenerationManifest,
	sha256Text,
} from "./baseline-generation-contract";
import {
	assertValidCatalogDifferenceReview,
	assertValidCatalogFingerprint,
	CANDIDATE_CATALOG_EVIDENCE_FILE,
	CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE,
	type CatalogDifferenceReview,
	type CatalogFingerprint,
	OLD_CHAIN_CATALOG_EVIDENCE_FILE,
} from "./catalog-fingerprint-contract";
import {
	BASELINE_PREAMBLE_MARKER,
	COLLAPSE_BASELINE_EXTENSION_SCHEMAS,
	COLLAPSE_BASELINE_EXTENSIONS,
	COLLAPSE_BASELINE_SCHEMAS,
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
const GENERATION_FILE = "baseline-generation.json";
const WRITE_CONFIRMATION_FLAG = "--confirm-pre-launch-virgin-reset";
const COLLAPSE_CONFIRMATION_FLAG = "--confirm-generation-collapse";
const WRITE_LOCK_DIRECTORY = ".drizzle-baseline-rebuild.lock";

export type { BaselineBuildPolicy } from "./baseline-generation-contract";

type MigrationPolicy = {
	schemaVersion: 2;
	migrations: Record<
		string,
		{
			phase: "baseline" | "expand" | "contract";
			summary: string;
			affectedObjects?: string[];
			compatibleReleasePrerequisite?: string;
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
	operation: "virgin" | "pre-live-reset" | "collapse";
	confirmed: boolean;
	collapseConfirmed: boolean;
	baseSha?: string;
	oldChainCatalogPath?: string;
	candidateCatalogPath?: string;
	catalogDifferenceReviewPath?: string;
	candidateOutputPath?: string;
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
		...COLLAPSE_BASELINE_SCHEMAS.map(
			(schema) => `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
		),
		...COLLAPSE_BASELINE_EXTENSIONS.map(
			(extension) =>
				`CREATE EXTENSION IF NOT EXISTS "${extension}" WITH SCHEMA "${COLLAPSE_BASELINE_EXTENSION_SCHEMAS[extension]}";`,
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
	const prefixes = [
		`${basename(targetDirectory)}.baseline-backup-`,
		`${GENERATION_FILE}.baseline-backup-`,
		`${COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE}.baseline-backup-`,
		`${CANDIDATE_CATALOG_EVIDENCE_FILE}.baseline-backup-`,
		`${CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE}.baseline-backup-`,
	];
	const backups = readdirSync(dirname(targetDirectory))
		.filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
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
	const failures = auditBaselineBuildPolicy(policy);
	if (failures.length > 0) fail(failures.join("; "));
	return policy;
}

export function readBaselineGeneration(path: string): BaselineGeneration {
	const generation = parseJson<BaselineGeneration>(
		readFileSync(path, "utf8"),
		GENERATION_FILE,
	);
	const failures = auditBaselineGeneration(generation);
	if (failures.length > 0) fail(failures.join("; "));
	return generation;
}

function assertMigrationPolicy(
	policy: MigrationPolicy,
	expectedTag: string,
): void {
	if (policy.schemaVersion !== 2) {
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
	for (const schema of COLLAPSE_BASELINE_SCHEMAS) {
		const count = databaseObjectCreationCount(sql, "SCHEMA", schema);
		if (count > 1 || (options.requirePreamble && count !== 1)) {
			fail(
				`${expectedTag}.sql must create required schema ${schema} exactly once`,
			);
		}
	}
	for (const extension of COLLAPSE_BASELINE_EXTENSIONS) {
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
	for (const schema of COLLAPSE_BASELINE_SCHEMAS) {
		if (databaseObjectCreationCount(input.generatedSql, "SCHEMA", schema) > 0) {
			fail(`Drizzle-generated SQL already creates required schema ${schema}`);
		}
	}
	for (const extension of COLLAPSE_BASELINE_EXTENSIONS) {
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
		schemaVersion: 2,
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
	const expectedChanges = Object.entries(artifacts)
		.filter(([path, source]) => {
			const current = join(directory, path);
			return !existsSync(current) || readFileSync(current, "utf8") !== source;
		})
		.map(([path]) => path);
	const actualPaths: string[] = [];
	const walk = (currentDirectory: string, prefix = "") => {
		for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) {
				fail(`migration directory must not contain symlinks: ${join(prefix, entry.name)}`);
			}
			const path = join(prefix, entry.name);
			if (entry.isDirectory()) {
				walk(join(currentDirectory, entry.name), path);
			} else if (entry.isFile()) {
				actualPaths.push(path);
			} else {
				fail(`migration directory contains a non-file artifact: ${path}`);
			}
		}
	};
	walk(directory);
	const expectedPaths = new Set(Object.keys(artifacts));
	return [
		...new Set([
			...expectedChanges,
			...actualPaths.filter((path) => !expectedPaths.has(path)),
		]),
	].sort();
}

export function parseBaselineCommandOptions(
	args: string[],
): BaselineCommandOptions {
	const known = new Set([
		"--dry-run",
		"--check",
		"--pre-live-reset",
		"--collapse",
		WRITE_CONFIRMATION_FLAG,
		COLLAPSE_CONFIRMATION_FLAG,
		"--help",
	]);
	const valued = [
		"--base-sha=",
		"--old-chain-catalog=",
		"--candidate-catalog=",
		"--catalog-difference-review=",
		"--candidate-output=",
	];
	const unknown = args.filter(
		(arg) =>
			!known.has(arg) && !valued.some((prefix) => arg.startsWith(prefix)),
	);
	if (unknown.length > 0) fail(`unknown argument(s): ${unknown.join(", ")}`);
	if (args.includes("--dry-run") && args.includes("--check")) {
		fail("--dry-run and --check are mutually exclusive");
	}
	const value = (name: string) => {
		const prefix = `${name}=`;
		const matches = args.filter((argument) => argument.startsWith(prefix));
		if (matches.length > 1) fail(`${name} may be supplied only once`);
		return matches[0]?.slice(prefix.length);
	};
	if (args.includes("--collapse") && args.includes("--pre-live-reset")) {
		fail("--collapse and --pre-live-reset are mutually exclusive");
	}
	const operation = args.includes("--collapse")
		? "collapse"
		: args.includes("--pre-live-reset")
			? "pre-live-reset"
			: "virgin";
	const baseSha = value("--base-sha");
	const oldChainCatalogPath = value("--old-chain-catalog");
	const candidateCatalogPath = value("--candidate-catalog");
	const catalogDifferenceReviewPath = value("--catalog-difference-review");
	const candidateOutputPath = value("--candidate-output");
	const collapseArgumentsPresent =
		args.includes(COLLAPSE_CONFIRMATION_FLAG) ||
		baseSha !== undefined ||
		oldChainCatalogPath !== undefined ||
		candidateCatalogPath !== undefined ||
		catalogDifferenceReviewPath !== undefined;
	if (
		candidateOutputPath &&
		(operation !== "collapse" ||
			args.includes("--check") ||
			!args.includes("--dry-run"))
	) {
		fail("--candidate-output is allowed only with --collapse --dry-run");
	}
	if (operation !== "collapse" && collapseArgumentsPresent) {
		fail("collapse-specific arguments require --collapse");
	}
	if (baseSha !== undefined && !/^[0-9a-f]{40}$/i.test(baseSha)) {
		fail("--base-sha must be a full Git commit SHA");
	}
	return {
		mode: args.includes("--check")
			? "check"
			: args.includes("--dry-run")
				? "dry-run"
				: "write",
		operation,
		confirmed: args.includes(WRITE_CONFIRMATION_FLAG),
		collapseConfirmed: args.includes(COLLAPSE_CONFIRMATION_FLAG),
		baseSha,
		oldChainCatalogPath,
		candidateCatalogPath,
		catalogDifferenceReviewPath,
		candidateOutputPath,
		help: args.includes("--help"),
	};
}

export function assertBaselineWriteAllowed(
	policy: BaselineBuildPolicy,
	options: BaselineCommandOptions,
): void {
	if (options.operation === "collapse") return;
	if (options.mode !== "write") return;
	if (!options.confirmed) {
		fail(`write mode requires ${WRITE_CONFIRMATION_FLAG}`);
	}
	if (policy.lifecycle !== "pre-launch") {
		fail("baseline build policy is sealed; migration history is append-only");
	}
}

export function assertCollapseWriteAllowed(
	policy: BaselineBuildPolicy,
	options: BaselineCommandOptions,
): void {
	if (options.operation !== "collapse") return;
	if (policy.lifecycle !== "sealed") {
		fail("generation collapse requires a sealed source generation");
	}
	if (!options.baseSha) {
		fail("generation collapse requires --base-sha=<full Git SHA>");
	}
	if (options.mode !== "write") return;
	if (!options.collapseConfirmed) {
		fail(`collapse write mode requires ${COLLAPSE_CONFIRMATION_FLAG}`);
	}
	if (
		!options.oldChainCatalogPath ||
		!options.candidateCatalogPath ||
		!options.catalogDifferenceReviewPath
	) {
		fail(
			"collapse write mode requires --old-chain-catalog=<path>, --candidate-catalog=<path>, and --catalog-difference-review=<path>",
		);
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

function runVerifierScripts(
	packageDirectory: string,
	scripts: readonly string[],
	overrides?: {
		migrationDirectory: string;
		baselineGenerationPath?: string;
	},
): void {
	for (const script of scripts) {
		const {
			RELAYAPI_VERIFY_MIGRATION_DIRECTORY: _ignoredMigrationOverride,
			RELAYAPI_VERIFY_BASELINE_GENERATION: _ignoredGenerationOverride,
			...inheritedEnvironment
		} = process.env;
		const env = {
			...inheritedEnvironment,
			...(overrides
				? {
						RELAYAPI_VERIFY_MIGRATION_DIRECTORY: overrides.migrationDirectory,
						...(overrides.baselineGenerationPath
							? {
									RELAYAPI_VERIFY_BASELINE_GENERATION:
										overrides.baselineGenerationPath,
								}
							: {}),
					}
				: {}),
		};
		execFileSync(process.execPath, ["run", script], {
			cwd: packageDirectory,
			stdio: "inherit",
			env,
		});
	}
}

function runMigrationHistoryVerifiers(packageDirectory: string): void {
	runVerifierScripts(packageDirectory, [
		"scripts/verify-migration-history.ts",
		"scripts/verify-migration-policy.ts",
	]);
}

function runStaticVerifiers(
	packageDirectory: string,
	overrides?: {
		migrationDirectory: string;
		baselineGenerationPath: string;
	},
): void {
	runVerifierScripts(
		packageDirectory,
		[
			"scripts/verify-migration-history.ts",
			"scripts/verify-migration-policy.ts",
			"scripts/verify-schema-contracts.ts",
		],
		overrides,
	);
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

/**
 * Commit a collapsed migration directory, root generation metadata, and
 * transition evidence as one recoverable operation. Originals remain as
 * same-filesystem backups until every replacement passes verification.
 */
export function replaceGenerationWithRollback(input: {
	targetDirectory: string;
	replacementDirectory: string;
	generationPath: string;
	replacementGenerationPath: string;
	additionalFiles?: Array<{
		targetPath: string;
		replacementPath: string;
	}>;
	verify: () => void;
}): void {
	const directoryBackup = `${input.targetDirectory}.baseline-backup-${process.pid}`;
	const generationBackup = `${input.generationPath}.baseline-backup-${process.pid}`;
	const additionalFiles = input.additionalFiles ?? [];
	const targetPaths = additionalFiles.map(({ targetPath }) => targetPath);
	if (new Set(targetPaths).size !== targetPaths.length) {
		fail("generation-collapse evidence targets must be unique");
	}
	const additionalStates = additionalFiles.map((file) => ({
		...file,
		backupPath: `${file.targetPath}.baseline-backup-${process.pid}`,
		hadTarget: existsSync(file.targetPath),
		backedUp: false,
		installed: false,
	}));
	if (
		existsSync(directoryBackup) ||
		existsSync(generationBackup) ||
		additionalStates.some(({ backupPath }) => existsSync(backupPath))
	) {
		fail("stale generation-collapse backup exists");
	}

	let directoryBackedUp = false;
	let generationBackedUp = false;
	let directoryInstalled = false;
	let generationInstalled = false;
	try {
		renameSync(input.targetDirectory, directoryBackup);
		directoryBackedUp = true;
		renameSync(input.generationPath, generationBackup);
		generationBackedUp = true;
		for (const state of additionalStates) {
			if (state.hadTarget) {
				renameSync(state.targetPath, state.backupPath);
				state.backedUp = true;
			}
		}
		renameSync(input.replacementDirectory, input.targetDirectory);
		directoryInstalled = true;
		renameSync(input.replacementGenerationPath, input.generationPath);
		generationInstalled = true;
		for (const state of additionalStates) {
			renameSync(state.replacementPath, state.targetPath);
			state.installed = true;
		}
		input.verify();
	} catch (error) {
		const recoveryFailures: string[] = [];
		const installedTargets = [
			...(directoryInstalled ? [input.targetDirectory] : []),
			...(generationInstalled ? [input.generationPath] : []),
			...additionalStates
				.filter(({ installed }) => installed)
				.map(({ targetPath }) => targetPath),
		];
		for (const target of installedTargets) {
			if (!existsSync(target)) continue;
			try {
				rmSync(target, { recursive: true, force: true });
			} catch (recoveryError) {
				recoveryFailures.push(
					`could not remove ${target}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
		}
		const backedUpTargets = [
			...(directoryBackedUp
				? ([[directoryBackup, input.targetDirectory]] as const)
				: []),
			...(generationBackedUp
				? ([[generationBackup, input.generationPath]] as const)
				: []),
			...additionalStates
				.filter(({ backedUp }) => backedUp)
				.map(({ backupPath, targetPath }) => [backupPath, targetPath] as const),
		];
		for (const [backup, target] of backedUpTargets) {
			if (!existsSync(backup) || existsSync(target)) continue;
			try {
				renameSync(backup, target);
			} catch (recoveryError) {
				recoveryFailures.push(
					`could not restore ${target}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
		}
		if (recoveryFailures.length > 0) {
			throw new Error(
				`Generation collapse failed and recovery was incomplete: ${recoveryFailures.join("; ")}`,
				{ cause: error },
			);
		}
		throw error;
	}

	try {
		if (directoryBackedUp) {
			rmSync(directoryBackup, { recursive: true, force: true });
		}
		if (generationBackedUp) rmSync(generationBackup, { force: true });
		for (const state of additionalStates) {
			if (state.backedUp) rmSync(state.backupPath, { force: true });
		}
	} catch (error) {
		throw new Error(
			"Generation collapse was verified, but backup cleanup failed; keep the installed replacement and review the backup files manually.",
			{ cause: error },
		);
	}
}

function readGitFile(
	repositoryRoot: string,
	baseSha: string,
	path: string,
): string {
	try {
		return execFileSync(
			"git",
			["-C", repositoryRoot, "show", `${baseSha}:${path}`],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
	} catch (error) {
		throw new Error(
			`Could not read collapse anchor ${baseSha}:${path}; fetch the full base revision and use its full SHA`,
			{ cause: error },
		);
	}
}

type CollapseAnchor = {
	baseManifest: Manifest;
	baseManifestText: string;
	baseGeneration: BaselineGeneration;
	baseGenerationText: string;
	baseBuildPolicy: BaselineBuildPolicy;
	baseBuildPolicyText: string;
	baseOldChainCatalogText: string;
	currentGeneration: BaselineGeneration;
	currentGenerationText: string;
};

export function readCommittedOldChainCatalogEvidence(
	repositoryRoot: string,
	baseSha: string,
	readFromGit: (
		repositoryRoot: string,
		baseSha: string,
		path: string,
	) => string = readGitFile,
): string {
	return readFromGit(
		repositoryRoot,
		baseSha,
		`packages/db/${OLD_CHAIN_CATALOG_EVIDENCE_FILE}`,
	);
}

export function assertOldChainCatalogEvidenceMatchesAnchor(
	committedText: string,
	suppliedText: string,
): void {
	if (suppliedText !== committedText) {
		fail(
			`--old-chain-catalog is not byte-identical to ${OLD_CHAIN_CATALOG_EVIDENCE_FILE} at --base-sha`,
		);
	}
}

function readCollapseAnchor(
	packageDirectory: string,
	baseSha: string,
	buildPolicy: BaselineBuildPolicy,
): CollapseAnchor {
	const repositoryRoot = resolve(packageDirectory, "..", "..");
	const baseManifestText = readGitFile(
		repositoryRoot,
		baseSha,
		"packages/db/drizzle/migration-manifest.json",
	);
	const baseGenerationText = readGitFile(
		repositoryRoot,
		baseSha,
		"packages/db/baseline-generation.json",
	);
	const baseBuildPolicyText = readGitFile(
		repositoryRoot,
		baseSha,
		"packages/db/baseline-build-policy.json",
	);
	const baseOldChainCatalogText = readCommittedOldChainCatalogEvidence(
		repositoryRoot,
		baseSha,
	);
	const currentManifestText = readFileSync(
		join(packageDirectory, "drizzle", MANIFEST_FILE),
		"utf8",
	);
	const currentGenerationText = readFileSync(
		join(packageDirectory, GENERATION_FILE),
		"utf8",
	);
	const currentBuildPolicyText = readFileSync(
		join(packageDirectory, "baseline-build-policy.json"),
		"utf8",
	);
	if (currentManifestText !== baseManifestText) {
		fail(
			"the working migration chain is not byte-identical to --base-sha; anchor collapse to the exact source revision",
		);
	}
	if (currentGenerationText !== baseGenerationText) {
		fail("the working generation metadata is not byte-identical to --base-sha");
	}
	if (currentBuildPolicyText !== baseBuildPolicyText) {
		fail("the working build policy is not byte-identical to --base-sha");
	}
	const baseGeneration = parseJson<BaselineGeneration>(
		baseGenerationText,
		"base baseline-generation.json",
	);
	const currentGeneration = readBaselineGeneration(
		join(packageDirectory, GENERATION_FILE),
	);
	const baseBuildPolicy = parseJson<BaselineBuildPolicy>(
		baseBuildPolicyText,
		"base baseline-build-policy.json",
	);
	assertNoGenerationFailures(
		[
			...auditBaselineBuildPolicy(baseBuildPolicy),
			...auditBaselineGeneration(baseGeneration),
		],
		"Collapse base metadata is invalid",
	);
	if (
		currentGeneration.generation !==
			buildPolicy.authorizedCollapse.fromGeneration ||
		currentGeneration.lifecycle !== "sealed"
	) {
		fail(
			`collapse source must be sealed generation ${buildPolicy.authorizedCollapse.fromGeneration}`,
		);
	}
	return {
		baseManifest: parseJson<Manifest>(
			baseManifestText,
			"base migration manifest",
		),
		baseManifestText,
		baseGeneration,
		baseGenerationText,
		baseBuildPolicy,
		baseBuildPolicyText,
		baseOldChainCatalogText,
		currentGeneration,
		currentGenerationText,
	};
}

function parseCatalogFingerprint(
	source: string,
	label: string,
): CatalogFingerprint {
	const fingerprint = parseJson<CatalogFingerprint>(source, label);
	assertValidCatalogFingerprint(fingerprint, label);
	return fingerprint;
}

function attestCatalogTransition(input: {
	oldChainPath: string;
	candidatePath: string;
	reviewPath: string;
	auditDocumentText: string;
	baseManifestText: string;
	baseOldChainCatalogText: string;
	candidateManifestText: string;
	sourceGeneration: number;
	targetGeneration: number;
}): {
	oldChainCatalogSha256: string;
	candidateCatalogSha256: string;
	catalogDifferenceReviewSha256: string;
	candidateCatalogText: string;
	catalogDifferenceReviewText: string;
} {
	const suppliedOldChainCatalogText = readFileSync(
		resolve(input.oldChainPath),
		"utf8",
	);
	assertOldChainCatalogEvidenceMatchesAnchor(
		input.baseOldChainCatalogText,
		suppliedOldChainCatalogText,
	);
	const oldChain = parseCatalogFingerprint(
		input.baseOldChainCatalogText,
		"old-chain catalog fingerprint",
	);
	const candidateCatalogText = readFileSync(
		resolve(input.candidatePath),
		"utf8",
	);
	const candidate = parseJson<CatalogFingerprint>(
		candidateCatalogText,
		"candidate catalog fingerprint",
	);
	assertValidCatalogFingerprint(candidate, "candidate catalog fingerprint");
	const failures: string[] = [];
	if (oldChain.source !== "old-chain") {
		failures.push("old-chain catalog source is not old-chain");
	}
	if (candidate.source !== "candidate") {
		failures.push("candidate catalog source is not candidate");
	}
	if (oldChain.generation !== input.sourceGeneration) {
		failures.push("old-chain catalog generation does not match the source");
	}
	if (candidate.generation !== input.targetGeneration) {
		failures.push("candidate catalog generation does not match the target");
	}
	if (oldChain.migrationManifestSha256 !== sha256(input.baseManifestText)) {
		failures.push("old-chain catalog is not bound to the base manifest");
	}
	if (
		candidate.migrationManifestSha256 !== sha256(input.candidateManifestText)
	) {
		failures.push("candidate catalog is not bound to the generated manifest");
	}
	if (failures.length > 0) {
		fail(`catalog transition attestation failed: ${failures.join("; ")}`);
	}
	const reviewText = readFileSync(resolve(input.reviewPath), "utf8");
	const review = parseJson<CatalogDifferenceReview>(
		reviewText,
		"catalog difference review",
	);
	try {
		assertValidCatalogDifferenceReview(
			review,
			oldChain,
			candidate,
			input.auditDocumentText,
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	return {
		oldChainCatalogSha256: oldChain.catalogSha256,
		candidateCatalogSha256: candidate.catalogSha256,
		catalogDifferenceReviewSha256: sha256(reviewText),
		candidateCatalogText,
		catalogDifferenceReviewText: reviewText,
	};
}

/**
 * The first collapse dry run must emit the candidate manifest before a
 * candidate catalog and its reviewed difference file can exist. Static schema
 * verification still needs to select generation-2 contracts, so use
 * deterministic, non-exported building metadata for that one verification
 * pass. Final writes never use this metadata and still require the real catalog
 * attestation.
 */
export function provisionalCollapseGenerationForStaticVerification(input: {
	generation: BaselineGeneration;
	candidateManifestText: string;
}): BaselineGeneration {
	if (input.generation.transition.kind !== "collapse") {
		fail("provisional verification requires a collapse generation");
	}
	return {
		...input.generation,
		lifecycle: "building",
		transition: {
			...input.generation.transition,
			oldChainCatalogSha256: sha256Text(
				`relayapi:provisional-old-chain-catalog:${input.generation.transition.baseManifestSha256}`,
			),
			candidateCatalogSha256: sha256Text(
				`relayapi:provisional-candidate-catalog:${input.candidateManifestText}`,
			),
			catalogDifferenceReviewSha256: sha256Text(
				`relayapi:provisional-catalog-review:${input.generation.transition.baseCommitSha}`,
			),
		},
	};
}

function usage(): string {
	return [
		"Usage:",
		"  bun run baseline:rebuild:dry-run",
		"  bun run baseline:rebuild:check",
		`  bun run baseline:rebuild ${WRITE_CONFIRMATION_FLAG}`,
		`  bun run baseline:rebuild --pre-live-reset ${WRITE_CONFIRMATION_FLAG}`,
		"  bun run baseline:rebuild --collapse --dry-run --base-sha=<sha> [--candidate-output=/tmp/relayapi-gen2]",
		`  bun run baseline:rebuild --collapse --base-sha=<sha> --old-chain-catalog=<path> --candidate-catalog=<path> --catalog-difference-review=<path> ${COLLAPSE_CONFIRMATION_FLAG}`,
		"",
		"Virgin and explicitly requested pre-live reset writes require a pre-launch policy. Collapse writes require the one-use generation-1-to-2 authorization and an exact, decision-linked catalog difference review.",
	].join("\n");
}

function rebuildCollapsedGeneration(
	packageDirectory: string,
	options: BaselineCommandOptions,
	buildPolicy: BaselineBuildPolicy,
): void {
	assertCollapseWriteAllowed(buildPolicy, options);
	if (options.mode === "check") {
		fail(
			"--collapse --check is unsupported; use --collapse --dry-run before the one-time write and ordinary migration verifiers afterwards",
		);
	}
	if (!options.baseSha) {
		fail("generation collapse requires --base-sha=<full Git SHA>");
	}
	const targetDirectory = join(packageDirectory, "drizzle");
	const generationPath = join(packageDirectory, GENERATION_FILE);
	const sourcePolicy = parseJson<MigrationPolicy>(
		readFileSync(join(targetDirectory, MIGRATION_POLICY_FILE), "utf8"),
		MIGRATION_POLICY_FILE,
	);
	const targetIdentity = buildPolicy.authorizedCollapse.baseline;
	const baselineSummary =
		sourcePolicy.migrations[buildPolicy.baseline.tag]?.summary.trim() ??
		"RelayAPI PostgreSQL baseline";
	const collapsedPolicy: MigrationPolicy = {
		schemaVersion: 2,
		migrations: {
			[targetIdentity.tag]: {
				phase: "baseline",
				summary: `Generation 2 collapsed baseline: ${baselineSummary}`,
			},
		},
	};
	const artifactPolicy: BaselineBuildPolicy = {
		...buildPolicy,
		baseline: targetIdentity,
	};
	const releaseWriteLock =
		options.mode === "write"
			? acquireBaselineWriteLock(packageDirectory)
			: undefined;
	let temporaryRoot: string | undefined;

	try {
		if (options.mode === "write") {
			assertNoStaleBaselineReplacement(targetDirectory);
		}
		// The source generation is deliberately older than the final schema
		// during a sanctioned collapse. Verify it as coherent, protected
		// evidence here; hold the generated candidate to final-schema contracts
		// after it exists.
		runMigrationHistoryVerifiers(packageDirectory);
		const anchor = readCollapseAnchor(
			packageDirectory,
			options.baseSha,
			buildPolicy,
		);
		temporaryRoot = mkdtempSync(
			join(dirname(targetDirectory), ".drizzle-generation-collapse-"),
		);

		const buildArtifacts = (suffix: string): BaselineArtifactSet => {
			const generatedDirectory = join(
				temporaryRoot ?? fail("temporary build root is missing"),
				`generated-${suffix}`,
			);
			runDrizzleGenerate(packageDirectory, generatedDirectory);
			const generated = readGeneratedBaseline(generatedDirectory);
			return normalizeBaselineArtifacts({
				generatedSql: generated.sql,
				generatedJournal: generated.journal,
				generatedSnapshot: generated.snapshot,
				preambleSql: renderBaselinePreambleSql(),
				customSql: renderCustomMigrationSql(),
				buildPolicy: artifactPolicy,
				migrationPolicy: collapsedPolicy,
			});
		};
		const artifacts = buildArtifacts("first");
		const confirmationArtifacts = buildArtifacts("second");
		if (JSON.stringify(artifacts) !== JSON.stringify(confirmationArtifacts)) {
			fail(
				"two independent collapse builds were not byte-identical; generation is nondeterministic",
			);
		}

		const replacementDirectory = join(temporaryRoot, "replacement");
		writeArtifactSet(replacementDirectory, artifacts);
		assertBaselineDirectory(replacementDirectory, targetIdentity.tag, {
			requireCustomSql: true,
			requirePreamble: true,
			expectedFolderMillis: targetIdentity.folderMillis,
			requireDeterministicSnapshot: true,
		});
		const candidateManifestText =
			artifacts[MANIFEST_FILE] ?? fail("candidate manifest is missing");
		const candidateManifest = parseJson<Manifest>(
			candidateManifestText,
			"candidate migration manifest",
		);
		const catalogEvidencePaths = [
			options.oldChainCatalogPath,
			options.candidateCatalogPath,
			options.catalogDifferenceReviewPath,
		];
		const suppliedCatalogEvidenceCount =
			catalogEvidencePaths.filter(Boolean).length;
		if (
			suppliedCatalogEvidenceCount > 0 &&
			suppliedCatalogEvidenceCount < catalogEvidencePaths.length
		) {
			fail(
				"--old-chain-catalog, --candidate-catalog, and --catalog-difference-review must be supplied together",
			);
		}
		const hasCatalogAttestation =
			suppliedCatalogEvidenceCount === catalogEvidencePaths.length;
		const catalogAttestation =
			hasCatalogAttestation &&
			options.oldChainCatalogPath &&
			options.candidateCatalogPath &&
			options.catalogDifferenceReviewPath
				? attestCatalogTransition({
						oldChainPath: options.oldChainCatalogPath,
						candidatePath: options.candidateCatalogPath,
						reviewPath: options.catalogDifferenceReviewPath,
						auditDocumentText: readFileSync(
							join(
								packageDirectory,
								"..",
								"..",
								"docs",
								"SCHEMA_OPTIMALITY_AUDIT_PRE_FREEZE_2026-07-27.md",
							),
							"utf8",
						),
						baseManifestText: anchor.baseManifestText,
						baseOldChainCatalogText: anchor.baseOldChainCatalogText,
						candidateManifestText,
						sourceGeneration: anchor.baseGeneration.generation,
						targetGeneration: buildPolicy.authorizedCollapse.toGeneration,
					})
				: {
						oldChainCatalogSha256: "0".repeat(64),
						candidateCatalogSha256: "0".repeat(64),
						catalogDifferenceReviewSha256: "0".repeat(64),
						candidateCatalogText: "",
						catalogDifferenceReviewText: "",
					};
		const {
			candidateCatalogText,
			catalogDifferenceReviewText,
			...catalogTransitionHashes
		} = catalogAttestation;

		const collapsedGeneration: BaselineGeneration = {
			schemaVersion: 1,
			generation: buildPolicy.authorizedCollapse.toGeneration,
			lifecycle: "sealed",
			baseline: targetIdentity,
			transition: {
				kind: "collapse",
				fromGeneration: buildPolicy.authorizedCollapse.fromGeneration,
				baseCommitSha: options.baseSha,
				baseManifestSha256: sha256Text(anchor.baseManifestText),
				baseGenerationSha256: sha256Text(anchor.baseGenerationText),
				baseBuildPolicySha256: sha256Text(anchor.baseBuildPolicyText),
				candidateManifestSha256: sha256(candidateManifestText),
				...catalogTransitionHashes,
			},
		};
		if (catalogTransitionHashes.oldChainCatalogSha256 !== "0".repeat(64)) {
			assertNoGenerationFailures(
				auditGenerationTransition({
					baseSha: options.baseSha,
					baseGeneration: anchor.baseGeneration,
					currentGeneration: collapsedGeneration,
					baseGenerationText: anchor.baseGenerationText,
					currentGenerationText: serializeJson(collapsedGeneration),
					baseBuildPolicy: anchor.baseBuildPolicy,
					currentBuildPolicy: buildPolicy,
					baseBuildPolicyText: anchor.baseBuildPolicyText,
					currentBuildPolicyText: readFileSync(
						join(packageDirectory, "baseline-build-policy.json"),
						"utf8",
					),
					baseOldChainCatalogText: anchor.baseOldChainCatalogText,
					baseManifest: anchor.baseManifest as GenerationManifest,
					currentManifest: candidateManifest as GenerationManifest,
					baseManifestText: anchor.baseManifestText,
					currentManifestText: candidateManifestText,
				}),
				"Generated collapse violates the generation contract",
			);
		}
		const candidateGenerationPath = join(
			temporaryRoot,
			"candidate-baseline-generation.json",
		);
		const verificationGeneration = hasCatalogAttestation
			? collapsedGeneration
			: provisionalCollapseGenerationForStaticVerification({
					generation: collapsedGeneration,
					candidateManifestText,
				});
		writeFileSync(
			candidateGenerationPath,
			serializeJson(verificationGeneration),
			{
				encoding: "utf8",
				mode: 0o644,
			},
		);
		runStaticVerifiers(packageDirectory, {
			migrationDirectory: replacementDirectory,
			baselineGenerationPath: candidateGenerationPath,
		});

		if (options.mode === "dry-run") {
			if (options.candidateOutputPath) {
				const candidateOutput = resolve(options.candidateOutputPath);
				if (existsSync(candidateOutput)) {
					fail(
						`candidate output already exists; refusing to overwrite ${candidateOutput}`,
					);
				}
				const candidateStaging = `${candidateOutput}.candidate-${process.pid}`;
				if (existsSync(candidateStaging)) {
					fail(`stale candidate output staging path: ${candidateStaging}`);
				}
				try {
					writeArtifactSet(join(candidateStaging, "drizzle"), artifacts);
					writeFileSync(
						join(candidateStaging, GENERATION_FILE),
						serializeJson(verificationGeneration),
						{ encoding: "utf8", mode: 0o644 },
					);
					renameSync(candidateStaging, candidateOutput);
				} catch (error) {
					rmSync(candidateStaging, { recursive: true, force: true });
					throw error;
				}
			}
			const catalogStatus =
				catalogTransitionHashes.oldChainCatalogSha256 === "0".repeat(64)
					? "catalog review not supplied"
					: `catalog transition ${catalogTransitionHashes.oldChainCatalogSha256} -> ${catalogTransitionHashes.candidateCatalogSha256} reviewed`;
			console.log(
				`Generation-2 collapse dry run is deterministic (${catalogStatus}; candidate manifest sha256 ${sha256(candidateManifestText)}${options.candidateOutputPath ? `; emitted ${resolve(options.candidateOutputPath)}` : ""}).`,
			);
			return;
		}

		if (!candidateCatalogText || !catalogDifferenceReviewText) {
			fail(
				"collapse write requires committed candidate-catalog and catalog-review evidence",
			);
		}
		const replacementGenerationPath = join(temporaryRoot, GENERATION_FILE);
		const replacementBoundaryManifestPath = join(
			temporaryRoot,
			COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
		);
		const replacementCandidateCatalogPath = join(
			temporaryRoot,
			CANDIDATE_CATALOG_EVIDENCE_FILE,
		);
		const replacementCatalogReviewPath = join(
			temporaryRoot,
			CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE,
		);
		writeFileSync(
			replacementGenerationPath,
			serializeJson(collapsedGeneration),
			{ encoding: "utf8", mode: 0o644 },
		);
		writeFileSync(replacementBoundaryManifestPath, candidateManifestText, {
			encoding: "utf8",
			mode: 0o644,
		});
		writeFileSync(replacementCandidateCatalogPath, candidateCatalogText, {
			encoding: "utf8",
			mode: 0o644,
		});
		writeFileSync(replacementCatalogReviewPath, catalogDifferenceReviewText, {
			encoding: "utf8",
			mode: 0o644,
		});
		replaceGenerationWithRollback({
			targetDirectory,
			replacementDirectory,
			generationPath,
			replacementGenerationPath,
			additionalFiles: [
				{
					targetPath: join(
						packageDirectory,
						COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
					),
					replacementPath: replacementBoundaryManifestPath,
				},
				{
					targetPath: join(packageDirectory, CANDIDATE_CATALOG_EVIDENCE_FILE),
					replacementPath: replacementCandidateCatalogPath,
				},
				{
					targetPath: join(
						packageDirectory,
						CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE,
					),
					replacementPath: replacementCatalogReviewPath,
				},
			],
			verify: () => {
				assertBaselineDirectory(targetDirectory, targetIdentity.tag, {
					requireCustomSql: true,
					requirePreamble: true,
					expectedFolderMillis: targetIdentity.folderMillis,
					requireDeterministicSnapshot: true,
				});
				const installedGeneration = readBaselineGeneration(generationPath);
				if (
					serializeJson(installedGeneration) !==
					serializeJson(collapsedGeneration)
				) {
					fail("installed generation metadata differs from the candidate");
				}
				runStaticVerifiers(packageDirectory);
				execFileSync(
					process.execPath,
					["run", "scripts/verify-baseline-sealed.ts"],
					{ cwd: packageDirectory, stdio: "inherit" },
				);
			},
		});
		console.log(
			`Collapsed migration history into sealed generation 2 (${targetIdentity.tag}; reviewed catalog ${catalogTransitionHashes.oldChainCatalogSha256} -> ${catalogTransitionHashes.candidateCatalogSha256}).`,
		);
	} finally {
		if (temporaryRoot && existsSync(temporaryRoot)) {
			rmSync(temporaryRoot, { recursive: true, force: true });
		}
		releaseWriteLock?.();
	}
}

export function rebuildBaseline(
	packageDirectory: string,
	options: BaselineCommandOptions,
): void {
	const buildPolicy = readBaselineBuildPolicy(
		join(packageDirectory, "baseline-build-policy.json"),
	);
	if (options.operation === "collapse") {
		rebuildCollapsedGeneration(packageDirectory, options, buildPolicy);
		return;
	}
	const targetDirectory = join(packageDirectory, "drizzle");
	const { tag, folderMillis } = buildPolicy.baseline;
	assertBaselineWriteAllowed(buildPolicy, options);
	if (options.operation === "pre-live-reset" && options.mode === "check") {
		fail(
			"--pre-live-reset --check is unsupported; use --pre-live-reset --dry-run before the one-time write and ordinary --check afterwards",
		);
	}
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
		if (options.operation === "virgin") {
			assertBaselineDirectory(targetDirectory, tag);
		} else {
			assertDirectory(targetDirectory, "migration directory");
		}
		const sourceMigrationPolicy = parseJson<MigrationPolicy>(
			readFileSync(join(targetDirectory, MIGRATION_POLICY_FILE), "utf8"),
			MIGRATION_POLICY_FILE,
		);
		const migrationPolicy: MigrationPolicy =
			options.operation === "pre-live-reset"
				? {
						schemaVersion: 2,
						migrations: {
							[tag]: {
								phase: "baseline",
								summary:
									sourceMigrationPolicy.migrations[tag]?.summary.trim() ||
									"Pre-live virgin PostgreSQL baseline",
							},
						},
					}
				: sourceMigrationPolicy;
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
		if (options.operation === "pre-live-reset") {
			runStaticVerifiers(packageDirectory, {
				migrationDirectory: replacementDirectory,
				baselineGenerationPath: join(packageDirectory, GENERATION_FILE),
			});
		}

		const changed = changedArtifactPaths(targetDirectory, artifacts);
		const summary =
			changed.length === 0
				? "no artifact changes"
				: `would replace ${changed.join(", ")}`;
		if (options.mode === "dry-run") {
			console.log(
				`${options.operation === "pre-live-reset" ? "Pre-live baseline reset" : "Virgin baseline"} dry run complete (${summary}; sha256 ${sha256(artifacts[`${tag}.sql`] ?? "")}).`,
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
			`${options.operation === "pre-live-reset" ? "Reset migration history and rebuilt" : "Rebuilt"} ${tag} from schema.ts (${changed.join(", ")}; sha256 ${sha256(artifacts[`${tag}.sql`] ?? "")}).`,
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
