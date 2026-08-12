/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { automationStepRuns } from "./schema";

test("automation step analytics are fenced to their authoritative run tuple", () => {
	const config = getTableConfig(automationStepRuns);
	expect(config.columns.map((column) => column.name)).toEqual(
		expect.arrayContaining([
			"run_id",
			"automation_id",
			"organization_id",
			"scope_key",
		]),
	);
	const runFk = config.foreignKeys.find(
		(foreignKey) =>
			foreignKey.getName() === "automation_step_runs_run_auto_org_scope_fk",
	);
	expect(
		runFk?.reference().columns.map((column) => column.name),
	).toEqual(["run_id", "automation_id", "organization_id", "scope_key"]);
	expect(runFk?.onDelete).toBe("cascade");
	expect(config.indexes.map((index) => index.config.name)).toEqual(
		expect.arrayContaining([
			"automation_step_runs_org_time_idx",
			"automation_step_runs_org_scope_time_idx",
			"automation_step_runs_retention_idx",
		]),
	);
});
