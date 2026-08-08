export const STRIPE_EVENT_ATTRIBUTION_INVARIANT_CONTRACT = {
	tableSchema: "public",
	tableName: "stripe_events",
	columnName: "organization_id",
	functionSchema: "public",
	functionName: "enforce_stripe_event_organization_attribution",
	triggerName: "stripe_events_organization_attribution_immutable",
} as const;

/**
 * Stripe-event tenant attribution is learned after durable acceptance. It may
 * move from NULL to one organization exactly once, but it can never be cleared
 * or reassigned. There is intentionally no organization FK: tenant erasure
 * must first minimize/delete the provider receipt under its durable attribution.
 */
export function renderStripeEventAttributionInvariantSql(): string {
	const contract = STRIPE_EVENT_ATTRIBUTION_INVARIANT_CONTRACT;
	return [
		`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_stripe_event_attribution_immutable$",
		"BEGIN",
		`	IF OLD."${contract.columnName}" IS NOT NULL`,
		`		AND NEW."${contract.columnName}" IS DISTINCT FROM OLD."${contract.columnName}"`,
		"	THEN",
		"		RAISE EXCEPTION USING",
		"			ERRCODE = '23514',",
		"			MESSAGE = 'Stripe event organization attribution is immutable once set';",
		"	END IF;",
		"	RETURN NEW;",
		"END;",
		"$relay_stripe_event_attribution_immutable$;",
		"--> statement-breakpoint",
		`DROP TRIGGER IF EXISTS "${contract.triggerName}" ON "${contract.tableSchema}"."${contract.tableName}";`,
		"--> statement-breakpoint",
		`CREATE TRIGGER "${contract.triggerName}"`,
		`BEFORE UPDATE OF "${contract.columnName}" ON "${contract.tableSchema}"."${contract.tableName}"`,
		"FOR EACH ROW",
		`EXECUTE FUNCTION "${contract.functionSchema}"."${contract.functionName}"();`,
		"--> statement-breakpoint",
		"",
	].join("\n");
}

if (import.meta.main) {
	process.stdout.write(renderStripeEventAttributionInvariantSql());
}
