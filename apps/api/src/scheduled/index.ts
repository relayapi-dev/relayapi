import { mapConcurrently } from "../lib/concurrency";
import { isSelfHosted } from "../lib/deployment-mode";
import { processPendingStripeEvents } from "../routes/stripe-webhooks";
import { processAccountRevocations } from "../services/account-revocation";
import { pruneExpiredAdvancedAdLeads } from "../services/ad-advanced-store";
import { reconcileAdCreationOperations } from "../services/ad-creation-operations";
import { reconcileAdMutationOperations } from "../services/ad-mutation-operations";
import {
	recoverAdvancedAdReportJobs,
	retainAdvancedAdReports,
} from "../services/ad-report-jobs";
import { syncAllExternalAds } from "../services/ad-sync";
import { processAiKnowledgeDocuments } from "../services/ai-knowledge";
import { enqueueAnalyticsRefresh } from "../services/analytics-refresh";
import { processDueAutomationConversionEvents } from "../services/automation-conversion-dispatch";
import { reconcileAutomationWaits } from "../services/automation-wait-reconciler";
import { cleanupAutomationWebhookReceipts } from "../services/automation-webhook-receipt-cleanup";
import { reconcileAutomationBindingSyncs } from "../services/automations/binding-sync";
import { processAutomationSchedule } from "../services/automations/scheduler";
import { reconcileAutomationWebhookReceipts } from "../services/automations/webhook-receiver";
import { recoverBillingOperations } from "../services/billing-operations";
import { processBillingOutbox } from "../services/billing-outbox";
import {
	renewComplimentaryBillingAuthoritiesForEnv,
	transitionExpiredHostedBillingAuthoritiesForEnv,
} from "../services/billing-periods";
import { processScheduledBroadcasts } from "../services/broadcast-processor";
import { processCrossPostActions } from "../services/cross-post-processor";
import { processDunning } from "../services/dunning";
import { reconcileDurableOperationUsageForEnv } from "../services/durable-operation-usage";
import { rotateEncryptedValues } from "../services/encryption-rotation";
import { maintainErasureHolds } from "../services/erasure-hold-maintenance";
import {
	continueExecutablePostgresRetention,
	runExecutablePostgresRetention,
} from "../services/executable-retention";
import { enqueueExternalPostSync } from "../services/external-post-sync/cron";
import { processExternalSubjectCleanupJobs } from "../services/external-subject-cleanup";
import { retainFinancialData } from "../services/financial-retention";
import { reconcileIdempotencyReceipts } from "../services/idempotency-receipt-reconciler";
import { reconcileInboundWebhookReceipts } from "../services/inbound-webhook-reconciler";
import { redactExpiredInboundWebhookPayloads } from "../services/inbound-webhook-retention";
import { reconcileInboxEventEffects } from "../services/inbox-effect-reconciler";
import { cleanupOldConversations } from "../services/inbox-maintenance";
import { generateInvoices } from "../services/invoice-generator";
import {
	cleanupExpiredMediaDerivatives,
	reconcileMediaProcessingJobs,
} from "../services/media-processing-jobs";
import {
	reconcileMediaDeletions,
	reconcileMediaUploads,
} from "../services/media-reliability";
import { cleanupExpiredMediaUploadSessions } from "../services/media-upload-session-cleanup";
import { cleanupOneTimeCapabilities } from "../services/one-time-capability-cleanup";
import {
	pruneApiRequestLogs,
	pruneAutomationEntrypointDailyCounts,
	pruneCompletedErasureSteps,
	pruneExpiredAuthState,
	recoverEmailDispatches,
	retainEmailDeliveries,
	retainQueueFailures,
} from "../services/operational-retention";
import {
	processDuePhoneReleases,
	reconcilePhoneProvisioningOperations,
} from "../services/phone-number-operations";
import { reconcilePostPublishExecutions } from "../services/post-publish-reconciler";
import { reconcileProviderOutcomes } from "../services/provider-outcome-reconciler";
import { processPublicGrowthEvents } from "../services/public-growth-events";
import { dispatchPublishOutbox } from "../services/publish-outbox";
import { reconcileQueueReplayClaims } from "../services/queue-replay";
import { processRecyclingPosts } from "../services/recycling-processor";
import { processAutoPostRules } from "../services/rss-generator";
import { processScheduledPosts } from "../services/scheduler";
import { syncShortLinkClicks } from "../services/short-link-click-sync";
import { reconcileSocialMutationOperations } from "../services/social-mutation-projection";
import { checkStreaks } from "../services/streak";
import { reconcileMissingStripeBillingAuthorities } from "../services/stripe-billing-authority";
import { cleanupExpiredTelegramConnectionChallenges } from "../services/telegram-connection";
import { processTenantDeletionJobs } from "../services/tenant-deletion";
import { reconcileThreadExecutions } from "../services/thread-execution-reconciler";
import { backfillMissingThumbnails } from "../services/thumbnail-backfill";
import { retainTimedDomainData } from "../services/timed-domain-retention";
import { enqueueExpiringTokenRefresh } from "../services/token-refresh";
import { maintainToolJobs } from "../services/tool-jobs";
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

