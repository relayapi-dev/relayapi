import postgres from "postgres";
import {
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSIONS,
	type RequiredDatabaseExtension,
} from "./database-prerequisites.js";

export const REQUIRED_POSTGRES_MAJOR = 18;

type DatabaseSql = ReturnType<typeof postgres>;

const PROBE_ROLLBACK = Symbol("relayapi-database-contract-probe-rollback");

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

export async function assertSupportedPostgres(
	sql: DatabaseSql,
): Promise<number> {
	const [row] = await sql<{ server_version_num: string }[]>`
		SHOW server_version_num
	`;
	const version = Number(row?.server_version_num);
	const major = Math.floor(version / 10_000);
	if (!Number.isSafeInteger(version) || major !== REQUIRED_POSTGRES_MAJOR) {
		throw new Error(
			`RelayAPI requires PostgreSQL major ${REQUIRED_POSTGRES_MAJOR}; server_version_num is ${row?.server_version_num ?? "missing"}`,
		);
	}
	return version;
}

/**
 * Prove the extension features RelayAPI actually uses, not merely that an
 * extension name appears in pg_available_extensions. The transaction always
 * rolls back, including CREATE EXTENSION on a virgin database.
 */
export async function verifyDatabaseSemanticCapabilities(
	sql: DatabaseSql,
	options: {
		installMissing: boolean;
		requiredExtensions?: readonly RequiredDatabaseExtension[];
		requiredSchemas?: Readonly<Record<string, string>>;
	},
): Promise<void> {
	const requiredExtensions =
		options.requiredExtensions ?? REQUIRED_DATABASE_EXTENSIONS;
	const requiredSchemas =
		options.requiredSchemas ?? REQUIRED_DATABASE_EXTENSION_SCHEMAS;
	if (requiredExtensions.length === 0) {
		throw new Error("Database semantic capability contract cannot be empty");
	}
	if (new Set(requiredExtensions).size !== requiredExtensions.length) {
		throw new Error(
			"Database semantic capability contract contains duplicate extensions",
		);
	}
	try {
		await sql.begin(async (transaction) => {
			for (const extension of requiredExtensions) {
				const schema = requiredSchemas[extension];
				if (!schema) {
					throw new Error(
						`Database semantic capability contract has no schema for ${extension}`,
					);
				}
				if (options.installMissing) {
					await transaction.unsafe(
						`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension)} WITH SCHEMA ${quoteIdentifier(schema)}`,
					);
				}
			}
			const installed = await transaction.unsafe<
				{
					extension_name: string;
					schema_name: string;
				}[]
			>(
				`SELECT extension_row.extname AS extension_name,
					namespace_row.nspname AS schema_name
				FROM pg_catalog.pg_extension extension_row
				JOIN pg_catalog.pg_namespace namespace_row
					ON namespace_row.oid = extension_row.extnamespace
				WHERE extension_row.extname IN (${requiredExtensions.map(
					quoteLiteral,
				).join(", ")})
				ORDER BY extension_row.extname`,
			);
			const states = new Map(
				installed.map((row) => [row.extension_name, row.schema_name]),
			);
			for (const extension of requiredExtensions) {
				const expectedSchema = requiredSchemas[extension];
				if (states.get(extension) !== expectedSchema) {
					throw new Error(
						`required extension ${extension} is not installable in ${expectedSchema}`,
					);
				}
			}

			if (requiredExtensions.includes("vector")) {
				await transaction.unsafe(
					`CREATE TEMP TABLE relayapi_vector_semantic_probe (
						embedding public.vector(1536) NOT NULL
					) ON COMMIT DROP`,
				);
				await transaction.unsafe(
					`INSERT INTO relayapi_vector_semantic_probe (embedding)
					VALUES (array_fill(0::real, ARRAY[1536])::public.vector)`,
				);
				await transaction.unsafe(
					`CREATE INDEX relayapi_vector_semantic_probe_hnsw
					ON relayapi_vector_semantic_probe
					USING hnsw (embedding public.vector_cosine_ops)`,
				);
			}
			if (requiredExtensions.includes("pg_trgm")) {
				await transaction.unsafe(
					`CREATE TEMP TABLE relayapi_trgm_semantic_probe (
						body text NOT NULL
					) ON COMMIT DROP`,
				);
				await transaction.unsafe(
					`CREATE INDEX relayapi_trgm_semantic_probe_gin
					ON relayapi_trgm_semantic_probe
					USING gin (body public.gin_trgm_ops)`,
				);
				await transaction.unsafe(
					`SELECT public.similarity('relayapi', 'relay api')`,
				);
			}
			if (requiredExtensions.includes("btree_gist")) {
				await transaction.unsafe(
					`CREATE TEMP TABLE relayapi_btree_gist_semantic_probe (
						resource_key text NOT NULL,
						active_during tstzrange NOT NULL
					) ON COMMIT DROP`,
				);
				await transaction.unsafe(
					`ALTER TABLE relayapi_btree_gist_semantic_probe
					ADD CONSTRAINT relayapi_btree_gist_semantic_probe_exclusion
					EXCLUDE USING gist (
						resource_key WITH =,
						active_during WITH &&
					)`,
				);
			}
			throw PROBE_ROLLBACK;
		});
	} catch (error) {
		if (error !== PROBE_ROLLBACK) throw error;
	}
}

