/** Current post-migration extension state required by application code. */
export const REQUIRED_DATABASE_EXTENSIONS = [
	"btree_gist",
	"pg_trgm",
	"vector",
] as const;

export type RequiredDatabaseExtension =
	(typeof REQUIRED_DATABASE_EXTENSIONS)[number];

export const REQUIRED_DATABASE_EXTENSION_SCHEMAS = {
	btree_gist: "public",
	pg_trgm: "public",
	vector: "public",
} as const satisfies Record<
	RequiredDatabaseExtension,
	string
>;

/**
 * Exact active versions when RelayAPI pins one. `undefined` is deliberate for
 * the frozen baseline extensions, whose CREATE statements use the provider's
 * default version.
 */
export const REQUIRED_DATABASE_EXTENSION_VERSIONS = {
	btree_gist: undefined,
	pg_trgm: undefined,
	vector: undefined,
} as const satisfies Record<
	RequiredDatabaseExtension,
	string | undefined
>;

export type DatabaseExtensionVersionEpoch = {
	/** Schema named by this epoch's CREATE EXTENSION statement. */
	schema: string;
	/** Exact CREATE VERSION, or undefined for the provider default. */
	createVersion?: string;
	/** Exact ALTER EXTENSION UPDATE TO targets in migration order. */
	updateTargets: readonly string[];
	/** Whether the extension is dropped before a later epoch or final state. */
	dropAfter: boolean;
};

export type DatabaseExtensionInstallabilityProbe = {
	/** Ordered create/update/drop epochs required by clean migration replay. */
	versionEpochs: readonly DatabaseExtensionVersionEpoch[];
};

/**
 * Publish-safe historical replay prerequisites. Entries are append-only even
 * after an extension is retired: a clean install must still be able to replay
 * the CREATE and later DROP. Probe schemas must be valid creation targets and
 * deliberately contain no numbered migration identities.
 */
export const DATABASE_EXTENSION_INSTALLABILITY_PROBES = {
	btree_gist: {
		versionEpochs: [{ schema: "public", updateTargets: [], dropAfter: false }],
	},
	pg_trgm: {
		versionEpochs: [{ schema: "public", updateTargets: [], dropAfter: false }],
	},
	vector: {
		versionEpochs: [{ schema: "public", updateTargets: [], dropAfter: false }],
	},
} as const satisfies Readonly<
	Record<string, DatabaseExtensionInstallabilityProbe>
>;
