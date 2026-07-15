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
mock.module("../services/publish-outbox", () => ({
	dispatchPublishOutbox: counter("dispatchPublishOutbox"),
}));
mock.module("../services/recycling-processor", () => ({
	processRecyclingPosts: counter("processRecyclingPosts"),
}));
mock.module("../services/broadcast-processor", () => ({
	processScheduledBroadcasts: counter("processScheduledBroadcasts"),
}));
mock.module("../services/cross-post-processor", () => ({
	processCrossPostActions: counter("processCrossPostActions"),
}));
mock.module("../services/automations/scheduler", () => ({
	processAutomationSchedule: counter("processAutomationSchedule"),
	processAutomationInputTimeouts: counter("processAutomationInputTimeouts"),
}));
mock.module("../services/automations/webhook-receiver", () => ({
	reconcileAutomationWebhookReceipts: counter(
		"reconcileAutomationWebhookReceipts",
	),
}));
mock.module("../services/automation-wait-reconciler", () => ({
	reconcileAutomationWaits: counter("reconcileAutomationWaits"),
}));
mock.module("../services/automation-webhook-receipt-cleanup", () => ({
	cleanupAutomationWebhookReceipts: counter("cleanupAutomationWebhookReceipts"),
}));
mock.module("../services/idempotency-receipt-reconciler", () => ({
	reconcileIdempotencyReceipts: counter("reconcileIdempotencyReceipts"),
}));
mock.module("../services/inbound-webhook-reconciler", () => ({
	reconcileInboundWebhookReceipts: counter("reconcileInboundWebhookReceipts"),
}));
mock.module("../services/queue-replay", () => ({
	reconcileQueueReplayClaims: counter("reconcileQueueReplayClaims"),
}));
mock.module("../services/webhook-delivery", () => ({
	reconcileCustomerWebhookDeliveries: counter(
		"reconcileCustomerWebhookDeliveries",
	),
}));
mock.module("../services/webhook-retention", () => ({
	cleanupCustomerWebhookHistory: counter("cleanupCustomerWebhookHistory"),
}));
mock.module("../services/inbox-effect-reconciler", () => ({
	reconcileInboxEventEffects: counter("reconcileInboxEventEffects"),
}));
mock.module("../services/media-reliability", () => ({
	reconcileMediaDeletions: counter("reconcileMediaDeletions"),
	reconcileMediaUploads: counter("reconcileMediaUploads"),
}));
mock.module("../services/post-publish-reconciler", () => ({
	reconcilePostPublishExecutions: counter("reconcilePostPublishExecutions"),
}));
mock.module("../services/thread-execution-reconciler", () => ({
	reconcileThreadExecutions: counter("reconcileThreadExecutions"),
}));
mock.module("../services/one-time-capability-cleanup", () => ({
	cleanupOneTimeCapabilities: counter("cleanupOneTimeCapabilities"),
}));
mock.module("../services/telegram-connection", () => ({
	cleanupExpiredTelegramConnectionChallenges: counter(
		"cleanupExpiredTelegramConnectionChallenges",
	),
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
mock.module("../services/encryption-rotation", () => ({
	rotateEncryptedValues: counter("rotateEncryptedValues"),
}));
mock.module("../services/weekly-digest", () => ({
	processWeeklyDigest: counter("processWeeklyDigest"),
}));
mock.module("../services/external-post-sync/cron", () => ({
	enqueueExternalPostSync: counter("enqueueExternalPostSync"),
}));
mock.module("../services/analytics-refresh", () => ({
	enqueueAnalyticsRefresh: counter("enqueueAnalyticsRefresh"),
	scheduleFirstMetricsRefresh: async () => {},
}));
mock.module("../services/rss-generator", () => ({
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
mock.module("../services/thumbnail-backfill", () => ({
	backfillMissingThumbnails: counter("backfillMissingThumbnails"),
}));
mock.module("../routes/stripe-webhooks", () => ({
	processPendingStripeEvents: counter("processPendingStripeEvents"),
}));
mock.module("../services/billing-outbox", () => ({
	processBillingOutbox: counter("processBillingOutbox"),
}));
mock.module("../services/account-revocation", () => ({
	processAccountRevocations: counter("processAccountRevocations"),
}));
mock.module("../services/tenant-deletion", () => ({
	processTenantDeletionJobs: counter("processTenantDeletionJobs"),
}));
mock.module("../services/workspace-erasure", () => ({
	processWorkspaceErasureJobs: counter("processWorkspaceErasureJobs"),
}));
mock.module("../services/inbound-webhook-retention", () => ({
	redactExpiredInboundWebhookPayloads: counter(
		"redactExpiredInboundWebhookPayloads",
	),
}));
mock.module("../services/phone-number-operations", () => ({
	reconcilePhoneProvisioningOperations: counter(
		"reconcilePhoneProvisioningOperations",
	),
	processDuePhoneReleases: counter("processDuePhoneReleases"),
}));
mock.module("../services/ad-creation-operations", () => ({
	reconcileAdCreationOperations: counter("reconcileAdCreationOperations"),
}));

const { handleScheduled } = await import("../scheduled/index");

import type { Env } from "../types";

const EVERY_MINUTE_TASKS = [
	"dispatchPublishOutbox",
	"processScheduledPosts",
	"processRecyclingPosts",
	"processScheduledBroadcasts",
	"processCrossPostActions",
	"processAutomationSchedule",
	"processAutomationInputTimeouts",
	"reconcileAutomationWaits",
	"processPendingStripeEvents",
	"processBillingOutbox",
	"processAccountRevocations",
	"processTenantDeletionJobs",
	"processWorkspaceErasureJobs",
	"reconcilePhoneProvisioningOperations",
	"processDuePhoneReleases",
	"reconcileAdCreationOperations",
	"reconcileIdempotencyReceipts",
	"reconcileCustomerWebhookDeliveries",
	"reconcileInboxEventEffects",
	"reconcileMediaDeletions",
	"reconcileMediaUploads",
	"reconcilePostPublishExecutions",
	"reconcileThreadExecutions",
	"reconcileAutomationWebhookReceipts",
];

async function fire(cron: string) {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	await handleScheduled(
		{ cron, scheduledTime: 0, noRetry: () => {} },
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
		expect(calls.reconcileInboundWebhookReceipts ?? 0).toBe(0);
		expect(calls.reconcileQueueReplayClaims ?? 0).toBe(0);
	});

	it("*/5 does NOT re-run the every-minute tasks", async () => {
		await fire("*/5 * * * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		expect(calls.enqueueExternalPostSync).toBe(1);
		expect(calls.enqueueAnalyticsRefresh).toBe(1);
		expect(calls.processAutoPostRules).toBe(1);
		expect(calls.cleanupAutomationWebhookReceipts).toBe(1);
		expect(calls.cleanupOneTimeCapabilities).toBe(1);
		expect(calls.cleanupExpiredTelegramConnectionChallenges).toBe(1);
		expect(calls.redactExpiredInboundWebhookPayloads).toBe(1);
		expect(calls.checkStreaks).toBe(1);
		expect(calls.syncShortLinkClicks).toBe(1);
		expect(calls.reconcileInboundWebhookReceipts).toBe(1);
		expect(calls.reconcileQueueReplayClaims).toBe(1);
		expect(calls.cleanupCustomerWebhookHistory).toBe(1);
	});

	it("*/30 only syncs ads", async () => {
		await fire("*/30 * * * *");
		for (const t of EVERY_MINUTE_TASKS) expect(calls[t] ?? 0).toBe(0);
		expect(calls.syncAllExternalAds).toBe(1);
		expect(calls.backfillMissingThumbnails).toBe(1);
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
		expect(calls.rotateEncryptedValues).toBe(1);
		expect(calls.cleanupAutomationWebhookReceipts ?? 0).toBe(0);
		expect(calls.cleanupOneTimeCapabilities ?? 0).toBe(0);
		expect(calls.cleanupExpiredTelegramConnectionChallenges ?? 0).toBe(0);
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
