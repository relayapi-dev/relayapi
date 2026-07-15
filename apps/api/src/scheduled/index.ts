import { mapConcurrently } from "../lib/concurrency";
import { processPendingStripeEvents } from "../routes/stripe-webhooks";
import { processAccountRevocations } from "../services/account-revocation";
import { reconcileAdCreationOperations } from "../services/ad-creation-operations";
import { syncAllExternalAds } from "../services/ad-sync";
import { enqueueAnalyticsRefresh } from "../services/analytics-refresh";
import { reconcileAutomationWaits } from "../services/automation-wait-reconciler";
import { cleanupAutomationWebhookReceipts } from "../services/automation-webhook-receipt-cleanup";
import {
	processAutomationInputTimeouts,
	processAutomationSchedule,
} from "../services/automations/scheduler";
import { reconcileAutomationWebhookReceipts } from "../services/automations/webhook-receiver";
import { processBillingOutbox } from "../services/billing-outbox";
import { processScheduledBroadcasts } from "../services/broadcast-processor";
import { processCrossPostActions } from "../services/cross-post-processor";
import { processDunning } from "../services/dunning";
import { rotateEncryptedValues } from "../services/encryption-rotation";
import { enqueueExternalPostSync } from "../services/external-post-sync/cron";
import { reconcileIdempotencyReceipts } from "../services/idempotency-receipt-reconciler";
import { reconcileInboundWebhookReceipts } from "../services/inbound-webhook-reconciler";
import { redactExpiredInboundWebhookPayloads } from "../services/inbound-webhook-retention";
import { reconcileInboxEventEffects } from "../services/inbox-effect-reconciler";
import { cleanupOldConversations } from "../services/inbox-maintenance";
import { generateInvoices } from "../services/invoice-generator";
import {
	reconcileMediaDeletions,
	reconcileMediaUploads,
} from "../services/media-reliability";
import { cleanupOneTimeCapabilities } from "../services/one-time-capability-cleanup";
import {
	processDuePhoneReleases,
	reconcilePhoneProvisioningOperations,
} from "../services/phone-number-operations";
import { reconcilePostPublishExecutions } from "../services/post-publish-reconciler";
import { dispatchPublishOutbox } from "../services/publish-outbox";
import { reconcileQueueReplayClaims } from "../services/queue-replay";
import { processRecyclingPosts } from "../services/recycling-processor";
import { processAutoPostRules } from "../services/rss-generator";
import { processScheduledPosts } from "../services/scheduler";
import { syncShortLinkClicks } from "../services/short-link-click-sync";
import { checkStreaks } from "../services/streak";
import { cleanupExpiredTelegramConnectionChallenges } from "../services/telegram-connection";
import { processTenantDeletionJobs } from "../services/tenant-deletion";
import { reconcileThreadExecutions } from "../services/thread-execution-reconciler";
import { backfillMissingThumbnails } from "../services/thumbnail-backfill";
import { enqueueExpiringTokenRefresh } from "../services/token-refresh";
import { reconcileCustomerWebhookDeliveries } from "../services/webhook-delivery";
import { cleanupCustomerWebhookHistory } from "../services/webhook-retention";
import { renewYouTubePubSubSubscriptions } from "../services/webhook-subscription";
import { processWeeklyDigest } from "../services/weekly-digest";
import { processWorkspaceErasureJobs } from "../services/workspace-erasure";
import type { Env } from "../types";

const EVERY_MINUTE_TASK_CONCURRENCY = 4;

interface ScheduledTask {
	name: string;
	run: () => Promise<unknown>;
}

async function runScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
	const failures = (
		await mapConcurrently(
			tasks,
			EVERY_MINUTE_TASK_CONCURRENCY,
			async (task) => {
				try {
					await task.run();
					return null;
				} catch (error) {
					return { name: task.name, error };
				}
			},
		)
	).filter((failure) => failure !== null);
	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`[scheduled] ${failure.name} failed`, failure.error);
		}
		throw new AggregateError(
			failures.map((failure) => failure.error),
			`${failures.length} scheduled task(s) failed`,
		);
	}
}

