import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import generationMetadata from "../baseline-generation.json";
import {
	assertDatabaseIdentity,
	assertMigrationAndRuntimeRoles,
	assertRuntimeConnectionCannotDdl,
	assertSchemaRoleContract,
	assertSupportedPostgres,
	verifyDatabaseSemanticCapabilities,
} from "../src/database-contract";
import {
	assertLiveResetGuardShape,
	canonicalDatabaseInventory,
	captureDatabaseInventoryOnTransaction,
	databaseInventorySha256,
	PRELIVE_INVENTORY_EXCLUDED_SCHEMA,
	type PreliveDatabaseInventory,
	parseDatabaseInventory,
} from "./prelive-database-inventory";
import {
	COLLAPSE_BASELINE_EXTENSIONS,
	COLLAPSE_BASELINE_SCHEMAS,
} from "./render-baseline-preamble-sql";
import {
	type MigrationManifest,
	verifyLiveMigrationHistory,
} from "./verify-migration-history";

const EXPECTED_GENERATION = 2;
const CONFIRMATION = "WIPE-DISPOSABLE-PRELIVE-GENERATION-2";
const CONNECTION_ENV =
	"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
const RUNTIME_CONNECTION_ENV = "PRELIVE_RUNTIME_DATABASE_URL";
const SENTINEL_SCHEMA = PRELIVE_INVENTORY_EXCLUDED_SCHEMA;
const SENTINEL_TABLE = "reset_sentinel";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function assertCutoverGeneration(): void {
	if (
		generationMetadata.generation !== EXPECTED_GENERATION ||
		generationMetadata.lifecycle !== "sealed" ||
		generationMetadata.transition.kind !== "collapse"
	) {
		throw new Error(
			"Pre-live reset is authorized only from the sealed generation-2 collapse",
		);
	}
}

function validateConnection(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new Error("Cutover database URL must use PostgreSQL");
	}
	const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
	if (
		!loopback.has(url.hostname) &&
		url.searchParams.get("sslmode") !== "verify-full"
	) {
		throw new Error(
			"Remote cutover database URL must require sslmode=verify-full",
		);
	}
	const runtimeRole = process.env.DATABASE_RUNTIME_ROLE ?? "relayapi_runtime";
	if (decodeURIComponent(url.username) === runtimeRole) {
		throw new Error("The no-DDL runtime role cannot perform a pre-live reset");
	}
	return url;
}

function validateRuntimeConnection(value: string, runtimeRole: string): URL {
	const url = new URL(value);
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new Error("Cutover runtime database URL must use PostgreSQL");
	}
	const loopback = new Set(["127.0.0.1", "::1", "localhost"]);
	if (
		!loopback.has(url.hostname) &&
		url.searchParams.get("sslmode") !== "verify-full"
	) {
		throw new Error(
			"Remote cutover runtime database URL must require sslmode=verify-full",
		);
	}
	if (decodeURIComponent(url.username) !== runtimeRole) {
		throw new Error(
			`Cutover runtime database URL must authenticate as ${runtimeRole}`,
		);
	}
	return url;
}

function expectedLedger(): {
	manifest: MigrationManifest;
	manifestText: string;
	manifestSha256: string;
} {
	const path = required("PRELIVE_EXPECTED_LEDGER_MANIFEST");
	const text = readFileSync(path, "utf8");
	const manifestSha256 = sha256(text);
	const transition = generationMetadata.transition as {
		kind: string;
		baseManifestSha256?: string;
	};
	if (
		transition.kind !== "collapse" ||
		typeof transition.baseManifestSha256 !== "string" ||
		manifestSha256 !== transition.baseManifestSha256
	) {
		throw new Error(
			"Generation-1 ledger manifest does not match the sealed collapse base",
		);
	}
	return {
		manifest: JSON.parse(text) as MigrationManifest,
		manifestText: text,
		manifestSha256,
	};
}

