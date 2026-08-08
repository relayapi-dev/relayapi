/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
	AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT,
	renderAutomationConversionEventInvariantSql,
} from "./render-automation-conversion-event-invariant-sql";

test("protects conversion facts while allowing same-row outbox transitions", () => {
	const sql = renderAutomationConversionEventInvariantSql();
	const contract = AUTOMATION_CONVERSION_EVENT_FACT_CONTRACT;

	expect(sql).toContain(
		`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
	);
	expect(sql).toContain(
		`BEFORE UPDATE ON "${contract.tableSchema}"."${contract.tableName}"`,
	);
	expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
	for (const column of contract.immutableColumns) {
		expect(sql).toContain(
			`OLD."${column}" IS DISTINCT FROM NEW."${column}"`,
		);
	}
	expect(contract.immutableColumns).not.toContain("metadata");
	expect(contract.immutableColumns).not.toContain("contact_id");
	expect(contract.immutableColumns).not.toContain("dispatch_status");
	expect(sql).toContain("automation conversion fact columns are immutable");
});
