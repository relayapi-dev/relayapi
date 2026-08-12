/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { is, sql } from "drizzle-orm";
import {
	check,
	getTableConfig,
	PgTable,
	pgTable,
	text,
} from "drizzle-orm/pg-core";
import { auditDurableDomains } from "./domain-contract-audit";
import type { DomainContract } from "./domain-contracts";
import * as schema from "./schema";

function schemaConfigs(): Array<ReturnType<typeof getTableConfig>> {
	const configs: Array<ReturnType<typeof getTableConfig>> = [];
	for (const value of Object.values(schema)) {
		if (is(value, PgTable)) configs.push(getTableConfig(value));
	}
	return configs;
}

test("every durable type/kind/role/direction column has exactly one valid domain contract", () => {
	const audit = auditDurableDomains(schemaConfigs());

	expect(audit.failures).toEqual([]);
	expect(audit.candidates).toHaveLength(55);
	expect(audit.contractCount).toBe(55);
	expect(
		audit.candidates.every(
			({ classification }) =>
				classification !== "missing" && classification !== "duplicate",
		),
	).toBe(true);
});

test("the audit rejects missing, duplicate and stale domain contracts", () => {
	const table = pgTable("__domain_contract_missing", {
		id: text("id").primaryKey(),
		kind: text("kind").notNull(),
	});
	const config = getTableConfig(table);
	const contract = {
		schemaName: "public",
		tableName: "__domain_contract_missing",
		columnName: "kind",
		classification: "provider_passthrough",
		provider: "test provider",
		rationale:
			"The test provider deliberately owns an extensible durable kind vocabulary.",
	} as const satisfies DomainContract;
	const stale = {
		...contract,
		columnName: "missing_kind",
	} as const satisfies DomainContract;

	expect(auditDurableDomains([config], []).failures).toContain(
		"public.__domain_contract_missing.kind is missing a DOMAIN_CONTRACTS entry",
	);
	expect(
		auditDurableDomains([config], [contract, contract]).failures,
	).toContain(
		"public.__domain_contract_missing.kind has 2 domain contracts; expected one",
	);
	expect(auditDurableDomains([config], [stale]).failures).toContain(
		"public.__domain_contract_missing.missing_kind domain contract references a missing column",
	);
});

test("closed CHECK values must equal the canonical registry exactly", () => {
	const table = pgTable(
		"__domain_contract_closed",
		{
			id: text("id").primaryKey(),
			type: text("type").notNull(),
		},
		(table) => [
			check(
				"__domain_contract_closed_type_check",
				sql`${table.type} IN ('one', 'unexpected')`,
			),
		],
	);
	const contract = {
		schemaName: "public",
		tableName: "__domain_contract_closed",
		columnName: "type",
		classification: "closed",
		values: ["one", "two"],
		database: {
			kind: "check",
			constraintName: "__domain_contract_closed_type_check",
		},
	} as const satisfies DomainContract;

	expect(
		auditDurableDomains([getTableConfig(table)], [contract]).failures,
	).toEqual([
		'public.__domain_contract_closed.type CHECK values ["one","unexpected"] do not equal canonical values ["one","two"]',
	]);
});
