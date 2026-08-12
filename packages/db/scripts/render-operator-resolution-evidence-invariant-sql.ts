export const OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT = {
	tableSchema: "public",
	tableName: "operator_resolution_evidence",
	functionSchema: "public",
	functionName: "reject_operator_resolution_evidence_mutation",
	triggerName: "operator_resolution_evidence_append_only",
} as const;

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
	return `${identifier(schema)}.${identifier(name)}`;
}

/**
 * The evidence table is deliberately append-only at the database boundary.
 * This renderer is appended after Drizzle creates the table in every fresh
 * baseline and ordinary migration that introduces the contract.
 */
export function renderOperatorResolutionEvidenceInvariantSql(): string {
	const contract = OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT;
	return `${[
		"--> statement-breakpoint",
		`CREATE OR REPLACE FUNCTION ${qualified(contract.functionSchema, contract.functionName)}()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_operator_resolution_evidence_append_only$",
		"BEGIN",
		"\tRAISE EXCEPTION USING",
		"\t\tERRCODE = '23514',",
		"\t\tMESSAGE = 'operator resolution evidence is append-only';",
		"END;",
		"$relay_operator_resolution_evidence_append_only$;",
		"--> statement-breakpoint",
		`DROP TRIGGER IF EXISTS ${identifier(contract.triggerName)} ON ${qualified(contract.tableSchema, contract.tableName)};`,
		"--> statement-breakpoint",
		`CREATE TRIGGER ${identifier(contract.triggerName)}`,
		`BEFORE UPDATE OR DELETE ON ${qualified(contract.tableSchema, contract.tableName)}`,
		"FOR EACH ROW",
		`EXECUTE FUNCTION ${qualified(contract.functionSchema, contract.functionName)}();`,
		"--> statement-breakpoint",
	].join("\n")}\n`;
}

if (import.meta.main) {
	process.stdout.write(renderOperatorResolutionEvidenceInvariantSql());
}
