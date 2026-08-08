export const FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT = {
	tableSchema: "public",
	tableName: "financial_retention_receipts",
	functionSchema: "public",
	functionName: "reject_financial_retention_receipt_update",
	triggerName: "financial_retention_receipts_immutable",
} as const;

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
	return `${identifier(schema)}.${identifier(name)}`;
}

/**
 * Financial receipts are immutable facts, but unlike operator evidence they
 * must remain deletable when their retention clock expires.
 */
export function renderFinancialRetentionReceiptInvariantSql(): string {
	const contract = FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT;
	return `${[
		"--> statement-breakpoint",
		`CREATE OR REPLACE FUNCTION ${qualified(contract.functionSchema, contract.functionName)}()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_financial_retention_receipt_immutable$",
		"BEGIN",
		"\tRAISE EXCEPTION USING",
		"\t\tERRCODE = '23514',",
		"\t\tMESSAGE = 'financial retention receipts are immutable';",
		"END;",
		"$relay_financial_retention_receipt_immutable$;",
		"--> statement-breakpoint",
		`DROP TRIGGER IF EXISTS ${identifier(contract.triggerName)} ON ${qualified(contract.tableSchema, contract.tableName)};`,
		"--> statement-breakpoint",
		`CREATE TRIGGER ${identifier(contract.triggerName)}`,
		`BEFORE UPDATE ON ${qualified(contract.tableSchema, contract.tableName)}`,
		"FOR EACH ROW",
		`EXECUTE FUNCTION ${qualified(contract.functionSchema, contract.functionName)}();`,
		"--> statement-breakpoint",
	].join("\n")}\n`;
}

if (import.meta.main) {
	process.stdout.write(renderFinancialRetentionReceiptInvariantSql());
}
