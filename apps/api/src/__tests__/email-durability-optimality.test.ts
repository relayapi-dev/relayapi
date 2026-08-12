import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { emailDeliveries, user } from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	EMAIL_DELIVERY_DEADLINE_MS,
	EMAIL_PROVIDER_MAX_ATTEMPTS,
	nextEmailProviderAttemptAt,
} from "../lib/email-queue/policy";
import { emailDeliveryIdForIdempotencyKey } from "../lib/email-queue/producer";
import { parseInternalEmailIntent } from "../services/email-intents";

function source(relativePath: string): string {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("email delivery optimality contract", () => {
	it("keeps personal email content out of Cloudflare Queue", () => {
		const types = source("../lib/email-queue/types.ts");
		const producer = source("../lib/email-queue/producer.ts");
		const consumer = source("../queues/email.ts");

		const queueShape = types.slice(
			types.indexOf("export interface EmailQueueMessage"),
			types.indexOf("export interface EmailDeliveryEnvelope"),
		);
		expect(queueShape).toContain("id: string");
		expect(queueShape).not.toContain("organization_id");
		expect(queueShape).not.toContain("to:");
		expect(queueShape).not.toContain("subject:");
		expect(queueShape).not.toContain("html:");
		expect(producer).toContain('field: "email_delivery_envelope"');
		expect(producer.indexOf(".insert(emailDeliveries)")).toBeLessThan(
			producer.indexOf("await dispatchEmailDelivery("),
		);
		expect(producer).toContain("await env.EMAIL_QUEUE.send(message)");
		expect(consumer).toContain("Object.keys(body).every");
		expect(consumer).toContain("await decryptToken(");
	});

	it("uses a stable opaque ledger ID instead of exposing logical identity", async () => {
		const logical =
			"notification:occurrence_1:user_personally_identifying_identifier";
		const first = await emailDeliveryIdForIdempotencyKey(logical);
		expect(first).toMatch(/^eml_[0-9a-f]{64}$/);
		expect(await emailDeliveryIdForIdempotencyKey(logical)).toBe(first);
		expect(first).not.toContain("user_");
		expect(await emailDeliveryIdForIdempotencyKey(`${logical}:other`)).not.toBe(
			first,
		);
	});

	it("has separate fenced Queue handoff and provider-call boundaries", () => {
		const config = getTableConfig(emailDeliveries);
		const columns = new Set(config.columns.map((column) => column.name));
		for (const column of [
			"intent",
			"organization_id",
			"auth_user_id",
			"subject_user_id",
			"envelope_ciphertext",
			"envelope_key_id",
			"provider_attempts",
			"dispatch_attempts",
			"dispatch_lease_token",
			"dispatch_lease_expires_at",
			"next_dispatch_at",
			"lease_token",
			"lease_expires_at",
			"request_may_have_been_sent_at",
			"deadline_at",
			"expires_at",
			"purge_at",
			"redacted_at",
		]) {
			expect(columns).toContain(column);
		}
		expect(
			config.columns.find((column) => column.name === "organization_id")
				?.notNull,
		).toBe(false);
		expect(
			config.columns.find((column) => column.name === "auth_user_id")?.notNull,
		).toBe(false);
		expect(
			config.columns.find((column) => column.name === "status")?.enumValues,
		).toEqual([
			"pending",
			"processing",
			"unknown",
			"sent",
			"failed",
			"manual_review",
		]);
		const checks = config.checks.map((constraint) => constraint.name);
		expect(checks).toEqual(
			expect.arrayContaining([
				"email_deliveries_state_fields_check",
				"email_deliveries_intent_owner_check",
				"email_deliveries_dispatch_lease_check",
				"email_deliveries_envelope_lifecycle_check",
			]),
		);

		const producer = source("../lib/email-queue/producer.ts");
		const consumer = source("../queues/email.ts");
		expect(producer).toContain("dispatchLeaseToken: sql");
		expect(producer).toContain("dispatchLeaseExpiresAt:");
		expect(consumer).toContain('status: "processing"');
		expect(consumer).toContain("dispatchLeaseExpiresAt: null");
		expect(consumer).toContain(
			"eq(emailDeliveries.requestMayHaveBeenSentAt, requestBoundary)",
		);
		expect(consumer).toContain(
			"eq(emailDeliveries.leaseToken, claim.leaseToken)",
		);
		expect(consumer).toContain('status: "unknown"');
		expect(consumer).toContain('status: "manual_review"');
		expect(consumer).toContain("nextAttemptAt: retryAt");
		expect(consumer).toContain("nextDispatchAt: retryAt");
		expect(consumer).not.toContain("message.retry(");
		expect(consumer).not.toContain("message.attempts");
	});

	it("bounds provider requests by the durable PostgreSQL clock over the full deadline", () => {
		expect(EMAIL_PROVIDER_MAX_ATTEMPTS).toBe(6);
		expect(EMAIL_DELIVERY_DEADLINE_MS).toBe(23 * 60 * 60 * 1_000);
		const startedAt = new Date("2026-07-29T00:00:00.000Z");
		const deadlineAt = new Date(
			startedAt.getTime() + EMAIL_DELIVERY_DEADLINE_MS,
		);
		let attemptAt = startedAt;
		let providerRequests = 0;
		for (;;) {
			providerRequests += 1;
			const retryAt = nextEmailProviderAttemptAt(
				providerRequests,
				attemptAt,
				deadlineAt,
			);
			if (!retryAt) break;
			attemptAt = retryAt;
		}
		expect(providerRequests).toBe(EMAIL_PROVIDER_MAX_ATTEMPTS);
		expect(nextEmailProviderAttemptAt(1, deadlineAt, deadlineAt)).toBeNull();
	});

	it("cascades identity-owned deliveries while retaining SET NULL audit subjects", () => {
		const config = getTableConfig(emailDeliveries);
		const byColumn = (columnName: string) =>
			config.foreignKeys.find((foreignKey) =>
				foreignKey
					.reference()
					.columns.some((column) => column.name === columnName),
			);
		const owner = byColumn("auth_user_id");
		expect(owner?.reference().foreignTable).toBe(user);
		expect(owner?.onDelete).toBe("cascade");
		const subject = byColumn("subject_user_id");
		expect(subject?.reference().foreignTable).toBe(user);
		expect(subject?.onDelete).toBe("set null");
	});

	it("rejects arbitrary envelope fields at the private intent boundary", () => {
		expect(
			parseInternalEmailIntent({
				type: "organization_invitation",
				invitationId: "invite_1",
				occurrenceId: "created",
			}),
		).toEqual({
			type: "organization_invitation",
			invitationId: "invite_1",
			occurrenceId: "created",
		});
		expect(() =>
			parseInternalEmailIntent({
				type: "account_action",
				kind: "verify-email",
				authUserId: "user_1",
				actionUrl: "https://relayapi.dev/verify?token=token_1",
				token: "token_1",
				to: "attacker@example.com",
				subject: "arbitrary",
				html: "<p>arbitrary</p>",
			}),
		).toThrow("unsupported fields");
	});

	it("has total recovery, redaction, deletion, and identity-erasure paths", () => {
		const retention = source("../services/operational-retention.ts");
		const identityDeletion = source("../../../app/src/lib/user-deletion.ts");
		expect(retention).toContain("row_number() OVER (");
		expect(retention).toContain("PARTITION BY delivery.intent");
		expect(retention).toContain("EMAIL_DISPATCH_OWNER_CAP");
		expect(retention).toContain("EMAIL_DISPATCH_RECOVERY_LIMIT");
		expect(retention).toContain("EMAIL_DISPATCH_RECOVERY_CONCURRENCY");
		expect(retention).toContain("mapConcurrently(");
		expect(retention).toContain("recoverEmailDispatches");
		expect(retention).toContain("retainEmailDeliveries");
		expect(retention).toContain("envelopeCiphertext: null");
		expect(retention).toContain("NOT EXISTS (");
		expect(retention).toContain("hold.subject_kind = 'organization'");
		expect(identityDeletion).toContain(
			"eq(emailDeliveries.subjectUserId, userId)",
		);
		expect(identityDeletion).toContain("recipient_identity_erased");
	});
});
