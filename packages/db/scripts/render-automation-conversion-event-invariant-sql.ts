export const AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT = {
	tableSchema: "public",
	tableName: "automation_conversion_events",
	functionSchema: "public",
	functionName: "protect_automation_conversion_event_fact",
	triggerName: "automation_conversion_event_fact_immutable",
	immutableColumns: [
		"id",
		"organization_id",
		"scope_key",
		"automation_id",
		"run_id",
		"occurrence_id",
		"event_name",
		"value",
		"currency",
		"channel",
		"social_account_id",
		"conversation_id",
		"event_depth",
		"created_at",
	],
} as const;

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
	return `${identifier(schema)}.${identifier(name)}`;
}

/**
 * Conversion analytics and outbox state deliberately share one row. This
 * trigger keeps the compact shape honest: dispatch/retention fields and the
 * run-owned canonical contact projection may transition, while the conversion
 * fact they describe cannot be rewritten.
 */
export function renderAutomationConversionEventInvariantSql(): string {
	const contract = AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT;
	const immutablePredicate = contract.immutableColumns
		.map(
			(column) =>
				`\t\tOLD.${identifier(column)} IS DISTINCT FROM NEW.${identifier(column)}`,
		)
		.join("\n\t\tOR ");
	return `${[
		"--> statement-breakpoint",
		`CREATE OR REPLACE FUNCTION ${qualified(contract.functionSchema, contract.functionName)}()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_automation_conversion_event_fact$",
		"BEGIN",
		"\tIF (",
		immutablePredicate,
		"\t) THEN",
		"\t\tRAISE EXCEPTION USING",
		"\t\t\tERRCODE = '23514',",
		"\t\t\tMESSAGE = 'automation conversion fact columns are immutable';",
		"\tEND IF;",
		"\tRETURN NEW;",
		"END;",
		"$relay_automation_conversion_event_fact$;",
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
	process.stdout.write(renderAutomationConversionEventInvariantSql());
}
