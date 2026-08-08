import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	type DatabaseExtensionInstallabilityProbe,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSION_VERSIONS,
	REQUIRED_DATABASE_EXTENSIONS,
} from "../src/database-prerequisites.js";
import type { DatabaseExtensionLifecycleEvent } from "./database-extension-lifecycle.js";
import { DATABASE_EXTENSION_LIFECYCLE_EVENTS } from "./database-extension-lifecycle.js";
import { auditDatabaseExtensionLifecycle } from "./render-baseline-preamble-sql.js";
import type {
	MigrationManifest,
	MigrationSql,
} from "./verify-migration-history.js";

export type InstalledDatabaseExtension = {
	schema: string;
	version: string;
	canManage: boolean;
};

export type DatabaseExtensionCatalogSnapshot = {
	installed: ReadonlyMap<string, InstalledDatabaseExtension>;
	availableDefaults: ReadonlyMap<string, string | undefined>;
	availableVersions: ReadonlySet<string>;
	relocatableVersions: ReadonlyMap<string, boolean>;
	updatePaths: ReadonlyMap<string, string | null>;
};

export type DatabaseExtensionGenerationContract = {
	lifecycleEvents: readonly DatabaseExtensionLifecycleEvent[];
	activeExtensions: readonly ("btree_gist" | "pg_trgm" | "vector")[];
	activeSchemas: Readonly<Record<string, string>>;
	activeVersions: Readonly<Record<string, string | undefined>>;
	installabilityProbes: Readonly<
		Record<string, DatabaseExtensionInstallabilityProbe>
	>;
};

export function databaseExtensionContractForGeneration(
	generation: number,
): DatabaseExtensionGenerationContract {
	if (!Number.isSafeInteger(generation) || generation < 1) {
		throw new Error(
			`Database extension lifecycle has no contract for generation ${generation}`,
		);
	}
	return {
		lifecycleEvents: DATABASE_EXTENSION_LIFECYCLE_EVENTS,
		activeExtensions: REQUIRED_DATABASE_EXTENSIONS,
		activeSchemas: REQUIRED_DATABASE_EXTENSION_SCHEMAS,
		activeVersions: REQUIRED_DATABASE_EXTENSION_VERSIONS,
		installabilityProbes: DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	};
}

type MappedLifecycleEvent = DatabaseExtensionLifecycleEvent & {
	migrationIndex: number;
};

type LifecycleState = {
	schema: string;
	/** An exact version owned by an applied CREATE VERSION or UPDATE TO event. */
	ownedVersion?: string;
};

function extensionVersionKey(extension: string, version: string): string {
	return `${extension}\0${version}`;
}

function extensionUpdatePathKey(
	extension: string,
	source: string,
	target: string,
): string {
	return `${extension}\0${source}\0${target}`;
}

function mapLifecycleEvents(
	manifest: MigrationManifest,
	lifecycleEvents: readonly DatabaseExtensionLifecycleEvent[],
): MappedLifecycleEvent[] {
	if (
		manifest.migrations.some(
			(migration, index) => migration.idx !== index || !migration.tag.trim(),
		)
	) {
		throw new Error(
			"Tracked migration manifest must be a dense, ordered ledger before extension lifecycle verification",
		);
	}
	const migrationIndexes = new Map<string, number>();
	for (const [index, migration] of manifest.migrations.entries()) {
		if (migrationIndexes.has(migration.tag)) {
			throw new Error(
				`Tracked migration manifest contains duplicate tag ${migration.tag}`,
			);
		}
		migrationIndexes.set(migration.tag, index);
	}

	let previousIndex = -1;
	return lifecycleEvents.map((event) => {
		const migrationIndex = migrationIndexes.get(event.migration);
		if (migrationIndex === undefined) {
			throw new Error(
				`Database extension lifecycle event ${event.operation} ${event.extension} references untracked migration ${event.migration}`,
			);
		}
		if (migrationIndex < previousIndex) {
			throw new Error(
				"Database extension lifecycle events are not ordered by the tracked migration manifest",
			);
		}
		previousIndex = migrationIndex;
		return { ...event, migrationIndex };
	});
}

