import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
	assertValidCatalogFingerprint,
	buildCatalogFingerprint,
	type CatalogFingerprint,
	type CatalogObject,
} from "./catalog-fingerprint-contract";

type Options =
	| {
			mode: "capture";
			output: string;
			source: CatalogFingerprint["source"];
			manifest: string;
			generation: number;
	  }
	| { mode: "verify"; input: string };

export function normalizeManagedRoleReferences(
	definition: string,
	manageableRoles: ReadonlySet<string>,
): string {
	const normalize = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(normalize);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, nested]) => [key, normalize(nested)]),
			);
		}
		if (typeof value !== "string") return value;
		if (manageableRoles.has(value)) return "migration-authority";
		let normalized = value;
		for (const role of manageableRoles) {
			if (normalized.startsWith(`${role}=`)) {
				normalized = `migration-authority=${normalized.slice(role.length + 1)}`;
			}
			if (normalized.endsWith(`/${role}`)) {
				normalized = `${normalized.slice(0, -(role.length + 1))}/migration-authority`;
			}
		}
		return normalized;
	};
	const normalized = normalize(JSON.parse(definition) as unknown);
	if (
		normalized &&
		typeof normalized === "object" &&
		!Array.isArray(normalized) &&
		"owner" in normalized &&
		normalized.owner === "migration-authority" &&
		"acl" in normalized &&
		Array.isArray(normalized.acl)
	) {
		normalized.acl = normalized.acl.filter(
			(entry) =>
				typeof entry !== "string" ||
				!entry.startsWith("migration-authority="),
		);
	}
	return JSON.stringify(normalized);
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function optionValue(args: string[], name: string): string | undefined {
	const prefix = `${name}=`;
	return args
		.find((argument) => argument.startsWith(prefix))
		?.slice(prefix.length);
}

function parseOptions(args: string[]): Options {
	const verify = optionValue(args, "--verify");
	const output = optionValue(args, "--output");
	const source = optionValue(args, "--source");
	const manifest =
		optionValue(args, "--manifest") ??
		resolve(packageDirectory, "drizzle", "migration-manifest.json");
	const generationValue = optionValue(args, "--generation");
	const recognized = [
		"--verify=",
		"--output=",
		"--source=",
		"--manifest=",
		"--generation=",
	];
	const unknown = args.filter(
		(argument) => !recognized.some((prefix) => argument.startsWith(prefix)),
	);
	if (unknown.length > 0) {
		throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
	}
	if (verify) {
		if (
			output ||
			source ||
			generationValue ||
			optionValue(args, "--manifest")
		) {
			throw new Error("--verify cannot be combined with capture arguments");
		}
		return { mode: "verify", input: resolve(verify) };
	}
	if (!output || (source !== "old-chain" && source !== "candidate")) {
		throw new Error(
			"Capture requires --output=<path> and --source=old-chain|candidate",
		);
	}
	const generation = Number(generationValue);
	if (!Number.isSafeInteger(generation) || generation <= 0) {
		throw new Error("Capture requires a positive --generation=<number>");
	}
	return {
		mode: "capture",
		output: resolve(output),
		source,
		manifest: resolve(manifest),
		generation,
	};
}

