/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { assertOrderedMigrationHistory } from "./migration-history-contract";

const baseline = { idx: 0, when: 100, tag: "0000_baseline" };
const valid = [baseline, { idx: 1, when: 200, tag: "0001_expand_accounts" }];

describe("migration history ordering contract", () => {
	test("accepts one contiguous, strictly increasing history", () => {
		expect(() =>
			assertOrderedMigrationHistory(valid, [
				{ folderMillis: 100 },
				{ folderMillis: 200 },
			]),
		).not.toThrow();
	});

	test("rejects an index gap and duplicate tag", () => {
		expect(() =>
			assertOrderedMigrationHistory(
				[baseline, { idx: 2, when: 200, tag: "0000_baseline" }],
				[{ folderMillis: 100 }, { folderMillis: 200 }],
			),
		).toThrow("indexes must be contiguous from zero");

		expect(() =>
			assertOrderedMigrationHistory(
				[baseline, { idx: 1, when: 200, tag: "0000_baseline" }],
				[{ folderMillis: 100 }, { folderMillis: 200 }],
			),
		).toThrow("tag is duplicated");
	});

	test("rejects a duplicate or decreasing timestamp", () => {
		for (const when of [100, 99]) {
			expect(() =>
				assertOrderedMigrationHistory(
					[baseline, { idx: 1, when, tag: "0001_expand_accounts" }],
					[{ folderMillis: 100 }, { folderMillis: when }],
				),
			).toThrow(when === 100 ? "timestamp is duplicated" : "must be greater");
		}
	});

	test("rejects journal/file timestamp disagreement", () => {
		expect(() =>
			assertOrderedMigrationHistory(valid, [
				{ folderMillis: 100 },
				{ folderMillis: 201 },
			]),
		).toThrow("journal mismatch");
	});
});