export async function assertDatabaseIdentity(
	sql: DatabaseSql,
	expectedDatabase: string,
): Promise<void> {
	if (
		!expectedDatabase ||
		!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(expectedDatabase)
	) {
		throw new Error("Expected database name is missing or malformed");
	}
	const [row] = await sql<{ database_name: string }[]>`
		SELECT current_database() AS database_name
	`;
	if (row?.database_name !== expectedDatabase) {
		throw new Error(
			`Connected database ${row?.database_name ?? "missing"} does not equal expected database ${expectedDatabase}`,
		);
	}
}

export async function assertMigrationAndRuntimeRoles(
	sql: DatabaseSql,
	runtimeRole: string,
	ownerRole?: string,
): Promise<{ migrationRole: string }> {
	const [row] = await sql<
		Array<{
			migration_role: string;
			can_create: boolean;
			runtime_role_exists: boolean;
			owner_role_manageable: boolean;
		}>
	>`
		SELECT
			current_user AS migration_role,
			has_database_privilege(current_user, current_database(), 'CREATE') AS can_create,
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${runtimeRole}
			) AS runtime_role_exists,
			CASE
				WHEN ${ownerRole ?? null}::text IS NULL THEN true
				ELSE EXISTS (
					SELECT 1
					FROM pg_catalog.pg_roles owner_role
					WHERE owner_role.rolname = ${ownerRole ?? null}
						AND pg_has_role(current_user, owner_role.oid, 'USAGE')
				)
			END AS owner_role_manageable
	`;
	if (!row?.can_create) {
		throw new Error("Migration role lacks CREATE on the target database");
	}
	if (!row.runtime_role_exists) {
		throw new Error(`Runtime role ${runtimeRole} does not exist`);
	}
	if (row.migration_role === runtimeRole) {
		throw new Error("Migration and runtime database roles must differ");
	}
	if (!row.owner_role_manageable) {
		throw new Error(
			`Migration role cannot assume configured owner role ${ownerRole}`,
		);
	}
	return { migrationRole: row.migration_role };
}

export async function assertSchemaRoleContract(
	sql: DatabaseSql,
	input: {
		runtimeRole: string;
		schemas: readonly string[];
		expectedOwnerRole?: string;
	},
): Promise<void> {
	for (const schema of input.schemas) {
		const rows = await sql<
			Array<{
				schema_name: string;
				owner_name: string;
				migration_can_manage_owner: boolean;
				migration_can_create: boolean;
				runtime_can_create: boolean;
			}>
		>`
			SELECT
				namespace_row.nspname AS schema_name,
				pg_get_userbyid(namespace_row.nspowner) AS owner_name,
				pg_has_role(current_user, namespace_row.nspowner, 'USAGE') AS migration_can_manage_owner,
				has_schema_privilege(current_user, namespace_row.oid, 'CREATE') AS migration_can_create,
				has_schema_privilege(${input.runtimeRole}, namespace_row.oid, 'CREATE') AS runtime_can_create
			FROM pg_catalog.pg_namespace namespace_row
			WHERE namespace_row.nspname = ${schema}
		`;
		const row = rows[0];
		if (!row) {
			if (input.expectedOwnerRole) {
				throw new Error(`Required schema ${schema} is missing`);
			}
			continue;
		}
		if (!row.migration_can_manage_owner || !row.migration_can_create) {
			throw new Error(
				`Migration role cannot manage required schema ${schema} owned by ${row.owner_name}`,
			);
		}
		if (input.expectedOwnerRole && row.owner_name !== input.expectedOwnerRole) {
			throw new Error(
				`Required schema ${schema} is owned by ${row.owner_name}, expected ${input.expectedOwnerRole}`,
			);
		}
		if (row.runtime_can_create) {
			throw new Error(
				`Runtime role ${input.runtimeRole} unexpectedly has CREATE on schema ${schema}`,
			);
		}
	}
}

async function currentUser(sql: DatabaseSql): Promise<string> {
	const [row] = await sql<{ role_name: string }[]>`
		SELECT current_user AS role_name
	`;
	if (!row?.role_name) throw new Error("Could not read current database role");
	return row.role_name;
}

export async function assertRuntimeConnectionCannotDdl(
	connectionString: string,
	expectedRuntimeRole?: string,
	expectedDatabase?: string,
): Promise<void> {
	const sql = postgres(connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 10,
		idle_timeout: 5,
	});
	try {
		if (expectedDatabase) {
			await assertDatabaseIdentity(sql, expectedDatabase);
		}
		const role = await currentUser(sql);
		if (expectedRuntimeRole && role !== expectedRuntimeRole) {
			throw new Error(
				`Runtime URL authenticates as ${role}, expected ${expectedRuntimeRole}`,
			);
		}
		for (const probe of [
			{
				label: "create schemas in the target database",
				statement: "CREATE SCHEMA relayapi_runtime_ddl_probe",
			},
			{
				label: "create tables in public",
				statement:
					"CREATE TABLE public.relayapi_runtime_ddl_probe (id integer)",
			},
		]) {
			let created = false;
			try {
				await sql.begin(async (transaction) => {
					await transaction.unsafe(probe.statement);
					created = true;
					throw PROBE_ROLLBACK;
				});
			} catch (error) {
				if (error !== PROBE_ROLLBACK) {
					const code =
						typeof error === "object" && error !== null && "code" in error
							? String(error.code)
							: "";
					if (code !== "42501") throw error;
				}
			}
			if (created) {
				throw new Error(`Runtime role ${role} can ${probe.label}`);
			}
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}
