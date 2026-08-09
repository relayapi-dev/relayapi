import postgres from "postgres";
import {
	assertDatabaseIdentity,
	assertMigrationAndRuntimeRoles,
	assertRuntimeConnectionCannotDdl,
	assertSchemaRoleContract,
	assertSupportedPostgres,
	verifyDatabaseSemanticCapabilities,
} from "../../db/src/database-contract.js";
import {
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	type DatabaseExtensionInstallabilityProbe,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSION_VERSIONS,
	REQUIRED_DATABASE_EXTENSIONS,
} from "../../db/src/database-prerequisites.js";
import { CloudflareClient, parsePostgresUrl } from "./cloudflare.js";
import { readConfig, readLock } from "./config.js";
import { commandExists } from "./process.js";
import type { CliOptions } from "./types.js";

export {
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSION_VERSIONS,
	REQUIRED_DATABASE_EXTENSIONS,
};

const ENCRYPTION_KEY_ENTRY = /^([A-Za-z0-9_-]{1,32})=([a-fA-F0-9]{64})$/;

export function validateEncryptionKeyRing(value: string): void {
	const entries = value.split(",").map((entry) => entry.trim());
	const keyIds = new Set<string>();
	const keyMaterials = new Set<string>();
	for (const entry of entries) {
		const match = ENCRYPTION_KEY_ENTRY.exec(entry);
		if (!match) {
			throw new Error(
				"ENCRYPTION_KEY must use comma-separated key-id=64hex entries",
			);
		}
		const keyId = match[1] as string;
		if (keyIds.has(keyId)) {
			throw new Error(`ENCRYPTION_KEY contains duplicate key id ${keyId}`);
		}
		const keyMaterial = (match[2] as string).toLowerCase();
		if (keyMaterials.has(keyMaterial)) {
			throw new Error("ENCRYPTION_KEY entries must use distinct key material");
		}
		keyIds.add(keyId);
		keyMaterials.add(keyMaterial);
	}
	if (entries[0]?.startsWith("identity=")) {
		throw new Error(
			"ENCRYPTION_KEY identity entry is retained authority material and cannot be active",
		);
	}
	if (!keyIds.has("identity")) {
		throw new Error(
			"ENCRYPTION_KEY must retain an immutable identity=64hex entry",
		);
	}
}

export function validateBetterAuthSecret(value: string): void {
	if (Buffer.byteLength(value, "utf8") < 32) {
		throw new Error("BETTER_AUTH_SECRET must contain at least 32 bytes");
	}
}

type ProbeTransaction = {
	unsafe: (query: string) => Promise<Record<string, unknown>[]>;
};

type ProbeClient = {
	begin: <T>(run: (transaction: ProbeTransaction) => Promise<T>) => Promise<T>;
	end: (options?: { timeout?: number }) => Promise<void>;
};

type ProbeFactory = (
	connectionString: string,
	options: {
		max: number;
		prepare: boolean;
		connect_timeout: number;
		idle_timeout: number;
	},
) => ProbeClient;

const DATABASE_EXTENSION_PROBE_ROLLBACK = Symbol(
	"database-extension-probe-rollback",
);

function sqlIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function extensionNameList(extensions: readonly string[]): string {
	return extensions.map(sqlLiteral).join(", ");
}

type ExtensionUpdatePaths = ReadonlyMap<string, string | null>;

function updatePathKey(source: string, target: string): string {
	return `${source}\0${target}`;
}

function requireReachableUpdatePath(input: {
	extension: string;
	source: string;
	target: string;
	paths: ExtensionUpdatePaths;
	context: string;
}): void {
	if (input.source === input.target) return;
	const path = input.paths.get(updatePathKey(input.source, input.target));
	if (typeof path !== "string" || !path.trim()) {
		throw new Error(
			`PostgreSQL extension ${input.extension} has no reachable update path from ${input.source} to ${input.target} required by ${input.context}`,
		);
	}
}

/**
 * Pre-migration capability check. Every extension ever created by the bundled
 * history must remain available for clean replay, including every ordered
 * UPDATE target. Existing managed extensions may still be in an older schema
 * or version, but the migration role must own them. Only the source-owned
 * verifier running under the migration advisory lock may interpret their
 * current state against the applied ledger prefix. Missing extensions replay
 * every create/update/drop epoch inside a transaction that always rolls back.
 */
