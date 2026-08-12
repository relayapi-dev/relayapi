import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	REQUIRED_BASELINE_EXTENSION_SCHEMAS,
	REQUIRED_BASELINE_EXTENSIONS,
} from "../../db/scripts/render-baseline-preamble-sql.js";
import {
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSION_VERSIONS,
	REQUIRED_DATABASE_EXTENSIONS,
	validateBetterAuthSecret,
	validateEncryptionKeyRing,
	validateMigrationDatabaseUrl,
	validateRuntimeDatabaseUrl,
	verifyMigratedDatabaseExtensions,
	verifyRequiredDatabaseExtensions,
} from "../src/doctor.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("self-host encryption key preflight", () => {
	test("accepts rotation entries only when the retained identity anchor survives", () => {
		expect(() =>
			validateEncryptionKeyRing(
				`current=${KEY_A},identity=${KEY_B},previous=${"c".repeat(64)}`,
			),
		).not.toThrow();
	});

	test("rejects removal or activation of the retained identity anchor", () => {
		expect(() => validateEncryptionKeyRing(`current=${KEY_A}`)).toThrow(
			"must retain an immutable identity=64hex entry",
		);
		expect(() =>
			validateEncryptionKeyRing(`identity=${KEY_B},current=${KEY_A}`),
		).toThrow("cannot be active");
	});

	test("rejects duplicate key ids", () => {
		expect(() =>
			validateEncryptionKeyRing(
				`current=${KEY_A},identity=${KEY_B},identity=${"c".repeat(64)}`,
			),
		).toThrow("duplicate key id identity");
	});

	test("rejects distinct ids that reuse the same key material", () => {
		expect(() =>
			validateEncryptionKeyRing(`active=${KEY_A},identity=${KEY_A}`),
		).toThrow("must use distinct key material");
	});
});

describe("self-host auth secret preflight", () => {
	test("requires enough key material for derived deployment credentials", () => {
		expect(() => validateBetterAuthSecret("x".repeat(32))).not.toThrow();
		expect(() => validateBetterAuthSecret("too-short")).toThrow(
			"at least 32 bytes",
		);
	});
});

