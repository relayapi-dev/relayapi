/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { PARENT_IDENTITY_PROJECTIONS } from "./provisioning-contracts";
import { contactSegmentMemberships, segments } from "./schema";

const dialect = new PgDialect();

describe("dynamic segment storage authority", () => {
	test("stores only static membership and reserves member_count for static rows", () => {
		const segmentConfig = getTableConfig(segments);
		const membershipConfig = getTableConfig(contactSegmentMemberships);
		const checks = new Map(
			[...segmentConfig.checks, ...membershipConfig.checks].map((check) => [
				check.name,
				dialect.sqlToQuery(check.value).sql,
			]),
		);

		expect(checks.get("segments_filter_mode_check")).toContain("jsonb_typeof");
		expect(checks.get("segments_dynamic_member_count_zero_check")).toContain(
			"member_count",
		);
		expect(
			checks.get("contact_segment_memberships_static_only_check"),
		).toContain("segment_is_dynamic");

		const staticForeignKey = membershipConfig.foreignKeys
			.map((foreignKey) => foreignKey.reference())
			.find(
				(reference) =>
					reference.name === "contact_segment_memberships_static_segment_fk",
			);
		expect(staticForeignKey?.columns.map((column) => column.name)).toEqual([
			"segment_id",
			"organization_id",
			"scope_key",
			"segment_is_dynamic",
		]);
		expect(
			staticForeignKey?.foreignColumns.map((column) => column.name),
		).toEqual(["id", "organization_id", "scope_key", "is_dynamic"]);
	});

	test("projects scope and mode from the authoritative segment parent", () => {
		const projection = PARENT_IDENTITY_PROJECTIONS.find(
			(contract) =>
				contract.childTable === "contact_segment_memberships" &&
				contract.childParentColumn === "segment_id",
		);
		expect(projection?.projections).toEqual([
			{ parentColumn: "scope_key", childColumn: "scope_key" },
			{
				parentColumn: "is_dynamic",
				childColumn: "segment_is_dynamic",
			},
		]);
	});
});
