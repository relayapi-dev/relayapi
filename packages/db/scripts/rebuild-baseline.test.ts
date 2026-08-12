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
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSION_VERSIONS,
	REQUIRED_DATABASE_EXTENSIONS,
} from "../src/database-prerequisites";
import {
	auditBaselineGeneration,
	type BaselineGeneration,
	COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
} from "./baseline-generation-contract";
import {
	CANDIDATE_CATALOG_EVIDENCE_FILE,
	CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE,
} from "./catalog-fingerprint-contract";
import {
	DATABASE_EXTENSION_LIFECYCLE_EVENTS,
	type DatabaseExtensionLifecycleEvent,
} from "./database-extension-lifecycle";
import {
	acquireBaselineWriteLock,
	assertBaselineDirectory,
	assertBaselineWriteAllowed,
	assertCollapseWriteAllowed,
	assertNoStaleBaselineReplacement,
	type BaselineArtifactSet,
	type BaselineBuildPolicy,
	changedArtifactPaths,
	normalizeBaselineArtifacts,
	parseBaselineCommandOptions,
	provisionalCollapseGenerationForStaticVerification,
	readBaselineBuildPolicy,
	replaceDirectoryWithRollback,
	replaceGenerationWithRollback,
	writeArtifactSet,
} from "./rebuild-baseline";
import {
	auditDatabaseExtensionLifecycle,
	auditDatabasePrerequisiteRegistries,
	BASELINE_PREAMBLE_MARKER,
	renderBaselinePreambleSql,
} from "./render-baseline-preamble-sql";
import { CUSTOM_MIGRATION_SQL_MARKER } from "./render-custom-migration-sql";

