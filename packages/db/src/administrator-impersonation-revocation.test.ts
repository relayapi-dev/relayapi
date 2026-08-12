/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { renderAuthIdentityInvariantSql } from "../scripts/render-auth-identity-invariant-sql";
import { session } from "./schema";

describe("administrator impersonation revocation", () => {
	test("indexes actor-attributed sessions for immediate containment", () => {
		const sessionConfig = getTableConfig(session);
		const actorIndex = sessionConfig.indexes.find(
			(index) => index.config.name === "session_impersonatedBy_idx",
		);
		expect(actorIndex).toBeDefined();
		expect(
			actorIndex?.config.columns.map((column) =>
				"name" in column ? column.name : null,
			),
		).toEqual(["impersonatedBy"]);
	});

	test("revokes on active ban, admin-role loss, deletion, and baseline backfill", () => {
		const sql = renderAuthIdentityInvariantSql();
		expect(sql).toContain(
			'AFTER DELETE OR UPDATE OF "role", "banned", "banExpires"',
		);
		expect(sql).toContain(
			"OR NOT ('admin' = ANY(string_to_array(replace(COALESCE(NEW.role, ''), ' ', ''), ',')))",
		);
		expect(sql).toContain(
			'WHERE impersonation_session."impersonatedBy" = actor_id;',
		);
		expect(sql).toContain(
			'WHERE impersonation_session."impersonatedBy" IS NOT NULL',
		);
	});

	test("revokes derived impersonation when any originating session is deleted", () => {
		const sql = renderAuthIdentityInvariantSql();
		expect(sql).toContain('AFTER DELETE ON "auth"."session"');
		expect(sql).toContain('IF OLD."impersonatedBy" IS NOT NULL THEN');
		expect(sql).toContain(
			'WHERE derived_impersonation_session."impersonatedBy" = OLD."userId";',
		);
		const branch = sql.slice(
			sql.indexOf("$relay_revoke_session_derived_impersonation$"),
			sql.lastIndexOf("$relay_revoke_session_derived_impersonation$"),
		);
		expect(branch).not.toContain('derived_impersonation_session."userId"');
	});
});
