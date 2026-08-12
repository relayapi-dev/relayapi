export const AUTOMATION_WEBHOOK_FAILURE_REASONS = [
	"missing_secret",
	"missing_signature",
	"credential_unavailable",
	"invalid_timestamp",
	"stale_timestamp",
	"bad_signature",
	"bad_payload",
	"contact_lookup_failed",
	"enrollment_blocked",
	"enrollment_failed",
] as const;

export type AutomationWebhookFailureReason =
	(typeof AUTOMATION_WEBHOOK_FAILURE_REASONS)[number];

export interface AutomationWebhookReceptionFailureAlert {
	type: "automation_webhook_reception_failure";
	organizationId: string;
	automationId: string;
	entrypointId: string;
	channel: string;
	socialAccountId: string | null;
	requestDigest: string;
	reason: AutomationWebhookFailureReason;
	receivedAt: string;
	occurrenceId: string;
}

export interface RetentionBacklogAlert {
	type: "retention_backlog";
	organizationId: string;
	storeId: `postgres:${string}`;
	handlerId: string;
	processed: number;
	hardLimit: number;
	oldestDueAt: string;
	observedAt: string;
	occurrenceId: string;
}

export interface QueueRescuePersistenceAlert {
	type: "queue_rescue_persistence_failure";
	organizationId: string | null;
	queueClass:
		| "media-cleanup"
		| "media-processing"
		| "publish"
		| "email"
		| "refresh"
		| "inbox"
		| "tools"
		| "ads"
		| "sync"
		| "customer-webhooks"
		| "rescue"
		| "unknown";
	messageDigest: string;
	attempt: number;
	terminal: boolean;
	observedAt: string;
	occurrenceId: string;
}

export interface CustomerWebhookRepairExhaustedAlert {
	type: "customer_webhook_pre_boundary_repair_exhausted";
	organizationId: string;
	deliveryId: string;
	repairAttempts: number;
	observedAt: string;
	occurrenceId: string;
}

type OperatorAlert =
	| AutomationWebhookReceptionFailureAlert
	| RetentionBacklogAlert
	| QueueRescuePersistenceAlert
	| CustomerWebhookRepairExhaustedAlert;

interface OperatorAlertDependencies {
	fetch: (
		input: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>;
	sendEmail: typeof sendEmail;
}

const DEFAULT_DEPENDENCIES: OperatorAlertDependencies = {
	fetch,
	sendEmail,
};

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

function alertHtml(alert: OperatorAlert): string {
	const fields: readonly (readonly [string, string])[] =
		alert.type === "automation_webhook_reception_failure"
			? [
					["Organization", alert.organizationId],
					["Automation", alert.automationId],
					["Entrypoint", alert.entrypointId],
					["Channel", alert.channel],
					["Social account", alert.socialAccountId ?? "none"],
					["Reason", alert.reason],
					["Request digest", alert.requestDigest],
					["Received", alert.receivedAt],
					["Occurrence", alert.occurrenceId],
				]
			: alert.type === "retention_backlog"
				? [
						["Organization", alert.organizationId],
						["Store", alert.storeId],
						["Handler", alert.handlerId],
						["Processed", String(alert.processed)],
						["Invocation hard limit", String(alert.hardLimit)],
						["Oldest due", alert.oldestDueAt],
						["Observed", alert.observedAt],
						["Occurrence", alert.occurrenceId],
					]
				: alert.type === "queue_rescue_persistence_failure"
					? [
							["Organization", alert.organizationId ?? "unscoped"],
							["Queue class", alert.queueClass],
							["Message digest", alert.messageDigest],
							["Attempt", String(alert.attempt)],
							["Terminal", String(alert.terminal)],
							["Observed", alert.observedAt],
							["Occurrence", alert.occurrenceId],
						]
					: [
							["Organization", alert.organizationId],
							["Delivery", alert.deliveryId],
							["Repair attempts", String(alert.repairAttempts)],
							["Observed", alert.observedAt],
							["Occurrence", alert.occurrenceId],
						];
	const heading =
		alert.type === "automation_webhook_reception_failure"
			? "Automation webhook reception failure"
			: alert.type === "retention_backlog"
				? "Retention backlog requires attention"
				: alert.type === "queue_rescue_persistence_failure"
					? "Queue rescue persistence failure"
					: "Customer webhook delivery requires operator review";
	const safetyNote =
		alert.type === "automation_webhook_reception_failure"
			? "No request body, signature, credential, or free-form provider error is included."
			: alert.type === "retention_backlog"
				? "No retained row id, payload, personal field, credential, or free-form error is included."
				: alert.type === "queue_rescue_persistence_failure"
					? "No Queue body, raw message identifier, personal field, credential, or free-form error is included."
					: "No webhook payload, endpoint URL, signing secret, personal field, or free-form error is included.";
	return `<h1>${heading}</h1><dl>${fields
		.map(
			([label, value]) =>
				`<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`,
		)
		.join("")}</dl><p>${safetyNote}</p>`;
}

function validAlertEmail(value: string): boolean {
	return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Structured operator alert adapter.
 *
 * The sanitized HTTPS webhook is primary. A configured operations address is
 * the durable email fallback and uses the same encrypted email outbox as other
 * transactional mail. Cloudflare's structured Worker log remains the
 * deployment-neutral sink when neither adapter is configured. The scheduled
 * job is the durable delivery receipt. No raw body, signature, credential,
 * free-form error, or untrusted contact data enters any alert adapter.
 */
async function dispatchOperatorAlert(
	alert: OperatorAlert,
	env: Env,
	dependencies: OperatorAlertDependencies,
): Promise<void> {
	console.error(`[operator-alert] ${alert.type}`, alert);
	const endpoint = env.OPERATIONS_ALERT_WEBHOOK_URL?.trim();
	const fallbackEmail = env.OPERATIONS_ALERT_EMAIL?.trim();
	let webhookFailed = false;

	if (endpoint) {
		try {
			const url = new URL(endpoint);
			if (url.protocol !== "https:") {
				throw new Error("HTTPS is required");
			}
			const response = await dependencies.fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(alert),
				signal: AbortSignal.timeout(10_000),
			});
			void response.body?.cancel().catch(() => {});
			if (!response.ok) throw new Error("non-success response");
			return;
		} catch {
			webhookFailed = true;
		}
	}