export function validateApprovedDatabaseInventoryArtifact(
	source: string,
	input: {
		databaseInventorySha256: string;
		aggregateInventorySha256: string;
	},
): {
	inventory: PreliveDatabaseInventory;
	databaseSha256: string;
	aggregateSha256: string;
} {
	if (!/^[0-9a-f]{64}$/.test(input.databaseInventorySha256)) {
		throw new Error(
			"PRELIVE_APPROVED_DATABASE_INVENTORY_SHA256 must be a SHA-256 digest",
		);
	}
	if (!/^[0-9a-f]{64}$/.test(input.aggregateInventorySha256)) {
		throw new Error(
			"PRELIVE_APPROVED_INVENTORY_SHA256 must be a SHA-256 digest",
		);
	}
	if (sha256(source) !== input.databaseInventorySha256) {
		throw new Error(
			"Approved database inventory file bytes do not match PRELIVE_APPROVED_DATABASE_INVENTORY_SHA256",
		);
	}
	return {
		inventory: parseDatabaseInventory(source),
		databaseSha256: input.databaseInventorySha256,
		aggregateSha256: input.aggregateInventorySha256,
	};
}

function approvedDatabaseInventory(): ReturnType<
	typeof validateApprovedDatabaseInventoryArtifact
> {
	return validateApprovedDatabaseInventoryArtifact(
		readFileSync(required("PRELIVE_APPROVED_DATABASE_INVENTORY"), "utf8"),
		{
			databaseInventorySha256: required(
				"PRELIVE_APPROVED_DATABASE_INVENTORY_SHA256",
			),
			aggregateInventorySha256: required("PRELIVE_APPROVED_INVENTORY_SHA256"),
		},
	);
}

function relationParts(relation: string): { schema: string; name: string } {
	const parts = relation.split(".");
	if (
		parts.length !== 2 ||
		!parts[0] ||
		!parts[1] ||
		parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))
	) {
		throw new Error(`Approved inventory has invalid relation ${relation}`);
	}
	return { schema: parts[0], name: parts[1] };
}

export function approvedDatabaseInventoryLockTargets(
	inventory: PreliveDatabaseInventory,
): { tables: string[]; sequences: string[] } {
	const tables = inventory.tables.map(({ relation }) => relation).sort();
	const sequences = inventory.sequences.map(({ relation }) => relation).sort();
	for (const relation of [...tables, ...sequences]) {
		const { schema } = relationParts(relation);
		if (schema === SENTINEL_SCHEMA) {
			throw new Error(
				`Approved inventory must exclude sentinel relation ${relation}`,
			);
		}
	}
	if (new Set(tables).size !== tables.length) {
		throw new Error("Approved inventory contains duplicate tables");
	}
	if (new Set(sequences).size !== sequences.length) {
		throw new Error("Approved inventory contains duplicate sequences");
	}
	return { tables, sequences };
}

export function assertResetCatalogAllowlist(
	inventory: PreliveDatabaseInventory,
): void {
	const allowedSchemas = new Set([
		"public",
		"drizzle",
		...COLLAPSE_BASELINE_SCHEMAS,
	]);
	const allowedExtensions = new Set(COLLAPSE_BASELINE_EXTENSIONS);
	const unexpectedSchemas = inventory.catalog.objects
		.filter(
			(object) =>
				object.kind === "schema" && !allowedSchemas.has(object.identity),
		)
		.map(({ identity }) => identity);
	const unexpectedExtensions = inventory.catalog.objects
		.filter(
			(object) =>
				object.kind === "extension" &&
				!allowedExtensions.has(
					object.identity as (typeof COLLAPSE_BASELINE_EXTENSIONS)[number],
				),
		)
		.map(({ identity }) => identity);
	if (unexpectedSchemas.length > 0 || unexpectedExtensions.length > 0) {
		throw new Error(
			`Approved inventory contains reset-unsafe schemas/extensions: ${[
				...unexpectedSchemas.map((name) => `schema:${name}`),
				...unexpectedExtensions.map((name) => `extension:${name}`),
			].join(", ")}`,
		);
	}
}

