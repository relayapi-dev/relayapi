import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { SegmentCreateSpec, SegmentFilter } from "../schemas/segments";
import {
	compileSegmentFilter,
	contactMatchesSegment,
} from "../services/dynamic-segments";

const dialect = new PgDialect();

function render(fragment: ReturnType<typeof compileSegmentFilter>) {
	return dialect.sqlToQuery(fragment);
}

describe("dynamic segment definition", () => {
	test("requires one closed, queryable predicate", () => {
		expect(
			SegmentFilter.safeParse({
				all: [{ field: "tags", op: "contains", value: "vip" }],
			}).success,
		).toBe(true);
		expect(
			SegmentFilter.safeParse({
				all: [{ field: "contact.email", op: "contains", value: "@example" }],
			}).success,
		).toBe(false);
		expect(
			SegmentFilter.safeParse({
				all: [{ field: "segment_ids", op: "contains", value: "seg_loop" }],
			}).success,
		).toBe(false);
		expect(SegmentFilter.safeParse({}).success).toBe(false);
	});

	test("makes filter authority conditional on segment mode", () => {
		expect(
			SegmentCreateSpec.safeParse({
				name: "Static VIPs",
				is_dynamic: false,
			}).success,
		).toBe(true);
		expect(
			SegmentCreateSpec.safeParse({
				name: "Broken dynamic",
				is_dynamic: true,
			}).success,
		).toBe(false);
		expect(
			SegmentCreateSpec.safeParse({
				name: "Broken static",
				is_dynamic: false,
				filter: {
					all: [{ field: "tags", op: "contains", value: "vip" }],
				},
			}).success,
		).toBe(false);
	});

	test("compiles values as parameters and binds custom fields to contact tenant/scope", () => {
		const query = render(
			compileSegmentFilter({
				all: [
					{
						field: "fields.plan",
						op: "contains",
						value: "pro%' OR true --",
						case_sensitive: false,
					},
				],
			}),
		);
		expect(query.sql).toContain("custom_field_values");
		expect(query.sql).toContain("segment_cfv.organization_id");
		expect(query.sql).toContain("segment_cfv.scope_key");
		expect(query.sql).not.toContain("OR true");
		expect(query.params).toContain("pro%' or true --");
	});

	test("always includes organization and scope in static and dynamic membership", () => {
		const staticSql = render(
			contactMatchesSegment({
				id: "seg_static",
				organizationId: "org_a",
				workspaceId: "ws_a",
				scopeKey: "ws/ws_a",
				filter: null,
				isDynamic: false,
				memberCount: 1,
			}),
		).sql;
		expect(staticSql).toContain("organization_id");
		expect(staticSql).toContain("scope_key");
		expect(staticSql).toContain("contact_segment_memberships");

		const dynamicSql = render(
			contactMatchesSegment({
				id: "seg_dynamic",
				organizationId: "org_a",
				workspaceId: "ws_a",
				scopeKey: "ws/ws_a",
				filter: {
					all: [{ field: "opted_in", op: "eq", value: true }],
				},
				isDynamic: true,
				memberCount: 0,
			}),
		).sql;
		expect(dynamicSql).toContain("organization_id");
		expect(dynamicSql).toContain("scope_key");
		expect(dynamicSql).toContain("opted_in");
	});
});