export async function verifyRequiredDatabaseExtensions(
	connectionString: string,
	createClient: ProbeFactory = postgres as unknown as ProbeFactory,
	installabilityProbes: Readonly<
		Record<string, DatabaseExtensionInstallabilityProbe>
	> = DATABASE_EXTENSION_INSTALLABILITY_PROBES,
): Promise<void> {
	const client = createClient(connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 10,
		idle_timeout: 5,
	});
	try {
		try {
			await client.begin(async (transaction) => {
				const extensions = Object.keys(installabilityProbes);
				const names = extensionNameList(extensions);
				const availableRows = await transaction.unsafe(
					`SELECT available_extension.name AS extension_name,
						available_extension.default_version AS default_version
					FROM pg_catalog.pg_available_extensions available_extension
					WHERE available_extension.name IN (${names})
					ORDER BY available_extension.name`,
				);
				const available = new Map(
					availableRows.map((row) => [
						String(row.extension_name),
						row.default_version === null || row.default_version === undefined
							? undefined
							: String(row.default_version),
					]),
				);
				for (const extension of extensions) {
					if (!available.has(extension)) {
						throw new Error(
							`historical PostgreSQL extension ${extension} is unavailable for clean migration replay`,
						);
					}
					const probe = installabilityProbes[extension];
					if (!probe || probe.versionEpochs.length === 0) {
						throw new Error(
							`historical PostgreSQL extension ${extension} has no version lifecycle epoch`,
						);
					}
					for (const [epochIndex, epoch] of probe.versionEpochs.entries()) {
						if (!epoch.schema.trim()) {
							throw new Error(
								`historical PostgreSQL extension ${extension} lifecycle epoch ${epochIndex + 1} has no probe schema`,
							);
						}
						if (
							epoch.createVersion !== undefined &&
							!epoch.createVersion.trim()
						) {
							throw new Error(
								`historical PostgreSQL extension ${extension} lifecycle epoch ${epochIndex + 1} has an empty CREATE version`,
							);
						}
						if (epoch.updateTargets.some((target) => !target.trim())) {
							throw new Error(
								`historical PostgreSQL extension ${extension} lifecycle epoch ${epochIndex + 1} has an empty UPDATE target`,
							);
						}
						if (
							epochIndex < probe.versionEpochs.length - 1 &&
							!epoch.dropAfter
						) {
							throw new Error(
								`historical PostgreSQL extension ${extension} lifecycle epoch ${epochIndex + 1} must drop before the next CREATE epoch`,
							);
						}
						if (
							epoch.createVersion === undefined &&
							!available.get(extension)?.trim()
						) {
							throw new Error(
								`historical PostgreSQL extension ${extension} has no provider default version for clean migration replay`,
							);
						}
					}
				}
				const pinnedVersions = extensions.flatMap((extension) =>
					(installabilityProbes[extension]?.versionEpochs ?? [])
						.flatMap((epoch) => [
							...(epoch.createVersion ? [epoch.createVersion] : []),
							...epoch.updateTargets,
						])
						.filter(
							(version, index, versions) => versions.indexOf(version) === index,
						)
						.map((version) => ({ extension, version })),
				);
				if (pinnedVersions.length > 0) {
					const versionRows = await transaction.unsafe(
						`SELECT available_version.name AS extension_name,
							available_version.version AS extension_version
						FROM pg_catalog.pg_available_extension_versions available_version
						WHERE available_version.name IN (${names})
						ORDER BY available_version.name, available_version.version`,
					);
					const availableVersions = new Set(
						versionRows.map(
							(row) =>
								`${String(row.extension_name)}\0${String(row.extension_version)}`,
						),
					);
					for (const { extension, version } of pinnedVersions) {
						if (!availableVersions.has(`${extension}\0${version}`)) {
							throw new Error(
								`historical PostgreSQL extension ${extension} version ${version} is unavailable for clean migration replay`,
							);
						}
					}
				}

				const installedRows = await transaction.unsafe(
					`SELECT extension_row.extname AS extension_name,
						pg_catalog.pg_has_role(current_user, extension_row.extowner, 'USAGE') AS can_manage_extension
					FROM pg_catalog.pg_extension extension_row
					WHERE extension_row.extname IN (${names})
					ORDER BY extension_row.extname`,
				);
				const installed = new Set<string>();
				for (const row of installedRows) {
					const extension = String(row.extension_name);
					installed.add(extension);
					if (row.can_manage_extension !== true) {
						throw new Error(
							`migration role cannot manage installed PostgreSQL extension ${extension}`,
						);
					}
				}

				const updatePaths = new Map<string, ExtensionUpdatePaths>();
				for (const extension of extensions) {
					const probe = installabilityProbes[
						extension
					] as DatabaseExtensionInstallabilityProbe;
					if (
						!probe.versionEpochs.some((epoch) => epoch.updateTargets.length > 0)
					) {
						continue;
					}
					const pathRows = await transaction.unsafe(
						`SELECT update_path.source AS source_version,
							update_path.target AS target_version,
							update_path.path AS update_path
						FROM pg_catalog.pg_extension_update_paths(${sqlLiteral(extension)}) update_path
						ORDER BY update_path.source, update_path.target`,
					);
					const paths = new Map<string, string | null>();
					for (const row of pathRows) {
						paths.set(
							updatePathKey(
								String(row.source_version),
								String(row.target_version),
							),
							row.update_path === null || row.update_path === undefined
								? null
								: String(row.update_path),
						);
					}
					updatePaths.set(extension, paths);
				}

				for (const extension of extensions) {
					const probe = installabilityProbes[
						extension
					] as DatabaseExtensionInstallabilityProbe;
					const paths = updatePaths.get(extension) ?? new Map();
					for (const [epochIndex, epoch] of probe.versionEpochs.entries()) {
						let source =
							epoch.createVersion ?? (available.get(extension) as string);
						for (const target of epoch.updateTargets) {
							requireReachableUpdatePath({
								extension,
								source,
								target,
								paths,
								context: `clean migration replay lifecycle epoch ${epochIndex + 1}`,
							});
							source = target;
						}
					}
				}

				const preparedProbeSchemas = new Set<string>();
				for (const extension of extensions) {
					if (installed.has(extension)) continue;
					const probe = installabilityProbes[
						extension
					] as DatabaseExtensionInstallabilityProbe;
					for (const epoch of probe.versionEpochs) {
						if (!preparedProbeSchemas.has(epoch.schema)) {
							await transaction.unsafe(
								`CREATE SCHEMA IF NOT EXISTS ${sqlIdentifier(epoch.schema)}`,
							);
							preparedProbeSchemas.add(epoch.schema);
						}
						await transaction.unsafe(
							`CREATE EXTENSION ${sqlIdentifier(extension)} WITH SCHEMA ${sqlIdentifier(epoch.schema)}${epoch.createVersion ? ` VERSION ${sqlLiteral(epoch.createVersion)}` : ""}`,
						);
						for (const target of epoch.updateTargets) {
							await transaction.unsafe(
								`ALTER EXTENSION ${sqlIdentifier(extension)} UPDATE TO ${sqlLiteral(target)}`,
							);
						}
						if (epoch.dropAfter) {
							await transaction.unsafe(
								`DROP EXTENSION ${sqlIdentifier(extension)}`,
							);
						}
					}
				}
				throw DATABASE_EXTENSION_PROBE_ROLLBACK;
			});
		} catch (error) {
			if (error !== DATABASE_EXTENSION_PROBE_ROLLBACK) throw error;
		}
	} finally {
		await client.end({ timeout: 5 });
	}
}

