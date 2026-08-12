/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { adAccountPromotableIdentities } from "./schema";

function columnNames(columns: readonly { name: string }[]): string[] {
	return columns.map(({ name }) => name);
}

test("promotable social identities cannot cross organization or workspace scope", () => {
	const config = getTableConfig(adAccountPromotableIdentities);
	const tenantForeignKey = config.foreignKeys.find(
		(foreignKey) =>
			foreignKey.reference().name ===
			"ad_account_identities_social_account_org_scope_fk",
	);

	expect(tenantForeignKey).toBeDefined();
	if (!tenantForeignKey) {
		throw new Error("Missing tenant-scoped promotable identity foreign key");
	}

	const reference = tenantForeignKey.reference();
	expect(columnNames(reference.columns)).toEqual([
		"social_account_id",
		"organization_id",
		"scope_key",
	]);
	expect(columnNames(reference.foreignColumns)).toEqual([
		"id",
		"organization_id",
		"scope_key",
	]);
});
