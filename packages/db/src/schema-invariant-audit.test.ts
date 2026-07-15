/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { is, sql } from "drizzle-orm";
import {
	check,
	getTableConfig,
	integer,
	pgEnum,
	pgTable,
	PgTable,
	text,
} from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { auditSchemaInvariants } from "./schema-invariant-audit";

function publicSchemaConfigs(): Array<ReturnType<typeof getTableConfig>> {
	const configs: Array<ReturnType<typeof getTableConfig>> = [];
	for (const value of Object.values(schema)) {
		if (!is(value, PgTable)) continue;
		const config = getTableConfig(value);
		if ((config.schema ?? "public") === "public") configs.push(config);
	}
	return configs;
}

test("every current workflow-state and durable numeric column has an explicit invariant decision", () => {
	const audit = auditSchemaInvariants(publicSchemaConfigs());

	expect(audit.failures).toEqual([]);
	expect(audit.candidates.length).toBeGreaterThan(250);
	expect(audit.candidates.every(({ coveredBy }) => coveredBy !== "missing")).toBe(
		true,
	);
});

test("the audit rejects newly introduced unconstrained workflow and numeric columns", () => {
	const unsafe = pgTable("__schema_invariant_unsafe", {
		id: text("id").primaryKey(),
		status: text("status").notNull(),
		attempts: integer("attempts").notNull(),
	});

	const audit = auditSchemaInvariants([getTableConfig(unsafe)], []);

	expect(audit.failures).toEqual([
		"__schema_invariant_unsafe.status is durable workflow state without a PostgreSQL enum, CHECK, or documented exception",
		"__schema_invariant_unsafe.attempts is a durable numeric value without a CHECK or documented exception",
	]);
});

test("PostgreSQL enums and CHECK constraints satisfy the audit", () => {
	const safeStatus = pgEnum("__schema_invariant_safe_status", [
		"pending",
		"complete",
	]);
	const safe = pgTable(
		"__schema_invariant_safe",
		{
			id: text("id").primaryKey(),
			status: safeStatus("status").notNull(),
			attempts: integer("attempts").notNull().default(0),
		},
		(table) => [
			check(
				"__schema_invariant_safe_attempts_check",
				sql`${table.attempts} >= 0`,
			),
		],
	);

	expect(auditSchemaInvariants([getTableConfig(safe)], []).failures).toEqual([]);
});
