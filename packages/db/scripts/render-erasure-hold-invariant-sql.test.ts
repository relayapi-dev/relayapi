/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { renderErasureHoldInvariantSql } from "./render-erasure-hold-invariant-sql";

test("renders target validation and immutable legal-hold transitions", () => {
	const sql = renderErasureHoldInvariantSql();
	expect(sql).toContain("CREATE OR REPLACE FUNCTION public.relayapi_guard_erasure_hold()");
	expect(sql).toContain("FROM auth.organization AS organization_row");
	expect(sql).toContain("FROM public.workspaces AS workspace_row");
	expect(sql).toContain("FOR KEY SHARE");
	expect(sql).toContain("erasure hold placement fields are immutable");
	expect(sql).toContain("erasure hold release may occur only once");
	expect(sql).toContain("invalid erasure hold redaction transition");
	expect(sql).toContain("CREATE TRIGGER relayapi_erasure_hold_guard");
	expect(sql).toContain("CREATE TRIGGER relayapi_organization_hold_delete_guard");
	expect(sql).toContain("CREATE TRIGGER relayapi_workspace_hold_delete_guard");
});
