import { USAGE_BUCKET_PROJECTION_CONTRACT } from "../src/usage-projection-contract";

const statementBreak = "--> statement-breakpoint";

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, name: string): string {
	return `${identifier(schema)}.${identifier(name)}`;
}

function contribution(relation: string, direction: 1 | -1): readonly string[] {
	const sign = direction === 1 ? "" : "-";
	return [
		"\t\tSELECT",
		"\t\t\tbucket_id,",
		`\t\t\t${sign}CASE WHEN state IN ('reserved', 'parked') THEN units ELSE 0 END AS reserved_delta,`,
		`\t\t\t${sign}CASE WHEN state = 'committed' THEN committed_units ELSE 0 END AS committed_delta`,
		`\t\tFROM ${identifier(relation)}`,
	];
}

function projectionUpdate(
	contributions: readonly (readonly string[])[],
): string[] {
	const contract = USAGE_BUCKET_PROJECTION_CONTRACT;
	const union: string[] = [];
	for (const [index, lines] of contributions.entries()) {
		if (index > 0) union.push("\t\tUNION ALL");
		union.push(...lines);
	}
	return [
		"\tWITH deltas AS (",
		"\t\tSELECT",
		"\t\t\tbucket_id,",
		"\t\t\tSUM(reserved_delta)::bigint AS reserved_delta,",
		"\t\t\tSUM(committed_delta)::bigint AS committed_delta",
		"\t\tFROM (",
		...union,
		"\t\t) AS changes",
		"\t\tGROUP BY bucket_id",
		"\t)",
		`\tUPDATE ${qualified(contract.tableSchema, contract.bucketTable)} AS bucket`,
		"\tSET",
		"\t\treserved_units = bucket.reserved_units + deltas.reserved_delta,",
		"\t\tcommitted_units = bucket.committed_units + deltas.committed_delta,",
		"\t\trevision = bucket.revision + 1,",
		"\t\tupdated_at = statement_timestamp()",
		"\tFROM deltas",
		"\tWHERE bucket.id = deltas.bucket_id",
		"\t\tAND (deltas.reserved_delta <> 0 OR deltas.committed_delta <> 0);",
	];
}

/**
 * Render the source-owned usage projection. Transition relations keep stale
 * release and retention batches O(affected buckets), while the guard makes the
 * ledger—not application-maintained arithmetic—the only counter authority.
 */
