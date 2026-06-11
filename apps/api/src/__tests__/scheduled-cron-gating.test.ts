// Regression guard: handleScheduled fires for ALL six cron triggers, and the
// every-minute block (scheduled posts, recycling, broadcasts, cross-posts,
// automation schedule) used to run unconditionally — so each */5, */30, daily,
// weekly and monthly invocation re-ran the every-minute work, racing the real
// */1 tick whenever schedules overlap (e.g. at :00 three triggers fire and the
// post scheduler ran 3x concurrently → duplicate claims / double publishes).
//
// Every service the scheduler dispatches to is mocked with a counter; we then
// assert each cron expression triggers exactly its own set of tasks.

import { beforeEach, describe, expect, it, mock } from "bun:test";

const calls: Record<string, number> = {};
const counter = (name: string) => async () => {
	calls[name] = (calls[name] ?? 0) + 1;
};

mock.module("../services/scheduler", () => ({
	processScheduledPosts: counter("processScheduledPosts"),
}));
mock.module("../services/recycling-processor", () => ({
	processRecyclingPosts: counter("processRecyclingPosts"),
}));
mock.module("../services/broadcast-processor", () => ({
	processScheduledBroadcasts: counter("processScheduledBroadcasts"),
}));
mock.module("../services/whatsapp-broadcast-processor", () => ({
	processScheduledWhatsAppBroadcasts: counter(
		"processScheduledWhatsAppBroadcasts",
	),
}));
mock.module("../services/cross-post-processor", () => ({
	processCrossPostActions: counter("processCrossPostActions"),
}));
mock.module("../services/automations/scheduler", () => ({
	processAutomationSchedule: counter("processAutomationSchedule"),
	processAutomationInputTimeouts: counter("processAutomationInputTimeouts"),
}));
mock.module("../services/invoice-generator", () => ({
	generateInvoices: counter("generateInvoices"),
}));
mock.module("../services/dunning", () => ({
	processDunning: counter("processDunning"),
}));
mock.module("../services/token-refresh", () => ({
	enqueueExpiringTokenRefresh: counter("enqueueExpiringTokenRefresh"),
}));
mock.module("../services/webhook-subscription", () => ({
	renewYouTubePubSubSubscriptions: counter("renewYouTubePubSubSubscriptions"),
}));
mock.module("../services/inbox-maintenance", () => ({
	cleanupOldConversations: counter("cleanupOldConversations"),
}));
mock.module("../services/weekly-digest", () => ({
	processWeeklyDigest: counter("processWeeklyDigest"),
}));
mock.module("../services/external-post-sync/cron", () => ({
	enqueueExternalPostSync: counter("enqueueExternalPostSync"),
}));
mock.module("../services/analytics-refresh", () => ({
	enqueueAnalyticsRefresh: counter("enqueueAnalyticsRefresh"),
}));
mock.module("../services/auto-post-processor", () => ({
	processAutoPostRules: counter("processAutoPostRules"),
}));
mock.module("../services/streak", () => ({
	checkStreaks: counter("checkStreaks"),
}));
mock.module("../services/short-link-click-sync", () => ({
	syncShortLinkClicks: counter("syncShortLinkClicks"),
}));
mock.module("../services/ad-sync", () => ({
	syncAllExternalAds: counter("syncAllExternalAds"),
}));

const { handleScheduled } = await import("../scheduled/index");
import type { Env } from "../types";

const EVERY_MINUTE_TASKS = [
	"processScheduledPosts",
	"processRecyclingPosts",
	"processScheduledBroadcasts",
	"processScheduledWhatsAppBroadcasts",
	"processCrossPostActions",
	"processAutomationSchedule",
	"processAutomationInputTimeouts",
];

async function fire(cron: string) {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	await handleScheduled(
		{ cron, scheduledTime: 0, type: "scheduled" } as unknown as ScheduledEvent,
		{} as Env,
		ctx,
	);
	await Promise.all(pending);
}

beforeEach(() => {
	for (const k of Object.keys(calls)) delete calls[k];
});

describe("handleScheduled cron gating", () => {
	it("*/1 runs exactly the every-minute tasks", async () => {
		await fire("*/1 * * * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(1);
		expect(calls.enqueueExternalPostSync ?? 0).toBe(0);
		expect(calls.syncAllExternalAds ?? 0).toBe(0);
		expect(calls.generateInvoices ?? 0).toBe(0);
	});

	it("*/5 does NOT re-run the every-minute tasks", async () => {
		await fire("*/5 * * * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		expect(calls.enqueueExternalPostSync).toBe(1);
		expect(calls.enqueueAnalyticsRefresh).toBe(1);
		expect(calls.processAutoPostRules).toBe(1);
		expect(calls.checkStreaks).toBe(1);
		expect(calls.syncShortLinkClicks).toBe(1);
	});

	it("*/30 only syncs ads", async () => {
		await fire("*/30 * * * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		expect(calls.syncAllExternalAds).toBe(1);
	});

	it("daily 9am runs invoice generation + dunning/token-refresh/pubsub/inbox-cleanup", async () => {
		await fire("0 9 * * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		// generateInvoices runs DAILY (not monthly): usage_records are keyed on
		// each org's Stripe billing period, which closes on arbitrary days, so
		// overage is billed daily and idempotently.
		expect(calls.generateInvoices).toBe(1);
		expect(calls.processDunning).toBe(1);
		expect(calls.enqueueExpiringTokenRefresh).toBe(1);
		expect(calls.renewYouTubePubSubSubscriptions).toBe(1);
		expect(calls.cleanupOldConversations).toBe(1);
	});

	it("weekly Monday 9am runs the digest only", async () => {
		await fire("0 9 * * 1");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		expect(calls.processWeeklyDigest).toBe(1);
	});

	it("monthly trigger no longer drives any task", async () => {
		await fire("0 0 1 * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		expect(calls.generateInvoices ?? 0).toBe(0);
	});
});
