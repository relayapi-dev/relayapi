/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import {
	FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT,
	renderFinancialRetentionReceiptInvariantSql,
} from "./render-financial-retention-receipt-invariant-sql";

test("renders database-enforced immutable but drainable financial receipts", () => {
	const sql = renderFinancialRetentionReceiptInvariantSql();
	const contract = FINANCIAL_RETENTION_RECEIPT_IMMUTABILITY_CONTRACT;

	expect(sql).toContain(
		`CREATE OR REPLACE FUNCTION "${contract.functionSchema}"."${contract.functionName}"()`,
	);
	expect(sql).toContain(
		`BEFORE UPDATE ON "${contract.tableSchema}"."${contract.tableName}"`,
	);
	expect(sql).not.toContain("BEFORE UPDATE OR DELETE");
	expect(sql).toContain(`CREATE TRIGGER "${contract.triggerName}"`);
	expect(sql).toContain("financial retention receipts are immutable");
});
