/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import {
	assertSupportedPostgres,
	verifyDatabaseSemanticCapabilities,
} from "./database-contract";

type DatabaseSql = Parameters<typeof assertSupportedPostgres>[0];

function versionSql(serverVersionNum: string): DatabaseSql {
	return (async () => [
		{ server_version_num: serverVersionNum },
	]) as unknown as DatabaseSql;
}

describe("database capability contract", () => {
	test("accepts only the reviewed PostgreSQL 18 major", async () => {
		await expect(assertSupportedPostgres(versionSql("180004"))).resolves.toBe(
			180004,
		);
		await expect(assertSupportedPostgres(versionSql("170012"))).rejects.toThrow(
			"requires PostgreSQL major 18",
		);
		await expect(assertSupportedPostgres(versionSql("190000"))).rejects.toThrow(
			"requires PostgreSQL major 18",
		);
	});

	test("proves vector, HNSW, trigram, and btree_gist semantics", async () => {
		const statements: string[] = [];
		const sql = Object.assign(async () => [], {
			async begin(
				run: (transaction: {
					unsafe: (query: string) => Promise<Record<string, unknown>[]>;
				}) => Promise<unknown>,
			) {
				return run({
					async unsafe(query) {
						statements.push(query);
						if (query.includes("FROM pg_catalog.pg_extension")) {
							return [
								{ extension_name: "btree_gist", schema_name: "public" },
								{ extension_name: "pg_trgm", schema_name: "public" },
								{ extension_name: "vector", schema_name: "public" },
							];
						}
						return [];
					},
				});
			},
		}) as unknown as DatabaseSql;

		await verifyDatabaseSemanticCapabilities(sql, { installMissing: false });
		expect(statements.join("\n")).toContain("public.vector(1536)");
		expect(statements.join("\n")).toContain("USING hnsw");
		expect(statements.join("\n")).toContain("public.vector_cosine_ops");
		expect(statements.join("\n")).toContain("public.gin_trgm_ops");
		expect(statements.join("\n")).toContain("public.similarity");
		expect(statements.join("\n")).toContain("EXCLUDE USING gist");
	});

	test("proves only the semantic capabilities active in a sealed generation", async () => {
		const statements: string[] = [];
		const sql = Object.assign(async () => [], {
			async begin(
				run: (transaction: {
					unsafe: (query: string) => Promise<Record<string, unknown>[]>;
				}) => Promise<unknown>,
			) {
				return run({
					async unsafe(query) {
						statements.push(query);
						if (query.includes("FROM pg_catalog.pg_extension")) {
							return [
								{ extension_name: "pg_trgm", schema_name: "public" },
							];
						}
						return [];
					},
				});
			},
		}) as unknown as DatabaseSql;

		await verifyDatabaseSemanticCapabilities(sql, {
			installMissing: false,
			requiredExtensions: ["pg_trgm"],
			requiredSchemas: { pg_trgm: "public" },
		});
		const source = statements.join("\n");
		expect(source).toContain("public.gin_trgm_ops");
		expect(source).toContain("public.similarity");
		expect(source).not.toContain("public.vector");
		expect(source).not.toContain("EXCLUDE USING gist");
	});
});