	if (fallbackEmail) {
		if (!validAlertEmail(fallbackEmail)) {
			throw new Error("Operations alert email configuration is invalid");
		}
		if (!alert.organizationId) {
			if (webhookFailed) {
				throw new Error(
					"Operations alert webhook failed and the unscoped alert cannot use the tenant email outbox",
				);
			}
			return;
		}
		try {
			await dependencies.sendEmail(env, {
				organizationId: alert.organizationId,
				to: fallbackEmail,
				subject:
					alert.type === "automation_webhook_reception_failure"
						? `[RelayAPI] Automation webhook failure: ${alert.reason}`
						: alert.type === "retention_backlog"
							? `[RelayAPI] Retention backlog: ${alert.handlerId}`
							: alert.type === "queue_rescue_persistence_failure"
								? `[RelayAPI] Queue rescue failure: ${alert.queueClass}`
								: "[RelayAPI] Customer webhook delivery requires review",
				html: alertHtml(alert),
				idempotencyKey: `operator-alert:${alert.occurrenceId}`,
			});
			return;
		} catch {
			throw new Error("Operations alert webhook and email delivery failed");
		}
	}

	if (webhookFailed) {
		throw new Error(
			"Operations alert webhook failed and no email fallback is configured",
		);
	}
}

export async function dispatchAutomationWebhookReceptionFailureAlert(
	alert: AutomationWebhookReceptionFailureAlert,
	env: Env,
	dependencies: OperatorAlertDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
	return dispatchOperatorAlert(alert, env, dependencies);
}

/**
 * Dispatch only bounded, non-row-identifying retention metadata. The daily
 * occurrence key makes the encrypted email outbox a durable handoff without
 * amplifying one persistent backlog into duplicate messages on cron retry.
 */
export async function dispatchRetentionBacklogAlert(
	alert: RetentionBacklogAlert,
	env: Env,
	dependencies: OperatorAlertDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
	return dispatchOperatorAlert(alert, env, dependencies);
}

export async function dispatchQueueRescuePersistenceAlert(
	alert: QueueRescuePersistenceAlert,
	env: Env,
	dependencies: OperatorAlertDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
	return dispatchOperatorAlert(alert, env, dependencies);
}

export async function dispatchCustomerWebhookRepairExhaustedAlert(
	alert: CustomerWebhookRepairExhaustedAlert,
	env: Env,
	dependencies: OperatorAlertDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
	return dispatchOperatorAlert(alert, env, dependencies);
}

import { sendEmail } from "../lib/email-queue/producer";
import type { Env } from "../types";
