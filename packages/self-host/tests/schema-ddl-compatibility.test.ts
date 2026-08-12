import { describe, expect, it } from "bun:test";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

describe("self-host schema DDL compatibility", () => {
	it("renders source-owned AI registry constants as PostgreSQL DDL literals", async () => {
		const [schema, literals] = await Promise.all([
			Bun.file(`${repositoryRoot}packages/db/src/schema.ts`).text(),
			Bun.file(`${repositoryRoot}packages/db/src/ddl-literals.ts`).text(),
		]);

		expect(schema).toContain("ddlTextLiteral(AI_EMBEDDING_PROVIDER)");
		expect(schema).toContain("ddlTextLiteral(AI_EMBEDDING_MODEL)");
		expect(schema).toContain("ddlIntegerLiteral(AI_EMBEDDING_DIMENSIONS)");
		expect(schema).toContain(
			"ddlIntegerLiteral(AI_KNOWLEDGE_DOCUMENT_MAX_ATTEMPTS)",
		);
		expect(schema).toContain("ddlTextLiteral(AI_INFERENCE_PROVIDER)");
		expect(schema).toContain("ddlTextLiteral(AI_INFERENCE_MODEL)");
		expect(literals).toContain("Number.isSafeInteger");
		expect(literals).toContain('value.includes("\\0")');
	});
});
