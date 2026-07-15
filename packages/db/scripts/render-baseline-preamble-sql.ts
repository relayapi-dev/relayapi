export const BASELINE_PREAMBLE_MARKER =
	"-- RelayAPI required database preamble (generated).";

export const REQUIRED_BASELINE_SCHEMAS = ["auth"] as const;
export const REQUIRED_BASELINE_EXTENSIONS = ["pg_trgm"] as const;
export const REQUIRED_BASELINE_EXTENSION_SCHEMAS = {
	pg_trgm: "public",
} as const satisfies Record<
	(typeof REQUIRED_BASELINE_EXTENSIONS)[number],
	string
>;

const statementBreak = "--> statement-breakpoint";

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function renderBaselinePreambleSql(): string {
	const statements = [
		...REQUIRED_BASELINE_SCHEMAS.map(
			(schema) => `CREATE SCHEMA IF NOT EXISTS ${identifier(schema)};`,
		),
		...REQUIRED_BASELINE_EXTENSIONS.map(
			(extension) =>
				`CREATE EXTENSION IF NOT EXISTS ${identifier(extension)} WITH SCHEMA ${identifier(REQUIRED_BASELINE_EXTENSION_SCHEMAS[extension])};`,
		),
	];
	return `${[
		BASELINE_PREAMBLE_MARKER,
		...statements.flatMap((statement) => [statement, statementBreak]),
		"DO $relay_verify_extension_schema$",
		"BEGIN",
		...REQUIRED_BASELINE_EXTENSIONS.flatMap((extension) => [
			"\tIF NOT EXISTS (",
			"\t\tSELECT 1 FROM pg_catalog.pg_extension extension_row",
			"\t\tJOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = extension_row.extnamespace",
			`\t\tWHERE extension_row.extname = '${extension.replaceAll("'", "''")}'`,
			`\t\t\tAND namespace_row.nspname = '${REQUIRED_BASELINE_EXTENSION_SCHEMAS[extension].replaceAll("'", "''")}'`,
			"\t) THEN",
			`\t\tRAISE EXCEPTION 'required extension ${extension} must be installed in schema ${REQUIRED_BASELINE_EXTENSION_SCHEMAS[extension]}';`,
			"\tEND IF;",
		]),
		"END;",
		"$relay_verify_extension_schema$;",
		statementBreak,
	].join("\n")}\n`;
}

if (import.meta.main) {
	process.stdout.write(renderBaselinePreambleSql());
}
