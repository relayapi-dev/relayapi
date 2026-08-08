import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { DatabaseExtensionLifecycleEvent } from "./database-extension-lifecycle";
import type { MigrationManifest } from "./verify-migration-history";
import {
	type DatabaseExtensionCatalogSnapshot,
	verifyPendingDatabaseExtensionLifecycleSnapshot,
	verifyTrackedDatabaseExtensionLifecycleSources,
} from "./verify-pending-database-extensions";

function manifest(tags: readonly string[]): MigrationManifest {
	return {
		schemaVersion: 2,
		journal: { version: "7", dialect: "postgresql" },
		migrations: tags.map((tag, idx) => ({
			idx,
			tag,
			folderMillis: 1_700_000_000_000 + idx,
			sha256: `${idx}`.padStart(64, "0"),
			snapshotSha256: `${idx + 1}`.padStart(64, "0"),
			drizzleVersion: "7",
			breakpoints: true,
		})),
	};
}

function catalog(input?: {
	installed?: DatabaseExtensionCatalogSnapshot["installed"];
	availableDefaults?: DatabaseExtensionCatalogSnapshot["availableDefaults"];
	availableVersions?: DatabaseExtensionCatalogSnapshot["availableVersions"];
	relocatableVersions?: DatabaseExtensionCatalogSnapshot["relocatableVersions"];
	updatePaths?: DatabaseExtensionCatalogSnapshot["updatePaths"];
}): DatabaseExtensionCatalogSnapshot {
	return {
		installed: input?.installed ?? new Map(),
		availableDefaults: input?.availableDefaults ?? new Map(),
		availableVersions: input?.availableVersions ?? new Set(),
		relocatableVersions: input?.relocatableVersions ?? new Map(),
		updatePaths: input?.updatePaths ?? new Map(),
	};
}

function versionKey(extension: string, version: string): string {
	return `${extension}\0${version}`;
}

function pathKey(extension: string, source: string, target: string): string {
	return `${extension}\0${source}\0${target}`;
}

const VERSIONED_LIFECYCLE = [
	{
		operation: "create",
		extension: "vector",
		migration: "0000_create",
		schema: "public",
	},
	{
		operation: "update",
		extension: "vector",
		migration: "0001_update",
		version: "0.8.0",
	},
	{
		operation: "update",
		extension: "vector",
		migration: "0002_update",
		version: "0.9.0",
	},
] as const satisfies readonly DatabaseExtensionLifecycleEvent[];

