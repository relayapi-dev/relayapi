import { describe, expect, it } from "bun:test";
import { externalPosts, postAnalytics, posts } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	cumulativeSnapshotsToDecay,
	cumulativeTimelineByDay,
} from "../lib/analytics-observations";
import { analyticsObservationWindowStart } from "../services/analytics-refresh";

function uniqueIndexColumns(
	table: Parameters<typeof getTableConfig>[0],
): string[][] {
	return getTableConfig(table)
		.indexes.filter((index) => index.config.unique)
		.map((index) =>
			index.config.columns.flatMap((column) => {
				const name = (column as { name?: unknown }).name;
				return typeof name === "string" ? [name] : [];
			}),
		);
}

describe("analytics observation durability", () => {
	it("uses a deterministic five-minute observation identity", () => {
		expect(
			analyticsObservationWindowStart(
				new Date("2026-07-28T12:09:59.999Z"),
			).toISOString(),
		).toBe("2026-07-28T12:05:00.000Z");
		expect(uniqueIndexColumns(postAnalytics)).toContainEqual([
			"post_target_id",
			"observation_window_start",
		]);
	});

	it("keeps freshness separate from producer and consumer claim state", () => {
		expect(posts.metricsCollectedAt).toBeDefined();
		expect(posts.metricsRefreshWindowStart).toBeDefined();
		expect(posts.metricsRefreshLeaseExpiresAt).toBeDefined();
		expect(posts.metricsRefreshStartedAt).toBeDefined();
		expect(externalPosts.metricsUpdatedAt).toBeDefined();
		expect(externalPosts.metricsNextPollAt).toBeDefined();
		expect(externalPosts.metricsPollGeneration).toBeDefined();
		expect(externalPosts.metricsPollLeaseExpiresAt).toBeDefined();
		expect(externalPosts.metricsPollStartedAt).toBeDefined();
	});

	it("converts cumulative snapshots to nonnegative interval deltas", () => {
		const snapshots = [
			{
				id: "pa_1",
				postTargetId: "pt_1",
				collectedAt: new Date("2026-07-28T00:00:00.000Z"),
				impressions: 100,
				likes: 10,
			},
			{
				id: "pa_2",
				postTargetId: "pt_1",
				collectedAt: new Date("2026-07-29T00:00:00.000Z"),
				impressions: 140,
				likes: 16,
			},
			{
				id: "pa_3",
				postTargetId: "pt_1",
				collectedAt: new Date("2026-07-30T00:00:00.000Z"),
				impressions: 130,
				likes: 15,
			},
		];

		expect(
			cumulativeSnapshotsToDecay(
				snapshots,
				new Date("2026-07-28T00:00:00.000Z"),
			),
		).toEqual([
			{
				day: 0,
				impressions: 100,
				engagement: 10,
				cumulative_impressions: 100,
				cumulative_engagement: 10,
			},
			{
				day: 1,
				impressions: 40,
				engagement: 6,
				cumulative_impressions: 140,
				cumulative_engagement: 16,
			},
			{
				day: 2,
				impressions: 0,
				engagement: 0,
				cumulative_impressions: 130,
				cumulative_engagement: 15,
			},
		]);
	});

	it("selects the latest target/day snapshot and carries it forward", () => {
		const timeline = cumulativeTimelineByDay([
			{
				id: "pa_a1",
				postTargetId: "pt_a",
				collectedAt: new Date("2026-07-28T10:00:00.000Z"),
				impressions: 10,
			},
			{
				id: "pa_a2",
				postTargetId: "pt_a",
				collectedAt: new Date("2026-07-28T11:00:00.000Z"),
				impressions: 12,
			},
			{
				id: "pa_b1",
				postTargetId: "pt_b",
				collectedAt: new Date("2026-07-28T12:00:00.000Z"),
				impressions: 5,
			},
			{
				id: "pa_a3",
				postTargetId: "pt_a",
				collectedAt: new Date("2026-07-29T09:00:00.000Z"),
				impressions: 20,
			},
		]);

		expect(
			timeline.map(({ date, impressions }) => ({ date, impressions })),
		).toEqual([
			{ date: "2026-07-28", impressions: 17 },
			{ date: "2026-07-29", impressions: 25 },
		]);
	});

	it("has one canonical external metrics producer", async () => {
		const analyticsSource = await Bun.file(
			new URL("../services/analytics-refresh.ts", import.meta.url),
		).text();
		const syncCronSource = await Bun.file(
			new URL("../services/external-post-sync/cron.ts", import.meta.url),
		).text();
		expect(
			analyticsSource.match(/type: "refresh_external_metrics_batch"/g),
		).toHaveLength(2);
		expect(syncCronSource).not.toContain(
			'type: "refresh_external_metrics_batch"',
		);
		expect(syncCronSource).not.toContain('type: "refresh_metrics"');
	});
});