export function renderUsageBucketProjectionSql(): string {
	const contract = USAGE_BUCKET_PROJECTION_CONTRACT;
	const insert = contract.triggers.insert;
	const update = contract.triggers.update;
	const remove = contract.triggers.delete;
	const guard = contract.triggers.bucketGuard;

	return `${[
		statementBreak,
		`CREATE OR REPLACE FUNCTION ${qualified(contract.projectionFunctionSchema, contract.projectionFunctionName)}()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_usage_bucket_projection$",
		"BEGIN",
		`\tPERFORM set_config('${contract.ownershipMarker}', 'on', true);`,
		"\tIF TG_OP = 'INSERT' THEN",
		...projectionUpdate([contribution(insert.newTransitionTable, 1)]).map(
			(line) => `\t${line}`,
		),
		"\tELSIF TG_OP = 'UPDATE' THEN",
		...projectionUpdate([
			contribution(update.oldTransitionTable, -1),
			contribution(update.newTransitionTable, 1),
		]).map((line) => `\t${line}`),
		"\tELSIF TG_OP = 'DELETE' THEN",
		...projectionUpdate([contribution(remove.oldTransitionTable, -1)]).map(
			(line) => `\t${line}`,
		),
		"\tEND IF;",
		`\tPERFORM set_config('${contract.ownershipMarker}', 'off', true);`,
		"\tRETURN NULL;",
		"END;",
		"$relay_usage_bucket_projection$;",
		statementBreak,
		"",
		`DROP TRIGGER IF EXISTS ${identifier(insert.name)} ON ${qualified(contract.tableSchema, contract.reservationTable)};`,
		statementBreak,
		`CREATE TRIGGER ${identifier(insert.name)}`,
		`AFTER ${insert.operation} ON ${qualified(contract.tableSchema, contract.reservationTable)}`,
		`REFERENCING NEW TABLE AS ${identifier(insert.newTransitionTable)}`,
		"FOR EACH STATEMENT",
		`EXECUTE FUNCTION ${qualified(contract.projectionFunctionSchema, contract.projectionFunctionName)}();`,
		statementBreak,
		"",
		`DROP TRIGGER IF EXISTS ${identifier(update.name)} ON ${qualified(contract.tableSchema, contract.reservationTable)};`,
		statementBreak,
		`CREATE TRIGGER ${identifier(update.name)}`,
		`AFTER ${update.operation} ON ${qualified(contract.tableSchema, contract.reservationTable)}`,
		`REFERENCING OLD TABLE AS ${identifier(update.oldTransitionTable)} NEW TABLE AS ${identifier(update.newTransitionTable)}`,
		"FOR EACH STATEMENT",
		`EXECUTE FUNCTION ${qualified(contract.projectionFunctionSchema, contract.projectionFunctionName)}();`,
		statementBreak,
		"",
		`DROP TRIGGER IF EXISTS ${identifier(remove.name)} ON ${qualified(contract.tableSchema, contract.reservationTable)};`,
		statementBreak,
		`CREATE TRIGGER ${identifier(remove.name)}`,
		`AFTER ${remove.operation} ON ${qualified(contract.tableSchema, contract.reservationTable)}`,
		`REFERENCING OLD TABLE AS ${identifier(remove.oldTransitionTable)}`,
		"FOR EACH STATEMENT",
		`EXECUTE FUNCTION ${qualified(contract.projectionFunctionSchema, contract.projectionFunctionName)}();`,
		statementBreak,
		"",
		`UPDATE ${qualified(contract.tableSchema, contract.bucketTable)} AS bucket`,
		"SET",
		"\treserved_units = projection.reserved_units,",
		"\tcommitted_units = projection.committed_units,",
		"\trevision = bucket.revision + 1,",
		"\tupdated_at = statement_timestamp()",
		"FROM (",
		"\tSELECT",
		"\t\tbucket_row.id AS bucket_id,",
		"\t\tCOALESCE(SUM(reservation.units) FILTER (WHERE reservation.state IN ('reserved', 'parked')), 0)::bigint AS reserved_units,",
		"\t\tCOALESCE(SUM(reservation.committed_units) FILTER (WHERE reservation.state = 'committed'), 0)::bigint AS committed_units",
		`\tFROM ${qualified(contract.tableSchema, contract.bucketTable)} AS bucket_row`,
		`\tLEFT JOIN ${qualified(contract.tableSchema, contract.reservationTable)} AS reservation`,
		"\t\tON reservation.bucket_id = bucket_row.id",
		"\tGROUP BY bucket_row.id",
		") AS projection",
		"WHERE bucket.id = projection.bucket_id",
		"\tAND (",
		"\t\tbucket.reserved_units IS DISTINCT FROM projection.reserved_units",
		"\t\tOR bucket.committed_units IS DISTINCT FROM projection.committed_units",
		"\t);",
		statementBreak,
		"",
		`CREATE OR REPLACE FUNCTION ${qualified(contract.guardFunctionSchema, contract.guardFunctionName)}()`,
		"RETURNS trigger",
		"LANGUAGE plpgsql",
		"SET search_path = pg_catalog, public",
		"AS $relay_usage_bucket_projection_guard$",
		"BEGIN",
		"\tIF TG_OP = 'INSERT' THEN",
		"\t\tIF NEW.reserved_units <> 0 OR NEW.committed_units <> 0 THEN",
		"\t\t\tRAISE EXCEPTION USING",
		"\t\t\t\tERRCODE = '23514',",
		"\t\t\t\tMESSAGE = 'usage bucket counters must start at zero';",
		"\t\tEND IF;",
		"\tELSIF (",
		"\t\tNEW.reserved_units IS DISTINCT FROM OLD.reserved_units",
		"\t\tOR NEW.committed_units IS DISTINCT FROM OLD.committed_units",
		"\t) AND (",
		"\t\tpg_trigger_depth() < 2",
		`\t\tOR COALESCE(current_setting('${contract.ownershipMarker}', true), 'off') <> 'on'`,
		"\t) THEN",
		"\t\tRAISE EXCEPTION USING",
		"\t\t\tERRCODE = '23514',",
		"\t\t\tMESSAGE = 'usage bucket counters are owned by usage_reservations';",
		"\tEND IF;",
		"\tRETURN NEW;",
		"END;",
		"$relay_usage_bucket_projection_guard$;",
		statementBreak,
		"",
		`DROP TRIGGER IF EXISTS ${identifier(guard.name)} ON ${qualified(contract.tableSchema, contract.bucketTable)};`,
		statementBreak,
		`CREATE TRIGGER ${identifier(guard.name)}`,
		`BEFORE INSERT OR UPDATE OF ${identifier("reserved_units")}, ${identifier("committed_units")}`,
		`ON ${qualified(contract.tableSchema, contract.bucketTable)}`,
		"FOR EACH ROW",
		`EXECUTE FUNCTION ${qualified(contract.guardFunctionSchema, contract.guardFunctionName)}();`,
		statementBreak,
	].join("\n")}\n`;
}

if (import.meta.main) {
	process.stdout.write(renderUsageBucketProjectionSql());
}