describe("locked pending database extension lifecycle", () => {
	test("rejects a future target whose owning migrations are absent from the verified ledger prefix", () => {
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest(["0000_create", "0001_update", "0002_update"]),
				appliedMigrationCount: 1,
				lifecycleEvents: VERSIONED_LIFECYCLE,
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.9.0", canManage: true }],
					]),
					availableDefaults: new Map([["vector", "0.7.0"]]),
					availableVersions: new Set([
						versionKey("vector", "0.8.0"),
						versionKey("vector", "0.9.0"),
					]),
					updatePaths: new Map([[pathKey("vector", "0.9.0", "0.8.0"), null]]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "public" },
				activeVersions: { vector: "0.9.0" },
			}),
		).toThrow(
			"vector is already at pending target 0.9.0, but migration 0002_update is not present in the verified ledger prefix",
		);
	});

	test("rejects a preinstalled wrong version when a pending pinned CREATE would no-op", () => {
		const lifecycle = [
			{
				operation: "create",
				extension: "hstore",
				migration: "0000_create",
				schema: "public",
				version: "1.8",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest(["0000_create"]),
				appliedMigrationCount: 0,
				lifecycleEvents: lifecycle,
				catalog: catalog({
					installed: new Map([
						["hstore", { schema: "public", version: "2.0", canManage: true }],
					]),
					availableDefaults: new Map([["hstore", "2.0"]]),
					availableVersions: new Set([versionKey("hstore", "1.8")]),
				}),
				activeExtensions: ["hstore"],
				activeSchemas: { hstore: "public" },
				activeVersions: { hstore: "1.8" },
			}),
		).toThrow(
			"Preinstalled PostgreSQL extension hstore is at version 2.0, but pending CREATE migration 0000_create pins version 1.8",
		);
	});

	test("preserves a provider-preinstalled unpinned extension through pending CREATE", () => {
		const lifecycle = [
			{
				operation: "create",
				extension: "vector",
				migration: "0000_create",
				schema: "public",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		expect(
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest(["0000_create"]),
				appliedMigrationCount: 0,
				lifecycleEvents: lifecycle,
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.7.4", canManage: true }],
					]),
					availableDefaults: new Map([["vector", "0.8.0"]]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "public" },
				activeVersions: { vector: undefined },
			}),
		).toEqual({ pendingEventCount: 1 });
	});

	test("requires a preinstall to satisfy the pending CREATE namespace immediately", () => {
		const create = {
			operation: "create",
			extension: "vector",
			migration: "0000_create",
			schema: "public",
		} as const;
		const input = {
			manifest: manifest(["0000_create", "0001_move"]),
			appliedMigrationCount: 0,
			catalog: catalog({
				installed: new Map([
					[
						"vector",
						{
							schema: "provider_extensions",
							version: "0.7.4",
							canManage: true,
						},
					],
				]),
				availableDefaults: new Map([["vector", "0.8.0"]]),
			}),
			activeExtensions: ["vector"],
			activeSchemas: { vector: "public" },
			activeVersions: { vector: undefined },
		} as const;
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				...input,
				lifecycleEvents: [create],
			}),
		).toThrow(
			"Preinstalled PostgreSQL extension vector is in schema provider_extensions, but pending CREATE migration 0000_create immediately requires schema public",
		);
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				...input,
				lifecycleEvents: [
					create,
					{
						operation: "set_schema",
						extension: "vector",
						migration: "0001_move",
						schema: "public",
					},
				],
			}),
		).toThrow(
			"Preinstalled PostgreSQL extension vector is in schema provider_extensions, but pending CREATE migration 0000_create immediately requires schema public",
		);
	});

	test("allows a genuinely pending SET SCHEMA after CREATE ownership is in the ledger prefix", () => {
		expect(
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest(["0000_create", "0001_move"]),
				appliedMigrationCount: 1,
				lifecycleEvents: [
					{
						operation: "create",
						extension: "vector",
						migration: "0000_create",
						schema: "public",
					},
					{
						operation: "set_schema",
						extension: "vector",
						migration: "0001_move",
						schema: "extensions",
					},
				],
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.7.4", canManage: true }],
					]),
					availableDefaults: new Map([["vector", "0.8.0"]]),
					relocatableVersions: new Map([[versionKey("vector", "0.7.4"), true]]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "extensions" },
				activeVersions: { vector: undefined },
			}),
		).toEqual({ pendingEventCount: 1 });
	});

	test("accepts an exact target only after its owning migration is in the verified prefix", () => {
		const lifecycle = [
			...VERSIONED_LIFECYCLE,
			{
				operation: "set_schema",
				extension: "vector",
				migration: "0003_move",
				schema: "extensions",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		expect(
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest([
					"0000_create",
					"0001_update",
					"0002_update",
					"0003_move",
				]),
				appliedMigrationCount: 3,
				lifecycleEvents: lifecycle,
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.9.0", canManage: true }],
					]),
					availableDefaults: new Map([["vector", "0.9.0"]]),
					relocatableVersions: new Map([[versionKey("vector", "0.9.0"), true]]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "extensions" },
				activeVersions: { vector: "0.9.0" },
			}),
		).toEqual({ pendingEventCount: 1 });
	});

	test("rejects a pending schema move when the simulated version is not relocatable", () => {
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest(["0000_create", "0001_move"]),
				appliedMigrationCount: 1,
				lifecycleEvents: [
					{
						operation: "create",
						extension: "vector",
						migration: "0000_create",
						schema: "public",
					},
					{
						operation: "set_schema",
						extension: "vector",
						migration: "0001_move",
						schema: "extensions",
					},
				],
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.7.4", canManage: true }],
					]),
					availableDefaults: new Map([["vector", "0.8.0"]]),
					relocatableVersions: new Map([
						[versionKey("vector", "0.7.4"), false],
					]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "extensions" },
				activeVersions: { vector: undefined },
			}),
		).toThrow(
			"vector version 0.7.4 is not relocatable for pending SET SCHEMA migration 0001_move",
		);
	});

	test("requires an available target and a non-null path for each genuinely pending update", () => {
		const base = {
			manifest: manifest(["0000_create", "0001_update", "0002_update"]),
			appliedMigrationCount: 1,
			lifecycleEvents: VERSIONED_LIFECYCLE,
			activeExtensions: ["vector"],
			activeSchemas: { vector: "public" },
			activeVersions: { vector: "0.9.0" },
		} as const;
		const installed = new Map([
			[
				"vector",
				{
					schema: "public",
					version: "0.7.0",
					canManage: true,
				},
			],
		]);
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				...base,
				catalog: catalog({
					installed,
					availableDefaults: new Map([["vector", "0.7.0"]]),
					availableVersions: new Set([versionKey("vector", "0.9.0")]),
				}),
			}),
		).toThrow(
			"vector version 0.8.0 is unavailable for pending UPDATE migration 0001_update",
		);
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				...base,
				catalog: catalog({
					installed,
					availableDefaults: new Map([["vector", "0.7.0"]]),
					availableVersions: new Set([
						versionKey("vector", "0.8.0"),
						versionKey("vector", "0.9.0"),
					]),
					updatePaths: new Map([[pathKey("vector", "0.7.0", "0.8.0"), null]]),
				}),
			}),
		).toThrow(
			"vector has no reachable update path from 0.7.0 to pending target 0.8.0 owned by migration 0001_update",
		);
	});

	test("maps lifecycle ownership to manifest position, not a matching target string", () => {
		expect(() =>
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: manifest(["0000_create", "0001_move"]),
				appliedMigrationCount: 1,
				lifecycleEvents: [
					{
						operation: "create",
						extension: "vector",
						migration: "0000_create",
						schema: "public",
						version: "0.9.0",
					},
					{
						operation: "set_schema",
						extension: "vector",
						migration: "0001_missing",
						schema: "extensions",
					},
				],
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.9.0", canManage: true }],
					]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "extensions" },
				activeVersions: { vector: "0.9.0" },
			}),
		).toThrow("references untracked migration 0001_missing");
	});

	test("treats every lifecycle event owned by one migration as one ledger-prefix unit", () => {
		const lifecycle = [
			{
				operation: "create",
				extension: "vector",
				migration: "0000_create_and_update",
				schema: "public",
			},
			{
				operation: "update",
				extension: "vector",
				migration: "0000_create_and_update",
				version: "0.8.0",
			},
		] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
		const trackedManifest = manifest(["0000_create_and_update"]);
		expect(
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: trackedManifest,
				appliedMigrationCount: 0,
				lifecycleEvents: lifecycle,
				catalog: catalog({
					availableDefaults: new Map([["vector", "0.7.0"]]),
					availableVersions: new Set([versionKey("vector", "0.8.0")]),
					updatePaths: new Map([
						[pathKey("vector", "0.7.0", "0.8.0"), "0.7.0--0.8.0"],
					]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "public" },
				activeVersions: { vector: "0.8.0" },
			}),
		).toEqual({ pendingEventCount: 2 });
		expect(
			verifyPendingDatabaseExtensionLifecycleSnapshot({
				manifest: trackedManifest,
				appliedMigrationCount: 1,
				lifecycleEvents: lifecycle,
				catalog: catalog({
					installed: new Map([
						["vector", { schema: "public", version: "0.8.0", canManage: true }],
					]),
				}),
				activeExtensions: ["vector"],
				activeSchemas: { vector: "public" },
				activeVersions: { vector: "0.8.0" },
			}),
		).toEqual({ pendingEventCount: 0 });
	});
});

