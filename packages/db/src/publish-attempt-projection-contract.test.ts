/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { postTargets, publishAttempts } from "./schema";

function columns(values: Array<{ name: string }>): string[] {
	return values.map((column) => column.name);
}

describe("post-target current-attempt projection", () => {
	test("binds the nullable current pointer to the same target and operation", () => {
		const targetConfig = getTableConfig(postTargets);
		const currentAttempt = targetConfig.foreignKeys.find(
			(foreignKey) =>
				foreignKey.getName() === "post_targets_current_attempt_identity_fk",
		);

		expect(columns(currentAttempt?.reference().columns ?? [])).toEqual([
			"attempt_id",
			"id",
			"publish_operation_id",
		]);
		expect(columns(currentAttempt?.reference().foreignColumns ?? [])).toEqual([
			"id",
			"post_target_id",
			"publish_operation_id",
		]);
		expect(currentAttempt?.onDelete).toBe("no action");
	});

	test("keeps attempt history dependent on its exact target operation", () => {
		const attemptConfig = getTableConfig(publishAttempts);
		const target = attemptConfig.foreignKeys.find(
			(foreignKey) =>
				foreignKey.getName() === "publish_attempts_target_operation_fk",
		);

		expect(columns(target?.reference().columns ?? [])).toEqual([
			"post_target_id",
			"publish_operation_id",
		]);
		expect(columns(target?.reference().foreignColumns ?? [])).toEqual([
			"id",
			"publish_operation_id",
		]);
		expect(target?.onDelete).toBe("cascade");
		expect(
			attemptConfig.uniqueConstraints.map((constraint) => constraint.name),
		).toContain("publish_attempts_id_target_operation_uniq");
	});
});
