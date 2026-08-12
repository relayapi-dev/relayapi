import { describe, expect, it } from "bun:test";
import { SPECIALIZED_POSTGRES_RETENTION_CONTRACTS } from "@relayapi/db";

const SPECIALIZED_RETENTION_RUNTIME_PROOF =
	"SPECIALIZED_RETENTION_RUNTIME_PROOF";
const repoRoot = new URL("../../../../", import.meta.url).pathname;

function readSource(path: string): Promise<string> {
	return Bun.file(`${repoRoot}${path}`).text();
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe(SPECIALIZED_RETENTION_RUNTIME_PROOF, () => {
	it("names real exports and exact scheduled task evidence", async () => {
		const scheduled = await Bun.file(
			`${repoRoot}apps/api/src/scheduled/index.ts`,
		).text();
		for (const contract of SPECIALIZED_POSTGRES_RETENTION_CONTRACTS) {
			const source = await Bun.file(
				`${repoRoot}${contract.handler.source}`,
			).text();
			expect(source).toMatch(
				new RegExp(
					`export\\s+(?:(?:async\\s+)?function|const|class)\\s+${escapeRegex(contract.handler.exportName)}\\b`,
				),
			);
			expect(scheduled).toContain(contract.cadence.cron);
			expect(scheduled).toContain(contract.cadence.taskName);
			expect(contract.batch.rows).toBeLessThanOrEqual(5_000);
			expect(contract.batch.maxPasses).toBeLessThanOrEqual(20);
		}
	});

	it("keeps every specialized drain deterministic and statement-bounded", async () => {
		const [
			operational,
			capabilities,
			telegram,
			automationReceipts,
			idempotency,
			inbound,
			webhooks,
			phone,
			outbox,
			growth,
			externalCleanup,
			toolJobs,
			holdPolicy,
			timedDomain,
			inbox,
		] = await Promise.all([
			readSource("apps/api/src/services/operational-retention.ts"),
			readSource("apps/api/src/services/one-time-capability-cleanup.ts"),
			readSource("apps/api/src/services/telegram-connection.ts"),
			readSource("apps/api/src/services/automation-webhook-receipt-cleanup.ts"),
			readSource("apps/api/src/services/idempotency-receipt-reconciler.ts"),
			readSource("apps/api/src/services/inbound-webhook-retention.ts"),
			readSource("apps/api/src/services/webhook-retention.ts"),
			readSource("apps/api/src/services/phone-number-operations.ts"),
			readSource("apps/api/src/services/publish-outbox.ts"),
			readSource("apps/api/src/services/public-growth-events.ts"),
			readSource("apps/api/src/services/external-subject-cleanup.ts"),
			readSource("apps/api/src/services/tool-jobs.ts"),
			readSource("apps/api/src/services/privacy-retention-policy.ts"),
			readSource("apps/api/src/services/timed-domain-retention.ts"),
			readSource("apps/api/src/services/inbox-maintenance.ts"),
		]);

		for (const snippet of [
			"AUTH_EPHEMERAL_MAX_DELETE_PASSES",
			"ORDER BY token.expires_at",
			"FROM $" + "{inviteTokenWorkspaces} AS child",
			"NOT EXISTS (",
			"ORDER BY step.completed_at, step.id",
			".orderBy(apiRequestLogs.createdAt, apiRequestLogs.id)",
			".orderBy(emailDeliveries.expiresAt, emailDeliveries.id)",
			".orderBy(emailDeliveries.purgeAt, emailDeliveries.id)",
			".orderBy(queueFailures.payloadExpiresAt, queueFailures.id)",
			".orderBy(queueFailures.purgeAt, queueFailures.id)",
			".orderBy(",
			"automationEntrypointDailyCounts.day",
		]) {
			expect(operational).toContain(snippet);
		}
		expect(capabilities).toContain(
			".orderBy(oneTimeCapabilities.expiresAt, oneTimeCapabilities.id)",
		);
		expect(capabilities).toContain("MAX_BATCHES_PER_RUN");
		expect(telegram).toContain("asc(telegramConnectionChallenges.expiresAt)");
		expect(telegram).toContain("CHALLENGE_CLEANUP_MAX_BATCHES");
		expect(automationReceipts).toContain("automationWebhookReceipts.expiresAt");
		expect(automationReceipts).toContain("automationWebhookReceipts.id");
		expect(automationReceipts).toContain("MAX_BATCHES_PER_RUN");
		expect(idempotency).toContain(
			".orderBy(idempotencyReceipts.expiresAt, idempotencyReceipts.id)",
		);
		expect(idempotency).toContain(".limit(boundedLimit)");

		expect(inbound).toContain("INBOUND_WEBHOOK_RECEIPT_RETENTION_DAYS = 365");
		expect(inbound).toContain("ORDER BY receipt.received_at, receipt.id");
		expect(inbound).toContain("LIMIT $" + "{limit}");
		expect(inbound).toContain(
			"hold.subject_id = ANY(receipt.organization_ids)",
		);

		expect(webhooks).toContain("return db.transaction(async (tx)");
		expect(webhooks).toContain("FOR SHARE");
		expect(webhooks).toContain("FOR UPDATE OF event SKIP LOCKED");
		expect(webhooks.indexOf("DELETE FROM webhook_logs")).toBeLessThan(
			webhooks.indexOf("DELETE FROM webhook_deliveries"),
		);
		expect(webhooks.indexOf("DELETE FROM webhook_deliveries")).toBeLessThan(
			webhooks.indexOf("DELETE FROM webhook_events"),
		);
		expect(webhooks).toContain("WHERE log.delivery_id = delivery.id");
		expect(webhooks).toContain("LIMIT $" + "{boundedLimit}");

		expect(phone).toContain("PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES");
		expect(phone).toContain(
			"whatsappPhoneProvisioningOperations.provisioningDetailExpiresAt",
		);
		expect(outbox).toContain("RETENTION_BATCH_SIZE = 1_000");
		expect(outbox).toContain("ORDER BY dispatched_at ASC, id ASC");
		expect(growth).toContain("CLEANUP_BATCH = 5_000");
		expect(growth).toContain("ORDER BY completed_at, id");
		expect(externalCleanup).toContain("ORDER BY purge_at ASC, id ASC");
		expect(externalCleanup).toContain("LIMIT $" + "{limit}");
		expect(toolJobs).toContain("ORDER BY purge_at ASC, id ASC");
		expect(toolJobs).toContain("LIMIT $" + "{limit}");

		expect(holdPolicy).toContain("RELEASED_HOLD_EVIDENCE_REDACTION_MAX_PASSES");
		expect(holdPolicy).toContain(
			".orderBy(erasureHolds.releasedAt, erasureHolds.id)",
		);
		expect(holdPolicy).toContain(
			".limit(RELEASED_HOLD_EVIDENCE_REDACTION_BATCH)",
		);

		expect(timedDomain).toContain("LIMIT $" + "{TIMED_DOMAIN_RETENTION_BATCH}");
		expect(timedDomain).toContain("interval '2 years'");
		expect(timedDomain).toContain("interval '25 months'");
		expect(timedDomain).toContain("interval '90 days'");
		expect(timedDomain).toContain("interval '1 year'");
		expect(timedDomain).toContain("FOR SHARE OF tenant");
		expect(timedDomain).toContain("FOR UPDATE OF recipient SKIP LOCKED");
		expect(
			timedDomain.indexOf("DELETE FROM broadcast_recipients"),
		).toBeLessThan(timedDomain.indexOf("DELETE FROM broadcasts AS parent"));
		expect(timedDomain).toContain("FROM $" + "{ads} AS ad");
		expect(timedDomain).toContain(".insert(externalSubjectCleanupJobs)");
		expect(timedDomain).toContain(
			"One candidate produces at most two physical writes",
		);

		expect(inbox).toContain("INBOX_MESSAGE_REDACTION_BATCH_SIZE = 2_000");
		expect(inbox).toContain("INBOX_NOTE_DELETION_BATCH_SIZE = 2_000");
		expect(inbox).toContain("NOT EXISTS (");
		expect(inbox.indexOf("UPDATE inbox_messages")).toBeLessThan(
			inbox.indexOf(".update(inboxConversations)"),
		);
	});

	it("never certifies an open-cardinality cascade as a source-row bound", async () => {
		const executable = await Bun.file(
			`${repoRoot}apps/api/src/services/executable-retention.ts`,
		).text();
		expect(executable).toContain(
			"NOT EXISTS (SELECT 1 FROM automation_effects AS effect WHERE effect.node_execution_id = item.id)",
		);
		expect(executable).toContain(
			"NOT EXISTS (SELECT 1 FROM automation_conversion_events AS conversion WHERE conversion.run_id = item.id)",
		);
		expect(executable).toContain(
			"NOT EXISTS (SELECT 1 FROM automation_step_runs AS step WHERE step.run_id = item.id)",
		);
		expect(executable.indexOf("retain_automation_effects")).toBeLessThan(
			executable.lastIndexOf(
				'{ id: "retain_automation_runs", run: retainAutomationRuns }',
			),
		);
	});
});
