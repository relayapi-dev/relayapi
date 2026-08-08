/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
	OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT,
	renderOperatorResolutionEvidenceInvariantSql,
} from "./render-operator-resolution-evidence-invariant-sql";

test("renders a database-enforced append-only operator evidence relation", () => {
	const sql = renderOperatorResolutionEvidenceInvariantSql();
	const contract = OPERATOR_RESOLUTION_EVIDENCE_APPEND_ONLY_CONTRACT;

	expect(sql).toContain(
		`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
	);
	expect(sql).toContain(
		`BEFORE UPDATE OR DELETE ON "${contract.tableSchema}"."${contract.tableName}"`,
	);
	expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
	expect(sql).toContain("operator resolution evidence is append-only");
	expect(sql).not.toContain("RETURN NEW");
	expect(sql).not.toContain("RETURN OLD");
});