export function rotateScheduledTasks<T>(
	tasks: readonly T[],
	scheduledTime: number,
): T[] {
	if (tasks.length < 2) return [...tasks];
	const minute = Math.max(0, Math.floor(scheduledTime / 60_000));
	const offset = minute % tasks.length;
	return [...tasks.slice(offset), ...tasks.slice(0, offset)];
}

async function runScheduledTasks(
	tasks: ScheduledTask[],
	scheduledTime: number,
): Promise<void> {
	// A shared iterator bounds concurrent database/provider work. Rotating its
	// start point by scheduled minute prevents the same late-array reconcilers
	// from always being the first work omitted if an invocation exhausts its
	// wall budget. Individual services remain the overlap authority: mutable
	// work is due-ordered and fenced in PostgreSQL.
	const orderedTasks = rotateScheduledTasks(tasks, scheduledTime);
	const failures = (
		await mapConcurrently(
			orderedTasks,
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
	// MUST be gated on the exact cron — handleScheduled fires for all configured
	// triggers, and an unguarded block would re-run the every-minute work on
	// every */5, */30, daily and weekly invocation too (duplicate
	// ticks racing each other whenever schedules overlap, e.g. at :00).
	if (event.cron === "*/1 * * * *") {
		// Reserve Worker connection headroom while durable reconcilers share this
		// invocation. Closures prevent work from starting before a slot is available,
		// while one failing task cannot prevent the rest from running.
		ctx.waitUntil(
			runScheduledTasks(
				[
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
						name: "automation_conversion_dispatch",
						run: () => processDueAutomationConversionEvents(env),
					},
					{
						name: "automation_waits",
						run: () => reconcileAutomationWaits(env),
					},
					...(!isSelfHosted(env)
						? [
								{
									name: "stripe_events",
									run: () => processPendingStripeEvents(env),
								},
								{
									name: "stripe_billing_authorities",
									run: () => reconcileMissingStripeBillingAuthorities(env),
								},
								{
									name: "billing_outbox",
									run: () => processBillingOutbox(env),
								},
								{
									name: "billing_operations",
									run: () => recoverBillingOperations(env),
								},
								{
									name: "billing_authority_transitions",
									run: () =>
										transitionExpiredHostedBillingAuthoritiesForEnv(env),
								},
							]
						: []),
					{
						name: "account_revocations",
						run: () => processAccountRevocations(env),
					},
					{
						name: "complimentary_billing_authorities",
						run: () => renewComplimentaryBillingAuthoritiesForEnv(env),
					},
					{
						name: "tenant_deletions",
						run: () => processTenantDeletionJobs(env),
					},
					{
						name: "workspace_erasures",
						run: () => processWorkspaceErasureJobs(env),
					},
					{
						name: "external_subject_cleanup",
						run: () => processExternalSubjectCleanupJobs(env),
					},
					{ name: "tool_jobs", run: () => maintainToolJobs(env) },
					{
						name: "durable_operation_usage",
						run: () => reconcileDurableOperationUsageForEnv(env),
					},
					{
						name: "phone_provisioning",
						run: () => reconcilePhoneProvisioningOperations(env),
					},
					{ name: "phone_releases", run: () => processDuePhoneReleases(env) },
					{
						name: "ad_creation",
						run: () => reconcileAdCreationOperations(env),
					},
					{
						name: "ad_mutations",
						run: () => reconcileAdMutationOperations(env),
					},
					{
						name: "advanced_ad_reports",
						run: () => recoverAdvancedAdReportJobs(env),
					},
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
						name: "media_processing",
						run: () => reconcileMediaProcessingJobs(env),
					},
					{
						name: "media_upload_session_expiry",
						run: () => cleanupExpiredMediaUploadSessions(env),
					},
					{
						name: "ai_knowledge_ingestion",
						run: () => processAiKnowledgeDocuments(env),
					},
					{
						name: "provider_outcomes",
						run: () => reconcileProviderOutcomes(env),
					},
					{
						name: "social_mutations",
						run: () => reconcileSocialMutationOperations(env),
					},
					{
						name: "post_publish",
						run: () => reconcilePostPublishExecutions(env),
					},
					{
						name: "public_growth_events",
						run: () => processPublicGrowthEvents(env),
					},
					{ name: "thread_publish", run: () => reconcileThreadExecutions(env) },
					{
						name: "automation_webhooks",
						run: () => reconcileAutomationWebhookReceipts(env),
					},
					{
						name: "automation_binding_sync",
						run: () => reconcileAutomationBindingSyncs(env),
					},
					{
						name: "email_dispatch_recovery",
						run: () => recoverEmailDispatches(env),
					},
					{
						name: "executable_postgres_retention_continuation",
						run: () => continueExecutablePostgresRetention(env),
					},
				],
				event.scheduledTime,
			),
		);
	}

	// Daily at 9am UTC: bill closed Stripe usage periods + downgrade expired subs
	// + dunning + token refresh + YouTube PubSub renewal + inbox cleanup.
	// generateInvoices runs daily (not monthly) because usage periods are keyed
	// on each org's Stripe billing window, which closes on arbitrary calendar
	// days; it bills any closed, unbilled period idempotently.
	if (event.cron === "0 9 * * *") {
		ctx.waitUntil(
			runScheduledTasks(
				[
					...(!isSelfHosted(env)
						? [
								{ name: "invoices", run: () => generateInvoices(env) },
								{ name: "dunning", run: () => processDunning(env) },
							]
						: []),
					{
						name: "expiring_token_refresh",
						run: () => enqueueExpiringTokenRefresh(env),
					},
					{
						name: "youtube_subscriptions",
						run: () => renewYouTubePubSubSubscriptions(env),
					},
					{
						name: "encryption_rotation",
						run: () => rotateEncryptedValues(env),
					},
					{
						name: "erasure_hold_maintenance",
						run: () => maintainErasureHolds(env),
					},
					{
						name: "api_request_log_retention",
						run: () => pruneApiRequestLogs(env),
					},
					{
						name: "executable_postgres_retention",
						run: () => runExecutablePostgresRetention(env),
					},
					{
						name: "auth_ephemeral_retention",
						run: () => pruneExpiredAuthState(env),
					},
					{
						name: "erasure_step_retention",
						run: () => pruneCompletedErasureSteps(env),
					},
					{
						name: "email_delivery_retention",
						run: () => retainEmailDeliveries(env),
					},
					{
						name: "queue_failure_retention",
						run: () => retainQueueFailures(env),
					},
					{
						name: "automation_entrypoint_daily_count_retention",
						run: () => pruneAutomationEntrypointDailyCounts(env),
					},
					{
						name: "timed_domain_retention",
						run: () => retainTimedDomainData(env),
					},
					{
						name: "media_derivative_retention",
						run: () => cleanupExpiredMediaDerivatives(env),
					},
					{
						name: "financial_retention",
						run: () => retainFinancialData(env),
					},
					{
						name: "advanced_ad_report_retention",
						run: () => retainAdvancedAdReports(env),
					},
					{
						name: "advanced_ad_lead_retention",
						run: () => pruneExpiredAdvancedAdLeads(env),
					},
				],
				event.scheduledTime,
			),
		);
	}

	// Weekly on Monday at 9am UTC: send weekly digest
	if (event.cron === "0 9 * * MON") {
		ctx.waitUntil(
			runScheduledTasks(
				[{ name: "weekly_digest", run: () => processWeeklyDigest(env) }],
				event.scheduledTime,
			),
		);
	}

	// Every 5 minutes: sync external posts + refresh analytics + process RSS auto-post rules + streak checks + short link clicks
	if (event.cron === "*/5 * * * *") {
		ctx.waitUntil(
			runScheduledTasks(
				[
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
				],
				event.scheduledTime,
			),
		);
	}

	// Every 30 minutes: sync external ads and refresh ad metrics + a small
	// thumbnail-backfill batch (self-terminating once all eligible media has a
	// durable preview).
	if (event.cron === "*/30 * * * *") {
		ctx.waitUntil(
			runScheduledTasks(
				[
					{ name: "external_ads", run: () => syncAllExternalAds(env) },
					{
						name: "thumbnail_backfill",
						run: () => backfillMissingThumbnails(env),
					},
					{
						name: "inbox_retention",
						run: () => cleanupOldConversations(env),
					},
				],
				event.scheduledTime,
			),
		);
	}
}