async function commonPreflight(
	sql: postgres.Sql,
	input: {
		checkLedger: boolean;
		installMissingExtensions: boolean;
		requireFinalOwners: boolean;
	},
): Promise<{
	runtimeRole: string;
	ownerRole: string;
	migrationRole: string;
	manifestSha256?: string;
}> {
	const expectedDatabase = required("PRELIVE_EXPECTED_DATABASE");
	const runtimeRole = process.env.DATABASE_RUNTIME_ROLE ?? "relayapi_runtime";
	const ownerRole = process.env.DATABASE_OWNER_ROLE ?? "relayapi_owner";
	await assertDatabaseIdentity(sql, expectedDatabase);
	await assertSupportedPostgres(sql);
	const { migrationRole } = await assertMigrationAndRuntimeRoles(
		sql,
		runtimeRole,
		ownerRole,
	);
	await assertSchemaRoleContract(sql, {
		runtimeRole,
		schemas: ["public", ...COLLAPSE_BASELINE_SCHEMAS, "drizzle"],
		...(input.requireFinalOwners ? { expectedOwnerRole: ownerRole } : {}),
	});
	await verifyDatabaseSemanticCapabilities(sql, {
		installMissing: input.installMissingExtensions,
	});
	await assertRuntimeConnectionCannotDdl(
		required(RUNTIME_CONNECTION_ENV),
		runtimeRole,
		expectedDatabase,
	);
	let manifestSha256: string | undefined;
	if (input.checkLedger) {
		const expected = expectedLedger();
		await verifyLiveMigrationHistory(sql, expected.manifest, {
			requireCurrent: true,
		});
		manifestSha256 = expected.manifestSha256;
	}
	console.log(
		JSON.stringify({
			event: "prelive_database_preflight_passed",
			role: migrationRole,
			database: expectedDatabase,
			runtime_role: runtimeRole,
			owner_role: ownerRole,
			postgres_major: 18,
			...(manifestSha256 ? { ledger_manifest_sha256: manifestSha256 } : {}),
		}),
	);
	return { runtimeRole, ownerRole, migrationRole, manifestSha256 };
}

async function armResetSentinel(sql: postgres.Sql): Promise<void> {
	const { manifestSha256 } = await commonPreflight(sql, {
		checkLedger: true,
		installMissingExtensions: false,
		requireFinalOwners: false,
	});
	if (!manifestSha256)
		throw new Error("Generation-1 ledger hash is unavailable");
	const sentinelHash = sha256(required("PRELIVE_RESET_SENTINEL"));
	const approvedInventorySha256 = required("PRELIVE_APPROVED_INVENTORY_SHA256");
	if (!/^[0-9a-f]{64}$/.test(approvedInventorySha256)) {
		throw new Error(
			"PRELIVE_APPROVED_INVENTORY_SHA256 must be a SHA-256 digest",
		);
	}
	const expectedDatabase = required("PRELIVE_EXPECTED_DATABASE");
	await sql.begin(async (transaction) => {
		await transaction`SELECT pg_advisory_xact_lock(hashtext('relayapi:prelive-generation-2-reset'))`;
		await assertLiveResetGuardShape(transaction as unknown as postgres.Sql, {
			allowAbsent: true,
		});
		await transaction.unsafe(
			`CREATE SCHEMA IF NOT EXISTS ${identifier(SENTINEL_SCHEMA)}`,
		);
		await transaction.unsafe(
			`CREATE TABLE IF NOT EXISTS ${identifier(SENTINEL_SCHEMA)}.${identifier(SENTINEL_TABLE)} (
				id boolean PRIMARY KEY DEFAULT true CHECK (id),
				sentinel_sha256 text NOT NULL CHECK (sentinel_sha256 ~ '^[0-9a-f]{64}$'),
				expected_database text NOT NULL,
				base_manifest_sha256 text NOT NULL CHECK (base_manifest_sha256 ~ '^[0-9a-f]{64}$'),
				approved_inventory_sha256 text NOT NULL CHECK (approved_inventory_sha256 ~ '^[0-9a-f]{64}$'),
				armed_at timestamptz NOT NULL DEFAULT now()
			)`,
		);
		await transaction.unsafe(
			`DELETE FROM ${identifier(SENTINEL_SCHEMA)}.${identifier(SENTINEL_TABLE)}`,
		);
		await transaction`
			INSERT INTO relayapi_cutover_guard.reset_sentinel (
				id,
				sentinel_sha256,
				expected_database,
				base_manifest_sha256,
				approved_inventory_sha256
			)
			VALUES (true, ${sentinelHash}, ${expectedDatabase}, ${manifestSha256}, ${approvedInventorySha256})
		`;
	});
	console.log(
		JSON.stringify({
			event: "prelive_database_reset_sentinel_armed",
			database: expectedDatabase,
			base_manifest_sha256: manifestSha256,
			approved_inventory_sha256: approvedInventorySha256,
		}),
	);
}