test("migrate verifies pending extension state under the session lock before Drizzle mutates", () => {
	const source = readFileSync(new URL("./migrate.ts", import.meta.url), "utf8");
	const lock = source.indexOf(
		"await sql`SELECT pg_advisory_lock(hashtext('relayapi:migrations'))`",
	);
	const history = source.indexOf(
		"const appliedMigrationCount = await verifyLiveMigrationHistory(",
	);
	const extensionPreflight = source.indexOf(
		"await verifyPendingDatabaseExtensionLifecycle(",
	);
	const mutation = source.indexOf(
		"await migrate(drizzle(sql), { migrationsFolder })",
	);
	expect(lock).toBeGreaterThan(-1);
	expect(history).toBeGreaterThan(lock);
	expect(extensionPreflight).toBeGreaterThan(history);
	expect(mutation).toBeGreaterThan(extensionPreflight);
	expect(source).toContain("databaseExtensionContractForGeneration(");
	expect(source.match(/requiredExtensions: extensionContract\.activeExtensions/g)).toHaveLength(
		2,
	);
	expect(source.match(/requiredSchemas: extensionContract\.activeSchemas/g)).toHaveLength(
		2,
	);
});

test("every sealed generation uses the complete reset-baseline extension lifecycle", () => {
	const drizzleDirectory = new URL("../drizzle/", import.meta.url);
	const trackedManifest = JSON.parse(
		readFileSync(new URL("migration-manifest.json", drizzleDirectory), "utf8"),
	) as MigrationManifest;
	const migrationsByTag = Object.fromEntries(
		trackedManifest.migrations.map((migration) => [
			migration.tag,
			readFileSync(new URL(`${migration.tag}.sql`, drizzleDirectory), "utf8"),
		]),
	);
	expect(() =>
		verifyTrackedDatabaseExtensionLifecycleSources({
			manifest: trackedManifest,
			migrationsByTag,
			generation: 1,
		}),
	).not.toThrow();
	expect(() =>
		verifyTrackedDatabaseExtensionLifecycleSources({
			manifest: trackedManifest,
			migrationsByTag,
			generation: 2,
		}),
	).not.toThrow();
});