/**
 * Post-migration exact-state check. Among every extension RelayAPI has ever
 * managed, precisely the current active set may remain installed, in its exact
 * schema and (when pinned) version.
 */
export async function verifyMigratedDatabaseExtensions(
	connectionString: string,
	createClient: ProbeFactory = postgres as unknown as ProbeFactory,
	input: {
		installabilityProbes?: Readonly<
			Record<string, DatabaseExtensionInstallabilityProbe>
		>;
		activeExtensions?: readonly string[];
		activeSchemas?: Readonly<Record<string, string>>;
		activeVersions?: Readonly<Record<string, string | undefined>>;
	} = {},
): Promise<void> {
	const installabilityProbes: Readonly<
		Record<string, DatabaseExtensionInstallabilityProbe>
	> = input.installabilityProbes ?? DATABASE_EXTENSION_INSTALLABILITY_PROBES;
	const activeExtensions: readonly string[] =
		input.activeExtensions ?? REQUIRED_DATABASE_EXTENSIONS;
	const activeSchemas: Readonly<Record<string, string>> =
		input.activeSchemas ?? REQUIRED_DATABASE_EXTENSION_SCHEMAS;
	const activeVersions: Readonly<Record<string, string | undefined>> =
		input.activeVersions ?? REQUIRED_DATABASE_EXTENSION_VERSIONS;
	const knownExtensions = Object.keys(installabilityProbes);
	const client = createClient(connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 10,
		idle_timeout: 5,
	});
	try {
		await client.begin(async (transaction) => {
			const rows = await transaction.unsafe(
				`SELECT extension_row.extname AS extension_name,
					namespace_row.nspname AS extension_schema,
					extension_row.extversion AS extension_version
				FROM pg_catalog.pg_extension extension_row
				JOIN pg_catalog.pg_namespace namespace_row
					ON namespace_row.oid = extension_row.extnamespace
				WHERE extension_row.extname IN (${extensionNameList(knownExtensions)})
				ORDER BY extension_row.extname`,
			);
			const installed = new Map(
				rows.map((row) => [
					String(row.extension_name),
					{
						schema: String(row.extension_schema),
						version: String(row.extension_version),
					},
				]),
			);
			for (const extension of installed.keys()) {
				if (!activeExtensions.includes(extension)) {
					throw new Error(
						`retired managed PostgreSQL extension ${extension} remains installed after migration`,
					);
				}
			}
			for (const extension of activeExtensions) {
				const state = installed.get(extension);
				if (!state) {
					throw new Error(
						`required PostgreSQL extension ${extension} is not installed after migration`,
					);
				}
				if (state.schema !== activeSchemas[extension]) {
					throw new Error(
						`required PostgreSQL extension ${extension} is in schema ${state.schema}, expected ${activeSchemas[extension]}`,
					);
				}
				const expectedVersion = activeVersions[extension];
				if (
					expectedVersion !== undefined &&
					state.version !== expectedVersion
				) {
					throw new Error(
						`required PostgreSQL extension ${extension} is at version ${state.version}, expected ${expectedVersion}`,
					);
				}
			}
		});
	} finally {
		await client.end({ timeout: 5 });
	}
}