async function resetSchemas(
	sql: postgres.Sql,
	ownerRole: string,
): Promise<void> {
	if (required("PRELIVE_RESET_CONFIRMATION") !== CONFIRMATION) {
		throw new Error(`PRELIVE_RESET_CONFIRMATION must equal ${CONFIRMATION}`);
	}
	const expectedDatabase = required("PRELIVE_EXPECTED_DATABASE");
	const sentinelHash = sha256(required("PRELIVE_RESET_SENTINEL"));
	const approved = approvedDatabaseInventory();
	const ledger = expectedLedger();
	if (
		approved.inventory.database !== expectedDatabase ||
		approved.inventory.migrationManifestSha256 !== ledger.manifestSha256
	) {
		throw new Error(
			"Approved inventory targets another database or generation-1 ledger",
		);
	}
	assertResetCatalogAllowlist(approved.inventory);
	const lockTargets = approvedDatabaseInventoryLockTargets(approved.inventory);
	await sql.begin(async (transaction) => {
		await transaction`SET LOCAL lock_timeout = '10s'`;
		await transaction`SET LOCAL statement_timeout = '5min'`;
		await transaction`SELECT pg_advisory_xact_lock(hashtext('relayapi:prelive-generation-2-reset'))`;
		await assertLiveResetGuardShape(transaction as unknown as postgres.Sql, {
			allowAbsent: false,
		});
		const consumed = await transaction<
			Array<{
				sentinel_sha256: string;
				expected_database: string;
				base_manifest_sha256: string;
				approved_inventory_sha256: string;
			}>
		>`
			DELETE FROM relayapi_cutover_guard.reset_sentinel
			WHERE id = true
			RETURNING sentinel_sha256, expected_database, base_manifest_sha256,
				approved_inventory_sha256
		`;
		const sentinel = consumed[0];
		if (
			!sentinel ||
			sentinel.sentinel_sha256 !== sentinelHash ||
			sentinel.expected_database !== expectedDatabase ||
			sentinel.base_manifest_sha256 !== ledger.manifestSha256 ||
			sentinel.approved_inventory_sha256 !== approved.aggregateSha256
		) {
			throw new Error(
				"One-use pre-live reset sentinel is absent, stale, or targets another database",
			);
		}
		for (const relation of lockTargets.tables) {
			const { schema, name } = relationParts(relation);
			await transaction.unsafe(
				`LOCK TABLE ONLY ${identifier(schema)}.${identifier(name)} IN ACCESS EXCLUSIVE MODE`,
			);
		}
		for (const relation of lockTargets.sequences) {
			const { schema, name } = relationParts(relation);
			const owners = await transaction.unsafe<Array<{ owner_name: string }>>(
				`SELECT pg_get_userbyid(relation_row.relowner) AS owner_name
				FROM pg_catalog.pg_class AS relation_row
				JOIN pg_catalog.pg_namespace AS namespace_row
					ON namespace_row.oid = relation_row.relnamespace
				WHERE namespace_row.nspname = $1
					AND relation_row.relname = $2
					AND relation_row.relkind = 'S'`,
				[schema, name],
			);
			if (owners.length !== 1 || owners[0]?.owner_name !== ownerRole) {
				throw new Error(
					`Approved sequence ${relation} is absent or not owned by ${ownerRole}`,
				);
			}
			// ALTER SEQUENCE takes the sequence lock that conflicts with every
			// state-changing sequence function. Reassigning the existing owner is
			// a transactional no-op and holds that lock through the schema drop.
			await transaction.unsafe(
				`ALTER SEQUENCE ${identifier(schema)}.${identifier(name)} OWNER TO ${identifier(ownerRole)}`,
			);
		}
		// The guard is deliberately excluded from canonical inventory. Dropping
		// it here consumes the sentinel, while any later failure rolls the schema
		// and sentinel row back with this same transaction.
		await transaction.unsafe(
			`DROP SCHEMA ${identifier(SENTINEL_SCHEMA)} CASCADE`,
		);
		const actual = await captureDatabaseInventoryOnTransaction(
			transaction as unknown as postgres.Sql,
			{
				expectedDatabase,
				manifest: ledger.manifest,
				manifestText: ledger.manifestText,
			},
		);
		assertResetCatalogAllowlist(actual);
		if (
			canonicalDatabaseInventory(actual) !==
			canonicalDatabaseInventory(approved.inventory)
		) {
			throw new Error(
				`Terminal database inventory changed; expected ${approved.databaseSha256}, got ${databaseInventorySha256(actual)}`,
			);
		}
		if (
			actual.moneyBearingReferences.length > 0 ||
			actual.unresolvedProviderOperations.length > 0
		) {
			throw new Error(
				"Terminal database inventory contains money-bearing resources or unresolved provider operations",
			);
		}
		for (const extension of [...COLLAPSE_BASELINE_EXTENSIONS].reverse()) {
			await transaction.unsafe(
				`DROP EXTENSION IF EXISTS ${identifier(extension)} CASCADE`,
			);
		}
		await transaction`DROP SCHEMA IF EXISTS drizzle CASCADE`;
		for (const schema of [...COLLAPSE_BASELINE_SCHEMAS].reverse()) {
			await transaction.unsafe(
				`DROP SCHEMA IF EXISTS ${identifier(schema)} CASCADE`,
			);
		}
		await transaction`DROP SCHEMA IF EXISTS public CASCADE`;
		await transaction.unsafe(
			`CREATE SCHEMA public AUTHORIZATION ${identifier(ownerRole)}`,
		);
		for (const schema of COLLAPSE_BASELINE_SCHEMAS) {
			await transaction.unsafe(
				`CREATE SCHEMA ${identifier(schema)} AUTHORIZATION ${identifier(ownerRole)}`,
			);
		}
	});
	console.log(
		JSON.stringify({
			event: "prelive_database_schemas_reset",
			generation: EXPECTED_GENERATION,
		}),
	);
}

