import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	OPERATOR_RESOLUTION_ACTIONS_BY_TARGET,
	operatorResolutionEvidence,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	AdminOperatorResolutionRequest,
	AdminOperatorResolutionTargetType,
} from "../schemas/admin";
import { allowedOperatorResolutionActions } from "../services/operator-resolution";

describe("operator resolution contract", () => {
	it("records tool-job abandon as an explicit audited usage write-off", () => {
		const source = readFileSync(
			new URL("../services/operator-resolution.ts", import.meta.url),
			"utf8",
		);
		const resolveToolJobSource = source.slice(
			source.indexOf("async function resolveToolJob"),
			source.indexOf(
				"async function resolveWhatsappPhoneProvisioningOperation",
			),
		);
		expect(resolveToolJobSource).toContain('state: "released"');
		expect(resolveToolJobSource).toContain('disposition: "written_off"');
		expect(resolveToolJobSource).toContain(
			'writeOffReason: "operator_abandoned_unknown_provider_outcome"',
		);
		expect(resolveToolJobSource).toContain("writtenOffAt: resolvedAt");
		expect(resolveToolJobSource).toContain("finalizedAt: resolvedAt");
		expect(resolveToolJobSource).toContain('errorCode: "OPERATOR_ABANDONED"');
	});

	it("never turns an unknown external mutation into an automatic retry", () => {
		expect(
			allowedOperatorResolutionActions({
				targetType: "automation_effect",
				status: "unknown",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "automation_binding",
				status: "unknown",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "account_revocation_job",
				status: "unknown",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "short_link_creation",
				status: "manual_review",
				reasonCode: "ambiguous_provider_create_candidate_recorded",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "short_link_creation",
				status: "manual_review",
				reasonCode: "ambiguous_provider_create",
			}),
		).toEqual(["mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "tool_job",
				status: "manual_review",
				reasonCode: "provider_outcome_unknown_retryable",
			}),
		).toEqual(["mark_not_applied", "abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "tool_job",
				status: "manual_review",
				reasonCode: "provider_outcome_unknown_closed_window",
			}),
		).toEqual(["abandon"]);
		for (const targetType of [
			"whatsapp_phone_billing_operation",
			"ad_mutation_operation",
		] as const) {
			expect(
				allowedOperatorResolutionActions({
					targetType,
					status: "unknown",
				}),
			).toEqual(["mark_succeeded", "mark_not_applied"]);
			expect(
				allowedOperatorResolutionActions({
					targetType,
					status: "manual_review",
				}),
			).toEqual(["mark_succeeded", "mark_not_applied"]);
		}
		expect(
			allowedOperatorResolutionActions({
				targetType: "ad_mutation_operation",
				status: "manual_review",
				reasonCode: "confirmed_ad_provider_mutation_projection_pending",
			}),
		).toEqual(["mark_succeeded"]);
	});

	it("allows retries only for lifecycle-safe reconciliation paths", () => {
		expect(
			allowedOperatorResolutionActions({
				targetType: "automation_conversion_event",
				status: "manual_review",
			}),
		).toEqual(["retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "automation_binding",
				status: "permanent",
			}),
		).toEqual(["retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "stripe_event",
				status: "manual_review",
			}),
		).toEqual(["retry", "abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "billing_operation",
				status: "manual_review",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied", "retry", "abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "billing_operation",
				status: "terminal_failed",
			}),
		).toEqual(["mark_not_applied", "abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "account_revocation_job",
				status: "manual_required",
			}),
		).toEqual(["mark_succeeded", "abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "external_subject_cleanup_job",
				status: "manual_review",
			}),
		).toEqual(["mark_succeeded", "retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "customer_webhook_delivery",
				status: "manual_review",
				reasonCode: "pre_http_repair_exhausted",
			}),
		).toEqual(["retry", "abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "customer_webhook_delivery",
				status: "manual_review",
				reasonCode: "http_outcome_unknown",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied", "retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "customer_webhook_delivery",
				status: "manual_review",
				reasonCode: "pre_http_repair_exhausted",
				operatorRetryRequestedAt: new Date(),
			}),
		).toEqual(["abandon"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "customer_webhook_delivery",
				status: "manual_review",
				reasonCode: "http_outcome_unknown",
				operatorRetryRequestedAt: new Date(),
			}),
		).toEqual(["mark_succeeded", "mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "whatsapp_phone_provisioning_operation",
				status: "manual_review",
				reasonCode: "provisioning_reconciliation_exhausted",
			}),
		).toEqual(["retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "whatsapp_phone_provisioning_operation",
				status: "manual_review",
				reasonCode: "provisioning_economic_boundary_recorded",
			}),
		).toEqual(["mark_succeeded", "retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "ad_mutation_operation",
				status: "manual_review",
				reasonCode: "ad_mutation_pre_provider_retries_exhausted",
			}),
		).toEqual(["mark_not_applied", "retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "whatsapp_phone_release_operation",
				status: "manual_review",
				reasonCode: "ambiguous_meta_deregistration",
			}),
		).toEqual(["mark_succeeded", "mark_not_applied"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "whatsapp_phone_release_operation",
				status: "manual_review",
				reasonCode: "manual_meta_deregistration_required",
			}),
		).toEqual(["mark_succeeded", "retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "ad_creation_operation",
				status: "manual_review",
				reasonCode: "ad_creation_provider_progress_recorded",
			}),
		).toEqual(["mark_succeeded"]);
	});

	it("does not offer an unsafe generic phone-operation transition", () => {
		expect(
			allowedOperatorResolutionActions({
				targetType: "whatsapp_phone_provisioning_operation",
				status: "manual_review",
				reasonCode: "provisioning_fenced_for_release",
			}),
		).toEqual([]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "customer_webhook_delivery",
				status: "manual_review",
				reasonCode: "unknown_external_outcome",
			}),
		).toEqual([]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "whatsapp_phone_release_operation",
				status: "manual_review",
				reasonCode: "manual_phone_release_provider_resolution",
			}),
		).toEqual(["retry"]);
	});

	it("keeps phase-scoped phone-release non-effect evidence fenced and retryable", async () => {
		const source = await Bun.file(
			new URL("../services/operator-resolution.ts", import.meta.url),
		).text();
		const releaseResolution = source.slice(
			source.indexOf("async function resolveWhatsappPhoneReleaseOperation"),
			source.indexOf("async function resolveWhatsappPhoneBillingOperation"),
		);
		const releaseList = source.slice(
			source.indexOf("'whatsapp_phone_release_operation'::text"),
			source.indexOf("'whatsapp_phone_billing_operation'::text"),
		);

		expect(releaseResolution).toContain('input.action === "mark_not_applied"');
		expect(releaseResolution).toContain(
			'releaseMetaStatus: "pending" as const',
		);
		expect(releaseResolution).not.toContain('? "manual_review"');
		expect(releaseResolution).not.toContain("assertNoTerminalOperatorDecision");
		expect(releaseList).not.toContain("operator_resolution_evidence");
	});

	it("retries completed phone release projections as DB-only failed work", async () => {
		const source = await Bun.file(
			new URL("../services/operator-resolution.ts", import.meta.url),
		).text();
		const releaseResolution = source.slice(
			source.indexOf("async function resolveWhatsappPhoneReleaseOperation"),
			source.indexOf("async function resolveWhatsappPhoneBillingOperation"),
		);
		expect(releaseResolution).toContain(
			"retry && row.releaseRequestMayHaveBeenSentAt !== null",
		);
		expect(releaseResolution).not.toContain(
			'retry && row.releasePhase !== "meta"',
		);
	});

	it("does not override a hold, queued retry, or live erasure lease", () => {
		const now = new Date("2026-07-28T12:00:00.000Z");
		expect(
			allowedOperatorResolutionActions({
				targetType: "tenant_erasure_job",
				status: "held",
				now,
			}),
		).toEqual([]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "tenant_erasure_job",
				status: "processing",
				leaseExpiresAt: new Date("2026-07-28T12:05:00.000Z"),
				now,
			}),
		).toEqual([]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "tenant_erasure_job",
				status: "processing",
				leaseExpiresAt: new Date("2026-07-28T11:59:00.000Z"),
				now,
			}),
		).toEqual(["retry"]);
		expect(
			allowedOperatorResolutionActions({
				targetType: "workspace_erasure_job",
				status: "failed",
				operatorRetryRequestedAt: now,
				now,
			}),
		).toEqual([]);
	});

	it("requires a bounded reason and keeps target/action vocabularies closed", () => {
		expect(
			AdminOperatorResolutionRequest.safeParse({
				action: "retry",
				reason: " ",
			}).success,
		).toBe(false);
		expect(
			AdminOperatorResolutionRequest.safeParse({
				action: "guess_succeeded",
				reason: "Provider evidence reviewed",
			}).success,
		).toBe(false);
		for (const targetType of Object.keys(
			OPERATOR_RESOLUTION_ACTIONS_BY_TARGET,
		)) {
			expect(
				AdminOperatorResolutionTargetType.safeParse(targetType).success,
			).toBe(true);
		}
	});

	it("stores only typed state summaries in a no-FK evidence relation", () => {
		const config = getTableConfig(operatorResolutionEvidence);
		expect(config.foreignKeys).toHaveLength(0);
		expect(config.columns.map(({ name }) => name)).not.toContain("payload");
		expect(config.columns.map(({ name }) => name)).not.toContain(
			"credential_ciphertext",
		);
	});

	it("terminalizes an abandoned Stripe receipt with digest-only reconciliation evidence", () => {
		const source = readFileSync(
			new URL("../services/operator-resolution.ts", import.meta.url),
			"utf8",
		);
		const stripeSource = source.slice(
			source.indexOf("async function resolveStripeEvent("),
			source.indexOf("async function resolveBillingOperation("),
		);
		expect(stripeSource).toContain(
			"providerReference must contain between 1 and 255 characters to abandon a Stripe receipt after reconciliation",
		);
		expect(stripeSource).toContain("await sha256Hex(providerReference)");
		expect(stripeSource).toContain(
			"reconciliation_reference_sha256: providerReferenceDigest",
		);
		expect(stripeSource).toContain("payload: {}");
		expect(stripeSource).toContain('lastErrorClass: "permanent"');
		expect(stripeSource).toContain("operatorRetryRequestedAt: null");
		expect(source).toContain("COALESCE(\n\t\t\t\t\tevent.organization_id");
		expect(source).toContain(
			"HAVING count(DISTINCT subscription.organization_id) = 1",
		);
		expect(source).toContain(
			"if (row.organizationId) return row.organizationId",
		);
		expect(source).toContain(".selectDistinct({");
		expect(source).toContain("subscriptions.length === 1");
		expect(stripeSource).not.toContain("provider_reference: providerReference");
	});

	it("resolves billing attempts, revisioned rebills, and audited write-offs", () => {
		const source = readFileSync(
			new URL("../services/operator-resolution.ts", import.meta.url),
			"utf8",
		);
		const billingSource = source.slice(
			source.indexOf("async function resolveBillingOperation"),
			source.indexOf("async function resolveTenantErasureJob"),
		);
		expect(billingSource).toContain("billingOperationAttempts");
		expect(billingSource).toContain('decision: "provider_effect_succeeded"');
		expect(billingSource).toContain('decision: "provider_effect_not_applied"');
		expect(billingSource).toContain(
			"const nextRevision = row.attemptRevision + 1",
		);
		expect(billingSource).toContain('status: "invoice_preparing"');
		expect(billingSource).toContain(
			'!["prepared", "requesting", "unknown"].includes(attempt.status)',
		);
		expect(billingSource).toContain('status: "written_off"');
		expect(billingSource).toContain('state: "written_off"');
		expect(billingSource).toContain("writeOffEvidence");
		expect(billingSource).not.toContain('state: "released"');
		expect(billingSource).not.toContain("releaseCount: 1");
	});

	it("surfaces late terminal Stripe proof only as a compensating decision", () => {
		expect(
			allowedOperatorResolutionActions({
				targetType: "billing_operation",
				status: "written_off",
				reasonCode:
					"late_provider_effect_requires_compensating_invoice_or_credit",
			}),
		).toEqual(["mark_succeeded", "abandon"]);
		const source = readFileSync(
			new URL("../services/operator-resolution.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("LATE_BILLING_EFFECT_ALERT_PREFIX");
		expect(source).toContain("LATE_BILLING_EFFECT_REASON_CODE");
		expect(source).toContain("LATE_BILLING_EFFECT_COMPENSATED_PREFIX");
		expect(source).toContain("LATE_BILLING_EFFECT_WAIVED_PREFIX");
		expect(source).toContain(
			"providerReference is required to record a compensating invoice or credit",
		);
		expect(source).toContain(
			"afterState: billingOperationState(resolvedAlert)",
		);
	});

	it("locks every target row and fences each mutation before evidence insert", async () => {
		const source = await Bun.file(
			new URL("../services/operator-resolution.ts", import.meta.url),
		).text();
		expect(
			source.match(/\.for\("update"\)/g)?.length ?? 0,
		).toBeGreaterThanOrEqual(23);
		const phoneBillingResolution = source.slice(
			source.indexOf("async function resolveWhatsappPhoneBillingOperation"),
			source.indexOf("function adCreationReasonCode"),
		);
		expect(phoneBillingResolution.match(/\.for\("update"\)/g)).toHaveLength(2);
		expect(phoneBillingResolution).toContain("whatsappPhoneBillingAttempts");
		expect(source).toContain("leaseToken");
		expect(source).toContain("syncDispatchGeneration");
		expect(source).toContain("sourceTokenVersion");
		expect(source).toContain("whatsapp_phone_provisioning_operation");
		expect(source).toContain("ambiguous_meta_deregistration");
		expect(source).toContain("resolveExternalSubjectCleanupJob");
		expect(source).toContain("resolveShortLinkCreation");
		expect(source).toContain("ambiguous_provider_create_candidate_recorded");
		expect(source).toContain("resolveAutomationConversionEvent");
		expect(source).toContain("resolveCustomerWebhookDelivery");
		expect(source).toContain("resolveToolJob");
		expect(source).toContain("provider_outcome_unknown_closed_window");
		expect(source).toContain('usageReservations.disposition, "unknown"');
		expect(source).toContain("pre_http_repair_exhausted");
		expect(source).toContain("http_outcome_unknown");
		expect(source).toContain("manualReviewUntil");
		expect(source).toContain("operatorIntervenedAt");
		expect(source).toContain("operatorRetryRequestedAt");
		expect(source).toContain(
			"Operator abandoned a known-not-sent delivery after review",
		);
		expect(source).toContain("operator_requested_external_cleanup_retry");
		expect(source).toContain(".insert(operatorResolutionEvidence)");
		expect(source.indexOf('.for("update")')).toBeLessThan(
			source.indexOf("return appendEvidence"),
		);
	});
});
