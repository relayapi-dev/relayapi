import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AUTOMATION_SCHEDULED_JOB_TYPES } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as dbSchema from "../../../../packages/db/src/schema";
import {
	ASYNC_CONTRACT_TYPES,
	ASYNC_LIFECYCLE_REGISTRY,
	ASYNC_SIGNATURE_EXCEPTIONS,
	AUTOMATION_SCHEDULED_JOB_CONTRACTS,
} from "../lib/async-contract-registry";
import {
	AD_ACCOUNT_POLL,
	AD_METRICS_POLL,
	AUTOMATION_BINDING_MUTATION,
	EXTERNAL_POST_POLL,
	INTERNAL_METRICS_POLL,
	maximumRetryDelayHorizonSeconds,
	nominalQueueDeliveryBound,
	QUEUE_RESCUE_POLICY,
	SHORT_LINK_POLL,
} from "../lib/async-policy";

const apiRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(apiRoot, "../..");
const source = (relative: string) =>
	readFileSync(resolve(apiRoot, relative), "utf8");

describe("derived async lifecycle contracts", () => {
	it("classifies every async-looking table into exactly five feature-owned contracts", () => {
		const signature =
			/(lease|claim|fresh|attempt|next.*at|request.*sent|effect.*started|poll|dispatch)/i;
		const detected = new Set<string>();
		for (const value of Object.values(dbSchema)) {
			try {
				const config = getTableConfig(value as never);
				if (config.columns.some((column) => signature.test(column.name))) {
					detected.add(config.name);
				}
			} catch {
				// Non-table schema exports are intentionally ignored.
			}
		}

		const registered = new Set(
			ASYNC_LIFECYCLE_REGISTRY.map(({ table }) => table),
		);
		const exceptions = new Set(Object.keys(ASYNC_SIGNATURE_EXCEPTIONS));
		expect(
			[...detected].filter(
				(table) => !registered.has(table) && !exceptions.has(table),
			),
		).toEqual([]);
		expect([...registered].filter((table) => !detected.has(table))).toEqual([]);
		expect(
			[
				...new Set(ASYNC_LIFECYCLE_REGISTRY.map(({ contract }) => contract)),
			].sort(),
		).toEqual([...ASYNC_CONTRACT_TYPES].sort());
		expect(detected.has("attempts")).toBe(false);
	});

	it("keeps every contract owner executable instead of documenting phantom workers", () => {
		for (const registration of ASYNC_LIFECYCLE_REGISTRY) {
			expect(
				existsSync(resolve(apiRoot, registration.source)),
				`${registration.table}: ${registration.source}`,
			).toBe(true);
		}
	});

	it("derives the scheduled-job effect boundary from the constrained job domain", () => {
		expect(Object.keys(AUTOMATION_SCHEDULED_JOB_CONTRACTS).sort()).toEqual(
			[...AUTOMATION_SCHEDULED_JOB_TYPES].sort(),
		);
		expect(
			Object.entries(AUTOMATION_SCHEDULED_JOB_CONTRACTS)
				.filter(([, contract]) => contract === "external_mutation")
				.map(([jobType]) => jobType),
		).toEqual(["webhook_reception_failure"]);

		const scheduler = source("src/services/automations/scheduler.ts");
		expect(scheduler.match(/await markEffectStarted\(\);/g)).toHaveLength(1);
		expect(scheduler).toContain(
			"automationScheduledJobMayCrossExternalBoundary(job.job_type)",
		);
	});

	it("gives every high-amplification poll a fair same-statement claim and terminal budget", () => {
		const externalPosts = source("src/services/external-post-sync/cron.ts");
		const analytics = source("src/services/analytics-refresh.ts");
		const ads = source("src/services/ad-sync.ts");
		const shortLinks = source("src/services/short-link-click-sync.ts");
		for (const worker of [externalPosts, analytics, ads, shortLinks]) {
			expect(worker).toContain("row_number() OVER");
			expect(worker).toContain("PARTITION BY");
			expect(worker).toContain("maxAutomaticAttempts");
		}
		expect(externalPosts).toContain("pollGeneration:");
		expect(analytics).toContain("metricsPollGeneration:");
		expect(ads).toContain("metricsPollGeneration:");
		expect(ads).toContain("sa.lifecycle_status = 'active'");
		expect(shortLinks).toContain("clickSyncGeneration:");
	});

	it("bounds and tenant-fairs customer-webhook repair and conversion dispatch", () => {
		const customerWebhooks = source("src/services/webhook-delivery.ts");
		const conversions = source(
			"src/services/automation-conversion-dispatch.ts",
		);
		for (const worker of [customerWebhooks, conversions]) {
			expect(worker).toContain("row_number() OVER");
			expect(worker).toContain("PARTITION BY");
			expect(worker).toContain("FOR UPDATE OF");
		}
		expect(customerWebhooks).toContain("MAX_PRE_BOUNDARY_REPAIR_ATTEMPTS");
		expect(customerWebhooks).toContain("repairDeadlineAt");
		expect(customerWebhooks).toContain("http_outcome_unknown");
		expect(customerWebhooks).toContain(
			"request_may_have_been_sent_at + interval '90 days'",
		);
		expect(customerWebhooks).not.toContain(
			"attempts: Math.max(delivery.attempts - 1, 0)",
		);
	});

	it("has concrete provider-call amplification bounds", () => {
		// A duplicate external-post queue delivery cannot cross the generation
		// claim, so only one consumer can spend this two-page budget.
		expect(EXTERNAL_POST_POLL.maxPagesPerAttempt).toBe(2);

		// One half-hour ad producer has independent listing and metrics pages.
		expect(
			AD_ACCOUNT_POLL.maxClaimsPerRun + AD_METRICS_POLL.maxClaimsPerRun,
		).toBe(150);
		expect(150).toBeLessThan(1_608);

		// Internal post analytics are tenant-fair and each provider target is
		// visited at most once per fenced claim.
		expect(INTERNAL_METRICS_POLL.maxClaimsPerRun).toBe(200);
		expect(INTERNAL_METRICS_POLL.maxClaimsPerTenant).toBe(20);
		expect(INTERNAL_METRICS_POLL.maxAutomaticAttempts).toBe(8);

		// Short.io is the worst adapter at two reads/link. The new global page is
		// 50 links, versus the previous 200-row × 288-delivery/day scenario.
		const worstShortLinkCallsPerRun = SHORT_LINK_POLL.maxClaimsPerRun * 2;
		expect(worstShortLinkCallsPerRun).toBe(100);
		expect(worstShortLinkCallsPerRun * 288).toBe(28_800);
		expect(28_800).toBeLessThan(57_600);

		// Permanent/unknown Meta outcomes stop after their first classified
		// attempt; only known transient failures can consume this finite budget.
		expect(AUTOMATION_BINDING_MUTATION.maxAutomaticAttempts).toBe(8);
		const binding = source("src/services/automations/binding-sync.ts");
		expect(binding).toContain('syncErrorClass, "transient"');
		expect(binding).toContain('errorClass === "transient"');
	});

	it("bounds rescue without a budget-renewing self-handoff", () => {
		const rescue = source("src/queues/queue-rescue.ts");
		const production = JSON.parse(source("production-resources.json")) as {
			queueMessageRetentionSeconds: number;
		};
		expect(QUEUE_RESCUE_POLICY.terminalAttempt).toBe(40);
		expect(QUEUE_RESCUE_POLICY.alertAttempts).toEqual([3, 10, 25, 40]);
		expect(nominalQueueDeliveryBound(3)).toBe(48);
		expect(nominalQueueDeliveryBound(5)).toBe(50);
		expect(
			maximumRetryDelayHorizonSeconds(
				QUEUE_RESCUE_POLICY.terminalAttempt - 1,
				QUEUE_RESCUE_POLICY.retry,
			),
		).toBeLessThan(10 * 60 * 60);
		expect(
			maximumRetryDelayHorizonSeconds(
				QUEUE_RESCUE_POLICY.terminalAttempt - 1,
				QUEUE_RESCUE_POLICY.retry,
			),
		).toBeLessThan(QUEUE_RESCUE_POLICY.messageRetentionSeconds);
		expect(production.queueMessageRetentionSeconds).toBe(
			QUEUE_RESCUE_POLICY.messageRetentionSeconds,
		);
		expect(rescue).not.toContain("QUEUE_RESCUE_QUEUE.send");
		expect(rescue).not.toContain("unknown-dlq");
		expect(rescue).toContain("bodyCiphertext");
		expect(rescue).toContain("encryptToken(");
		expect(rescue).toContain("deleteQueueRescueSubjectPage");
		expect(rescue).not.toContain(
			"QUEUE_RESCUE_BUCKET.put(key, serializeEnvelope",
		);
	});

	it("keeps transient Queue handoffs to durable identifiers or encrypted envelopes", () => {
		const publish = source("src/services/publish-outbox.ts");
		const inbound = source("src/services/inbound-webhook-acceptance.ts");
		const inboxConsumer = source("src/queues/inbox.ts");
		const syncTypes = source("src/services/external-post-sync/types.ts");
		const customerWebhooks = source("src/services/webhook-delivery.ts");

		expect(publish).toContain('type: "publish_outbox"');
		expect(publish).toContain("outbox_id: row.id");
		expect(inbound).toContain('type: "raw_platform_webhook"');
		expect(inbound).toContain("receipt_id: durableReceiptId");
		expect(inboxConsumer).toContain("createInlineInboxEnv");
		expect(inboxConsumer).toContain("await processInboxEvent(");
		expect(syncTypes).not.toContain("platform_post_id");
		expect(syncTypes).not.toContain("hint?:");
		expect(customerWebhooks).toContain("delivery_id: id");
		expect(customerWebhooks).not.toMatch(
			/body:\s*\{[\s\S]{0,120}type:\s*"deliver_customer_webhook"[\s\S]{0,120}payload:/,
		);
	});

	it("has one configured owner per cron and deployment-neutral request-log retention", () => {
		for (const configPath of [
			"apps/api/wrangler.jsonc",
			"apps/api/production-resources.json",
			"packages/self-host/src/wrangler-config.ts",
		]) {
			const config = readFileSync(resolve(repoRoot, configPath), "utf8");
			expect(config).not.toContain("0 0 1 * *");
			expect(config).not.toContain("0 9 * * 1");
			expect(config).toContain("0 9 * * MON");
		}
		const scheduler = source("src/scheduled/index.ts");
		expect(scheduler).not.toContain("processAutomationInputTimeouts");
		expect(scheduler).toContain("pruneApiRequestLogs");
		expect(scheduler).toContain("pruneExpiredAuthState");
		expect(scheduler).toContain("recoverEmailDispatches");
		expect(scheduler).toContain("retainEmailDeliveries");
		expect(scheduler).toContain("retainQueueFailures");
		expect(source("src/services/invoice-generator.ts")).not.toContain(
			"apiRequestLogs",
		);
	});

	it("keeps rejected webhook bodies out of operator events and classifies them evidence-only", () => {
		const receiver = source("src/services/automations/webhook-receiver.ts");
		const alerts = source("src/services/operator-alerts.ts");
		const admin = source("src/routes/admin.ts");
		expect(receiver).toContain("stageRejectedWebhook");
		expect(receiver).toContain("automationWebhookFailureOccurrenceId");
		expect(receiver).toContain('jobType: "webhook_reception_failure"');
		expect(alerts).toContain("OPERATIONS_ALERT_WEBHOOK_URL");
		expect(alerts).toContain("JSON.stringify(alert)");
		expect(alerts).not.toMatch(
			/interface AutomationWebhookReceptionFailureAlert[\s\S]*rawBody/,
		);
		expect(admin).toContain('resolutionMode: "evidence_only"');
	});
});
