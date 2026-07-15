import { describe, expect, it } from "bun:test";
import {
	automationScheduledJobs,
	autoPostFeedItems,
	autoPostRules,
	crossPostActions,
	postRecyclingConfigs,
	recyclingOccurrences,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	automationScheduleOccurrenceBase,
	automationScheduleOccurrenceId,
} from "../services/automations/scheduler";
import {
	chooseCrossPostSourceTarget,
	classifyCrossPostResult,
	crossPostReadinessDelayMs,
} from "../services/cross-post-processor";
import {
	canonicalFeedItemIdentity,
	normalizeCanonicalFeedUrl,
	rssFeedItemOperationId,
} from "../services/feed-parser";
import { recyclingOperationId } from "../services/recycling-processor";
import { validateRecyclingConfig } from "../services/recycling-validator";

function uniqueColumns(
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

describe("F-16 stable scheduled identities", () => {
	it("canonicalizes equivalent feed URLs", () => {
		expect(
			normalizeCanonicalFeedUrl(
				"HTTPS://Example.COM:443/article/?z=2&a=1#comments",
			),
		).toBe("https://example.com/article?a=1&z=2");
	});

	it("prefers retained RSS/Atom IDs over mutable URLs", async () => {
		const first = await canonicalFeedItemIdentity({
			sourceId: "urn:item:42",
			title: "First title",
			url: "https://example.com/old",
			description: "",
			publishedAt: null,
			imageUrl: null,
		});
		const moved = await canonicalFeedItemIdentity({
			sourceId: "urn:item:42",
			title: "Updated title",
			url: "https://example.com/new",
			description: "",
			publishedAt: null,
			imageUrl: null,
		});
		expect(moved.canonicalFeedItemId).toBe(first.canonicalFeedItemId);
		expect(rssFeedItemOperationId("apr_1", first.canonicalFeedItemId)).toBe(
			rssFeedItemOperationId("apr_1", moved.canonicalFeedItemId),
		);
	});

	it("keys recycle and automation pages by their logical occurrence", () => {
		const at = new Date("2026-07-13T09:00:00.000Z");
		expect(recyclingOperationId("rc_1", at)).toBe(
			"recycle:rc_1:2026-07-13T09:00:00.000Z",
		);
		expect(automationScheduleOccurrenceBase("aep_1", at)).toBe(
			"schedule:aep_1:2026-07-13T09:00:00.000Z",
		);
		expect(automationScheduleOccurrenceId("aep_1", at, 200)).toEndWith(
			":page:200",
		);
	});
});

describe("F-16 database invariants", () => {
	it("enforces one RSS ledger row per rule and canonical item", () => {
		const rssUniqueColumns = uniqueColumns(autoPostFeedItems);
		expect(rssUniqueColumns).toContainEqual([
			"rule_id",
			"canonical_feed_item_id",
		]);
		expect(rssUniqueColumns).not.toContainEqual(["operation_id"]);
		expect(autoPostRules.leaseToken).toBeDefined();
		expect(autoPostRules.leaseExpiresAt).toBeDefined();
		expect("claimAttempts" in autoPostRules).toBe(false);
	});

	it("does not resolve RSS accounts for a feed poll with no new item", async () => {
		const source = await Bun.file(
			new URL("../services/rss-generator.ts", import.meta.url),
		).text();
		const candidates = source.indexOf("const candidates =");
		const accounts = source.indexOf("const accounts =", candidates);

		expect(candidates).toBeGreaterThan(-1);
		expect(accounts).toBeGreaterThan(candidates);
		expect(source.slice(accounts, accounts + 120)).toContain(
			"candidates.length === 0",
		);
	});

	it("enforces stable recycling, cross-post, and automation occurrences", () => {
		const recyclingUniqueColumns = uniqueColumns(recyclingOccurrences);
		expect(recyclingUniqueColumns).toContainEqual([
			"config_id",
			"scheduled_for",
		]);
		expect(recyclingUniqueColumns).not.toContainEqual(["operation_id"]);
		expect(uniqueColumns(crossPostActions)).toContainEqual(["operation_id"]);
		expect(uniqueColumns(automationScheduledJobs)).toContainEqual([
			"occurrence_id",
		]);
		expect(postRecyclingConfigs.leaseToken).toBeDefined();
		expect(crossPostActions.sourceTargetId).toBeDefined();
		expect(crossPostActions.sourcePlatform).toBeDefined();
		expect(crossPostActions.targetPlatform).toBeDefined();
		expect(crossPostActions.readinessChecks).toBeDefined();
		expect(crossPostActions.requestMayHaveBeenSentAt).toBeDefined();
		expect(automationScheduledJobs.effectStartedAt).toBeDefined();
	});

	it("pins a deterministic same-platform source target", () => {
		const targets = [
			{ id: "pt_z", platform: "twitter" },
			{ id: "pt_b", platform: "linkedin" },
			{ id: "pt_a", platform: "twitter" },
		];

		expect(chooseCrossPostSourceTarget(targets, "twitter")?.id).toBe("pt_a");
		expect(
			chooseCrossPostSourceTarget([...targets].reverse(), "twitter")?.id,
		).toBe("pt_a");
		expect(chooseCrossPostSourceTarget(targets, "linkedin")?.id).toBe("pt_b");
		expect(chooseCrossPostSourceTarget(targets, "youtube")).toBeUndefined();
	});

	it("keeps readiness polling separate from provider attempts", async () => {
		expect(crossPostReadinessDelayMs(1)).toBe(15_000);
		expect(crossPostReadinessDelayMs(100)).toBe(5 * 60_000);

		const processor = await Bun.file(
			new URL("../services/cross-post-processor.ts", import.meta.url),
		).text();
		const route = await Bun.file(
			new URL("../routes/posts.ts", import.meta.url),
		).text();
		const claimStart = processor.indexOf("const [row] = await db");
		const claimEnd = processor.indexOf(
			"if (row) claimed.push(row)",
			claimStart,
		);

		expect(claimStart).toBeGreaterThan(-1);
		expect(claimEnd).toBeGreaterThan(claimStart);
		expect(processor.slice(claimStart, claimEnd)).not.toContain("attempts:");
		expect(processor).toContain(
			"const nextReadinessCheck = action.readinessChecks + 1",
		);
		expect(processor).toContain("readinessChecks: nextReadinessCheck");
		expect(processor).toMatch(
			/attempts: sql`\$\{crossPostActions\.attempts\} \+ 1`/,
		);
		expect(processor).toContain("eq(postTargets.id, action.sourceTargetId)");
		expect(route).toContain("sourceTargetId: sourceTarget.id");
		expect(route).toContain("sourcePlatform: sourceTarget.platform");
	});
});

describe("F-16 outcome classification", () => {
	it("separates retryable, terminal, and unknown cross-post outcomes", () => {
		expect(
			classifyCrossPostResult({
				success: false,
				error: { code: "RATE_LIMITED", message: "slow down" },
			}),
		).toEqual({ state: "retry", error: "slow down" });
		expect(
			classifyCrossPostResult({
				success: false,
				error: { code: "CONTENT_ERROR", message: "invalid" },
			}),
		).toEqual({ state: "failed", error: "invalid" });
		expect(
			classifyCrossPostResult({
				success: false,
				error: { code: "PLATFORM_ERROR", message: "timed out" },
			}),
		).toEqual({ state: "unknown", error: "timed out" });
	});

	it("rejects recycling before insert when no eligible target exists", async () => {
		const result = await validateRecyclingConfig(
			{} as never,
			"org_1",
			"post_1",
			"scheduled",
			{ expire_count: 1 },
			undefined,
			[],
		);
		expect(result).toEqual({
			valid: false,
			error: expect.objectContaining({ code: "NO_ELIGIBLE_RECYCLE_TARGETS" }),
		});
	});
});

describe("F-16 transactional handoff and free background work", () => {
	it("commits generated posts and outbox entries without charging API usage", async () => {
		const rssSource = await Bun.file(
			new URL("../services/rss-generator.ts", import.meta.url),
		).text();
		const recycleSource = await Bun.file(
			new URL("../services/recycling-processor.ts", import.meta.url),
		).text();
		for (const source of [rssSource, recycleSource]) {
			expect(source).toContain(".transaction(");
			expect(source).toContain("publishOutbox");
			expect(source).not.toContain("usageRecords");
			expect(source).not.toContain("recordScheduledPostUsage");
			expect(source).not.toContain("incrementUsage(");
			expect(source).not.toContain("PUBLISH_QUEUE.send");
			expect(source).toContain("dispatchPublishOutbox(env)");
		}
	});
});
