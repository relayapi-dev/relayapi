/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireBaselineWriteLock,
	assertBaselineDirectory,
	assertBaselineWriteAllowed,
	assertNoStaleBaselineReplacement,
	type BaselineArtifactSet,
	type BaselineBuildPolicy,
	changedArtifactPaths,
	normalizeBaselineArtifacts,
	parseBaselineCommandOptions,
	readBaselineBuildPolicy,
	replaceDirectoryWithRollback,
	writeArtifactSet,
} from "./rebuild-baseline";
import {
	BASELINE_PREAMBLE_MARKER,
	renderBaselinePreambleSql,
} from "./render-baseline-preamble-sql";
import { CUSTOM_MIGRATION_SQL_MARKER } from "./render-custom-migration-sql";

const buildPolicy: BaselineBuildPolicy = {
	schemaVersion: 1,
	lifecycle: "pre-launch",
	baseline: {
		tag: "0000_baseline",
		folderMillis: 1_783_987_200_000,
	},
};

function journal(when: number, tag = "0000_generated") {
	return {
		version: "7",
		dialect: "postgresql",
		entries: [
			{
				idx: 0,
				version: "7",
				when,
				tag,
				breakpoints: true,
			},
		],
	};
}

function snapshot(id: string) {
	return {
		id,
		prevId: "00000000-0000-0000-0000-000000000000",
		version: "7",
		dialect: "postgresql",
		tables: {
			"public.example": {
				name: "example",
				schema: "",
				columns: {},
			},
		},
		enums: {},
		_meta: { columns: {}, schemas: {}, tables: {} },
	};
}

function migrationPolicy() {
	return {
		schemaVersion: 1 as const,
		migrations: {
			"0000_baseline": {
				phase: "baseline" as const,
				summary: "Pre-launch virgin PostgreSQL 18 baseline",
			},
		},
	};
}

function normalizedArtifacts(
	randomSnapshotId = "11111111-1111-4111-8111-111111111111",
	randomWhen = 123,
): BaselineArtifactSet {
	return normalizeBaselineArtifacts({
		generatedSql: "CREATE TABLE example (id text PRIMARY KEY);\n",
		generatedJournal: journal(randomWhen),
		generatedSnapshot: snapshot(randomSnapshotId),
		preambleSql: renderBaselinePreambleSql(),
		customSql: `--> statement-breakpoint\n${CUSTOM_MIGRATION_SQL_MARKER}\nSELECT 1;\n`,
		buildPolicy,
		migrationPolicy: migrationPolicy(),
	});
}