function applyOwnedLifecycleEvent(
	state: Map<string, LifecycleState>,
	event: MappedLifecycleEvent,
): void {
	if (event.operation === "create") {
		if (state.has(event.extension)) {
			throw new Error(
				`Database extension lifecycle creates already-active extension ${event.extension}`,
			);
		}
		state.set(event.extension, {
			schema: event.schema,
			...(event.version === undefined ? {} : { ownedVersion: event.version }),
		});
		return;
	}

	const current = state.get(event.extension);
	if (!current) {
		throw new Error(
			`Database extension lifecycle ${event.operation} targets inactive extension ${event.extension}`,
		);
	}
	if (event.operation === "drop") {
		state.delete(event.extension);
		return;
	}
	if (event.operation === "set_schema") {
		state.set(event.extension, { ...current, schema: event.schema });
		return;
	}
	state.set(event.extension, {
		...current,
		ownedVersion: event.version,
	});
}

function assertPrefixMatchesInstalledState(input: {
	expectedPrefix: ReadonlyMap<string, LifecycleState>;
	installed: ReadonlyMap<string, InstalledDatabaseExtension>;
	knownExtensions: ReadonlySet<string>;
	pendingEvents: readonly MappedLifecycleEvent[];
}): void {
	for (const extension of input.knownExtensions) {
		const expected = input.expectedPrefix.get(extension);
		const actual = input.installed.get(extension);
		if (actual && !actual.canManage) {
			throw new Error(
				`Migration role cannot manage installed PostgreSQL extension ${extension}`,
			);
		}
		if (expected && !actual) {
			throw new Error(
				`PostgreSQL extension ${extension} is missing even though its owning CREATE migration is present in the verified ledger prefix`,
			);
		}
		if (!expected || !actual) continue;
		if (actual.schema !== expected.schema) {
			throw new Error(
				`PostgreSQL extension ${extension} is in schema ${actual.schema}, but the verified ledger prefix owns schema ${expected.schema}`,
			);
		}
		if (
			expected.ownedVersion !== undefined &&
			actual.version !== expected.ownedVersion
		) {
			throw new Error(
				`PostgreSQL extension ${extension} is at version ${actual.version}, but the verified ledger prefix owns version ${expected.ownedVersion}`,
			);
		}
		if (expected.ownedVersion !== undefined) continue;

		for (const event of input.pendingEvents) {
			if (event.extension !== extension) continue;
			if (event.operation === "drop") break;
			if (event.operation === "update" && event.version === actual.version) {
				throw new Error(
					`PostgreSQL extension ${extension} is already at pending target ${actual.version}, but migration ${event.migration} is not present in the verified ledger prefix`,
				);
			}
		}
	}
}

function requirePendingExtensionAvailability(
	extension: string,
	catalog: DatabaseExtensionCatalogSnapshot,
): string | undefined {
	if (!catalog.availableDefaults.has(extension)) {
		throw new Error(
			`PostgreSQL extension ${extension} is unavailable for a pending lifecycle operation`,
		);
	}
	return catalog.availableDefaults.get(extension);
}

/**
 * Verify the exact extension state owned by the applied migration prefix, then
 * simulate only the remaining lifecycle operations from that real state.
 *
 * A version is considered complete only when its owning pinned CREATE/UPDATE
 * event belongs to the verified ledger prefix. This prevents CREATE IF NOT
 * EXISTS and UPDATE TO from silently accepting out-of-band future state.
 */
