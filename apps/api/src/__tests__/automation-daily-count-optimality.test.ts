import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { automationEntrypointDailyCounts } from "@relayapi/db";

describe("automation daily admission counter", () => {
	it("stores an actual PostgreSQL UTC calendar date", () => {
		expect(automationEntrypointDailyCounts.day.getSQLType()).toBe("date");
		const runner = readFileSync(
			new URL("../services/automations/runner.ts", import.meta.url),
			"utf8",
		);
		expect(runner).toContain("new Date().toISOString().slice(0, 10)");
	});

	it("has a bounded 90-day drain with legal-hold exclusion", () => {
		const source = readFileSync(
			new URL("../services/operational-retention.ts", import.meta.url),
			"utf8",
		);
		const start = source.indexOf(
			"export async function pruneAutomationEntrypointDailyCounts",
		);
		const end = source.indexOf("/**", start + 10);
		const implementation = source.slice(start, end);
		expect(start).toBeGreaterThan(-1);
		expect(source).toContain(
			"export const AUTOMATION_DAILY_COUNT_RETENTION_DAYS = 90",
		);
		expect(implementation).toContain(
			"AUTOMATION_DAILY_COUNT_MAX_DELETE_PASSES",
		);
		expect(implementation).toContain(
			".limit(AUTOMATION_DAILY_COUNT_DELETE_BATCH)",
		);
		expect(implementation).toContain("hold.released_at IS NULL");
		expect(implementation).toContain(".orderBy(");
	});
});
