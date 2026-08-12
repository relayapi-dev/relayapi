/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { USAGE_BUCKET_PROJECTION_CONTRACT } from "../src/usage-projection-contract";
import { renderCustomMigrationSql } from "./render-custom-migration-sql";
import { renderUsageBucketProjectionSql } from "./render-usage-bucket-projection-sql";

test("renders a statement-level ledger-owned usage projection", () => {
	const sql = renderUsageBucketProjectionSql();
	const contract = USAGE_BUCKET_PROJECTION_CONTRACT;

	expect(sql).toContain(
		`CREATE OR REPLACE FUNCTION "${contract.projectionFunctionSchema}"."${contract.projectionFunctionName}"()`,
	);
	expect(sql).toContain(
		`REFERENCING NEW TABLE AS "${contract.triggers.insert.newTransitionTable}"`,
	);
	expect(sql).toContain(
		`REFERENCING OLD TABLE AS "${contract.triggers.update.oldTransitionTable}" NEW TABLE AS "${contract.triggers.update.newTransitionTable}"`,
	);
	expect(sql).toContain(
		`REFERENCING OLD TABLE AS "${contract.triggers.delete.oldTransitionTable}"`,
	);
	expect(sql.match(/FOR EACH STATEMENT/g)).toHaveLength(3);
	expect(sql).toContain("SUM(reserved_delta)::bigint");
	expect(sql).toContain("SUM(committed_delta)::bigint");
	// An operator-authorized parked→retry transition updates the reservation
	// from parked to reserved. Partial commit transitions must subtract N from
	// reserved and add only K to committed in
	// the same statement.
	expect(sql).toContain(
		"-CASE WHEN state = 'committed' THEN committed_units ELSE 0 END AS committed_delta",
	);
	expect(sql).toContain(
		"CASE WHEN state IN ('reserved', 'parked') THEN units ELSE 0 END AS reserved_delta",
	);
	// The marker identifies the projection function; the nested trigger depth
	// prevents a caller from bypassing the guard with SET LOCAL alone. Both are
	// required, so neither arbitrary SQL nor an unrelated future trigger can
	// write the maintained counters.
	expect(sql).toContain("pg_trigger_depth() < 2");
	expect(sql).toContain(
		`PERFORM set_config('${contract.ownershipMarker}', 'on', true);`,
	);
	expect(sql).toContain(
		`PERFORM set_config('${contract.ownershipMarker}', 'off', true);`,
	);
	expect(sql).toContain(
		`OR COALESCE(current_setting('${contract.ownershipMarker}', true), 'off') <> 'on'`,
	);
	expect(
		sql.indexOf(
			`PERFORM set_config('${contract.ownershipMarker}', 'on', true);`,
		),
	).toBeLessThan(sql.indexOf('UPDATE "public"."usage_buckets" AS bucket'));
	expect(sql.indexOf('UPDATE "public"."usage_buckets" AS bucket')).toBeLessThan(
		sql.indexOf(
			`PERFORM set_config('${contract.ownershipMarker}', 'off', true);`,
		),
	);
	expect(sql).toContain(
		"usage bucket counters are owned by usage_reservations",
	);
	expect(sql).toContain(
		'LEFT JOIN "public"."usage_reservations" AS reservation',
	);
	expect(renderCustomMigrationSql()).toContain(sql);
});