export function verifyPendingDatabaseExtensionLifecycleSnapshot(input: {
	manifest: MigrationManifest;
	appliedMigrationCount: number;
	catalog: DatabaseExtensionCatalogSnapshot;
	lifecycleEvents?: readonly DatabaseExtensionLifecycleEvent[];
	activeExtensions?: readonly string[];
	activeSchemas?: Readonly<Record<string, string>>;
	activeVersions?: Readonly<Record<string, string | undefined>>;
}): { pendingEventCount: number } {
	if (
		!Number.isSafeInteger(input.appliedMigrationCount) ||
		input.appliedMigrationCount < 0 ||
		input.appliedMigrationCount > input.manifest.migrations.length
	) {
		throw new Error(
			`Applied migration count ${input.appliedMigrationCount} is outside the tracked manifest`,
		);
	}
	const lifecycleEvents =
		input.lifecycleEvents ?? DATABASE_EXTENSION_LIFECYCLE_EVENTS;
	const activeExtensions =
		input.activeExtensions ?? REQUIRED_DATABASE_EXTENSIONS;
	const activeSchemas: Readonly<Record<string, string>> =
		input.activeSchemas ?? REQUIRED_DATABASE_EXTENSION_SCHEMAS;
	const activeVersions: Readonly<Record<string, string | undefined>> =
		input.activeVersions ?? REQUIRED_DATABASE_EXTENSION_VERSIONS;
	const mappedEvents = mapLifecycleEvents(input.manifest, lifecycleEvents);
	const knownExtensions = new Set(mappedEvents.map((event) => event.extension));
	const appliedEvents = mappedEvents.filter(
		(event) => event.migrationIndex < input.appliedMigrationCount,
	);
	const pendingEvents = mappedEvents.filter(
		(event) => event.migrationIndex >= input.appliedMigrationCount,
	);
	const expectedPrefix = new Map<string, LifecycleState>();
	for (const event of appliedEvents) {
		applyOwnedLifecycleEvent(expectedPrefix, event);
	}
	assertPrefixMatchesInstalledState({
		expectedPrefix,
		installed: input.catalog.installed,
		knownExtensions,
		pendingEvents,
	});

	const simulated = new Map(
		[...input.catalog.installed].flatMap(([extension, state]) =>
			knownExtensions.has(extension)
				? [
						[
							extension,
							{ schema: state.schema, version: state.version },
						] as const,
					]
				: [],
		),
	);
	for (const event of pendingEvents) {
		if (event.operation === "create") {
			const providerDefault = requirePendingExtensionAvailability(
				event.extension,
				input.catalog,
			);
			if (
				event.version !== undefined &&
				!input.catalog.availableVersions.has(
					extensionVersionKey(event.extension, event.version),
				)
			) {
				throw new Error(
					`PostgreSQL extension ${event.extension} version ${event.version} is unavailable for pending CREATE migration ${event.migration}`,
				);
			}
			if (
				event.version === undefined &&
				(providerDefault === undefined || !providerDefault.trim())
			) {
				throw new Error(
					`PostgreSQL extension ${event.extension} has no provider default for pending CREATE migration ${event.migration}`,
				);
			}
			// CREATE EXTENSION IF NOT EXISTS deliberately accepts a provider-
			// preinstalled extension. PostgreSQL preserves that installation's
			// schema/version, so the simulation must do the same and let later
			// pending UPDATE/DROP plus final-state checks decide. The migration's
			// own immediate namespace assertion still requires the declared
			// schema, and a pinned CREATE cannot silently accept another version.
			const existing = simulated.get(event.extension);
			if (existing && existing.schema !== event.schema) {
				throw new Error(
					`Preinstalled PostgreSQL extension ${event.extension} is in schema ${existing.schema}, but pending CREATE migration ${event.migration} immediately requires schema ${event.schema}`,
				);
			}
			if (
				existing &&
				event.version !== undefined &&
				existing.version !== event.version
			) {
				throw new Error(
					`Preinstalled PostgreSQL extension ${event.extension} is at version ${existing.version}, but pending CREATE migration ${event.migration} pins version ${event.version}`,
				);
			}
			if (!existing) {
				simulated.set(event.extension, {
					schema: event.schema,
					version: event.version ?? (providerDefault as string),
				});
			}
			continue;
		}

		const current = simulated.get(event.extension);
		if (!current) {
			throw new Error(
				`Pending ${event.operation} for PostgreSQL extension ${event.extension} has no installed lifecycle state`,
			);
		}
		if (event.operation === "drop") {
			simulated.delete(event.extension);
			continue;
		}
		if (event.operation === "set_schema") {
			requirePendingExtensionAvailability(event.extension, input.catalog);
			if (
				input.catalog.relocatableVersions.get(
					extensionVersionKey(event.extension, current.version),
				) !== true
			) {
				throw new Error(
					`PostgreSQL extension ${event.extension} version ${current.version} is not relocatable for pending SET SCHEMA migration ${event.migration}`,
				);
			}
			simulated.set(event.extension, {
				...current,
				schema: event.schema,
			});
			continue;
		}

		requirePendingExtensionAvailability(event.extension, input.catalog);
		if (
			!input.catalog.availableVersions.has(
				extensionVersionKey(event.extension, event.version),
			)
		) {
			throw new Error(
				`PostgreSQL extension ${event.extension} version ${event.version} is unavailable for pending UPDATE migration ${event.migration}`,
			);
		}
		if (current.version === event.version) {
			throw new Error(
				`PostgreSQL extension ${event.extension} is already at pending target ${event.version}, but migration ${event.migration} is not present in the verified ledger prefix`,
			);
		}
		const path = input.catalog.updatePaths.get(
			extensionUpdatePathKey(event.extension, current.version, event.version),
		);
		if (typeof path !== "string" || !path.trim()) {
			throw new Error(
				`PostgreSQL extension ${event.extension} has no reachable update path from ${current.version} to pending target ${event.version} owned by migration ${event.migration}`,
			);
		}
		simulated.set(event.extension, {
			...current,
			version: event.version,
		});
	}

	const activeSet = new Set(activeExtensions);
	for (const extension of simulated.keys()) {
		if (!activeSet.has(extension)) {
			throw new Error(
				`Pending extension lifecycle leaves retired managed extension ${extension} installed`,
			);
		}
	}
	for (const extension of activeExtensions) {
		const state = simulated.get(extension);
		if (!state) {
			throw new Error(
				`Pending extension lifecycle does not leave required extension ${extension} installed`,
			);
		}
		const expectedSchema = activeSchemas[extension];
		if (!expectedSchema || state.schema !== expectedSchema) {
			throw new Error(
				`Pending extension lifecycle leaves ${extension} in schema ${state.schema}, expected ${expectedSchema ?? "<unregistered>"}`,
			);
		}
		const expectedVersion = activeVersions[extension];
		if (expectedVersion !== undefined && state.version !== expectedVersion) {
			throw new Error(
				`Pending extension lifecycle leaves ${extension} at version ${state.version}, expected ${expectedVersion}`,
			);
		}
	}
	return { pendingEventCount: pendingEvents.length };
}

