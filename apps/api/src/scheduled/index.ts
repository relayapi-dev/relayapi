import { syncAllExternalAds } from "../services/ad-sync";
import { enqueueAnalyticsRefresh } from "../services/analytics-refresh";
import { processAutoPostRules } from "../services/auto-post-processor";
import {
	processAutomationInputTimeouts,
	processAutomationSchedule,
} from "../services/automations/scheduler";
import { processScheduledBroadcasts } from "../services/broadcast-processor";
import { processCrossPostActions } from "../services/cross-post-processor";
import { processScheduledWhatsAppBroadcasts } from "../services/whatsapp-broadcast-processor";
import { processDunning } from "../services/dunning";
import { enqueueExternalPostSync } from "../services/external-post-sync/cron";
import { cleanupOldConversations } from "../services/inbox-maintenance";
import { generateInvoices } from "../services/invoice-generator";
import { processRecyclingPosts } from "../services/recycling-processor";
import { processScheduledPosts } from "../services/scheduler";
import { syncShortLinkClicks } from "../services/short-link-click-sync";
import { checkStreaks } from "../services/streak";
import { enqueueExpiringTokenRefresh } from "../services/token-refresh";
import { renewYouTubePubSubSubscriptions } from "../services/webhook-subscription";
import { processWeeklyDigest } from "../services/weekly-digest";
import type { Env } from "../types";

export async function handleScheduled(
	event: ScheduledEvent,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	// Every minute: scheduled posts + cross-post actions + automation schedule.
	// MUST be gated on the exact cron — handleScheduled fires for ALL six
	// triggers, and an unguarded block would re-run the every-minute work on
	// every */5, */30, monthly, daily and weekly invocation too (duplicate
	// ticks racing each other whenever schedules overlap, e.g. at :00).
	if (event.cron === "*/1 * * * *") {
		ctx.waitUntil(processScheduledPosts(env));
		ctx.waitUntil(processRecyclingPosts(env));
		ctx.waitUntil(processScheduledBroadcasts(env));
		ctx.waitUntil(processScheduledWhatsAppBroadcasts(env));
		ctx.waitUntil(processCrossPostActions(env));
		ctx.waitUntil(processAutomationSchedule(env));
		ctx.waitUntil(processAutomationInputTimeouts(env));
	}

	// Daily at 9am UTC: bill closed Stripe usage periods + downgrade expired subs
	// + dunning + token refresh + YouTube PubSub renewal + inbox cleanup.
	// generateInvoices runs daily (not monthly) because usage periods are keyed
	// on each org's Stripe billing window, which closes on arbitrary calendar
	// days; it bills any closed, unbilled period idempotently.
	if (event.cron === "0 9 * * *") {
		ctx.waitUntil(generateInvoices(env));
		ctx.waitUntil(processDunning(env));
		ctx.waitUntil(enqueueExpiringTokenRefresh(env));
		ctx.waitUntil(renewYouTubePubSubSubscriptions(env));
		ctx.waitUntil(cleanupOldConversations(env));
	}

	// Weekly on Monday at 9am UTC: send weekly digest
	if (event.cron === "0 9 * * 1") {
		ctx.waitUntil(processWeeklyDigest(env));
	}

	// Every 5 minutes: sync external posts + refresh analytics + process RSS auto-post rules + streak checks + short link clicks
	if (event.cron === "*/5 * * * *") {
		ctx.waitUntil(enqueueExternalPostSync(env));
		ctx.waitUntil(enqueueAnalyticsRefresh(env));
		ctx.waitUntil(processAutoPostRules(env));
		ctx.waitUntil(checkStreaks(env));
		ctx.waitUntil(syncShortLinkClicks(env));
	}

	// Every 30 minutes: sync external ads and refresh ad metrics
	if (event.cron === "*/30 * * * *") {
		ctx.waitUntil(syncAllExternalAds(env));
	}
}