const buildPolicy: BaselineBuildPolicy = {
	schemaVersion: 2,
	lifecycle: "pre-launch",
	generation: 1,
	baseline: {
		tag: "0000_baseline",
		folderMillis: 1_783_987_200_000,
	},
	authorizedCollapse: {
		fromGeneration: 1,
		toGeneration: 2,
		baseline: {
			tag: "0000_baseline",
			folderMillis: 1_785_196_800_000,
		},
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
		schemaVersion: 2 as const,
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
	test("keeps the frozen collapse preamble independent from future active requirements", () => {
		const before = renderBaselinePreambleSql();
		expect(
			auditDatabasePrerequisiteRegistries({
				activeSchemas: ["future_schema"],
				activeExtensions: ["pg_trgm"],
				activeExtensionSchemas: { pg_trgm: "future_schema" },
				activeExtensionVersions: { pg_trgm: undefined },
			}),
		).toEqual([]);
		expect(
			auditDatabasePrerequisiteRegistries({
				activeSchemas: [],
				activeExtensions: [],
				activeExtensionSchemas: {},
				activeExtensionVersions: {},
			}),
		).toEqual([]);
		expect(renderBaselinePreambleSql()).toBe(before);
		expect(before).not.toContain("future_schema");
		expect(before).not.toContain("hstore");
	});

	test("owns extension creation and updates in journal/object order without quoted-example false positives", () => {
		const baselineMigrations = {
			"0000_baseline": renderBaselinePreambleSql(),
		};
		expect(auditDatabaseExtensionLifecycle(baselineMigrations)).toEqual([]);
		expect(
			auditDatabaseExtensionLifecycle({
				"0000_baseline": renderBaselinePreambleSql(),
			}),
		).toEqual([]);

		const hstoreMigrations = {
			...baselineMigrations,
			"0001_hstore":
				'CREATE /* nested /* comment */ still comment */ EXTENSION IF NOT EXISTS "hstore" WITH SCHEMA "public" VERSION \'1.8\';',
		};
		const hstoreLifecycle = [
			...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
			{
				operation: "create",
				extension: "hstore",
				migration: "0001_hstore",
				schema: "public",
				version: "1.8",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		const hstoreRegistry = {
			activeSchemas: ["auth"],
			activeExtensions: [...REQUIRED_DATABASE_EXTENSIONS, "hstore"],
			activeExtensionSchemas: {
				...REQUIRED_DATABASE_EXTENSION_SCHEMAS,
				hstore: "public",
			},
			activeExtensionVersions: {
				...REQUIRED_DATABASE_EXTENSION_VERSIONS,
				hstore: "1.8",
			},
			installabilityProbes: {
				...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
				hstore: {
					versionEpochs: [
						{
							schema: "public",
							createVersion: "1.8",
							updateTargets: [],
							dropAfter: false,
						},
					],
				},
			},
			lifecycleEvents: hstoreLifecycle,
		} as const;
		expect(
			auditDatabaseExtensionLifecycle(hstoreMigrations, hstoreRegistry),
		).toEqual([]);
		expect(
			auditDatabaseExtensionLifecycle(
				{
					...hstoreMigrations,
					"0001_hstore":
						"CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public;",
				},
				{
					...hstoreRegistry,
					activeExtensionVersions: {
						...REQUIRED_DATABASE_EXTENSION_VERSIONS,
						hstore: undefined,
					},
					installabilityProbes: {
						...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
						hstore: {
							versionEpochs: [
								{ schema: "public", updateTargets: [], dropAfter: false },
							],
						},
					},
					lifecycleEvents: [
						...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
						{
							operation: "create",
							extension: "hstore",
							migration: "0001_hstore",
							schema: "public",
						},
					],
				},
			),
		).toContain(
			"database extension lifecycle CREATE hstore outside 0000_baseline must pin an exact version",
		);
		expect(
			auditDatabaseExtensionLifecycle(
				{
					...hstoreMigrations,
					"0001_hstore":
						"CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA public VERSION '1.8' CASCADE;",
				},
				hstoreRegistry,
			),
		).toContain(
			"migration 0001_hstore CREATE EXTENSION hstore uses unmodelled CASCADE dependency installation",
		);
		expect(
			auditDatabaseExtensionLifecycle(hstoreMigrations).some((failure) =>
				failure.includes("SQL 0001_hstore:create:hstore"),
			),
		).toBe(true);

		expect(
			auditDatabaseExtensionLifecycle({
				...baselineMigrations,
				"0001_quoted_example": `
					SELECT 'CREATE /* not a comment */ EXTENSION imaginary';
					SELECT E'CREATE EXTENSION imaginary_e';
					SELECT $$CREATE EXTENSION imaginary_dollar$$;
				`,
			}),
		).toEqual([]);
		for (const proceduralSql of [
			"DO $$ BEGIN EXECUTE 'CREATE EXTENSION hstore'; END $$;",
			"DO $$ BEGIN EXECUTE 'CREATE ' || 'EXTENSION hstore'; END $$;",
			"DO 'BEGIN EXECUTE ''CREATE '' || ''EXTENSION hstore''; END';",
			String.raw`DO E'BEGIN EXECUTE \'CREATE \' || \'EXTENSION hstore\'; END';`,
			"CREATE FUNCTION extension_guard_test() RETURNS void AS 'BEGIN EXECUTE ''DROP EXTENSION vector''; END' LANGUAGE plpgsql;",
			String.raw`DO E'BEGIN EXECUTE \'CREATE\\x20EXTENSION hstore\'; END;';`,
			String.raw`DO E'BEGIN EXECUTE \'CREATE\x20EXTENSION hstore\'; END;';`,
			String.raw`DO E'BEGIN EXECUTE \'CREATE\040EXTENSION hstore\'; END;';`,
			String.raw`DO E'BEGIN EXECUTE \'CREATE\u0020EXTENSION hstore\'; END;';`,
			String.raw`DO E'BEGIN EXECUTE \'CREATE\U00000020EXTENSION hstore\'; END;';`,
			String.raw`DO E'BEGIN EXECUTE \'CREATE\tEXTENSION hstore\'; END;';`,
			String.raw`DO U&'BEGIN EXECUTE ''CREATE\0020EXTENSION hstore''; END;';`,
			String.raw`DO U&'BEGIN EXECUTE ''CREATE\+000020EXTENSION hstore''; END;';`,
			"DO U&'BEGIN EXECUTE ''CREATE!0020EXTENSION hstore''; END;' UESCAPE '!';",
			"DO $$ DECLARE op text := 'CREATE '; BEGIN EXECUTE op || 'EXTENSION hstore'; END; $$;",
		]) {
			expect(
				auditDatabaseExtensionLifecycle({
					...baselineMigrations,
					"0001_dynamic": proceduralSql,
				}).some((failure) => failure.includes("EXTENSION in procedural body")),
				proceduralSql,
			).toBe(true);
		}
		expect(
			auditDatabaseExtensionLifecycle({
				...baselineMigrations,
				"0001_non_extension_dynamic":
					"DO $$ DECLARE op text := 'SELECT '; BEGIN EXECUTE op || '1'; END; $$;",
			}),
		).toEqual([]);

		const updateMigrations = {
			...baselineMigrations,
			"0001_vector_update": "ALTER EXTENSION vector UPDATE TO '0.8.0';",
		};
		const updateLifecycle = [
			...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
			{
				operation: "update",
				extension: "vector",
				migration: "0001_vector_update",
				version: "0.8.0",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		const updateInstallabilityProbes = {
			...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
			vector: {
				versionEpochs: [
					{
						schema: "public",
						updateTargets: ["0.8.0"],
						dropAfter: false,
					},
				],
			},
		} as const;
		expect(
			auditDatabaseExtensionLifecycle(updateMigrations, {
				activeExtensionVersions: {
					...REQUIRED_DATABASE_EXTENSION_VERSIONS,
					vector: "0.8.0",
				},
				installabilityProbes: updateInstallabilityProbes,
				lifecycleEvents: updateLifecycle,
			}),
		).toEqual([]);
		expect(
			auditDatabaseExtensionLifecycle(updateMigrations, {
				activeExtensionVersions: {
					...REQUIRED_DATABASE_EXTENSION_VERSIONS,
					vector: "0.8.0",
				},
				lifecycleEvents: updateLifecycle,
			}),
		).toContain(
			"database extension vector installability epochs [schema=public;create=<provider-default>;updates=<none>;drop=false] do not exactly match lifecycle epochs [schema=public;create=<provider-default>;updates=0.8.0;drop=false]",
		);
		expect(
			auditDatabaseExtensionLifecycle(updateMigrations, {
				activeExtensionVersions: {
					...REQUIRED_DATABASE_EXTENSION_VERSIONS,
					vector: "0.7.0",
				},
				installabilityProbes: updateInstallabilityProbes,
				lifecycleEvents: updateLifecycle,
			}),
		).toContain(
			"database extension lifecycle leaves vector at version 0.8.0 instead of active version 0.7.0",
		);
		expect(
			auditDatabaseExtensionLifecycle(updateMigrations, {
				lifecycleEvents: [
					...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
					{
						operation: "update",
						extension: "vector",
						migration: "0001_vector_update",
						version: "0.7.0",
					},
				],
				activeExtensionVersions: {
					...REQUIRED_DATABASE_EXTENSION_VERSIONS,
					vector: "0.7.0",
				},
				installabilityProbes: {
					...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
					vector: {
						versionEpochs: [
							{
								schema: "public",
								updateTargets: ["0.7.0"],
								dropAfter: false,
							},
						],
					},
				},
			}).some((failure) => failure.includes("version=0.7.0")),
		).toBe(true);
		expect(
			auditDatabaseExtensionLifecycle({
				...baselineMigrations,
				"0001_vector_update": "ALTER EXTENSION vector UPDATE;",
			}),
		).toContain(
			"migration 0001_vector_update ALTER EXTENSION vector UPDATE must pin an exact version with TO",
		);

		const quotedExtensionRegistry = {
			activeSchemas: ["auth"],
			activeExtensions: [...REQUIRED_DATABASE_EXTENSIONS, "uuid-ossp"],
			activeExtensionSchemas: {
				...REQUIRED_DATABASE_EXTENSION_SCHEMAS,
				"uuid-ossp": "public",
			},
			activeExtensionVersions: {
				...REQUIRED_DATABASE_EXTENSION_VERSIONS,
				"uuid-ossp": "1.1",
			},
			installabilityProbes: {
				...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
				"uuid-ossp": {
					versionEpochs: [
						{
							schema: "public",
							createVersion: "1.1",
							updateTargets: [],
							dropAfter: false,
						},
					],
				},
			},
		} as const;
		for (const optionalWith of ["WITH ", ""]) {
			const quotedExtensionMigrations = {
				...baselineMigrations,
				"0002_uuid_ossp": `CREATE EXTENSION IF NOT EXISTS "uuid-ossp" ${optionalWith}SCHEMA "public" VERSION '1.1';`,
			};
			expect(
				auditDatabaseExtensionLifecycle(quotedExtensionMigrations, {
					...quotedExtensionRegistry,
					lifecycleEvents: [
						...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
						{
							operation: "create",
							extension: "uuid-ossp",
							migration: "0002_uuid_ossp",
							schema: "public",
							version: "1.1",
						},
					],
				}),
			).toEqual([]);
			expect(
				auditDatabaseExtensionLifecycle(quotedExtensionMigrations).some(
					(failure) => failure.includes("uuid-ossp"),
				),
			).toBe(true);
		}
	});

	test("requires registered drops and schema moves to produce the exact active registry", () => {
		const baselineMigrations = {
			"0000_baseline": renderBaselinePreambleSql(),
		};
		const dropMigrations = {
			...baselineMigrations,
			"0001_drop_vector": "DROP EXTENSION IF EXISTS vector;",
		};
		const dropLifecycle = [
			...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
			{
				operation: "drop",
				extension: "vector",
				migration: "0001_drop_vector",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		const dropInstallabilityProbes = {
			...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
			vector: {
				versionEpochs: [
					{ schema: "public", updateTargets: [], dropAfter: true },
				],
			},
		} as const;
		const { vector: _droppedVectorSchema, ...dropActiveSchemas } =
			REQUIRED_DATABASE_EXTENSION_SCHEMAS;
		const { vector: _droppedVectorVersion, ...dropActiveVersions } =
			REQUIRED_DATABASE_EXTENSION_VERSIONS;
		expect(
			auditDatabaseExtensionLifecycle(dropMigrations, {
				activeExtensions: REQUIRED_DATABASE_EXTENSIONS.filter(
					(extension) => extension !== "vector",
				),
				activeExtensionSchemas: dropActiveSchemas,
				activeExtensionVersions: dropActiveVersions,
				installabilityProbes: dropInstallabilityProbes,
				lifecycleEvents: dropLifecycle,
			}),
		).toEqual([]);
		expect(
			auditDatabaseExtensionLifecycle(dropMigrations).some((failure) =>
				failure.includes("SQL 0001_drop_vector:drop:vector"),
			),
		).toBe(true);
		expect(
			auditDatabaseExtensionLifecycle(
				{
					...baselineMigrations,
					"0001_drop_vector": "DROP EXTENSION vector CASCADE;",
				},
				{
					activeExtensions: REQUIRED_DATABASE_EXTENSIONS.filter(
						(extension) => extension !== "vector",
					),
					activeExtensionSchemas: REQUIRED_DATABASE_EXTENSION_SCHEMAS,
					activeExtensionVersions: REQUIRED_DATABASE_EXTENSION_VERSIONS,
					lifecycleEvents: dropLifecycle,
				},
			),
		).toContain(
			"migration 0001_drop_vector DROP EXTENSION uses unmodelled CASCADE destruction",
		);
		expect(
			auditDatabaseExtensionLifecycle(dropMigrations, {
				lifecycleEvents: dropLifecycle,
			}),
		).toContain(
			"active database extension vector is absent after lifecycle replay",
		);
		expect(
			auditDatabaseExtensionLifecycle(
				{
					...baselineMigrations,
					"0001_drop_unregistered": "DROP EXTENSION hstore;",
				},
				{
					lifecycleEvents: [
						...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
						{
							operation: "drop",
							extension: "hstore",
							migration: "0001_drop_unregistered",
						},
					],
				},
			),
		).toContain("database extension lifecycle drops inactive extension hstore");

		const moveMigrations = {
			...baselineMigrations,
			"0001_move_vector": [
				"CREATE SCHEMA IF NOT EXISTS extensions;",
				"ALTER EXTENSION vector SET SCHEMA extensions;",
			].join("\n"),
		};
		const moveLifecycle = [
			...DATABASE_EXTENSION_LIFECYCLE_EVENTS,
			{
				operation: "set_schema",
				extension: "vector",
				migration: "0001_move_vector",
				schema: "extensions",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		expect(
			auditDatabaseExtensionLifecycle(moveMigrations, {
				activeSchemas: ["auth", "extensions"],
				activeExtensionSchemas: {
					...REQUIRED_DATABASE_EXTENSION_SCHEMAS,
					vector: "extensions",
				},
				lifecycleEvents: moveLifecycle,
			}),
		).toEqual([]);
		expect(
			auditDatabaseExtensionLifecycle(moveMigrations).some((failure) =>
				failure.includes("SQL 0001_move_vector:set_schema:vector"),
			),
		).toBe(true);
		expect(
			auditDatabaseExtensionLifecycle(moveMigrations, {
				activeSchemas: ["auth", "extensions"],
				lifecycleEvents: moveLifecycle,
			}),
		).toContain(
			"database extension lifecycle leaves vector in schema extensions instead of active schema public",
		);
	});

	test("keeps hosted migration verification version-aware", () => {
		const verifier = readFileSync(
			new URL("./verify-migrations.ts", import.meta.url),
			"utf8",
		);
		expect(verifier).toContain("extension_row.extversion AS extension_version");
		expect(verifier).toContain("REQUIRED_DATABASE_EXTENSION_VERSIONS");
		expect(verifier).toContain("actualState.version !== expectedVersion");
	});

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
		expect(
			baselineSql.split(
				'CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";',
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
			expect(
				changedArtifactPaths(historyDirectory, normalizedArtifacts()),
			).toContain("0001_expand.sql");
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
				"schemaVersion must be 2",
			);
		});
	});

	test("requires explicit write confirmation and separates read-only modes", () => {
		expect(parseBaselineCommandOptions([])).toEqual({
			mode: "write",
			operation: "virgin",
			confirmed: false,
			collapseConfirmed: false,
			baseSha: undefined,
			oldChainCatalogPath: undefined,
			candidateCatalogPath: undefined,
			catalogDifferenceReviewPath: undefined,
			candidateOutputPath: undefined,
			help: false,
		});
		expect(
			parseBaselineCommandOptions(["--confirm-pre-launch-virgin-reset"]),
		).toEqual({
			mode: "write",
			operation: "virgin",
			confirmed: true,
			collapseConfirmed: false,
			baseSha: undefined,
			oldChainCatalogPath: undefined,
			candidateCatalogPath: undefined,
			catalogDifferenceReviewPath: undefined,
			candidateOutputPath: undefined,
			help: false,
		});
		expect(parseBaselineCommandOptions(["--dry-run"]).mode).toBe("dry-run");
		expect(parseBaselineCommandOptions(["--check"]).mode).toBe("check");
		const reset = parseBaselineCommandOptions([
			"--pre-live-reset",
			"--dry-run",
		]);
		expect(reset.operation).toBe("pre-live-reset");
		expect(() =>
			parseBaselineCommandOptions(["--pre-live-reset", "--collapse"]),
		).toThrow("mutually exclusive");
		expect(() => parseBaselineCommandOptions(["--dry-run", "--check"])).toThrow(
			"mutually exclusive",
		);
		expect(() => parseBaselineCommandOptions(["--force"])).toThrow(
			"unknown argument",
		);
		expect(() => parseBaselineCommandOptions(["--base-sha=not-a-sha"])).toThrow(
			"require --collapse",
		);
		const collapse = parseBaselineCommandOptions([
			"--collapse",
			"--dry-run",
			`--base-sha=${"a".repeat(40)}`,
		]);
		expect(collapse.operation).toBe("collapse");
		expect(collapse.baseSha).toBe("a".repeat(40));
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
				buildPolicy,
				parseBaselineCommandOptions([
					"--pre-live-reset",
					"--confirm-pre-launch-virgin-reset",
				]),
			),
		).not.toThrow();
		expect(() =>
			assertBaselineWriteAllowed(
				{ ...buildPolicy, lifecycle: "sealed" },
				parseBaselineCommandOptions(["--check"]),
			),
		).not.toThrow();
	});

	test("requires separate authority and catalog evidence for collapse writes", () => {
		const sealedPolicy: BaselineBuildPolicy = {
			...buildPolicy,
			lifecycle: "sealed",
		};
		const baseArgument = `--base-sha=${"a".repeat(40)}`;
		expect(() =>
			assertCollapseWriteAllowed(
				sealedPolicy,
				parseBaselineCommandOptions(["--collapse", baseArgument]),
			),
		).toThrow("requires --confirm-generation-collapse");
		expect(() =>
			assertCollapseWriteAllowed(
				sealedPolicy,
				parseBaselineCommandOptions([
					"--collapse",
					baseArgument,
					"--confirm-generation-collapse",
				]),
			),
		).toThrow("requires --old-chain-catalog");
		expect(() =>
			assertCollapseWriteAllowed(
				sealedPolicy,
				parseBaselineCommandOptions([
					"--collapse",
					baseArgument,
					"--old-chain-catalog=/tmp/old.json",
					"--candidate-catalog=/tmp/candidate.json",
					"--catalog-difference-review=/tmp/review.json",
					"--confirm-generation-collapse",
				]),
			),
		).not.toThrow();
		expect(() =>
			assertCollapseWriteAllowed(
				sealedPolicy,
				parseBaselineCommandOptions(["--collapse", "--dry-run", baseArgument]),
			),
		).not.toThrow();
	});

	test("verifies the old chain as evidence and the candidate against final schema", () => {
		const source = readFileSync(
			new URL("./rebuild-baseline.ts", import.meta.url),
			"utf8",
		);
		const collapseStart = source.indexOf(
			"function rebuildCollapsedGeneration(",
		);
		const collapseSource = source.slice(collapseStart);
		const sourceHistoryVerification = collapseSource.indexOf(
			"runMigrationHistoryVerifiers(packageDirectory);",
		);
		const anchorRead = collapseSource.indexOf(
			"const anchor = readCollapseAnchor(",
		);
		const candidateFinalVerification = collapseSource.indexOf(
			"runStaticVerifiers(packageDirectory, {",
		);

		expect(collapseStart).toBeGreaterThan(-1);
		expect(sourceHistoryVerification).toBeGreaterThan(-1);
		expect(anchorRead).toBeGreaterThan(sourceHistoryVerification);
		expect(candidateFinalVerification).toBeGreaterThan(anchorRead);
		expect(
			collapseSource
				.slice(sourceHistoryVerification, anchorRead)
				.includes("verify-schema-contracts"),
		).toBe(false);

		for (const verifier of [
			"verify-migration-history.ts",
			"verify-migration-policy.ts",
			"verify-schema-contracts.ts",
		]) {
			expect(
				readFileSync(new URL(`./${verifier}`, import.meta.url), "utf8"),
			).toContain("RELAYAPI_VERIFY_MIGRATION_DIRECTORY");
		}
	});

	test("uses valid non-exported metadata to bootstrap the evidence-free candidate dry run", () => {
		const generation: BaselineGeneration = {
			schemaVersion: 1,
			generation: 2,
			lifecycle: "sealed",
			baseline: {
				tag: "0000_baseline",
				folderMillis: 1_785_196_800_000,
			},
			transition: {
				kind: "collapse",
				fromGeneration: 1,
				baseCommitSha: "a".repeat(40),
				baseManifestSha256: "b".repeat(64),
				baseGenerationSha256: "c".repeat(64),
				baseBuildPolicySha256: "d".repeat(64),
				candidateManifestSha256: "e".repeat(64),
				oldChainCatalogSha256: "0".repeat(64),
				candidateCatalogSha256: "0".repeat(64),
				catalogDifferenceReviewSha256: "0".repeat(64),
			},
		};

		const provisional = provisionalCollapseGenerationForStaticVerification({
			generation,
			candidateManifestText: '{"schemaVersion":2}\n',
		});

		expect(provisional.lifecycle).toBe("building");
		expect(auditBaselineGeneration(provisional)).toEqual([]);
		expect(provisional.transition).not.toEqual(generation.transition);
		if (generation.transition.kind !== "collapse") {
			throw new Error("fixture must remain a collapse transition");
		}
		expect(generation.transition.oldChainCatalogSha256).toBe("0".repeat(64));
	});

	test("atomically restores both migration history and generation metadata", () => {
		withTemporaryDirectory((root) => {
			const target = join(root, "drizzle");
			const replacement = join(root, "replacement");
			const generationPath = join(root, "baseline-generation.json");
			const replacementGenerationPath = join(root, "next-generation.json");
			const evidencePath = join(root, "catalog-review.json");
			const replacementEvidencePath = join(root, "next-catalog-review.json");
			mkdirSync(target);
			mkdirSync(replacement);
			writeFileSync(join(target, "value"), "old");
			writeFileSync(join(replacement, "value"), "new");
			writeFileSync(generationPath, "generation-1");
			writeFileSync(replacementGenerationPath, "generation-2");
			writeFileSync(evidencePath, "review-1");
			writeFileSync(replacementEvidencePath, "review-2");

			expect(() =>
				replaceGenerationWithRollback({
					targetDirectory: target,
					replacementDirectory: replacement,
					generationPath,
					replacementGenerationPath,
					additionalFiles: [
						{
							targetPath: evidencePath,
							replacementPath: replacementEvidencePath,
						},
					],
					verify: () => {
						throw new Error("pair verification failed");
					},
				}),
			).toThrow("pair verification failed");
			expect(readFileSync(join(target, "value"), "utf8")).toBe("old");
			expect(readFileSync(generationPath, "utf8")).toBe("generation-1");
			expect(readFileSync(evidencePath, "utf8")).toBe("review-1");
		});
	});

	test("restores every original when an evidence staging file is missing", () => {
		withTemporaryDirectory((root) => {
			const target = join(root, "drizzle");
			const replacement = join(root, "replacement");
			const generationPath = join(root, "baseline-generation.json");
			const replacementGenerationPath = join(root, "next-generation.json");
			const evidencePath = join(root, "catalog-review.json");
			mkdirSync(target);
			mkdirSync(replacement);
			writeFileSync(join(target, "value"), "old");
			writeFileSync(join(replacement, "value"), "new");
			writeFileSync(generationPath, "generation-1");
			writeFileSync(replacementGenerationPath, "generation-2");
			writeFileSync(evidencePath, "review-1");

			expect(() =>
				replaceGenerationWithRollback({
					targetDirectory: target,
					replacementDirectory: replacement,
					generationPath,
					replacementGenerationPath,
					additionalFiles: [
						{
							targetPath: evidencePath,
							replacementPath: join(root, "missing-review.json"),
						},
					],
					verify: () => {},
				}),
			).toThrow();
			expect(readFileSync(join(target, "value"), "utf8")).toBe("old");
			expect(readFileSync(generationPath, "utf8")).toBe("generation-1");
			expect(readFileSync(evidencePath, "utf8")).toBe("review-1");
		});
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

			rmSync(join(root, "drizzle.baseline-backup-crash-marker"));
			for (const evidenceFile of [
				COLLAPSE_BOUNDARY_MANIFEST_EVIDENCE_FILE,
				CANDIDATE_CATALOG_EVIDENCE_FILE,
				CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE,
			]) {
				const backup = join(
					root,
					`${evidenceFile}.baseline-backup-crash-marker`,
				);
				writeFileSync(backup, "review me");
				expect(() => assertNoStaleBaselineReplacement(target)).toThrow(
					"stale baseline backup",
				);
				rmSync(backup);
			}
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
			"create extension vector with schema public;\nSELECT 1;\n",
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