function withTemporaryDirectory(run: (directory: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "relayapi-baseline-test-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("virgin baseline artifact normalization", () => {
	test("normalizes random Drizzle metadata into byte-identical artifacts", () => {
		const first = normalizedArtifacts(
			"11111111-1111-4111-8111-111111111111",
			123,
		);
		const second = normalizedArtifacts(
			"22222222-2222-4222-8222-222222222222",
			999,
		);

		expect(second).toEqual(first);
		const baselineSql = first["0000_baseline.sql"] ?? "";
		expect(baselineSql.split(CUSTOM_MIGRATION_SQL_MARKER).length - 1).toBe(1);
		expect(baselineSql.startsWith(renderBaselinePreambleSql())).toBe(true);
		expect(baselineSql.split(BASELINE_PREAMBLE_MARKER).length - 1).toBe(1);
		expect(
			baselineSql.split('CREATE SCHEMA IF NOT EXISTS "auth";').length - 1,
		).toBe(1);
		expect(
			baselineSql.split(
				'CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";',
			).length - 1,
		).toBe(1);

		const manifest = JSON.parse(first["migration-manifest.json"] ?? "{}") as {
			schemaVersion: number;
			migrations: Array<{
				folderMillis: number;
				sha256: string;
				snapshotSha256: string;
			}>;
		};
		expect(manifest.schemaVersion).toBe(2);
		expect(manifest.migrations[0]?.folderMillis).toBe(
			buildPolicy.baseline.folderMillis,
		);
		expect(manifest.migrations[0]?.sha256).toBe(
			createHash("sha256").update(baselineSql).digest("hex"),
		);
		expect(manifest.migrations[0]?.snapshotSha256).toBe(
			createHash("sha256")
				.update(first["meta/0000_snapshot.json"] ?? "")
				.digest("hex"),
		);

		const normalizedSnapshot = JSON.parse(
			first["meta/0000_snapshot.json"] ?? "{}",
		) as { id: string };
		expect(normalizedSnapshot.id).not.toBe(
			"11111111-1111-4111-8111-111111111111",
		);
	});

	test("writes a self-consistent baseline that the strict validator accepts", () => {
		withTemporaryDirectory((root) => {
			const directory = join(root, "drizzle");
			const artifacts = normalizedArtifacts();
			writeArtifactSet(directory, artifacts);

			expect(() =>
				assertBaselineDirectory(directory, "0000_baseline", {
					requireCustomSql: true,
					requirePreamble: true,
					expectedFolderMillis: buildPolicy.baseline.folderMillis,
					requireDeterministicSnapshot: true,
				}),
			).not.toThrow();
			expect(changedArtifactPaths(directory, artifacts)).toEqual([]);
		});
	});

	test("accepts a coherent old baseline with no custom block as rebuild input", () => {
		withTemporaryDirectory((root) => {
			const directory = join(root, "drizzle");
			const artifacts = normalizedArtifacts();
			const sql = `${renderBaselinePreambleSql()}CREATE TABLE example (id text PRIMARY KEY);\n`;
			const manifest = JSON.parse(
				artifacts["migration-manifest.json"] ?? "{}",
			) as {
				migrations: Array<{ sha256: string }>;
			};
			if (!manifest.migrations[0]) throw new Error("fixture manifest missing");
			manifest.migrations[0].sha256 = createHash("sha256")
				.update(sql)
				.digest("hex");
			artifacts["0000_baseline.sql"] = sql;
			artifacts["migration-manifest.json"] =
				`${JSON.stringify(manifest, null, 2)}\n`;
			writeArtifactSet(directory, artifacts);

			expect(() =>
				assertBaselineDirectory(directory, "0000_baseline"),
			).not.toThrow();
		});
	});

	test("rejects duplicate custom SQL and unexpected migration history", () => {
		withTemporaryDirectory((root) => {
			const duplicateDirectory = join(root, "duplicate");
			const duplicate = normalizedArtifacts();
			duplicate["0000_baseline.sql"] =
				`${duplicate["0000_baseline.sql"]}${CUSTOM_MIGRATION_SQL_MARKER}\n`;
			writeArtifactSet(duplicateDirectory, duplicate);
			expect(() =>
				assertBaselineDirectory(duplicateDirectory, "0000_baseline"),
			).toThrow("at most one generated custom-SQL block");

			const historyDirectory = join(root, "history");
			writeArtifactSet(historyDirectory, normalizedArtifacts());
			writeFileSync(join(historyDirectory, "0001_expand.sql"), "SELECT 1;\n");
			expect(() =>
				assertBaselineDirectory(historyDirectory, "0000_baseline"),
			).toThrow("unexpected history or files");
		});
	});

	test("rejects a non-baseline migration policy", () => {
		withTemporaryDirectory((root) => {
			const directory = join(root, "drizzle");
			writeArtifactSet(directory, normalizedArtifacts());
			const policyPath = join(directory, "migration-policy.json");
			const policy = JSON.parse(readFileSync(policyPath, "utf8")) as {
				migrations: Record<string, { phase: string }>;
			};
			const baseline = policy.migrations["0000_baseline"];
			if (!baseline) throw new Error("fixture policy missing");
			baseline.phase = "expand";
			writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);

			expect(() => assertBaselineDirectory(directory, "0000_baseline")).toThrow(
				"reviewed baseline policy entry",
			);
		});
	});
});

