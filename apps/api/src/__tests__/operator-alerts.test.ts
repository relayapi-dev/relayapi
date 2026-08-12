import { describe, expect, it } from "bun:test";
import {
	type AutomationWebhookReceptionFailureAlert,
	type CustomerWebhookRepairExhaustedAlert,
	dispatchAutomationWebhookReceptionFailureAlert,
	dispatchCustomerWebhookRepairExhaustedAlert,
	dispatchQueueRescuePersistenceAlert,
	dispatchRetentionBacklogAlert,
	type QueueRescuePersistenceAlert,
	type RetentionBacklogAlert,
} from "../services/operator-alerts";
import type { Env } from "../types";

const ALERT: AutomationWebhookReceptionFailureAlert = {
	type: "automation_webhook_reception_failure",
	organizationId: "org_test",
	automationId: "aut_test",
	entrypointId: "aep_test",
	channel: "instagram",
	socialAccountId: "acc_test",
	requestDigest: "sha256:test",
	reason: "bad_signature",
	receivedAt: "2026-07-28T12:00:00.000Z",
	occurrenceId: "occ_test",
};

const RETENTION_ALERT: RetentionBacklogAlert = {
	type: "retention_backlog",
	organizationId: "org_test",
	storeId: "postgres:public.notifications",
	handlerId: "retain_notifications",
	processed: 2_000,
	hardLimit: 2_000,
	oldestDueAt: "2026-01-01T00:00:00.000Z",
	observedAt: "2026-07-28T09:00:00.000Z",
	occurrenceId: "retention:retain_notifications:2026-07-28",
};

const QUEUE_RESCUE_ALERT: QueueRescuePersistenceAlert = {
	type: "queue_rescue_persistence_failure",
	organizationId: "org_test",
	queueClass: "publish",
	messageDigest: "a".repeat(64),
	attempt: 40,
	terminal: true,
	observedAt: "2026-07-28T09:00:00.000Z",
	occurrenceId: `queue-rescue:${"a".repeat(64)}:40`,
};

const CUSTOMER_WEBHOOK_ALERT: CustomerWebhookRepairExhaustedAlert = {
	type: "customer_webhook_pre_boundary_repair_exhausted",
	organizationId: "org_test",
	deliveryId: "whd_test",
	repairAttempts: 12,
	observedAt: "2026-07-28T09:00:00.000Z",
	occurrenceId:
		"customer-webhook-repair-exhausted:whd_test:2026-07-29T09:00:00.000Z",
};

describe("operator alert adapters", () => {
	it("uses the sanitized HTTPS webhook as the primary adapter", async () => {
		let requestBody = "";
		let emailCalls = 0;
		await dispatchAutomationWebhookReceptionFailureAlert(
			ALERT,
			{
				OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
				OPERATIONS_ALERT_EMAIL: "admin@example.test",
			} as Env,
			{
				fetch: async (_input, init) => {
					requestBody = String(init?.body);
					return new Response(null, { status: 204 });
				},
				sendEmail: async () => {
					emailCalls += 1;
				},
			},
		);

		expect(JSON.parse(requestBody)).toEqual(ALERT);
		expect(requestBody).not.toContain("credential");
		expect(emailCalls).toBe(0);
	});

	it("falls back to the encrypted email outbox without raw request data", async () => {
		const emails: Array<{
			organizationId: string;
			to: string;
			html: string;
			idempotencyKey: string;
		}> = [];
		await dispatchAutomationWebhookReceptionFailureAlert(
			ALERT,
			{
				OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
				OPERATIONS_ALERT_EMAIL: "admin@example.test",
			} as Env,
			{
				fetch: async () => new Response(null, { status: 503 }),
				sendEmail: async (_env, options) => {
					emails.push(options);
				},
			},
		);

		expect(emails).toEqual([
			expect.objectContaining({
				organizationId: "org_test",
				to: "admin@example.test",
				idempotencyKey: "operator-alert:occ_test",
			}),
		]);
		expect(emails[0]?.html).toContain("sha256:test");
		expect(emails[0]?.html).toContain(
			"No request body, signature, credential, or free-form provider error",
		);
	});

	it("keeps the durable scheduled receipt retryable when every adapter fails", async () => {
		await expect(
			dispatchAutomationWebhookReceptionFailureAlert(
				ALERT,
				{
					OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
					OPERATIONS_ALERT_EMAIL: "admin@example.test",
				} as Env,
				{
					fetch: async () => {
						throw new Error("network details must not escape");
					},
					sendEmail: async () => {
						throw new Error("provider details must not escape");
					},
				},
			),
		).rejects.toThrow("webhook and email delivery failed");
	});

	it("delivers sanitized retention backlog metadata through the same durable adapter", async () => {
		let requestBody = "";
		await dispatchRetentionBacklogAlert(
			RETENTION_ALERT,
			{
				OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
			} as Env,
			{
				fetch: async (_input, init) => {
					requestBody = String(init?.body);
					return new Response(null, { status: 204 });
				},
				sendEmail: async () => {},
			},
		);

		expect(JSON.parse(requestBody)).toEqual(RETENTION_ALERT);
		expect(requestBody).not.toContain("rowId");
		expect(requestBody).not.toContain("payload");
		expect(requestBody).not.toContain("error");
	});

	it("alerts on rescue persistence without exposing the Queue body or raw message id", async () => {
		let requestBody = "";
		await dispatchQueueRescuePersistenceAlert(
			QUEUE_RESCUE_ALERT,
			{
				OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
			} as Env,
			{
				fetch: async (_input, init) => {
					requestBody = String(init?.body);
					return new Response(null, { status: 204 });
				},
				sendEmail: async () => {},
			},
		);

		expect(JSON.parse(requestBody)).toEqual(QUEUE_RESCUE_ALERT);
		expect(requestBody).not.toContain("originMessageId");
		expect(requestBody).not.toContain("bodyCiphertext");
		expect(requestBody).not.toContain("error");
	});

	it("alerts on exhausted pre-HTTP repair without payload, endpoint, or credential data", async () => {
		let requestBody = "";
		await dispatchCustomerWebhookRepairExhaustedAlert(
			CUSTOMER_WEBHOOK_ALERT,
			{
				OPERATIONS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
			} as Env,
			{
				fetch: async (_input, init) => {
					requestBody = String(init?.body);
					return new Response(null, { status: 204 });
				},
				sendEmail: async () => {},
			},
		);

		expect(JSON.parse(requestBody)).toEqual(CUSTOMER_WEBHOOK_ALERT);
		expect(requestBody).not.toContain("payload");
		expect(requestBody).not.toContain("endpoint");
		expect(requestBody).not.toContain("secret");
		expect(requestBody).not.toContain("error");
	});
});