export function validateMigrationDatabaseUrl(value: string) {
	const parsed = parsePostgresUrl(value);
	const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
	if (!loopbackHosts.has(parsed.hostname) && parsed.sslmode !== "verify-full") {
		throw new Error(
			"Non-loopback migration connections must use sslmode=verify-full",
		);
	}
	return parsed;
}

export function validateRuntimeDatabaseUrl(value: string) {
	const parsed = parsePostgresUrl(value);
	const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
	if (!loopbackHosts.has(parsed.hostname) && parsed.sslmode !== "verify-full") {
		throw new Error(
			"Non-loopback runtime connections must use sslmode=verify-full",
		);
	}
	return parsed;
}

function assertSameDatabaseOrigin(
	migration: ReturnType<typeof parsePostgresUrl>,
	runtime: ReturnType<typeof parsePostgresUrl>,
): void {
	if (
		migration.hostname !== runtime.hostname ||
		migration.port !== runtime.port ||
		migration.database !== runtime.database
	) {
		throw new Error(
			"Migration and runtime database URLs must target the same host, port, and database",
		);
	}
	if (migration.username === runtime.username) {
		throw new Error(
			"Migration and runtime database URLs must use different roles",
		);
	}
}

/**
 * Source-owned database contract used by both doctor and deploy before any
 * Cloudflare resource mutation. It proves server major, exact database/role
 * identity, no-DDL runtime authority, and the pgvector/HNSW/pg_trgm operations
 * the schema relies on.
 */
export async function verifySelfHostDatabaseContract(
	migrationDatabaseUrl: string,
	runtimeDatabaseUrl: string,
	options: { postMigration?: boolean } = {},
): Promise<void> {
	const migration = validateMigrationDatabaseUrl(migrationDatabaseUrl);
	const runtime = validateRuntimeDatabaseUrl(runtimeDatabaseUrl);
	assertSameDatabaseOrigin(migration, runtime);

	if (!options.postMigration) {
		await verifyRequiredDatabaseExtensions(migrationDatabaseUrl);
	}
	const sql = postgres(migrationDatabaseUrl, {
		max: 1,
		prepare: false,
		connect_timeout: 10,
		idle_timeout: 5,
	});
	try {
		await assertDatabaseIdentity(sql, migration.database);
		await assertSupportedPostgres(sql);
		await assertMigrationAndRuntimeRoles(sql, runtime.username);
		await assertSchemaRoleContract(sql, {
			runtimeRole: runtime.username,
			schemas: ["public", "auth", "drizzle"],
		});
		await verifyDatabaseSemanticCapabilities(sql, {
			installMissing: !options.postMigration,
		});
	} finally {
		await sql.end({ timeout: 5 });
	}
	await assertRuntimeConnectionCannotDdl(
		runtimeDatabaseUrl,
		runtime.username,
		runtime.database,
	);
}

