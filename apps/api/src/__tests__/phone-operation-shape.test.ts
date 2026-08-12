import { describe, expect, it } from "bun:test";
import {
	whatsappPhoneBillingAttempts,
	whatsappPhoneBillingOperations,
	whatsappPhoneNumbers,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";

function uniqueColumnSets(
	table: Parameters<typeof getTableConfig>[0],
): string[][] {
	return getTableConfig(table)
		.indexes.filter((index) => index.config.unique)
		.map((index) =>
			index.config.columns.flatMap((column) => {
				const name = (column as { name?: unknown }).name;
				return typeof name === "string" ? [name] : [];
			}),
		);
}

describe("WhatsApp phone operation shape", () => {
	it("keeps the durable phone entity free of retry-machine columns", () => {
		expect("provisioningState" in whatsappPhoneNumbers).toBe(false);
		expect("provisioningLeaseToken" in whatsappPhoneNumbers).toBe(false);
		expect("releaseState" in whatsappPhoneNumbers).toBe(false);
		expect("releaseLeaseToken" in whatsappPhoneNumbers).toBe(false);
		expect("releaseAccessTokenCiphertext" in whatsappPhoneNumbers).toBe(false);
	});

	it("models provisioning and release as independent one-per-phone lifecycles", () => {
		expect(
			uniqueColumnSets(whatsappPhoneProvisioningOperations),
		).toContainEqual(["phone_number_id"]);
		expect(uniqueColumnSets(whatsappPhoneReleaseOperations)).toContainEqual([
			"phone_number_id",
		]);

		for (const operationTable of [
			whatsappPhoneProvisioningOperations,
			whatsappPhoneReleaseOperations,
		]) {
			const parentForeignKey = getTableConfig(operationTable).foreignKeys.find(
				(foreignKey) =>
					foreignKey.reference().foreignTable === whatsappPhoneNumbers,
			);
			expect(parentForeignKey?.onDelete).toBe("cascade");
			expect(
				parentForeignKey?.reference().columns.map((column) => column.name),
			).toEqual(["phone_number_id", "organization_id"]);
		}

		expect(whatsappPhoneProvisioningOperations.provisioningState.name).toBe(
			"status",
		);
		expect(whatsappPhoneProvisioningOperations.provisioningPhase.name).toBe(
			"phase",
		);
		expect(
			whatsappPhoneProvisioningOperations.provisioningLeaseToken.name,
		).toBe("lease_token");
		expect(whatsappPhoneReleaseOperations.releaseState.name).toBe("status");
		expect(whatsappPhoneReleaseOperations.releasePhase.name).toBe("phase");
		expect(whatsappPhoneReleaseOperations.releaseLeaseToken.name).toBe(
			"lease_token",
		);
	});

	it("serializes the shared Stripe phone add-on by organization", async () => {
		expect(
			getTableConfig(whatsappPhoneBillingOperations)
				.columns.filter((column) => column.isUnique)
				.map((column) => column.name),
		).toContain("organization_id");
		expect(whatsappPhoneNumbers.stripePhoneSubscriptionId).toBeDefined();
		expect(whatsappPhoneBillingOperations.desiredQuantity.notNull).toBe(true);
		expect(whatsappPhoneBillingOperations.appliedQuantity.notNull).toBe(true);
		expect(
			whatsappPhoneBillingOperations.stripeCheckoutSessionId,
		).toBeDefined();
		expect(whatsappPhoneBillingOperations.idempotencyKey.notNull).toBe(true);
		expect(uniqueColumnSets(whatsappPhoneBillingAttempts)).toContainEqual([
			"phone_billing_operation_id",
			"revision",
		]);
		expect(
			getTableConfig(whatsappPhoneBillingAttempts).checks.map(
				(check) => check.name,
			),
		).toEqual(
			expect.arrayContaining([
				"wa_phone_billing_attempts_state_shape_check",
				"wa_phone_billing_attempts_timestamp_check",
			]),
		);
		expect(
			getTableConfig(whatsappPhoneBillingOperations).checks.map(
				(check) => check.name,
			),
		).toEqual(
			expect.arrayContaining([
				"wa_phone_billing_lease_check",
				"wa_phone_billing_boundary_check",
				"wa_phone_billing_applied_check",
			]),
		);

		const source = await Bun.file(
			new URL("../services/phone-number-operations.ts", import.meta.url),
		).text();
		expect(source).toContain("ensurePhoneBillingTarget");
		expect(source).toContain("markPhoneBillingBoundary");
		expect(source).toContain("stripe.subscriptions.cancel(");
		expect(source).not.toContain("stripe.subscriptionItems.del(");
		expect(source).toContain("STRIPE_SUBSCRIPTION_ROLES.phoneAddon");
		expect(source).toContain("await assertPhoneAddonPrice(stripe, priceId)");
		expect(source).toContain('price.currency !== "usd"');
		expect(source).toContain("phoneBillingOperationId");
		expect(source).toContain("phoneBillingRevision");
		expect(source).toContain("listPhoneBillingCheckoutSessions");
		expect(source).toContain("reconcileAmbiguousPhoneBilling");
		expect(source).toContain("resetPhoneBillingAfterConfirmedNotApplied");
		expect(source).toContain(
			'checkoutSession.status === "expired" && !checkoutSubscriptionId',
		);
		expect(source).toContain(
			"Canonical Stripe state confirmed the prior mutation was not applied",
		);
		const convergence = source.slice(
			source.indexOf("async function convergePhoneAddonBilling"),
			source.indexOf(
				"export async function wakePhoneAddonBillingReconciliation",
			),
		);
		expect(
			convergence.indexOf("claim.row.stripeCheckoutSessionId ??"),
		).toBeLessThan(convergence.indexOf("stripe.checkout.sessions.create("));
		expect(
			convergence.indexOf("listPhoneBillingCheckoutSessions"),
		).toBeLessThan(convergence.indexOf("stripe.checkout.sessions.create("));
		expect(source).toContain("insertPhoneBillingAttempt");
		expect(source).toContain("whatsappPhoneBillingAttempts.providerEvidence");
		expect(source).toContain(
			"await assertStripeOrganizationFence(tx, fence ?? null)",
		);
	});

	it("stores only the minimal durable provisioning source and shreds terminal detail", async () => {
		expect("provisioningRequest" in whatsappPhoneProvisioningOperations).toBe(
			false,
		);
		expect(
			whatsappPhoneProvisioningOperations.provisioningSourceAccountId.notNull,
		).toBe(true);
		expect(
			whatsappPhoneProvisioningOperations.provisioningSourceWabaId.notNull,
		).toBe(true);
		expect(
			whatsappPhoneProvisioningOperations.provisioningDetailExpiresAt,
		).toBeDefined();
		expect(
			whatsappPhoneProvisioningOperations.provisioningDetailRedactedAt,
		).toBeDefined();

		const schemaChecks = getTableConfig(
			whatsappPhoneProvisioningOperations,
		).checks.map((check) => check.name);
		expect(schemaChecks).toContain(
			"wa_phone_provisioning_detail_retention_check",
		);
		expect(
			getTableConfig(whatsappPhoneReleaseOperations).checks.map(
				(check) => check.name,
			),
		).toContain("wa_phone_release_completion_check");

		const source = await Bun.file(
			new URL("../services/phone-number-operations.ts", import.meta.url),
		).text();
		const provisioningCompletion = source.slice(
			source.indexOf("if (row.waPhoneNumberId"),
			source.indexOf("async function deferProvisioningReconciliation"),
		);
		expect(provisioningCompletion).toContain("provisioningVerifiedName: null");
		expect(provisioningCompletion).toContain(
			"provisioningDetailExpiresAt: new Date(",
		);
		expect(provisioningCompletion).not.toContain("stripeCheckoutUrl: null");

		const detailRedaction = source.slice(
			source.indexOf(
				"export async function redactExpiredPhoneProvisioningDetails",
			),
		);
		expect(detailRedaction).toContain("stripeCheckoutUrl: null");
		expect(detailRedaction).toContain(
			"PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES",
		);
		expect(detailRedaction).toContain("provisioningDetailExpiresAt");

		const releaseCompletion = source.slice(
			source.indexOf("const mandatoryComplete"),
			source.indexOf("export async function processDuePhoneReleases"),
		);
		expect(releaseCompletion).toContain("releaseSourceAccountId: null");
		expect(releaseCompletion).toContain("releaseSourceTokenVersion: null");
		expect(releaseCompletion).toContain("releaseAccessTokenCiphertext: null");
	});
});
