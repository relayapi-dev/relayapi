import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { assertOrderedMigrationHistory } from "./migration-history-contract";

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

export type MigrationManifest = {
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

type AppliedMigration = {
	id: number;
	hash: string;
	created_at: string | number;
};

type LedgerState = {
	ledger_exists: boolean;
};

type UserDatabaseObject = {
	object_kind: string;
	object_identity: string;
};

export type MigrationSql = ReturnType<typeof postgres>;

const migrationsFolder = process.env.RELAYAPI_VERIFY_MIGRATION_DIRECTORY
	? resolve(process.env.RELAYAPI_VERIFY_MIGRATION_DIRECTORY)
	: fileURLToPath(new URL("../drizzle", import.meta.url));
function sha256(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

/**
 * Derive the protected manifest from every Drizzle artifact that can affect a
 * replay or the next generated migration. Hashing snapshots as well as SQL
 * prevents an edited historical snapshot from silently poisoning future
 * generation while leaving today's clean replay unchanged.
 */
export function buildExpectedMigrationManifest(
	directory = migrationsFolder,
): MigrationManifest {
	const journal = JSON.parse(
		readFileSync(join(directory, "meta", "_journal.json"), "utf8"),
	) as Journal;
	const migrationFiles = readMigrationFiles({ migrationsFolder: directory });

	assertOrderedMigrationHistory(journal.entries, migrationFiles);
	if (journal.dialect !== "postgresql") {
		throw new Error(`Unsupported Drizzle journal dialect: ${journal.dialect}`);
	}
	if (!journal.version.trim()) {
		throw new Error("Drizzle journal version must be non-empty");
	}

	return {
		schemaVersion: 2,
		journal: {
			version: journal.version,
			dialect: journal.dialect,
		},
		migrations: journal.entries.map((entry, index) => {
			const migration = migrationFiles[index];
			if (!migration) {
				throw new Error(`Migration file missing at index ${entry.idx}`);
			}
			const snapshotPath = join(
				directory,
				"meta",
				`${String(entry.idx).padStart(4, "0")}_snapshot.json`,
			);
			return {
				idx: entry.idx,
				tag: entry.tag,
				folderMillis: migration.folderMillis,
				sha256: migration.hash,
				snapshotSha256: sha256(readFileSync(snapshotPath, "utf8")),
				drizzleVersion: entry.version,
				breakpoints: entry.breakpoints,
			};
		}),
	};
}

export function verifyTrackedMigrationManifest(options?: {
	write?: boolean;
	migrationsFolder?: string;
}): MigrationManifest {
	const directory = options?.migrationsFolder ?? migrationsFolder;
	const manifestPath = join(directory, "migration-manifest.json");
	const expected = buildExpectedMigrationManifest(directory);
	const serialized = `${JSON.stringify(expected, null, 2)}\n`;

	if (options?.write) {
		writeFileSync(manifestPath, serialized, { encoding: "utf8", mode: 0o644 });
		console.log(
			`Wrote migration manifest (${expected.migrations.length} entries).`,
		);
		return expected;
	}

	const trackedManifest = readFileSync(manifestPath, "utf8");
	if (trackedManifest !== serialized) {
		throw new Error(
			"Migration SQL, snapshots, or journal history differs from migration-manifest.json. " +
				"Never rewrite an applied migration or its Drizzle metadata; add a new migration. If this is a new migration, run migration:manifest:write and review the result.",
		);
	}
	return expected;
}

/**
 * Verify every ledger row, not only Drizzle's newest timestamp. Callers that
 * can mutate the ledger must invoke this while holding the migration advisory
 * lock on the same one-connection client.
 */
export async function verifyLiveMigrationHistory(
	sql: MigrationSql,
	expected: MigrationManifest,
	options?: { requireCurrent?: boolean },
): Promise<number> {
	const [ledgerState] = await sql<LedgerState[]>`
		SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ledger_exists
		`;

	if (!ledgerState) {
		throw new Error("Could not inspect the database migration ledger");
	}

	let applied: AppliedMigration[];
	if (!ledgerState.ledger_exists) {
		const userObjects = await sql<UserDatabaseObject[]>`
			SELECT object_kind, object_identity
			FROM (
				SELECT
					CASE relation_row.relkind
						WHEN 'S' THEN 'sequence'
						WHEN 'v' THEN 'view'
						WHEN 'm' THEN 'materialized view'
						WHEN 'f' THEN 'foreign table'
						WHEN 'c' THEN 'composite relation'
						ELSE 'table'
					END AS object_kind,
					format('%I.%I', namespace_row.nspname, relation_row.relname) AS object_identity
				FROM pg_class relation_row
				JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
				WHERE namespace_row.nspname IN ('auth', 'public')
					AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
					AND NOT EXISTS (
						SELECT 1
						FROM pg_depend dependency
						WHERE dependency.classid = 'pg_class'::regclass
							AND dependency.objid = relation_row.oid
							AND dependency.deptype = 'e'
					)

				UNION ALL

				SELECT
					CASE function_row.prokind
						WHEN 'p' THEN 'procedure'
						WHEN 'a' THEN 'aggregate'
						WHEN 'w' THEN 'window function'
						ELSE 'function'
					END AS object_kind,
					format(
						'%I.%I(%s)',
						namespace_row.nspname,
						function_row.proname,
						pg_get_function_identity_arguments(function_row.oid)
					) AS object_identity
				FROM pg_proc function_row
				JOIN pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
				WHERE namespace_row.nspname IN ('auth', 'public')
					AND NOT EXISTS (
						SELECT 1
						FROM pg_depend dependency
						WHERE dependency.classid = 'pg_proc'::regclass
							AND dependency.objid = function_row.oid
							AND dependency.deptype = 'e'
					)

				UNION ALL

				SELECT
					CASE type_row.typtype
						WHEN 'd' THEN 'domain'
						WHEN 'e' THEN 'enum'
						WHEN 'r' THEN 'range type'
						WHEN 'm' THEN 'multirange type'
						ELSE 'base type'
					END AS object_kind,
					format('%I.%I', namespace_row.nspname, type_row.typname) AS object_identity
				FROM pg_type type_row
				JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
				WHERE namespace_row.nspname IN ('auth', 'public')
					AND type_row.typisdefined
					AND type_row.typrelid = 0
					AND type_row.typelem = 0
					AND NOT EXISTS (
						SELECT 1
						FROM pg_depend dependency
						WHERE dependency.classid = 'pg_type'::regclass
							AND dependency.objid = type_row.oid
							AND dependency.deptype = 'e'
					)
			) AS user_object
			ORDER BY object_kind, object_identity
		`;
		if (userObjects.length > 0) {
			throw new Error(
				"Database has no Drizzle migration ledger but is not empty; refusing to infer or rebaseline migration history. " +
					`Found ${userObjects.length} non-extension auth/public user objects: ${userObjects.map((row) => `${row.object_kind} ${row.object_identity}`).join(", ")}`,
			);
		}
		applied = [];
	} else {
		applied = await sql<AppliedMigration[]>`
			SELECT id, hash, created_at
			FROM drizzle.__drizzle_migrations
			ORDER BY created_at, id
		`;
		if (applied.length === 0) {
			throw new Error(
				"Database has an empty Drizzle migration ledger; only a truly virgin database with no ledger and no non-extension auth/public user objects may start from this baseline",
			);
		}
	}

	if (applied.length > expected.migrations.length) {
		throw new Error(
			`Database contains ${applied.length} migrations but this checkout has only ${expected.migrations.length}`,
		);
	}

	for (const [index, row] of applied.entries()) {
		const migration = expected.migrations[index];
		if (
			!migration ||
			row.hash !== migration.sha256 ||
			Number(row.created_at) !== migration.folderMillis
		) {
			throw new Error(
				`Database migration history diverges from this checkout at position ${index + 1}`,
			);
		}
	}

	if (
		options?.requireCurrent &&
		applied.length !== expected.migrations.length
	) {
		throw new Error(
			`Database is behind this checkout (${applied.length}/${expected.migrations.length} migrations applied)`,
		);
	}

	console.log(
		`Live migration history verified (${applied.length}/${expected.migrations.length} migrations applied).`,
	);
	return applied.length;
}

async function main(): Promise<void> {
	const expected = verifyTrackedMigrationManifest({
		write: process.argv.includes("--write-manifest"),
	});
	if (process.argv.includes("--write-manifest")) return;

	if (!process.argv.includes("--live")) {
		console.log(
			`Migration manifest verified (${expected.migrations.length} entries).`,
		);
		return;
	}

	const connectionString =
		process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
	if (!connectionString) {
		throw new Error(
			"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE is not set",
		);
	}

	const sql = postgres(connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 10,
	});
	try {
		await verifyLiveMigrationHistory(sql, expected, {
			requireCurrent: process.argv.includes("--require-current"),
		});
	} finally {
		await sql.end({ timeout: 5 });
	}
}

if (import.meta.main) {
	await main();
}