/**
 * Bind the lifecycle ledger to the exact SQL protected by the tracked manifest.
 * Every supported baseline generation owns the complete current extension
 * lifecycle; pre-live history was reset before generation 1 was sealed.
 */
export function verifyTrackedDatabaseExtensionLifecycleSources(input: {
	manifest: MigrationManifest;
	migrationsByTag: Readonly<Record<string, string>>;
	generation: number;
}): void {
	const contract = databaseExtensionContractForGeneration(input.generation);
	const migrationOrder = input.manifest.migrations.map(
		(migration) => migration.tag,
	);
	const expectedTags = new Set(migrationOrder);
	for (const tag of migrationOrder) {
		if (input.migrationsByTag[tag] === undefined) {
			throw new Error(
				`Tracked migration ${tag} has no SQL source for database extension lifecycle verification`,
			);
		}
	}
	for (const tag of Object.keys(input.migrationsByTag)) {
		if (!expectedTags.has(tag)) {
			throw new Error(
				`Untracked migration SQL ${tag} was supplied for database extension lifecycle verification`,
			);
		}
	}
	const failures = auditDatabaseExtensionLifecycle(input.migrationsByTag, {
		migrationOrder,
		activeExtensions: contract.activeExtensions,
		activeExtensionSchemas: contract.activeSchemas,
		activeExtensionVersions: contract.activeVersions,
		installabilityProbes: contract.installabilityProbes,
		lifecycleEvents: contract.lifecycleEvents,
	});
	if (failures.length > 0) {
		throw new Error(
			`Tracked migration SQL does not match the database extension lifecycle:\n- ${failures.join("\n- ")}`,
		);
	}
}

type InstalledExtensionRow = {
	extension_name: string;
	extension_schema: string;
	extension_version: string;
	can_manage_extension: boolean;
};

type AvailableExtensionRow = {
	extension_name: string;
	default_version: string | null;
};

type AvailableVersionRow = {
	extension_name: string;
	extension_version: string;
	relocatable: boolean;
};

type UpdatePathRow = {
	source_version: string;
	target_version: string;
	update_path: string | null;
};

/**
 * Live authority invoked by migrate.ts after ledger verification and while the
 * same one-session advisory lock is still held.
 */