describe("virgin baseline command safety", () => {
	test("rejects a sealed policy that omits the baseline identity", () => {
		withTemporaryDirectory((root) => {
			const policyPath = join(root, "baseline-build-policy.json");
			writeFileSync(
				policyPath,
				JSON.stringify({ schemaVersion: 1, lifecycle: "sealed" }),
			);
			expect(() => readBaselineBuildPolicy(policyPath)).toThrow(
				"only supported virgin baseline tag",
			);
		});
	});

	test("requires explicit write confirmation and separates read-only modes", () => {
		expect(parseBaselineCommandOptions([])).toEqual({
			mode: "write",
			confirmed: false,
			help: false,
		});
		expect(
			parseBaselineCommandOptions(["--confirm-pre-launch-virgin-reset"]),
		).toEqual({ mode: "write", confirmed: true, help: false });
		expect(parseBaselineCommandOptions(["--dry-run"]).mode).toBe("dry-run");
		expect(parseBaselineCommandOptions(["--check"]).mode).toBe("check");
		expect(() => parseBaselineCommandOptions(["--dry-run", "--check"])).toThrow(
			"mutually exclusive",
		);
		expect(() => parseBaselineCommandOptions(["--force"])).toThrow(
			"unknown argument",
		);
		expect(() =>
			assertBaselineWriteAllowed(buildPolicy, parseBaselineCommandOptions([])),
		).toThrow("requires --confirm-pre-launch-virgin-reset");
		expect(() =>
			assertBaselineWriteAllowed(
				{ ...buildPolicy, lifecycle: "sealed" },
				parseBaselineCommandOptions(["--confirm-pre-launch-virgin-reset"]),
			),
		).toThrow("migration history is append-only");
		expect(() =>
			assertBaselineWriteAllowed(
				{ ...buildPolicy, lifecycle: "sealed" },
				parseBaselineCommandOptions(["--check"]),
			),
		).not.toThrow();
	});

	test("serializes writers and refuses an unreviewed crash backup", () => {
		withTemporaryDirectory((root) => {
			const release = acquireBaselineWriteLock(root);
			try {
				expect(() => acquireBaselineWriteLock(root)).toThrow(
					"another rebuild may be running",
				);
			} finally {
				release();
			}

			const target = join(root, "drizzle");
			writeFileSync(
				join(root, "drizzle.baseline-backup-crash-marker"),
				"review me",
			);
			expect(() => assertNoStaleBaselineReplacement(target)).toThrow(
				"stale baseline backup",
			);
		});
	});

	test("commits a verified replacement and removes its recovery backup", () => {
		withTemporaryDirectory((root) => {
			const target = join(root, "drizzle");
			const replacement = join(root, "replacement");
			mkdirSync(target);
			mkdirSync(replacement);
			writeFileSync(join(target, "value"), "old");
			writeFileSync(join(replacement, "value"), "new");

			replaceDirectoryWithRollback(target, replacement, () => {
				expect(readFileSync(join(target, "value"), "utf8")).toBe("new");
			});

			expect(readFileSync(join(target, "value"), "utf8")).toBe("new");
			expect(existsSync(`${target}.baseline-backup-${process.pid}`)).toBe(
				false,
			);
		});
	});

	test("restores the original directory when replacement verification fails", () => {
		withTemporaryDirectory((root) => {
			const target = join(root, "drizzle");
			const replacement = join(root, "replacement");
			mkdirSync(target);
			mkdirSync(replacement);
			writeFileSync(join(target, "value"), "old");
			writeFileSync(join(replacement, "value"), "new");

			expect(() =>
				replaceDirectoryWithRollback(target, replacement, () => {
					throw new Error("verification failed");
				}),
			).toThrow("verification failed");
			expect(readFileSync(join(target, "value"), "utf8")).toBe("old");
			expect(existsSync(`${target}.baseline-backup-${process.pid}`)).toBe(
				false,
			);
		});
	});

	test("refuses a custom renderer that would append the block twice", () => {
		expect(() =>
			normalizeBaselineArtifacts({
				generatedSql: "SELECT 1;\n",
				generatedJournal: journal(123),
				generatedSnapshot: snapshot("11111111-1111-4111-8111-111111111111"),
				preambleSql: renderBaselinePreambleSql(),
				customSql: `--> statement-breakpoint\n${CUSTOM_MIGRATION_SQL_MARKER}\n${CUSTOM_MIGRATION_SQL_MARKER}\n`,
				buildPolicy,
				migrationPolicy: migrationPolicy(),
			}),
		).toThrow("exactly one generated marker");
	});

	test("refuses to duplicate a preamble that Drizzle starts generating", () => {
		expect(() =>
			normalizeBaselineArtifacts({
				generatedSql:
					'CREATE SCHEMA IF NOT EXISTS "auth";\nCREATE TABLE example (id text PRIMARY KEY);\n',
				generatedJournal: journal(123),
				generatedSnapshot: snapshot("11111111-1111-4111-8111-111111111111"),
				preambleSql: renderBaselinePreambleSql(),
				customSql: `--> statement-breakpoint\n${CUSTOM_MIGRATION_SQL_MARKER}\nSELECT 1;\n`,
				buildPolicy,
				migrationPolicy: migrationPolicy(),
			}),
		).toThrow("Drizzle-generated SQL already creates required schema auth");
	});

	test("refuses semantically equivalent prerequisite DDL variants", () => {
		for (const generatedSql of [
			"create schema auth;\nSELECT 1;\n",
			"CREATE   SCHEMA IF NOT EXISTS auth ;\nSELECT 1;\n",
			"create extension pg_trgm with schema public;\nSELECT 1;\n",
		]) {
			expect(() =>
				normalizeBaselineArtifacts({
					generatedSql,
					generatedJournal: journal(123),
					generatedSnapshot: snapshot("11111111-1111-4111-8111-111111111111"),
					preambleSql: renderBaselinePreambleSql(),
					customSql: `--> statement-breakpoint\n${CUSTOM_MIGRATION_SQL_MARKER}\nSELECT 1;\n`,
					buildPolicy,
					migrationPolicy: migrationPolicy(),
				}),
			).toThrow("Drizzle-generated SQL already creates required");
		}
	});
});
