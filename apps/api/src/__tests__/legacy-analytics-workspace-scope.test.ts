import { describe, expect, test } from "bun:test";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { legacyAnalyticsConditions } from "../lib/legacy-analytics-scope";
import {
	DailyMetricsQuery,
	PostTimelineQuery,
	PostingFrequencyQuery,
	YouTubeDailyViewsQuery,
} from "../schemas/analytics";
import { bestTimeCacheKey } from "../services/best-time-cache";

function compileScope(
	workspaceScope: "all" | string[],
	workspaceId?: string | null,
) {
	const condition = and(
		...legacyAnalyticsConditions({
			organizationId: "org_test",
			workspaceScope,
			workspaceId,
			accountId: "acc_test",
			postId: "post_test",
			platform: "youtube",
			fromDate: new Date("2026-01-01T00:00:00.000Z"),
			toDate: new Date("2026-02-01T00:00:00.000Z"),
		}),
	);
	if (!condition) throw new Error("Expected analytics scope condition");
	return new PgDialect().sqlToQuery(condition);
}

describe("legacy analytics workspace scope", () => {
	test("anchors every filter to the owning post workspace", () => {
		const compiled = compileScope(["ws_allowed"]);

		expect(compiled.sql).toContain('"posts"."organization_id"');
		expect(compiled.sql).toContain('"posts"."workspace_id" is null');
		expect(compiled.sql).toContain('"posts"."workspace_id" in');
		expect(compiled.sql).toContain('"post_targets"."social_account_id"');
		expect(compiled.sql).toContain('"posts"."id"');
		expect(compiled.sql).toContain('"post_targets"."platform"');
		expect(compiled.sql).toContain('"posts"."published_at"');
		expect(compiled.params).toEqual(
			expect.arrayContaining([
				"org_test",
				"ws_allowed",
				"acc_test",
				"post_test",
				"youtube",
			]),
		);
	});

	test("fails closed for a zero-grant credential", () => {
		const compiled = compileScope([]);
		expect(compiled.sql).toContain("false");
	});

	test("can narrow slot signals to organization-scoped posts", () => {
		const compiled = compileScope(["ws_allowed"], null);
		expect(compiled.sql.match(/"posts"\."workspace_id" is null/g)?.length).toBe(
			2,
		);
	});

	test("partitions best-time cache entries by normalized authority", async () => {
		const base = {
			organizationId: "org_test",
			accountId: "acc_test",
		};
		const first = await bestTimeCacheKey({
			...base,
			workspaceScope: ["ws_b", "ws_a"],
		});
		const reordered = await bestTimeCacheKey({
			...base,
			workspaceScope: ["ws_a", "ws_b"],
		});
		const different = await bestTimeCacheKey({
			...base,
			workspaceScope: ["ws_a"],
		});

		expect(first).toBe(reordered);
		expect(first).not.toBe(different);
		expect(first).toMatch(/^best-time:v2:[a-f0-9]{64}$/);
	});

	test("rejects reversed or unbounded time-series windows", () => {
		for (const schema of [
			DailyMetricsQuery,
			PostingFrequencyQuery,
			PostTimelineQuery,
			YouTubeDailyViewsQuery,
		]) {
			const required =
				schema === PostTimelineQuery
					? { post_id: "post_test" }
					: schema === YouTubeDailyViewsQuery
						? { account_id: "acc_test" }
						: {};
			expect(
				schema.safeParse({
					...required,
					from_date: "2026-02-01T00:00:00.000Z",
					to_date: "2026-01-01T00:00:00.000Z",
				}).success,
			).toBe(false);
			expect(
				schema.safeParse({
					...required,
					from_date: "2024-01-01T00:00:00.000Z",
					to_date: "2026-01-02T00:00:00.000Z",
				}).success,
			).toBe(false);
		}
	});
});