describe("self-host database extension preflight", () => {
	test("matches the active database extension-and-schema contract", () => {
		expect(
			REQUIRED_DATABASE_EXTENSIONS.map((extension) => [
				extension,
				REQUIRED_DATABASE_EXTENSION_SCHEMAS[extension],
			]),
		).toEqual(
			REQUIRED_BASELINE_EXTENSIONS.map((extension) => [
				extension,
				REQUIRED_BASELINE_EXTENSION_SCHEMAS[extension],
			]),
		);
	});

	test("probes a clean install for every historical extension and always rolls back/closes", async () => {
		const statements: string[] = [];
		let closed = false;

		await verifyRequiredDatabaseExtensions(
			"postgresql://migration@example.invalid/relayapi",
			() => ({
				begin: async (run) =>
					run({
						async unsafe(query) {
							statements.push(query);
							if (query.includes("pg_available_extensions")) {
								return Object.keys(
									DATABASE_EXTENSION_INSTALLABILITY_PROBES,
								).map((extension) => ({
									extension_name: extension,
									default_version: extension === "vector" ? "0.7.0" : "1.6",
								}));
							}
							if (query.includes("pg_catalog.pg_extension")) return [];
							return [];
						},
					}),
				async end() {
					closed = true;
				},
			}),
		);

		expect(
			statements.filter((statement) =>
				statement.startsWith("CREATE EXTENSION"),
			),
		).toEqual(
			Object.entries(DATABASE_EXTENSION_INSTALLABILITY_PROBES).flatMap(
				([extension, probe]) =>
					probe.versionEpochs.map(
						(epoch) =>
							`CREATE EXTENSION "${extension}" WITH SCHEMA "${epoch.schema}"${"createVersion" in epoch && epoch.createVersion ? ` VERSION '${epoch.createVersion}'` : ""}`,
					),
			),
		);
		expect(
			statements.filter((statement) => statement.startsWith("CREATE SCHEMA")),
		).toEqual(['CREATE SCHEMA IF NOT EXISTS "public"']);
		expect(
			statements.some((statement) =>
				statement.includes("pg_extension_update_paths"),
			),
		).toBe(false);
		expect(closed).toBe(true);
	});

	test("allows manageable installed extensions to remain in their pre-migration schema", async () => {
		const statements: string[] = [];
		await verifyRequiredDatabaseExtensions(
			"postgresql://migration@example.invalid/relayapi",
			() => ({
				begin: async (run) =>
					run({
						async unsafe(query) {
							statements.push(query);
							if (query.includes("pg_available_extensions")) {
								return REQUIRED_DATABASE_EXTENSIONS.map((extension) => ({
									extension_name: extension,
									default_version: extension === "vector" ? "0.7.0" : "1.6",
								}));
							}
							if (query.includes("pg_catalog.pg_extension")) {
								return REQUIRED_DATABASE_EXTENSIONS.map((extension) => ({
									extension_name: extension,
									extension_schema: "legacy_extensions",
									can_manage_extension: true,
								}));
							}
							return [];
						},
					}),
				async end() {},
			}),
		);
		expect(
			statements.some((statement) => statement.startsWith("CREATE EXTENSION")),
		).toBe(false);
	});

	test("retains installability probes for extensions removed by later migrations", async () => {
		const probes = {
			...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
			hstore: {
				versionEpochs: [
					{
						schema: "extension_probe",
						createVersion: "1.8",
						updateTargets: [],
						dropAfter: true,
					},
				],
			},
		};
		const statements: string[] = [];
		await verifyRequiredDatabaseExtensions(
			"postgresql://migration@example.invalid/relayapi",
			() => ({
				begin: async (run) =>
					run({
						async unsafe(query) {
							statements.push(query);
							if (query.includes("pg_available_extensions")) {
								return Object.keys(probes).map((extension) => ({
									extension_name: extension,
									default_version: extension === "vector" ? "0.7.0" : "1.6",
								}));
							}
							if (query.includes("pg_available_extension_versions")) {
								return [
									{
										extension_name: "hstore",
										extension_version: "1.8",
									},
								];
							}
							if (query.includes("pg_catalog.pg_extension")) return [];
							return [];
						},
					}),
				async end() {},
			}),
			probes,
		);
		expect(statements).toContain(
			`CREATE EXTENSION "hstore" WITH SCHEMA "extension_probe" VERSION '1.8'`,
		);
	});

	test("rejects a pinned historical version unavailable to clean replay", async () => {
		const probes = {
			...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
			hstore: {
				versionEpochs: [
					{
						schema: "public",
						createVersion: "1.8",
						updateTargets: [],
						dropAfter: true,
					},
				],
			},
		};
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return Object.keys(probes).map((extension) => ({
										extension_name: extension,
										default_version: extension === "vector" ? "0.7.0" : "1.6",
									}));
								}
								if (query.includes("pg_available_extension_versions")) {
									return [];
								}
								return [];
							},
						}),
					async end() {},
				}),
				probes,
			),
		).rejects.toThrow(
			"historical PostgreSQL extension hstore version 1.8 is unavailable for clean migration replay",
		);
	});

	test("rejects an unavailable extension needed by historical replay", async () => {
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return Object.keys(DATABASE_EXTENSION_INSTALLABILITY_PROBES)
										.filter((extension) => extension !== "vector")
										.map((extension) => ({
											extension_name: extension,
											default_version: "1.6",
										}));
								}
								return [];
							},
						}),
					async end() {},
				}),
			),
		).rejects.toThrow(
			"historical PostgreSQL extension vector is unavailable for clean migration replay",
		);
	});

	test("rejects installed extensions the migration role cannot manage", async () => {
		let closed = false;
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return REQUIRED_DATABASE_EXTENSIONS.map((extension) => ({
										extension_name: extension,
										default_version: extension === "vector" ? "0.7.0" : "1.6",
									}));
								}
								if (query.includes("pg_catalog.pg_extension")) {
									return [
										{
											extension_name: "vector",
											extension_schema: "public",
											can_manage_extension: false,
										},
									];
								}
								return [];
							},
						}),
					async end() {
						closed = true;
					},
				}),
			),
		).rejects.toThrow(
			"migration role cannot manage installed PostgreSQL extension vector",
		);
		expect(closed).toBe(true);
	});

	test("replays ordered provider-default updates for a missing extension", async () => {
		const probes = {
			vector: {
				versionEpochs: [
					{
						schema: "public",
						updateTargets: ["0.8.0", "0.9.0"],
						dropAfter: false,
					},
				],
			},
		};
		const statements: string[] = [];
		await verifyRequiredDatabaseExtensions(
			"postgresql://migration@example.invalid/relayapi",
			() => ({
				begin: async (run) =>
					run({
						async unsafe(query) {
							statements.push(query);
							if (query.includes("pg_available_extensions")) {
								return [{ extension_name: "vector", default_version: "0.7.0" }];
							}
							if (query.includes("pg_available_extension_versions")) {
								return ["0.8.0", "0.9.0"].map((version) => ({
									extension_name: "vector",
									extension_version: version,
								}));
							}
							if (query.includes("pg_catalog.pg_extension ")) return [];
							if (query.includes("pg_extension_update_paths")) {
								return [
									{
										source_version: "0.7.0",
										target_version: "0.8.0",
										update_path: "0.7.0--0.8.0",
									},
									{
										source_version: "0.8.0",
										target_version: "0.9.0",
										update_path: "0.8.0--0.9.0",
									},
								];
							}
							return [];
						},
					}),
				async end() {},
			}),
			probes,
		);
		expect(
			statements.filter(
				(statement) =>
					statement.startsWith("CREATE EXTENSION") ||
					statement.startsWith("ALTER EXTENSION"),
			),
		).toEqual([
			'CREATE EXTENSION "vector" WITH SCHEMA "public"',
			`ALTER EXTENSION "vector" UPDATE TO '0.8.0'`,
			`ALTER EXTENSION "vector" UPDATE TO '0.9.0'`,
		]);
	});

	test("checks clean update paths without inferring pending progress from an installed version", async () => {
		const probes = {
			vector: {
				versionEpochs: [
					{
						schema: "public",
						updateTargets: ["0.8.0", "0.9.0"],
						dropAfter: false,
					},
				],
			},
		};
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return [
										{
											extension_name: "vector",
											default_version: "0.7.0",
										},
									];
								}
								if (query.includes("pg_available_extension_versions")) {
									return ["0.8.0", "0.9.0"].map((version) => ({
										extension_name: "vector",
										extension_version: version,
									}));
								}
								if (query.includes("pg_catalog.pg_extension ")) {
									return [
										{
											extension_name: "vector",
											extension_schema: "legacy_extensions",
											extension_version: "0.8.0",
											can_manage_extension: true,
										},
									];
								}
								if (query.includes("pg_extension_update_paths")) {
									return [
										{
											source_version: "0.7.0",
											target_version: "0.8.0",
											update_path: "0.7.0--0.8.0",
										},
										{
											source_version: "0.8.0",
											target_version: "0.9.0",
											update_path: "0.8.0--0.9.0",
										},
									];
								}
								return [];
							},
						}),
					async end() {},
				}),
				probes,
			),
		).resolves.toBeUndefined();
	});

	test("rejects an unreachable provider-default clean update path", async () => {
		const probes = {
			vector: {
				versionEpochs: [
					{
						schema: "public",
						updateTargets: ["0.8.0"],
						dropAfter: false,
					},
				],
			},
		};
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return [
										{
											extension_name: "vector",
											default_version: "0.7.0",
										},
									];
								}
								if (query.includes("pg_available_extension_versions")) {
									return [
										{
											extension_name: "vector",
											extension_version: "0.8.0",
										},
									];
								}
								if (query.includes("pg_catalog.pg_extension ")) return [];
								if (query.includes("pg_extension_update_paths")) {
									return [
										{
											source_version: "0.7.0",
											target_version: "0.8.0",
											update_path: null,
										},
									];
								}
								return [];
							},
						}),
					async end() {},
				}),
				probes,
			),
		).rejects.toThrow(
			"PostgreSQL extension vector has no reachable update path from 0.7.0 to 0.8.0 required by clean migration replay lifecycle epoch 1",
		);
	});

	test("leaves installed-version ownership to the locked migration verifier", async () => {
		const probes = {
			vector: {
				versionEpochs: [
					{
						schema: "public",
						updateTargets: ["0.8.0"],
						dropAfter: false,
					},
				],
			},
		};
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return [
										{
											extension_name: "vector",
											default_version: "0.7.0",
										},
									];
								}
								if (query.includes("pg_available_extension_versions")) {
									return [
										{
											extension_name: "vector",
											extension_version: "0.8.0",
										},
									];
								}
								if (query.includes("pg_catalog.pg_extension ")) {
									return [
										{
											extension_name: "vector",
											extension_schema: "public",
											extension_version: "1.0.0",
											can_manage_extension: true,
										},
									];
								}
								if (query.includes("pg_extension_update_paths")) {
									return [
										{
											source_version: "0.7.0",
											target_version: "0.8.0",
											update_path: "0.7.0--0.8.0",
										},
										{
											source_version: "1.0.0",
											target_version: "0.8.0",
											update_path: null,
										},
									];
								}
								return [];
							},
						}),
					async end() {},
				}),
				probes,
			),
		).resolves.toBeUndefined();
	});

	test("replays drop-and-recreate epochs in their own schemas", async () => {
		const probes = {
			hstore: {
				versionEpochs: [
					{
						schema: "extensions_v1",
						updateTargets: ["1.1"],
						dropAfter: true,
					},
					{
						schema: "extensions_v2",
						createVersion: "2.0",
						updateTargets: ["2.1"],
						dropAfter: false,
					},
				],
			},
		};
		const statements: string[] = [];
		await verifyRequiredDatabaseExtensions(
			"postgresql://migration@example.invalid/relayapi",
			() => ({
				begin: async (run) =>
					run({
						async unsafe(query) {
							statements.push(query);
							if (query.includes("pg_available_extensions")) {
								return [{ extension_name: "hstore", default_version: "1.0" }];
							}
							if (query.includes("pg_available_extension_versions")) {
								return ["1.1", "2.0", "2.1"].map((version) => ({
									extension_name: "hstore",
									extension_version: version,
								}));
							}
							if (query.includes("pg_catalog.pg_extension ")) return [];
							if (query.includes("pg_extension_update_paths")) {
								return [
									{
										source_version: "1.0",
										target_version: "1.1",
										update_path: "1.0--1.1",
									},
									{
										source_version: "2.0",
										target_version: "2.1",
										update_path: "2.0--2.1",
									},
								];
							}
							return [];
						},
					}),
				async end() {},
			}),
			probes,
		);
		expect(
			statements.filter(
				(statement) =>
					statement.startsWith("CREATE EXTENSION") ||
					statement.startsWith("ALTER EXTENSION") ||
					statement.startsWith("DROP EXTENSION"),
			),
		).toEqual([
			'CREATE EXTENSION "hstore" WITH SCHEMA "extensions_v1"',
			`ALTER EXTENSION "hstore" UPDATE TO '1.1'`,
			'DROP EXTENSION "hstore"',
			`CREATE EXTENSION "hstore" WITH SCHEMA "extensions_v2" VERSION '2.0'`,
			`ALTER EXTENSION "hstore" UPDATE TO '2.1'`,
		]);
	});

	test("does not assign an installed version to a drop-and-recreate epoch", async () => {
		const probes = {
			hstore: {
				versionEpochs: [
					{
						schema: "extensions_v1",
						createVersion: "1.0",
						updateTargets: [],
						dropAfter: true,
					},
					{
						schema: "extensions_v2",
						createVersion: "2.0",
						updateTargets: [],
						dropAfter: false,
					},
				],
			},
		};
		await expect(
			verifyRequiredDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				() => ({
					begin: async (run) =>
						run({
							async unsafe(query) {
								if (query.includes("pg_available_extensions")) {
									return [{ extension_name: "hstore", default_version: "2.0" }];
								}
								if (query.includes("pg_available_extension_versions")) {
									return ["1.0", "2.0"].map((version) => ({
										extension_name: "hstore",
										extension_version: version,
									}));
								}
								if (query.includes("pg_catalog.pg_extension ")) {
									return [
										{
											extension_name: "hstore",
											extension_schema: "extensions_v3",
											extension_version: "3.0",
											can_manage_extension: true,
										},
									];
								}
								return [];
							},
						}),
					async end() {},
				}),
				probes,
			),
		).resolves.toBeUndefined();
	});

	test("post-migration verification enforces exact active subset, schema, and pinned version", async () => {
		const probes = {
			...DATABASE_EXTENSION_INSTALLABILITY_PROBES,
			hstore: {
				versionEpochs: [
					{ schema: "public", updateTargets: [], dropAfter: true },
				],
			},
		};
		const rows = REQUIRED_DATABASE_EXTENSIONS.map((extension) => ({
			extension_name: extension,
			extension_schema: REQUIRED_DATABASE_EXTENSION_SCHEMAS[extension],
			extension_version: extension === "vector" ? "0.8.0" : "1.6",
		}));
		const createClient =
			(
				resultRows: Array<Record<string, unknown>>,
				onClose: () => void = () => {},
			) =>
			() => ({
				begin: async <T>(
					run: (transaction: {
						unsafe: () => Promise<Record<string, unknown>[]>;
					}) => Promise<T>,
				) => run({ unsafe: async () => resultRows }),
				async end() {
					onClose();
				},
			});
		await expect(
			verifyMigratedDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				createClient(rows),
				{
					installabilityProbes: probes,
					activeVersions: {
						...REQUIRED_DATABASE_EXTENSION_VERSIONS,
						vector: "0.8.0",
					},
				},
			),
		).resolves.toBeUndefined();
		let closedAfterFailure = false;
		await expect(
			verifyMigratedDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				createClient(rows, () => {
					closedAfterFailure = true;
				}),
				{
					installabilityProbes: probes,
					activeVersions: {
						...REQUIRED_DATABASE_EXTENSION_VERSIONS,
						vector: "0.7.0",
					},
				},
			),
		).rejects.toThrow(
			"required PostgreSQL extension vector is at version 0.8.0, expected 0.7.0",
		);
		expect(closedAfterFailure).toBe(true);
		await expect(
			verifyMigratedDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				createClient(
					rows.map((row) =>
						row.extension_name === "vector"
							? { ...row, extension_schema: "legacy_extensions" }
							: row,
					),
				),
				{ installabilityProbes: probes },
			),
		).rejects.toThrow(
			"required PostgreSQL extension vector is in schema legacy_extensions, expected public",
		);
		await expect(
			verifyMigratedDatabaseExtensions(
				"postgresql://migration@example.invalid/relayapi",
				createClient([
					...rows,
					{
						extension_name: "hstore",
						extension_schema: "public",
						extension_version: "1.8",
					},
				]),
				{ installabilityProbes: probes },
			),
		).rejects.toThrow(
			"retired managed PostgreSQL extension hstore remains installed after migration",
		);
	});
});