export async function handleScheduled(
	event: ScheduledController,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	// Every minute: scheduled posts + cross-post actions + automation schedule.
	// MUST be gated on the exact cron — handleScheduled fires for ALL six
	// triggers, and an unguarded block would re-run the every-minute work on
	// every */5, */30, monthly, daily and weekly invocation too (duplicate
	// ticks racing each other whenever schedules overlap, e.g. at :00).
	if (event.cron === "*/1 * * * *") {
		// Reserve Worker connection headroom while durable reconcilers share this
		// invocation. Closures prevent work from starting before a slot is available,
		// while one failing task cannot prevent the rest from running.
		ctx.waitUntil(
			runScheduledTasks([
				{
					name: "publish_outbox",
					// Bulk claims keep each batch to three DB statements; drain up to
					// 1,000 rows/minute so completion effects cannot outgrow the cron.
					run: () => dispatchPublishOutbox(env, 10),
				},
				{ name: "scheduled_posts", run: () => processScheduledPosts(env) },
				{ name: "recycling", run: () => processRecyclingPosts(env) },
				{ name: "broadcasts", run: () => processScheduledBroadcasts(env) },
				{ name: "cross_posts", run: () => processCrossPostActions(env) },
				{
					name: "automation_schedule",
					run: () => processAutomationSchedule(env),
				},
				{
					name: "automation_input_timeouts",
					run: () => processAutomationInputTimeouts(env),
				},
				{ name: "automation_waits", run: () => reconcileAutomationWaits(env) },
				{ name: "stripe_events", run: () => processPendingStripeEvents(env) },
				{ name: "billing_outbox", run: () => processBillingOutbox(env) },
				{
					name: "account_revocations",
					run: () => processAccountRevocations(env),
				},
				{ name: "tenant_deletions", run: () => processTenantDeletionJobs(env) },
				{
					name: "workspace_erasures",
					run: () => processWorkspaceErasureJobs(env),
				},
				{
					name: "phone_provisioning",
					run: () => reconcilePhoneProvisioningOperations(env),
				},
				{ name: "phone_releases", run: () => processDuePhoneReleases(env) },
				{ name: "ad_creation", run: () => reconcileAdCreationOperations(env) },
				{
					name: "idempotency_receipts",
					run: () => reconcileIdempotencyReceipts(env),
				},
				{
					name: "customer_webhooks",
					run: () => reconcileCustomerWebhookDeliveries(env),
				},
				{ name: "inbox_effects", run: () => reconcileInboxEventEffects(env) },
				{ name: "media_deletions", run: () => reconcileMediaDeletions(env) },
				{ name: "media_uploads", run: () => reconcileMediaUploads(env) },
				{
					name: "post_publish",
					run: () => reconcilePostPublishExecutions(env),
				},
				{ name: "thread_publish", run: () => reconcileThreadExecutions(env) },
				{
					name: "automation_webhooks",
					run: () => reconcileAutomationWebhookReceipts(env),
				},
			]),
		);
	}

	// Daily at 9am UTC: bill closed Stripe usage periods + downgrade expired subs
	// + dunning + token refresh + YouTube PubSub renewal + inbox cleanup.
	// generateInvoices runs daily (not monthly) because usage periods are keyed
	// on each org's Stripe billing window, which closes on arbitrary calendar
	// days; it bills any closed, unbilled period idempotently.
	if (event.cron === "0 9 * * *") {
		ctx.waitUntil(
			runScheduledTasks([
				{ name: "invoices", run: () => generateInvoices(env) },
				{ name: "dunning", run: () => processDunning(env) },
				{
					name: "expiring_token_refresh",
					run: () => enqueueExpiringTokenRefresh(env),
				},
				{
					name: "youtube_subscriptions",
					run: () => renewYouTubePubSubSubscriptions(env),
				},
				{
					name: "inbox_cleanup",
					run: () => cleanupOldConversations(env),
				},
				{
					name: "encryption_rotation",
					run: () => rotateEncryptedValues(env),
				},
			]),
		);
	}

	// Weekly on Monday at 9am UTC: send weekly digest
	if (event.cron === "0 9 * * 1") {
		ctx.waitUntil(processWeeklyDigest(env));
	}

	// Every 5 minutes: sync external posts + refresh analytics + process RSS auto-post rules + streak checks + short link clicks
	if (event.cron === "*/5 * * * *") {
		ctx.waitUntil(
			runScheduledTasks([
				{
					name: "external_post_sync",
					run: () => enqueueExternalPostSync(env),
				},
				{
					name: "analytics_refresh",
					run: () => enqueueAnalyticsRefresh(env),
				},
				{ name: "rss", run: () => processAutoPostRules(env) },
				{
					name: "automation_webhook_cleanup",
					run: () => cleanupAutomationWebhookReceipts(env),
				},
				{
					name: "capability_cleanup",
					run: () => cleanupOneTimeCapabilities(env),
				},
				{
					name: "telegram_challenge_cleanup",
					run: () => cleanupExpiredTelegramConnectionChallenges(env),
				},
				{ name: "streaks", run: () => checkStreaks(env) },
				{ name: "short_link_clicks", run: () => syncShortLinkClicks(env) },
				// These scans use five-minute stale leases. Keep them off the
				// every-minute path to bound steady-state Postgres traffic.
				{
					name: "inbound_receipts",
					run: () => reconcileInboundWebhookReceipts(env),
				},
				{
					name: "inbound_payload_retention",
					run: () => redactExpiredInboundWebhookPayloads(env),
				},
				{
					name: "queue_replay",
					run: () => reconcileQueueReplayClaims(env),
				},
				{
					name: "webhook_retention",
					run: () => cleanupCustomerWebhookHistory(env),
				},
			]),
		);
	}

	// Every 30 minutes: sync external ads and refresh ad metrics + a small
	// thumbnail-backfill batch (self-terminating once all eligible media has a
	// durable preview).
	if (event.cron === "*/30 * * * *") {
		ctx.waitUntil(syncAllExternalAds(env));
		ctx.waitUntil(backfillMissingThumbnails(env));
	}
}