export async function verifyPendingDatabaseExtensionLifecycle(
	sql: MigrationSql,
	manifest: MigrationManifest,
	appliedMigrationCount: number,
	migrationsFolder: string,
	generation: number,
): Promise<void> {
	const contract = databaseExtensionContractForGeneration(generation);
	verifyTrackedDatabaseExtensionLifecycleSources({
		manifest,
		migrationsByTag: Object.fromEntries(
			manifest.migrations.map((migration) => [
				migration.tag,
				readFileSync(join(migrationsFolder, `${migration.tag}.sql`), "utf8"),
			]),
		),
		generation,
	});
	const mappedEvents = mapLifecycleEvents(manifest, contract.lifecycleEvents);
	const knownExtensions = [
		...new Set(mappedEvents.map((event) => event.extension)),
	];
	const pendingEvents = mappedEvents.filter(
		(event) => event.migrationIndex >= appliedMigrationCount,
	);
	const capabilityExtensions = [
		...new Set(
			pendingEvents.flatMap((event) =>
				event.operation === "create" ||
				event.operation === "update" ||
				event.operation === "set_schema"
					? [event.extension]
					: [],
			),
		),
	];
	const updatePathExtensions = [
		...new Set(
			pendingEvents.flatMap((event) =>
				event.operation === "update" ? [event.extension] : [],
			),
		),
	];

	const installedRows =
		knownExtensions.length === 0
			? []
			: await sql<InstalledExtensionRow[]>`
				SELECT extension_row.extname AS extension_name,
					namespace_row.nspname AS extension_schema,
					extension_row.extversion AS extension_version,
					pg_catalog.pg_has_role(current_user, extension_row.extowner, 'USAGE') AS can_manage_extension
				FROM pg_catalog.pg_extension extension_row
				JOIN pg_catalog.pg_namespace namespace_row
					ON namespace_row.oid = extension_row.extnamespace
				WHERE extension_row.extname IN ${sql(knownExtensions)}
				ORDER BY extension_row.extname
			`;
	const availableRows =
		capabilityExtensions.length === 0
			? []
			: await sql<AvailableExtensionRow[]>`
				SELECT available_extension.name AS extension_name,
					available_extension.default_version AS default_version
				FROM pg_catalog.pg_available_extensions available_extension
				WHERE available_extension.name IN ${sql(capabilityExtensions)}
				ORDER BY available_extension.name
			`;
	const availableVersionRows =
		capabilityExtensions.length === 0
			? []
			: await sql<AvailableVersionRow[]>`
				SELECT available_version.name AS extension_name,
					available_version.version AS extension_version,
					available_version.relocatable AS relocatable
				FROM pg_catalog.pg_available_extension_versions available_version
				WHERE available_version.name IN ${sql(capabilityExtensions)}
				ORDER BY available_version.name, available_version.version
			`;
	const updatePaths = new Map<string, string | null>();
	for (const extension of updatePathExtensions) {
		const rows = await sql<UpdatePathRow[]>`
			SELECT update_path.source AS source_version,
				update_path.target AS target_version,
				update_path.path AS update_path
			FROM pg_catalog.pg_extension_update_paths(${extension}) update_path
			ORDER BY update_path.source, update_path.target
		`;
		for (const row of rows) {
			updatePaths.set(
				extensionUpdatePathKey(
					extension,
					String(row.source_version),
					String(row.target_version),
				),
				row.update_path === null ? null : String(row.update_path),
			);
		}
	}

	const result = verifyPendingDatabaseExtensionLifecycleSnapshot({
		manifest,
		appliedMigrationCount,
		catalog: {
			installed: new Map(
				installedRows.map((row) => [
					String(row.extension_name),
					{
						schema: String(row.extension_schema),
						version: String(row.extension_version),
						canManage: row.can_manage_extension === true,
					},
				]),
			),
			availableDefaults: new Map(
				availableRows.map((row) => [
					String(row.extension_name),
					row.default_version === null
						? undefined
						: String(row.default_version),
				]),
			),
			availableVersions: new Set(
				availableVersionRows.map((row) =>
					extensionVersionKey(
						String(row.extension_name),
						String(row.extension_version),
					),
				),
			),
			relocatableVersions: new Map(
				availableVersionRows.map((row) => [
					extensionVersionKey(
						String(row.extension_name),
						String(row.extension_version),
					),
					row.relocatable === true,
				]),
			),
			updatePaths,
		},
		lifecycleEvents: contract.lifecycleEvents,
		activeExtensions: contract.activeExtensions,
		activeSchemas: contract.activeSchemas,
		activeVersions: contract.activeVersions,
	});
	console.log(
		`Pending database extension lifecycle verified (${result.pendingEventCount} events remain).`,
	);
}