export async function doctor(options: CliOptions): Promise<void> {
	const checks: Array<[string, () => Promise<void>]> = [
		[
			"configuration",
			async () => {
				await readConfig(options.configPath);
				const lock = await readLock(options.configPath);
				if (!lock.sourceArchiveSha256) {
					throw new Error(
						"relayapi.lock.json is not sealed; run upgrade before doctor or deploy",
					);
				}
			},
		],
		[
			"Bun",
			async () => {
				if (!(await commandExists("bun")))
					throw new Error("bun is not installed");
			},
		],
		[
			"tar",
			async () => {
				if (!(await commandExists("tar")))
					throw new Error("tar is not installed");
			},
		],
		[
			"database URLs",
			async () => {
				const migration = validateMigrationDatabaseUrl(
					required("RELAYAPI_MIGRATION_DATABASE_URL"),
				);
				const runtime = validateRuntimeDatabaseUrl(
					required("RELAYAPI_RUNTIME_DATABASE_URL"),
				);
				assertSameDatabaseOrigin(migration, runtime);
			},
		],
		[
			"PostgreSQL 18 database and runtime-role contract",
			async () => {
				await verifySelfHostDatabaseContract(
					required("RELAYAPI_MIGRATION_DATABASE_URL"),
					required("RELAYAPI_RUNTIME_DATABASE_URL"),
				);
			},
		],
		[
			"deployment secrets",
			async () => {
				const config = await readConfig(options.configPath);
				for (const name of [
					"ENCRYPTION_KEY",
					"BETTER_AUTH_SECRET",
					"R2_ACCESS_KEY_ID",
					"R2_SECRET_ACCESS_KEY",
					"RELAYAPI_ADMIN_EMAIL",
					"RELAYAPI_ADMIN_PASSWORD",
				]) {
					required(name);
				}
				validateEncryptionKeyRing(required("ENCRYPTION_KEY"));
				validateBetterAuthSecret(required("BETTER_AUTH_SECRET"));
				if (required("RELAYAPI_ADMIN_PASSWORD").length < 12) {
					throw new Error(
						"RELAYAPI_ADMIN_PASSWORD must contain at least 12 characters",
					);
				}
				if (config.features.email) required("RESEND_API_KEY");
				if (config.features.ai) required("OPENAI_API_KEY");
				if (config.features.downloader) {
					required("DOWNLOADER_SERVICE_URL");
					required("DOWNLOADER_SERVICE_KEY");
				}
			},
		],
		[
			"Cloudflare access",
			async () => {
				const config = await readConfig(options.configPath);
				const accountId = required("CLOUDFLARE_ACCOUNT_ID");
				if (config.cloudflare.accountId !== accountId) {
					throw new Error("Cloudflare account ID does not match the config");
				}
				const client = new CloudflareClient(
					accountId,
					required("CLOUDFLARE_API_TOKEN"),
				);
				await client.verifyAccess(config.cloudflare.zoneId);
				const plan = await client.plan(
					config,
					required("RELAYAPI_RUNTIME_DATABASE_URL"),
					options.hyperdriveCaCertificateId
						? {
								requestedCaCertificateId: options.hyperdriveCaCertificateId,
							}
						: {},
				);
				console.log(
					`Hyperdrive CA certificate intent: ${plan.hyperdrive.caCertificateAction} ${plan.hyperdrive.caCertificateId}`,
				);
				if (plan.hyperdrive.caCertificateAction === "adopt") {
					console.warn(
						`! Legacy config: the next successful configure or deploy will pin Hyperdrive CA certificate ${plan.hyperdrive.caCertificateId} in relayapi.selfhost.json`,
					);
				}
				if (plan.hyperdrive.visibleDrift.length > 0) {
					console.warn(
						`! Hyperdrive has repairable drift: ${plan.hyperdrive.visibleDrift.join(", ")}`,
					);
				}
				if (plan.hyperdrive.action === "reconcile") {
					console.warn(
						"! Hyperdrive password is write-only and cannot be attested by doctor; deploy will reapply it",
					);
				}
			},
		],
	];

	for (const [name, check] of checks) {
		try {
			await check();
			console.log(`✓ ${name}`);
		} catch (error) {
			console.error(
				`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}
	}
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
