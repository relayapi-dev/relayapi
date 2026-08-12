import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const drizzleDirectory = join(import.meta.dir, "..", "drizzle");

/**
 * PostgreSQL requires a CASE index expression to be wrapped in an additional
 * pair of parentheses. Function calls may omit them, which is why Drizzle's
 * otherwise-valid expression-index output can hide this specific syntax bug.
 */
function bareCaseIndexExpressions(source: string): string[] {
	return source
		.split("--> statement-breakpoint")
		.filter((statement) => /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement))
		.filter((statement) =>
			/(?:\bUSING\s+\w+\s*\(|,)\s*CASE\s+WHEN\b/i.test(statement),
		)
		.map(
			(statement) =>
				statement.match(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i)?.[1] ??
				"unknown_index",
		);
}

describe("PostgreSQL expression-index syntax", () => {
	it("rejects bare CASE expressions from every migration", () => {
		const migrations = readdirSync(drizzleDirectory)
			.filter((name) => /^\d{4}_.+\.sql$/.test(name))
			.sort();

		for (const migration of migrations) {
			const offenders = bareCaseIndexExpressions(
				readFileSync(join(drizzleDirectory, migration), "utf8"),
			);
			expect(offenders).toEqual([]);
		}
	});
});