async function grantRuntime(
	sql: postgres.Sql,
	runtimeRole: string,
	ownerRole: string,
): Promise<void> {
	const runtime = sql(runtimeRole);
	await sql.begin(async (transaction) => {
		await transaction`SELECT pg_advisory_xact_lock(hashtext('relayapi:prelive-generation-2-reset'))`;
		for (const schema of ["public", ...COLLAPSE_BASELINE_SCHEMAS, "drizzle"]) {
			await transaction.unsafe(
				`ALTER SCHEMA ${identifier(schema)} OWNER TO ${identifier(ownerRole)}`,
			);
			await transaction.unsafe(
				`REVOKE CREATE ON SCHEMA ${identifier(schema)} FROM ${identifier(runtimeRole)}`,
			);
			await transaction.unsafe(
				`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(runtimeRole)}`,
			);
		}
		await transaction.unsafe(
			`REVOKE CREATE ON DATABASE ${identifier(required("PRELIVE_EXPECTED_DATABASE"))} FROM ${identifier(runtimeRole)}`,
		);
		for (const schema of ["public", ...COLLAPSE_BASELINE_SCHEMAS]) {
			await transaction`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${sql(schema)} TO ${runtime}`;
			await transaction`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${sql(schema)} TO ${runtime}`;
			await transaction`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${sql(schema)} TO ${runtime}`;
			await transaction`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sql(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`;
			await transaction`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sql(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`;
			await transaction`ALTER DEFAULT PRIVILEGES IN SCHEMA ${sql(schema)} GRANT EXECUTE ON FUNCTIONS TO ${runtime}`;
		}
	});
	console.log(
		JSON.stringify({
			event: "prelive_runtime_privileges_granted",
			runtime_role: runtimeRole,
			owner_role: ownerRole,
		}),
	);
}

if (import.meta.main) {
	assertCutoverGeneration();
	const command = process.argv[2];
	const connectionString = required(CONNECTION_ENV);
	validateConnection(connectionString);
	const runtimeRole = process.env.DATABASE_RUNTIME_ROLE ?? "relayapi_runtime";
	validateRuntimeConnection(required(RUNTIME_CONNECTION_ENV), runtimeRole);
	const sql = postgres(connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 15,
		idle_timeout: 20,
	});
	try {
		switch (command) {
			case "preflight":
				await commonPreflight(sql, {
					checkLedger: true,
					installMissingExtensions: false,
					requireFinalOwners: false,
				});
				break;
			case "arm-reset":
				await armResetSentinel(sql);
				break;
			case "reset": {
				const roles = await commonPreflight(sql, {
					checkLedger: true,
					installMissingExtensions: false,
					requireFinalOwners: false,
				});
				await resetSchemas(sql, roles.ownerRole);
				break;
			}
			case "grant-runtime": {
				const roles = await commonPreflight(sql, {
					checkLedger: false,
					installMissingExtensions: false,
					requireFinalOwners: false,
				});
				await grantRuntime(sql, roles.runtimeRole, roles.ownerRole);
				break;
			}
			case "postflight":
				await commonPreflight(sql, {
					checkLedger: false,
					installMissingExtensions: false,
					requireFinalOwners: true,
				});
				break;
			default:
				throw new Error(
					"Usage: bun run scripts/prelive-reset.ts preflight|arm-reset|reset|grant-runtime|postflight",
				);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}
