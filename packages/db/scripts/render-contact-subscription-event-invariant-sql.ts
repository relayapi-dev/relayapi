export const CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT = {
	tableSchema: "public",
	tableName: "contact_subscription_events",
	functionSchema: "public",
	functionName: "reject_contact_subscription_event_update",
	triggerName: "contact_subscription_events_append_only",
} as const;

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
	return `${identifier(schema)}.${identifier(name)}`;
}

/**
 * Committed subscription evidence cannot be rewritten. DELETE remains
 * available because explicit contact/tenant erasure and retention drains must
 * be able to remove the evidence instead of conflicting with privacy policy.
 */
export function renderContactSubscriptionEventInvariantSql(): string {
	const contract = CONTACT_SUBSCRIPTION_EVENT_APPEND_ONLY_CONTRACT;
	return `${[
		"--> statement-breakpoint",
		`CREATE OR REPLACE FUNCTION ${qualified(contract.functionSchema, contract.functionName)}()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_contact_subscription_event_append_only$",
		"BEGIN",
		"\tRAISE EXCEPTION USING",
		"\t\tERRCODE = '23514',",
		"\t\tMESSAGE = 'contact subscription events are append-only';",
		"END;",
		"$relay_contact_subscription_event_append_only$;",
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
	process.stdout.write(renderContactSubscriptionEventInvariantSql());
}
