/**
 * Migration-only, append-ordered ownership of extension lifecycle DDL.
 *
 * This ledger describes history, including extensions that are no longer
 * active. Runtime and self-host consumers intentionally import only
 * ../src/database-prerequisites.ts, whose final active registry is checked
 * against the state produced by replaying these events.
 */
export type DatabaseExtensionLifecycleEvent =
	| {
			operation: "create";
			extension: string;
			migration: string;
			schema: string;
			version?: string;
	  }
	| {
			operation: "drop";
			extension: string;
			migration: string;
	  }
	| {
			operation: "set_schema";
			extension: string;
			migration: string;
			schema: string;
	  }
	| {
			operation: "update";
			extension: string;
			migration: string;
			version: string;
	  };

export const DATABASE_EXTENSION_LIFECYCLE_EVENTS = [
	{
		operation: "create",
		extension: "btree_gist",
		migration: "0000_baseline",
		schema: "public",
	},
	{
		operation: "create",
		extension: "pg_trgm",
		migration: "0000_baseline",
		schema: "public",
	},
	{
		operation: "create",
		extension: "vector",
		migration: "0000_baseline",
		schema: "public",
	},
] as const satisfies readonly DatabaseExtensionLifecycleEvent[];