describe("self-host migration connection preflight", () => {
	test("matches the deploy-time verify-full contract for remote databases", () => {
		expect(() =>
			validateMigrationDatabaseUrl(
				"postgresql://migration:secret@db.example.com/relayapi?sslmode=verify-full",
			),
		).not.toThrow();
		expect(() =>
			validateMigrationDatabaseUrl(
				"postgresql://migration:secret@db.example.com/relayapi?sslmode=require",
			),
		).toThrow("must use sslmode=verify-full");
	});

	test("allows loopback development connections", () => {
		expect(() =>
			validateMigrationDatabaseUrl(
				"postgresql://migration:secret@127.0.0.1:5433/relayapi",
			),
		).not.toThrow();
	});

	test("requires verify-full for a remote runtime connection", () => {
		expect(() =>
			validateRuntimeDatabaseUrl(
				"postgresql://runtime:secret@db.example.com/relayapi?sslmode=require",
			),
		).toThrow("runtime connections must use sslmode=verify-full");
		expect(() =>
			validateRuntimeDatabaseUrl(
				"postgresql://runtime:secret@db.example.com/relayapi?sslmode=verify-full",
			),
		).not.toThrow();
	});
});

test("deploy proves the database contract before Cloudflare apply and again after migration", () => {
	const source = readFileSync(
		new URL("../src/deploy.ts", import.meta.url),
		"utf8",
	);
	const databaseContract = source.indexOf(
		"await verifySelfHostDatabaseContract(",
	);
	const cloudflareApply = source.indexOf(
		"await reconcileCloudflareResources({",
	);
	const preflight = source.indexOf(
		"await verifyRequiredDatabaseExtensions(migrationDatabaseUrl)",
	);
	const migrate = source.indexOf(
		'await run("bun", ["run", "--cwd", "packages/db", "migrate"]',
	);
	const verify = source.indexOf(
		"await verifyMigratedDatabaseExtensions(migrationDatabaseUrl)",
	);
	const bootstrap = source.indexOf(
		'await run("bun", ["run", "scripts/bootstrap-self-host.ts"]',
	);
	const build = source.indexOf(
		'await run("bun", ["run", "--cwd", "apps/app", "build"]',
	);
	const workerDeploy = source.indexOf("await deployWorker(");
	const postMigrationContract = source.lastIndexOf(
		"await verifySelfHostDatabaseContract(",
	);
	expect(databaseContract).toBeGreaterThan(-1);
	expect(cloudflareApply).toBeGreaterThan(databaseContract);
	expect(preflight).toBeGreaterThan(-1);
	expect(migrate).toBeGreaterThan(-1);
	expect(preflight).toBeLessThan(migrate);
	expect(source.slice(preflight, migrate + 'await run("bun"'.length)).toMatch(
		/await verifyRequiredDatabaseExtensions\(migrationDatabaseUrl\);\n\s+await run\("bun"/,
	);
	expect(verify).toBeGreaterThan(migrate);
	expect(postMigrationContract).toBeGreaterThan(verify);
	expect(bootstrap).toBeGreaterThan(postMigrationContract);
	expect(bootstrap).toBeGreaterThan(verify);
	expect(build).toBeGreaterThan(verify);
	expect(workerDeploy).toBeGreaterThan(build);
});

test("doctor inspects the configured resources against the runtime origin", () => {
	const source = readFileSync(
		new URL("../src/doctor.ts", import.meta.url),
		"utf8",
	);
	expect(source).toContain("const plan = await client.plan(");
	expect(source).toContain('required("RELAYAPI_RUNTIME_DATABASE_URL")');
	expect(source).toContain("requestedCaCertificateId:");
	expect(source).toContain("Hyperdrive CA certificate intent:");
	expect(source).toContain("Hyperdrive password is write-only");
});
