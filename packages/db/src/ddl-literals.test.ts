/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import {
	AI_EMBEDDING_DIMENSIONS,
	AI_EMBEDDING_MODEL,
	AI_EMBEDDING_PROVIDER,
	AI_INFERENCE_MODEL,
	AI_INFERENCE_PROVIDER,
	AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS,
} from "./ai-contracts";
import { ddlIntegerLiteral, ddlTextLiteral } from "./ddl-literals";
import { aiAgents, aiKnowledgeBases, aiKnowledgeDocuments } from "./schema";

const dialect = new PgDialect();

function serializedCheck(table: PgTable, name: string) {
	const constraint = getTableConfig(table).checks.find(
		(candidate) => candidate.name === name,
	);
	if (!constraint) throw new Error(`Missing CHECK ${name}`);
	return dialect.sqlToQuery(constraint.value);
}

describe("source-owned DDL literals", () => {
	test("AI registry CHECK constraints serialize without bind parameters", () => {
		const constraints = [
			{
				query: serializedCheck(
					aiKnowledgeBases,
					"ai_knowledge_bases_embedding_registry_check",
				),
				literals: [
					`E'${AI_EMBEDDING_PROVIDER}'`,
					`E'${AI_EMBEDDING_MODEL}'`,
					String(AI_EMBEDDING_DIMENSIONS),
				],
			},
			{
				query: serializedCheck(
					aiKnowledgeDocuments,
					"ai_knowledge_documents_attempt_count_check",
				),
				literals: [String(AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS)],
			},
			{
				query: serializedCheck(aiAgents, "ai_agents_model_registry_check"),
				literals: [`E'${AI_INFERENCE_PROVIDER}'`, `E'${AI_INFERENCE_MODEL}'`],
			},
		];

		for (const { query, literals } of constraints) {
			expect(query.params).toEqual([]);
			expect(query.sql).not.toMatch(/\$\d+/);
			for (const literal of literals) {
				expect(query.sql).toContain(literal);
			}
		}
	});

	test("text literals escape quotes and backslashes without parameters", () => {
		const query = dialect.sqlToQuery(
			sql`SELECT ${ddlTextLiteral("O'Reilly\\archive")}`,
		);

		expect(query).toEqual({
			sql: "SELECT E'O''Reilly\\\\archive'",
			params: [],
		});
		expect(() => ddlTextLiteral("before\0after")).toThrow(
			"PostgreSQL text literals cannot contain NUL bytes",
		);
	});

	test("integer literals accept only safe integers", () => {
		const query = dialect.sqlToQuery(
			sql`SELECT ${ddlIntegerLiteral(Number.MAX_SAFE_INTEGER)}`,
		);
		expect(query).toEqual({
			sql: `SELECT ${Number.MAX_SAFE_INTEGER}`,
			params: [],
		});

		for (const invalid of [
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() => ddlIntegerLiteral(invalid)).toThrow(
				"DDL integer literal must be a safe integer",
			);
		}
	});
});