function sha256(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

export async function readCatalog(
	sql: ReturnType<typeof postgres>,
): Promise<{ postgresMajor: number; objects: CatalogObject[] }> {
	const [version] = await sql<{ server_version_num: string }[]>`
		SHOW server_version_num
	`;
	if (!version) throw new Error("Could not read PostgreSQL server version");
	const postgresMajor = Math.floor(Number(version.server_version_num) / 10_000);
	if (!Number.isSafeInteger(postgresMajor) || postgresMajor <= 0) {
		throw new Error(
			`PostgreSQL returned invalid server_version_num ${version.server_version_num}`,
		);
	}
	const manageableRoleRows = await sql<{ role_name: string }[]>`
		SELECT role_row.rolname AS role_name
		FROM pg_catalog.pg_roles role_row
		WHERE role_row.rolname = current_user
			OR (
				NOT role_row.rolcanlogin
				AND pg_has_role(current_user, role_row.oid, 'USAGE')
				AND role_row.oid IN (
					SELECT namespace_row.nspowner
					FROM pg_catalog.pg_namespace namespace_row
					WHERE namespace_row.nspname !~ '^pg_'
						AND namespace_row.nspname <> 'information_schema'

					UNION

					SELECT relation_row.relowner
					FROM pg_catalog.pg_class relation_row
					JOIN pg_catalog.pg_namespace namespace_row
						ON namespace_row.oid = relation_row.relnamespace
					WHERE namespace_row.nspname !~ '^pg_'
						AND namespace_row.nspname <> 'information_schema'

					UNION

					SELECT function_row.proowner
					FROM pg_catalog.pg_proc function_row
					JOIN pg_catalog.pg_namespace namespace_row
						ON namespace_row.oid = function_row.pronamespace
					WHERE namespace_row.nspname !~ '^pg_'
						AND namespace_row.nspname <> 'information_schema'

					UNION

					SELECT type_row.typowner
					FROM pg_catalog.pg_type type_row
					JOIN pg_catalog.pg_namespace namespace_row
						ON namespace_row.oid = type_row.typnamespace
					WHERE namespace_row.nspname !~ '^pg_'
						AND namespace_row.nspname <> 'information_schema'

					UNION

					SELECT extension_row.extowner
					FROM pg_catalog.pg_extension extension_row
					JOIN pg_catalog.pg_namespace namespace_row
						ON namespace_row.oid = extension_row.extnamespace
					WHERE namespace_row.nspname !~ '^pg_'
						AND namespace_row.nspname <> 'information_schema'
				)
			)
	`;
	const manageableRoles = new Set(
		manageableRoleRows.map((row) => row.role_name),
	);

	const objects = await sql<CatalogObject[]>`
		WITH catalog_object AS (
			SELECT
				'schema'::text AS kind,
				namespace_row.nspname::text AS identity,
				jsonb_build_object(
					'owner', pg_get_userbyid(namespace_row.nspowner),
					'acl', coalesce(
						(
							SELECT array_agg(acl_item::text ORDER BY acl_item::text)
							FROM unnest(namespace_row.nspacl) AS acl_item
						),
						ARRAY[]::text[]
					)
				)::text AS definition
			FROM pg_namespace AS namespace_row
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'

			UNION ALL

			SELECT
				'extension',
				extension_row.extname,
				jsonb_build_object(
					'schema', extension_namespace.nspname,
					'version', extension_row.extversion,
					'owner', pg_get_userbyid(extension_row.extowner)
				)::text
			FROM pg_extension AS extension_row
			JOIN pg_namespace AS extension_namespace
				ON extension_namespace.oid = extension_row.extnamespace
			WHERE extension_namespace.nspname !~ '^pg_'
				AND extension_namespace.nspname <> 'information_schema'

			UNION ALL

			SELECT
				'relation',
				format('%I.%I', namespace_row.nspname, relation_row.relname),
				jsonb_build_object(
					'kind', relation_row.relkind,
					'persistence', relation_row.relpersistence,
					'rowSecurity', relation_row.relrowsecurity,
					'forceRowSecurity', relation_row.relforcerowsecurity,
					'partitionBound', pg_get_expr(relation_row.relpartbound, relation_row.oid),
					'owner', pg_get_userbyid(relation_row.relowner),
					'acl', coalesce(
						(
							SELECT array_agg(acl_item::text ORDER BY acl_item::text)
							FROM unnest(relation_row.relacl) AS acl_item
						),
						ARRAY[]::text[]
					)
				)::text
			FROM pg_class AS relation_row
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
				AND NOT EXISTS (
					SELECT 1
					FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation_row.oid
						AND dependency.deptype = 'e'
				)

			UNION ALL

			SELECT
				'column',
				format(
					'%I.%I.%I',
					namespace_row.nspname,
					relation_row.relname,
					attribute_row.attname
				),
				jsonb_build_object(
					'ordinal', attribute_row.attnum,
					'type', format_type(attribute_row.atttypid, attribute_row.atttypmod),
					'notNull', attribute_row.attnotnull,
					'default', pg_get_expr(default_row.adbin, default_row.adrelid),
					'generated', attribute_row.attgenerated,
					'identity', attribute_row.attidentity,
					'collation', CASE
						WHEN attribute_row.attcollation = 0 THEN NULL
						ELSE attribute_row.attcollation::regcollation::text
					END
				)::text
			FROM pg_attribute AS attribute_row
			JOIN pg_class AS relation_row ON relation_row.oid = attribute_row.attrelid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			LEFT JOIN pg_attrdef AS default_row
				ON default_row.adrelid = attribute_row.attrelid
				AND default_row.adnum = attribute_row.attnum
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
				AND attribute_row.attnum > 0
				AND NOT attribute_row.attisdropped
				AND NOT EXISTS (
					SELECT 1
					FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation_row.oid
						AND dependency.deptype = 'e'
				)

			UNION ALL

			SELECT
				'constraint',
				format(
					'%I.%I.%I',
					namespace_row.nspname,
					relation_row.relname,
					constraint_row.conname
				),
				jsonb_build_object(
					'type', constraint_row.contype,
					'definition', pg_get_constraintdef(constraint_row.oid, false),
					'validated', constraint_row.convalidated,
					'deferrable', constraint_row.condeferrable,
					'deferred', constraint_row.condeferred
				)::text
			FROM pg_constraint AS constraint_row
			JOIN pg_class AS relation_row ON relation_row.oid = constraint_row.conrelid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'

			UNION ALL

			SELECT
				'index',
				format('%I.%I', namespace_row.nspname, index_row.relname),
				jsonb_build_object(
					'table', format('%I.%I', namespace_row.nspname, table_row.relname),
					'definition', pg_get_indexdef(index_row.oid),
					'valid', index_catalog.indisvalid,
					'ready', index_catalog.indisready,
					'live', index_catalog.indislive,
					'owner', pg_get_userbyid(index_row.relowner)
				)::text
			FROM pg_index AS index_catalog
			JOIN pg_class AS index_row ON index_row.oid = index_catalog.indexrelid
			JOIN pg_class AS table_row ON table_row.oid = index_catalog.indrelid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = table_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'

			UNION ALL

			SELECT
				'enum-label',
				format(
					'%I.%I.%s',
					namespace_row.nspname,
					type_row.typname,
					enum_row.enumlabel
				),
				jsonb_build_object('sortOrder', enum_row.enumsortorder)::text
			FROM pg_enum AS enum_row
			JOIN pg_type AS type_row ON type_row.oid = enum_row.enumtypid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = type_row.typnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'

			UNION ALL

			SELECT
				'type',
				format('%I.%I', namespace_row.nspname, type_row.typname),
				jsonb_build_object(
					'kind', type_row.typtype,
					'category', type_row.typcategory,
					'notNull', type_row.typnotnull,
					'baseType', CASE
						WHEN type_row.typbasetype = 0 THEN NULL
						ELSE format_type(type_row.typbasetype, type_row.typtypmod)
					END,
					'default', type_row.typdefault,
					'collation', CASE
						WHEN type_row.typcollation = 0 THEN NULL
						ELSE type_row.typcollation::regcollation::text
					END,
					'owner', pg_get_userbyid(type_row.typowner),
					'acl', coalesce(
						(
							SELECT array_agg(acl_item::text ORDER BY acl_item::text)
							FROM unnest(type_row.typacl) AS acl_item
						),
						ARRAY[]::text[]
					),
					'rangeSubtype', (
						SELECT format_type(range_row.rngsubtype, NULL)
						FROM pg_range AS range_row
						WHERE range_row.rngtypid = type_row.oid
					)
				)::text
			FROM pg_type AS type_row
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = type_row.typnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND type_row.typrelid = 0
				AND type_row.typelem = 0
				AND type_row.typtype IN ('d', 'e', 'r', 'm')
				AND NOT EXISTS (
					SELECT 1
					FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_type'::regclass
						AND dependency.objid = type_row.oid
						AND dependency.deptype = 'e'
				)

			UNION ALL

			SELECT
				'domain-constraint',
				format(
					'%I.%I.%I',
					namespace_row.nspname,
					type_row.typname,
					constraint_row.conname
				),
				jsonb_build_object(
					'definition', pg_get_constraintdef(constraint_row.oid, false),
					'validated', constraint_row.convalidated
				)::text
			FROM pg_constraint AS constraint_row
			JOIN pg_type AS type_row ON type_row.oid = constraint_row.contypid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = type_row.typnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND constraint_row.contypid <> 0

			UNION ALL

			SELECT
				'sequence',
				format('%I.%I', namespace_row.nspname, relation_row.relname),
				jsonb_build_object(
					'type', format_type(sequence_row.seqtypid, NULL),
					'start', sequence_row.seqstart,
					'increment', sequence_row.seqincrement,
					'max', sequence_row.seqmax,
					'min', sequence_row.seqmin,
					'cache', sequence_row.seqcache,
					'cycle', sequence_row.seqcycle,
					'owner', pg_get_userbyid(relation_row.relowner),
					'acl', coalesce(
						(
							SELECT array_agg(acl_item::text ORDER BY acl_item::text)
							FROM unnest(relation_row.relacl) AS acl_item
						),
						ARRAY[]::text[]
					)
				)::text
			FROM pg_sequence AS sequence_row
			JOIN pg_class AS relation_row ON relation_row.oid = sequence_row.seqrelid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND NOT EXISTS (
					SELECT 1
					FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation_row.oid
						AND dependency.deptype = 'e'
				)

			UNION ALL

			SELECT
				'routine',
				format(
					'%I.%I(%s)',
					namespace_row.nspname,
					procedure_row.proname,
					pg_get_function_identity_arguments(procedure_row.oid)
				),
				jsonb_build_object(
					'kind', procedure_row.prokind,
					'definition', pg_get_functiondef(procedure_row.oid),
					'config', procedure_row.proconfig,
					'owner', pg_get_userbyid(procedure_row.proowner),
					'acl', coalesce(
						(
							SELECT array_agg(acl_item::text ORDER BY acl_item::text)
							FROM unnest(procedure_row.proacl) AS acl_item
						),
						ARRAY[]::text[]
					)
				)::text
			FROM pg_proc AS procedure_row
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = procedure_row.pronamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND NOT EXISTS (
					SELECT 1
					FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_proc'::regclass
						AND dependency.objid = procedure_row.oid
						AND dependency.deptype = 'e'
				)

			UNION ALL

			SELECT
				'trigger',
				format(
					'%I.%I.%I',
					namespace_row.nspname,
					relation_row.relname,
					trigger_row.tgname
				),
				jsonb_build_object(
					'definition', pg_get_triggerdef(trigger_row.oid, false),
					'enabled', trigger_row.tgenabled
				)::text
			FROM pg_trigger AS trigger_row
			JOIN pg_class AS relation_row ON relation_row.oid = trigger_row.tgrelid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND NOT trigger_row.tgisinternal

			UNION ALL

			SELECT
				'view',
				format('%I.%I', namespace_row.nspname, relation_row.relname),
				jsonb_build_object(
					'definition', pg_get_viewdef(relation_row.oid, false)
				)::text
			FROM pg_class AS relation_row
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
				AND relation_row.relkind IN ('v', 'm')

			UNION ALL

			SELECT
				'policy',
				format(
					'%I.%I.%I',
					namespace_row.nspname,
					relation_row.relname,
					policy_row.polname
				),
				jsonb_build_object(
					'permissive', policy_row.polpermissive,
					'command', policy_row.polcmd,
					'roles', (
						SELECT jsonb_agg(
							CASE
								WHEN policy_role.role_oid = 0 THEN 'PUBLIC'
								ELSE pg_get_userbyid(policy_role.role_oid)
							END
							ORDER BY
								CASE
									WHEN policy_role.role_oid = 0 THEN 'PUBLIC'
									ELSE pg_get_userbyid(policy_role.role_oid)
								END
						)
						FROM unnest(policy_row.polroles) AS policy_role(role_oid)
					),
					'using', pg_get_expr(policy_row.polqual, policy_row.polrelid),
					'withCheck', pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
				)::text
			FROM pg_policy AS policy_row
			JOIN pg_class AS relation_row ON relation_row.oid = policy_row.polrelid
			JOIN pg_namespace AS namespace_row
				ON namespace_row.oid = relation_row.relnamespace
			WHERE namespace_row.nspname !~ '^pg_'
				AND namespace_row.nspname <> 'information_schema'
		)
		SELECT kind, identity, definition
		FROM catalog_object
		ORDER BY kind, identity, definition
	`;
	return {
		postgresMajor,
		objects: objects.map((object) => ({
			...object,
			definition: normalizeManagedRoleReferences(
				object.definition,
				manageableRoles,
			),
		})),
	};
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const connectionString =
		process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
	if (!connectionString) {
		throw new Error(
			"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is required",
		);
	}
	const sql = postgres(connectionString, { max: 1 });
	try {
		const live = await readCatalog(sql);
		if (options.mode === "verify") {
			const expected = JSON.parse(
				readFileSync(options.input, "utf8"),
			) as CatalogFingerprint;
			assertValidCatalogFingerprint(expected, options.input);
			const actual = buildCatalogFingerprint({
				source: expected.source,
				generation: expected.generation,
				postgresMajor: live.postgresMajor,
				migrationManifestSha256: expected.migrationManifestSha256,
				objects: live.objects,
			});
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error(
					`Live catalog does not match ${options.input} (expected ${expected.catalogSha256}, found ${actual.catalogSha256})`,
				);
			}
			console.log(
				`Verified ${expected.source} catalog fingerprint ${expected.catalogSha256}.`,
			);
			return;
		}

		if (existsSync(options.output)) {
			throw new Error(
				`Refusing to overwrite existing catalog fingerprint: ${options.output}`,
			);
		}
		const manifestText = readFileSync(options.manifest, "utf8");
		const fingerprint = buildCatalogFingerprint({
			source: options.source,
			generation: options.generation,
			postgresMajor: live.postgresMajor,
			migrationManifestSha256: sha256(manifestText),
			objects: live.objects,
		});
		writeFileSync(options.output, `${JSON.stringify(fingerprint, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o644,
			flag: "wx",
		});
		console.log(
			`Captured ${options.source} catalog fingerprint ${fingerprint.catalogSha256} at ${options.output}.`,
		);
	} finally {
		await sql.end();
	}
}

if (import.meta.main) {
	await main();
}
