import {
	createDb,
	type Database,
	eq,
	generateId,
	organization,
	organizationSubscriptions,
	socialAccounts,
	whatsappPhoneBillingAttempts,
	whatsappPhoneBillingOperations,
	whatsappPhoneNumbers,
	whatsappPhoneProvisioningOperations,
	whatsappPhoneReleaseOperations,
} from "@relayapi/db";
import { and, count, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { GRAPH_BASE } from "../config/api-versions";
import {
	STRIPE_MANAGED_BY_KEY,
	STRIPE_MANAGED_BY_VALUE,
	STRIPE_SUBSCRIPTION_ROLE_KEY,
	STRIPE_SUBSCRIPTION_ROLES,
} from "../config/billing";
import { decryptAccountToken } from "../lib/account-token-crypto";
import {
	type DurableCredentialAuthorityAdmission,
	type DurableCredentialAuthoritySnapshot,
	revalidateDurableCredentialAuthority,
} from "../lib/durable-credential-authority";
import { durableOperationHashes } from "../lib/durable-operation";
import { readResponseJson } from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Env } from "../types";
import {
	adoptDurableUsageReservationInTransaction,
	settleLinkedDurableUsage,
	settleLinkedDurableUsageInTransaction,
} from "./durable-operation-usage";
import { createStripeClient } from "./stripe";
import {
	assertStripeOrganizationFence,
	type StripeOrganizationFence,
} from "./stripe-organization-lease";
import {
	findNumberOrderByCustomerReference,
	findOwnedPhoneNumber,
	orderNumber,
	releaseNumber,
	TelnyxError,
	telnyxPhoneNumberExists,
} from "./telnyx";
import type { UsageReservation } from "./usage-meter";

const PROVISIONING_LEASE_MS = 2 * 60_000;
const RELEASE_LEASE_MS = 5 * 60_000;
const MAX_NUMBERS_PER_ORG = 5;
const MAX_RECONCILIATION_ATTEMPTS = 5;
const META_TIMEOUT_MS = 5_000;
const META_RESPONSE_MAX_BYTES = 256 * 1024;
const PROVISIONING_DETAIL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PHONE_PAYMENT_RECHECK_MS = 60_000;
const PHONE_BILLING_LEASE_MS = 2 * 60_000;
const PHONE_ADDON_MONTHLY_PRICE_CENTS = 200;
const PHONE_ADDON_LIVE_STATUSES = new Set<Stripe.Subscription.Status>([
	"active",
	"trialing",
	"past_due",
	"unpaid",
	"incomplete",
	"paused",
]);
export const PHONE_PROVISIONING_DETAIL_REDACTION_BATCH = 1_000;
export const PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES = 10;

type PhoneEntity = typeof whatsappPhoneNumbers.$inferSelect;
type ProvisioningOperation =
	typeof whatsappPhoneProvisioningOperations.$inferSelect;
type ReleaseOperation = typeof whatsappPhoneReleaseOperations.$inferSelect;
type PhoneBillingOperation = typeof whatsappPhoneBillingOperations.$inferSelect;
type PhoneBillingAttempt = typeof whatsappPhoneBillingAttempts.$inferSelect;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ProvisioningProjection = Omit<
	ProvisioningOperation,
	"phoneNumberId" | "organizationId" | "createdAt" | "updatedAt"
>;
type ReleaseProjection = {
	[K in keyof Omit<
		ReleaseOperation,
		"phoneNumberId" | "organizationId" | "updatedAt"
	>]: ReleaseOperation[K] | null;
};
export type PhoneRow = PhoneEntity & ProvisioningProjection & ReleaseProjection;
type ReleaseReason = "user_requested" | "tenant_deleted";
const RELEASE_PRIOR_PHONE_STATUSES = [
	"purchasing",
	"pending_verification",
	"verified",
	"active",
	"releasing",
] as const;
type ReleasePriorPhoneStatus = (typeof RELEASE_PRIOR_PHONE_STATUSES)[number];

function isReleasePriorPhoneStatus(
	value: string,
): value is ReleasePriorPhoneStatus {
	return (RELEASE_PRIOR_PHONE_STATUSES as readonly string[]).includes(value);
}

function releaseAuthoritySnapshot(
	row: PhoneRow,
): DurableCredentialAuthoritySnapshot | null {
	if (row.releaseReason === "tenant_deleted") return null;
	if (
		!row.releaseAuthorityKeyId ||
		!row.releaseAuthorityPrincipalId ||
		!row.releaseAuthorityPrincipalType ||
		!row.releaseAuthorityCredentialVersion ||
		!row.releaseAuthorityAdmittedAt ||
		row.releaseAuthorityRequiresAllWorkspaceScope === null ||
		(row.releaseAuthorityPrincipalType === "dashboard_user" &&
			(!row.releaseAuthorityUserId ||
				!row.releaseAuthorityMemberId ||
				!row.releaseAuthoritySessionId)) ||
		(row.releaseAuthorityPrincipalType === "service" &&
			(row.releaseAuthorityUserId !== null ||
				row.releaseAuthorityMemberId !== null ||
				row.releaseAuthoritySessionId !== null)) ||
		row.releaseAuthorityRevision === null
	) {
		throw new Error("User-requested phone release lost its authority snapshot");
	}
	return {
		organizationId: row.organizationId,
		keyId: row.releaseAuthorityKeyId,
		principalId: row.releaseAuthorityPrincipalId,
		principalType: row.releaseAuthorityPrincipalType,
		userId: row.releaseAuthorityUserId,
		authorityMemberId: row.releaseAuthorityMemberId,
		authoritySessionId: row.releaseAuthoritySessionId,
		authorityWorkspaceId: row.releaseAuthorityWorkspaceId,
		authorityRequiresAllWorkspaceScope:
			row.releaseAuthorityRequiresAllWorkspaceScope,
		credentialVersion: row.releaseAuthorityCredentialVersion,
		admittedAt: row.releaseAuthorityAdmittedAt,
		revision: row.releaseAuthorityRevision,
	};
}

function releaseAuthorityValues(
	snapshot: DurableCredentialAuthoritySnapshot | null,
) {
	return {
		releaseAuthorityKeyId: snapshot?.keyId ?? null,
		releaseAuthorityPrincipalId: snapshot?.principalId ?? null,
		releaseAuthorityPrincipalType: snapshot?.principalType ?? null,
		releaseAuthorityUserId: snapshot?.userId ?? null,
		releaseAuthorityMemberId: snapshot?.authorityMemberId ?? null,
		releaseAuthoritySessionId: snapshot?.authoritySessionId ?? null,
		releaseAuthorityWorkspaceId: snapshot?.authorityWorkspaceId ?? null,
		releaseAuthorityRequiresAllWorkspaceScope:
			snapshot?.authorityRequiresAllWorkspaceScope ?? null,
		releaseAuthorityCredentialVersion: snapshot?.credentialVersion ?? null,
		releaseAuthorityAdmittedAt: snapshot?.admittedAt ?? null,
		releaseAuthorityRevision: snapshot?.revision ?? null,
	};
}

function sameReleaseAuthority(
	row: PhoneRow,
	snapshot: DurableCredentialAuthoritySnapshot,
): boolean {
	return (
		row.releaseAuthorityKeyId === snapshot.keyId &&
		row.releaseAuthorityPrincipalId === snapshot.principalId &&
		row.releaseAuthorityPrincipalType === snapshot.principalType &&
		row.releaseAuthorityUserId === snapshot.userId &&
		row.releaseAuthorityMemberId === snapshot.authorityMemberId &&
		row.releaseAuthoritySessionId === snapshot.authoritySessionId &&
		row.releaseAuthorityWorkspaceId === snapshot.authorityWorkspaceId &&
		row.releaseAuthorityRequiresAllWorkspaceScope ===
			snapshot.authorityRequiresAllWorkspaceScope &&
		row.releaseAuthorityCredentialVersion === snapshot.credentialVersion
	);
}

interface ProvisioningRequest {
	account_id: string;
	waba_id: string;
	verified_name: string;
	country: string;
	area_code?: string;
}

async function provisioningHashes(
	organizationId: string,
	operationKey: string | undefined,
	request: ProvisioningRequest,
): Promise<{ operationKeyHash: string; requestHash: string }> {
	if (!operationKey) {
		throw new PhoneOperationError(
			"IDEMPOTENCY_KEY_REQUIRED",
			"Idempotency-Key is required for phone-number purchase",
		);
	}
	return durableOperationHashes(
		organizationId,
		"whatsapp_phone_purchase",
		operationKey,
		request,
	);
}

export async function findPhoneProvisioningOperation(
	db: Database,
	options: {
		organizationId: string;
		operationKey: string | undefined;
		request: ProvisioningRequest;
	},
): Promise<PhoneRow | null> {
	const { operationKeyHash, requestHash } = await provisioningHashes(
		options.organizationId,
		options.operationKey,
		options.request,
	);
	const [existing] = await db
		.select({
			phoneNumberId: whatsappPhoneProvisioningOperations.phoneNumberId,
		})
		.from(whatsappPhoneProvisioningOperations)
		.where(
			and(
				eq(
					whatsappPhoneProvisioningOperations.organizationId,
					options.organizationId,
				),
				eq(
					whatsappPhoneProvisioningOperations.provisioningOperationKeyHash,
					operationKeyHash,
				),
			),
		)
		.limit(1);
	if (!existing) return null;
	const operation = await getPhoneRow(db, existing.phoneNumberId);
	if (!operation) {
		throw new Error("Phone provisioning operation lost its phone parent");
	}
	if (operation.provisioningRequestHash !== requestHash) {
		throw new PhoneOperationError(
			"IDEMPOTENCY_KEY_REUSED",
			"Idempotency-Key was already used with a different purchase request",
		);
	}
	return operation;
}

export class PhoneOperationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "PhoneOperationError";
	}
}

function delayForAttempt(attempt: number): number {
	return Math.min(6 * 60 * 60_000, 2 ** Math.min(attempt, 8) * 60_000);
}

function normalizePhone(value: string): string {
	return value.replace(/\D/g, "");
}

function requireTelnyxApiKey(env: Env): string {
	if (!env.TELNYX_API_KEY) {
		throw new PhoneOperationError(
			"CONFIG_ERROR",
			"Telnyx phone-number operations are not configured",
		);
	}
	return env.TELNYX_API_KEY;
}

function isSelfHosted(env: Env): boolean {
	return env.DEPLOYMENT_MODE === "self_hosted";
}

function subscriptionId(value: string | { id: string } | null): string | null {
	return typeof value === "string" ? value : (value?.id ?? null);
}

function isPhoneAddonSubscription(
	subscription: Pick<Stripe.Subscription, "metadata">,
	organizationId: string,
): boolean {
	return (
		subscription.metadata?.[STRIPE_MANAGED_BY_KEY] ===
			STRIPE_MANAGED_BY_VALUE &&
		subscription.metadata?.[STRIPE_SUBSCRIPTION_ROLE_KEY] ===
			STRIPE_SUBSCRIPTION_ROLES.phoneAddon &&
		subscription.metadata.organizationId === organizationId
	);
}

function phoneBillingMetadata(
	organizationId: string,
	operationId: string,
	revision: number,
): Record<string, string> {
	return {
		type: "wa_phone_addon",
		organizationId,
		[STRIPE_MANAGED_BY_KEY]: STRIPE_MANAGED_BY_VALUE,
		[STRIPE_SUBSCRIPTION_ROLE_KEY]: STRIPE_SUBSCRIPTION_ROLES.phoneAddon,
		phoneBillingOperationId: operationId,
		phoneBillingRevision: String(revision),
	};
}

function isPhoneBillingCheckoutSession(
	session: Pick<Stripe.Checkout.Session, "customer" | "metadata" | "mode">,
	claim: PhoneBillingClaim,
): boolean {
	return (
		subscriptionId(session.customer) === claim.row.stripeCustomerId &&
		session.mode === "subscription" &&
		session.metadata?.type === "wa_phone_addon" &&
		session.metadata?.organizationId === claim.row.organizationId &&
		session.metadata?.[STRIPE_MANAGED_BY_KEY] === STRIPE_MANAGED_BY_VALUE &&
		session.metadata?.[STRIPE_SUBSCRIPTION_ROLE_KEY] ===
			STRIPE_SUBSCRIPTION_ROLES.phoneAddon &&
		session.metadata?.phoneBillingOperationId === claim.row.id &&
		session.metadata?.phoneBillingRevision === String(claim.row.revision)
	);
}

function phoneAddonItem(
	subscription: Stripe.Subscription,
	priceId: string,
): Stripe.SubscriptionItem {
	const matches = subscription.items.data.filter(
		(item) => item.price.id === priceId,
	);
	if (matches.length !== 1 || subscription.items.data.length !== 1) {
		throw new PhoneOperationError(
			"MANUAL_REVIEW_REQUIRED",
			"The phone add-on subscription does not contain exactly one server-owned phone price",
		);
	}
	const item = matches[0];
	if (!item) throw new Error("Phone add-on item disappeared");
	return item;
}

async function assertPhoneAddonPrice(
	stripe: Stripe,
	priceId: string,
): Promise<void> {
	const price = await stripe.prices.retrieve(priceId);
	if (
		!price.active ||
		price.currency !== "usd" ||
		price.unit_amount !== PHONE_ADDON_MONTHLY_PRICE_CENTS ||
		price.type !== "recurring" ||
		price.recurring?.interval !== "month" ||
		price.recurring.interval_count !== 1
	) {
		throw new PhoneOperationError(
			"CONFIG_ERROR",
			"The server-owned phone add-on price must be an active USD $2.00 monthly recurring price",
		);
	}
}

async function findPhoneAddonSubscription(
	stripe: Stripe,
	customerId: string,
	organizationId: string,
): Promise<Stripe.Subscription | null> {
	let startingAfter: string | undefined;
	const matches: Stripe.Subscription[] = [];
	for (;;) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			status: "all",
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		for (const candidate of page.data) {
			if (
				PHONE_ADDON_LIVE_STATUSES.has(candidate.status) &&
				isPhoneAddonSubscription(candidate, organizationId)
			) {
				matches.push(candidate);
			}
		}
		if (!page.has_more) break;
		const last = page.data.at(-1);
		if (!last) break;
		startingAfter = last.id;
	}
	if (matches.length > 1) {
		throw new PhoneOperationError(
			"MANUAL_REVIEW_REQUIRED",
			"Multiple live phone add-on subscriptions require operator reconciliation",
		);
	}
	return matches[0] ?? null;
}

function expandedInvoice(
	value: string | Stripe.Invoice | null,
): Stripe.Invoice | null {
	return typeof value === "string" ? null : value;
}

interface PhoneBillingClaim {
	row: PhoneBillingOperation;
	leaseToken: number;
	previousState: PhoneBillingOperation["state"];
}

interface PhoneBillingConvergence {
	state: "applied" | "waiting_payment";
	stripeSubscriptionId: string | null;
	stripeSubscriptionItemId: string | null;
	stripeCheckoutSessionId: string | null;
	checkoutUrl: string | null;
}

function phoneBillingIdempotencyKey(
	organizationId: string,
	revision: number,
	desiredQuantity: number,
): string {
	return `wa-phone-addon:${organizationId}:r${revision}:q${desiredQuantity}`;
}

async function insertPhoneBillingAttempt(
	tx: Transaction,
	operation: PhoneBillingOperation,
): Promise<void> {
	if (!operation.stripeCustomerId) {
		throw new Error("Phone billing attempt requires a Stripe customer");
	}
	await tx.insert(whatsappPhoneBillingAttempts).values({
		organizationId: operation.organizationId,
		phoneBillingOperationId: operation.id,
		revision: operation.revision,
		status: "prepared",
		desiredQuantity: operation.desiredQuantity,
		priorAppliedQuantity: operation.appliedQuantity,
		stripeCustomerId: operation.stripeCustomerId,
		idempotencyKey: operation.idempotencyKey,
	});
}

async function currentPhoneBillingAttempt(
	tx: Transaction,
	operation: PhoneBillingOperation,
): Promise<PhoneBillingAttempt> {
	const [attempt] = await tx
		.select()
		.from(whatsappPhoneBillingAttempts)
		.where(
			and(
				eq(whatsappPhoneBillingAttempts.phoneBillingOperationId, operation.id),
				eq(
					whatsappPhoneBillingAttempts.organizationId,
					operation.organizationId,
				),
				eq(whatsappPhoneBillingAttempts.revision, operation.revision),
			),
		)
		.for("update")
		.limit(1);
	if (!attempt) throw new Error("Phone billing attempt evidence is missing");
	return attempt;
}

/**
 * Snapshot the current count into the single organization authority. Active or
 * ambiguous work is never superseded: the persisted phone rows remain the next
 * desired-state source and a later pass advances the revision after the current
 * provider outcome is known.
 */
async function ensurePhoneBillingTarget(
	db: Database,
	organizationId: string,
	stripeCustomerId: string,
): Promise<{
	operation: PhoneBillingOperation;
	actualDesiredQuantity: number;
}> {
	return db.transaction(async (tx) => {
		const [lockedOrganization] = await tx
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.id, organizationId))
			.for("update")
			.limit(1);
		if (!lockedOrganization) {
			throw new PhoneOperationError(
				"NOT_FOUND",
				"Organization no longer exists for phone billing",
			);
		}

		const [quantity] = await tx
			.select({ value: count() })
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.organizationId, organizationId),
					inArray(whatsappPhoneNumbers.status, [
						"purchasing",
						"pending_verification",
						"verified",
						"active",
					]),
				),
			);
		const actualDesiredQuantity = quantity?.value ?? 0;
		const [existing] = await tx
			.select()
			.from(whatsappPhoneBillingOperations)
			.where(eq(whatsappPhoneBillingOperations.organizationId, organizationId))
			.for("update")
			.limit(1);

		if (!existing) {
			const revision = 1;
			const [inserted] = await tx
				.insert(whatsappPhoneBillingOperations)
				.values({
					organizationId,
					state: "pending",
					desiredQuantity: actualDesiredQuantity,
					appliedQuantity: 0,
					stripeCustomerId,
					idempotencyKey: phoneBillingIdempotencyKey(
						organizationId,
						revision,
						actualDesiredQuantity,
					),
					revision,
					nextAttemptAt: new Date(),
				})
				.returning();
			if (!inserted)
				throw new Error("Failed to create phone billing authority");
			await insertPhoneBillingAttempt(tx, inserted);
			return { operation: inserted, actualDesiredQuantity };
		}

		const blocksRetarget = [
			"processing",
			"request_may_have_been_sent",
			"unknown",
			"waiting_payment",
			"manual_review",
		].includes(existing.state);
		if (
			blocksRetarget ||
			(existing.desiredQuantity === actualDesiredQuantity &&
				existing.stripeCustomerId === stripeCustomerId)
		) {
			return { operation: existing, actualDesiredQuantity };
		}

		const retargetedAt = new Date();
		if (existing.state === "pending") {
			const attempt = await currentPhoneBillingAttempt(tx, existing);
			const [closed] = await tx
				.update(whatsappPhoneBillingAttempts)
				.set({
					status: "confirmed_not_applied",
					providerEvidence: {
						reason: "superseded_before_provider_boundary",
					},
					resolvedAt: retargetedAt,
				})
				.where(
					and(
						eq(whatsappPhoneBillingAttempts.id, attempt.id),
						eq(whatsappPhoneBillingAttempts.status, "prepared"),
					),
				)
				.returning({ id: whatsappPhoneBillingAttempts.id });
			if (!closed) throw new Error("Phone billing attempt close fence lost");
		}

		const revision = existing.revision + 1;
		const [updated] = await tx
			.update(whatsappPhoneBillingOperations)
			.set({
				state: "pending",
				desiredQuantity: actualDesiredQuantity,
				stripeCustomerId,
				idempotencyKey: phoneBillingIdempotencyKey(
					organizationId,
					revision,
					actualDesiredQuantity,
				),
				revision,
				leaseExpiresAt: null,
				requestMayHaveBeenSentAt: null,
				stripeCheckoutSessionId: null,
				nextAttemptAt: retargetedAt,
				lastError: null,
				appliedAt: null,
				updatedAt: retargetedAt,
			})
			.where(eq(whatsappPhoneBillingOperations.id, existing.id))
			.returning();
		if (!updated) throw new Error("Failed to advance phone billing target");
		await insertPhoneBillingAttempt(tx, updated);
		return { operation: updated, actualDesiredQuantity };
	});
}

async function claimPhoneBillingOperation(
	db: Database,
	operation: PhoneBillingOperation,
): Promise<PhoneBillingClaim | null> {
	const now = new Date();
	const [claimed] = await db
		.update(whatsappPhoneBillingOperations)
		.set({
			state: "processing",
			leaseToken: sql`${whatsappPhoneBillingOperations.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + PHONE_BILLING_LEASE_MS),
			requestMayHaveBeenSentAt: null,
			attempts: sql`${whatsappPhoneBillingOperations.attempts} + 1`,
			lastError: null,
			appliedAt: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneBillingOperations.id, operation.id),
				eq(whatsappPhoneBillingOperations.revision, operation.revision),
				or(
					eq(whatsappPhoneBillingOperations.state, "pending"),
					eq(whatsappPhoneBillingOperations.state, "waiting_payment"),
					and(
						eq(whatsappPhoneBillingOperations.state, "processing"),
						lte(whatsappPhoneBillingOperations.leaseExpiresAt, now),
						isNull(whatsappPhoneBillingOperations.requestMayHaveBeenSentAt),
					),
				),
			),
		)
		.returning();
	if (!claimed) return null;
	return {
		row: claimed,
		leaseToken: claimed.leaseToken,
		previousState: operation.state,
	};
}

async function markPhoneBillingBoundary(
	db: Database,
	claim: PhoneBillingClaim,
): Promise<void> {
	const now = new Date();
	await db.transaction(async (tx) => {
		const attempt = await currentPhoneBillingAttempt(tx, claim.row);
		const updated = await tx
			.update(whatsappPhoneBillingOperations)
			.set({
				state: "request_may_have_been_sent",
				requestMayHaveBeenSentAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneBillingOperations.id, claim.row.id),
					eq(whatsappPhoneBillingOperations.revision, claim.row.revision),
					eq(whatsappPhoneBillingOperations.leaseToken, claim.leaseToken),
					eq(whatsappPhoneBillingOperations.state, "processing"),
				),
			)
			.returning({ id: whatsappPhoneBillingOperations.id });
		if (updated.length !== 1) {
			throw new PhoneOperationError(
				"OPERATION_LEASE_LOST",
				"Phone billing lease was lost before the Stripe request",
			);
		}
		const [attemptUpdated] = await tx
			.update(whatsappPhoneBillingAttempts)
			.set({ status: "requesting", requestMayHaveBeenSentAt: now })
			.where(
				and(
					eq(whatsappPhoneBillingAttempts.id, attempt.id),
					eq(whatsappPhoneBillingAttempts.status, "prepared"),
				),
			)
			.returning({ id: whatsappPhoneBillingAttempts.id });
		if (!attemptUpdated) throw new Error("Phone billing attempt boundary lost");
	});
}

async function finishPhoneBillingClaim(
	db: Database,
	claim: PhoneBillingClaim,
	values: {
		state: "applied" | "waiting_payment";
		appliedQuantity: number;
		stripeCheckoutSessionId?: string | null;
		stripeSubscriptionId: string | null;
		stripeSubscriptionItemId: string | null;
		stripeLatestInvoiceId: string | null;
		lastError?: string | null;
	},
): Promise<void> {
	const now = new Date();
	await db.transaction(async (tx) => {
		const attempt = await currentPhoneBillingAttempt(tx, claim.row);
		const checkoutSessionId =
			values.stripeCheckoutSessionId === undefined
				? claim.row.stripeCheckoutSessionId
				: values.stripeCheckoutSessionId;
		const [updated] = await tx
			.update(whatsappPhoneBillingOperations)
			.set({
				state: values.state,
				appliedQuantity: values.appliedQuantity,
				stripeCheckoutSessionId: checkoutSessionId,
				stripeSubscriptionId: values.stripeSubscriptionId,
				stripeSubscriptionItemId: values.stripeSubscriptionItemId,
				stripeLatestInvoiceId: values.stripeLatestInvoiceId,
				leaseExpiresAt: null,
				requestMayHaveBeenSentAt: null,
				nextAttemptAt: new Date(
					now.getTime() +
						(values.state === "waiting_payment" ? PHONE_PAYMENT_RECHECK_MS : 0),
				),
				lastError: values.lastError ?? null,
				appliedAt: values.state === "applied" ? now : null,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneBillingOperations.id, claim.row.id),
					eq(whatsappPhoneBillingOperations.revision, claim.row.revision),
					eq(whatsappPhoneBillingOperations.leaseToken, claim.leaseToken),
					inArray(whatsappPhoneBillingOperations.state, [
						"processing",
						"request_may_have_been_sent",
					]),
				),
			)
			.returning({ id: whatsappPhoneBillingOperations.id });
		if (!updated) throw new Error("Phone billing completion fence lost");
		const [attemptUpdated] = await tx
			.update(whatsappPhoneBillingAttempts)
			.set({
				status: values.state,
				stripeCheckoutSessionId:
					checkoutSessionId ?? attempt.stripeCheckoutSessionId,
				stripeSubscriptionId:
					values.stripeSubscriptionId ?? attempt.stripeSubscriptionId,
				stripeSubscriptionItemId:
					values.stripeSubscriptionItemId ?? attempt.stripeSubscriptionItemId,
				stripeLatestInvoiceId:
					values.stripeLatestInvoiceId ?? attempt.stripeLatestInvoiceId,
				providerEvidence: sql`COALESCE(${whatsappPhoneBillingAttempts.providerEvidence}, '{}'::jsonb)
					|| jsonb_build_object(${values.state === "applied" ? "appliedOutcome" : "waitingPaymentObserved"}, true)
					|| CASE WHEN ${values.state} = 'applied'
						THEN jsonb_build_object('finalAppliedQuantity', ${values.appliedQuantity})
						ELSE '{}'::jsonb END`,
				resolvedAt: values.state === "applied" ? now : null,
			})
			.where(
				and(
					eq(whatsappPhoneBillingAttempts.id, attempt.id),
					inArray(whatsappPhoneBillingAttempts.status, [
						"prepared",
						"requesting",
						"unknown",
						"waiting_payment",
					]),
				),
			)
			.returning({ id: whatsappPhoneBillingAttempts.id });
		if (!attemptUpdated)
			throw new Error("Phone billing attempt finish fence lost");

		if (values.stripeSubscriptionId && values.stripeSubscriptionItemId) {
			await tx
				.update(whatsappPhoneNumbers)
				.set({
					stripePhoneSubscriptionId: values.stripeSubscriptionId,
					stripeSubscriptionItemId: values.stripeSubscriptionItemId,
					updatedAt: now,
				})
				.where(
					and(
						eq(whatsappPhoneNumbers.organizationId, claim.row.organizationId),
						inArray(whatsappPhoneNumbers.status, [
							"purchasing",
							"pending_verification",
							"verified",
							"active",
						]),
					),
				);
		}
	});
}

async function failPhoneBillingClaim(
	db: Database,
	claim: PhoneBillingClaim,
	error: unknown,
	boundaryOpen: boolean,
): Promise<void> {
	const manual =
		error instanceof PhoneOperationError &&
		error.code === "MANUAL_REVIEW_REQUIRED";
	const reconciliationExhausted =
		boundaryOpen && claim.row.attempts >= MAX_RECONCILIATION_ATTEMPTS;
	const nextState =
		manual || reconciliationExhausted
			? "manual_review"
			: boundaryOpen
				? "unknown"
				: claim.previousState === "waiting_payment"
					? "waiting_payment"
					: "pending";
	const message = error instanceof Error ? error.message : String(error);
	await db.transaction(async (tx) => {
		const attempt = await currentPhoneBillingAttempt(tx, claim.row);
		const [updated] = await tx
			.update(whatsappPhoneBillingOperations)
			.set({
				state: nextState,
				leaseExpiresAt: null,
				...(boundaryOpen ? {} : { requestMayHaveBeenSentAt: null }),
				nextAttemptAt: new Date(
					Date.now() + delayForAttempt(claim.row.attempts + 1),
				),
				lastError: message,
				appliedAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(whatsappPhoneBillingOperations.id, claim.row.id),
					eq(whatsappPhoneBillingOperations.revision, claim.row.revision),
					eq(whatsappPhoneBillingOperations.leaseToken, claim.leaseToken),
					inArray(whatsappPhoneBillingOperations.state, [
						"processing",
						"request_may_have_been_sent",
					]),
				),
			)
			.returning({ id: whatsappPhoneBillingOperations.id });
		if (!updated) return;
		if (nextState === "unknown" || nextState === "manual_review") {
			const [attemptUpdated] = await tx
				.update(whatsappPhoneBillingAttempts)
				.set({
					status: nextState,
					providerEvidence: sql`COALESCE(${whatsappPhoneBillingAttempts.providerEvidence}, '{}'::jsonb)
						|| CASE
							WHEN COALESCE(${whatsappPhoneBillingAttempts.providerEvidence}, '{}'::jsonb) ? 'firstAmbiguousError'
							THEN '{}'::jsonb
							ELSE jsonb_build_object('firstAmbiguousError', ${message})
						END
						|| CASE WHEN ${nextState} = 'manual_review'
							THEN jsonb_build_object('manualReviewReason', ${message})
							ELSE '{}'::jsonb END`,
				})
				.where(
					and(
						eq(whatsappPhoneBillingAttempts.id, attempt.id),
						inArray(whatsappPhoneBillingAttempts.status, [
							"prepared",
							"requesting",
							"unknown",
							"waiting_payment",
						]),
					),
				)
				.returning({ id: whatsappPhoneBillingAttempts.id });
			if (!attemptUpdated)
				throw new Error("Phone billing attempt failure fence lost");
		}
	});
}

async function claimPhoneBillingReconciliation(
	db: Database,
	operation: PhoneBillingOperation,
): Promise<PhoneBillingClaim | null> {
	const now = new Date();
	const [claimed] = await db
		.update(whatsappPhoneBillingOperations)
		.set({
			state: "processing",
			leaseToken: sql`${whatsappPhoneBillingOperations.leaseToken} + 1`,
			leaseExpiresAt: new Date(now.getTime() + PHONE_BILLING_LEASE_MS),
			attempts: sql`${whatsappPhoneBillingOperations.attempts} + 1`,
			lastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneBillingOperations.id, operation.id),
				eq(whatsappPhoneBillingOperations.revision, operation.revision),
				eq(whatsappPhoneBillingOperations.leaseToken, operation.leaseToken),
				or(
					eq(whatsappPhoneBillingOperations.state, "unknown"),
					and(
						eq(
							whatsappPhoneBillingOperations.state,
							"request_may_have_been_sent",
						),
						lte(whatsappPhoneBillingOperations.leaseExpiresAt, now),
					),
				),
			),
		)
		.returning();
	return claimed
		? {
				row: claimed,
				leaseToken: claimed.leaseToken,
				previousState: operation.state,
			}
		: null;
}

async function listPhoneBillingCheckoutSessions(
	stripe: Stripe,
	claim: PhoneBillingClaim,
): Promise<Stripe.Checkout.Session[]> {
	if (!claim.row.stripeCustomerId) return [];
	let startingAfter: string | undefined;
	const matches: Stripe.Checkout.Session[] = [];
	for (;;) {
		const page = await stripe.checkout.sessions.list({
			customer: claim.row.stripeCustomerId,
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		matches.push(
			...page.data.filter((session) =>
				isPhoneBillingCheckoutSession(session, claim),
			),
		);
		if (!page.has_more) break;
		const last = page.data.at(-1);
		if (!last) break;
		startingAfter = last.id;
	}
	return matches;
}

async function retrievePhoneSubscription(
	stripe: Stripe,
	id: string | null,
): Promise<Stripe.Subscription | null> {
	if (!id) return null;
	try {
		return await stripe.subscriptions.retrieve(id, {
			expand: ["latest_invoice"],
		});
	} catch (error) {
		if (
			error instanceof Stripe.errors.StripeInvalidRequestError &&
			error.statusCode === 404
		) {
			return null;
		}
		throw error;
	}
}

async function resetPhoneBillingAfterConfirmedNotApplied(
	db: Database,
	claim: PhoneBillingClaim,
): Promise<void> {
	const now = new Date();
	const revision = claim.row.revision + 1;
	await db.transaction(async (tx) => {
		const attempt = await currentPhoneBillingAttempt(tx, claim.row);
		const [attemptUpdated] = await tx
			.update(whatsappPhoneBillingAttempts)
			.set({
				status: "confirmed_not_applied",
				providerEvidence: sql`COALESCE(${whatsappPhoneBillingAttempts.providerEvidence}, '{}'::jsonb)
					|| jsonb_build_object(
						'confirmedNotApplied', true,
						'appliedQuantity', ${claim.row.appliedQuantity}
					)`,
				resolvedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneBillingAttempts.id, attempt.id),
					inArray(whatsappPhoneBillingAttempts.status, [
						"prepared",
						"requesting",
						"unknown",
						"waiting_payment",
						"manual_review",
					]),
				),
			)
			.returning({ id: whatsappPhoneBillingAttempts.id });
		if (!attemptUpdated)
			throw new Error("Phone billing attempt resolution fence lost");
		const [updated] = await tx
			.update(whatsappPhoneBillingOperations)
			.set({
				state: "pending",
				stripeCheckoutSessionId: null,
				idempotencyKey: phoneBillingIdempotencyKey(
					claim.row.organizationId,
					revision,
					claim.row.desiredQuantity,
				),
				revision,
				leaseExpiresAt: null,
				requestMayHaveBeenSentAt: null,
				attempts: 0,
				nextAttemptAt: now,
				lastError:
					"Canonical Stripe state confirmed the prior mutation was not applied",
				appliedAt: null,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneBillingOperations.id, claim.row.id),
					eq(whatsappPhoneBillingOperations.revision, claim.row.revision),
					eq(whatsappPhoneBillingOperations.leaseToken, claim.leaseToken),
					eq(whatsappPhoneBillingOperations.state, "processing"),
				),
			)
			.returning();
		if (!updated) throw new Error("Phone billing reconciliation fence lost");
		await insertPhoneBillingAttempt(tx, updated);
	});
}

async function reconcileAmbiguousPhoneBilling(
	env: Env,
	db: Database,
	operation: PhoneBillingOperation,
): Promise<PhoneBillingConvergence> {
	const claim = await claimPhoneBillingReconciliation(db, operation);
	if (!claim) {
		throw new PhoneOperationError(
			"UNKNOWN_EXTERNAL_OUTCOME",
			"The Stripe phone billing outcome is being reconciled",
		);
	}
	try {
		const priceId = env.STRIPE_WA_PHONE_PRICE_ID;
		if (!priceId || !claim.row.stripeCustomerId) {
			throw new PhoneOperationError(
				"CONFIG_ERROR",
				"Hosted phone billing reconciliation is not configured",
			);
		}
		const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
		await assertPhoneAddonPrice(stripe, priceId);
		const sessions = await listPhoneBillingCheckoutSessions(stripe, claim);
		if (sessions.length > 1) {
			throw new PhoneOperationError(
				"MANUAL_REVIEW_REQUIRED",
				"Multiple Checkout Sessions exist for one phone billing revision",
			);
		}
		const session = sessions[0] ?? null;
		let subscription = await retrievePhoneSubscription(
			stripe,
			subscriptionId(session?.subscription ?? null) ??
				claim.row.stripeSubscriptionId,
		);
		if (!subscription) {
			const discovered = await findPhoneAddonSubscription(
				stripe,
				claim.row.stripeCustomerId,
				claim.row.organizationId,
			);
			subscription = await retrievePhoneSubscription(
				stripe,
				discovered?.id ?? null,
			);
		}

		if (subscription) {
			if (!isPhoneAddonSubscription(subscription, claim.row.organizationId)) {
				throw new PhoneOperationError(
					"MANUAL_REVIEW_REQUIRED",
					"Canonical Stripe state points at a non-phone subscription",
				);
			}
			const item = phoneAddonItem(subscription, priceId);
			const currentQuantity =
				subscription.status === "canceled" ? 0 : (item.quantity ?? 0);
			const invoice = expandedInvoice(subscription.latest_invoice);
			const increasing = claim.row.desiredQuantity > claim.row.appliedQuantity;
			if (subscription.pending_update) {
				await finishPhoneBillingClaim(db, claim, {
					state: "waiting_payment",
					appliedQuantity: currentQuantity,
					stripeCheckoutSessionId: session?.id ?? null,
					stripeSubscriptionId: subscription.id,
					stripeSubscriptionItemId: item.id,
					stripeLatestInvoiceId: invoice?.id ?? null,
					lastError:
						"Canonical phone add-on quantity update is awaiting payment",
				});
				return {
					state: "waiting_payment",
					stripeSubscriptionId: subscription.id,
					stripeSubscriptionItemId: item.id,
					stripeCheckoutSessionId: session?.id ?? null,
					checkoutUrl: invoice?.hosted_invoice_url ?? session?.url ?? null,
				};
			}
			const matchesDesired = currentQuantity === claim.row.desiredQuantity;
			const ready =
				matchesDesired &&
				(claim.row.desiredQuantity === 0
					? subscription.status === "canceled"
					: increasing
						? subscription.status === "active" && invoice?.status === "paid"
						: true);
			if (matchesDesired) {
				await finishPhoneBillingClaim(db, claim, {
					state: ready ? "applied" : "waiting_payment",
					appliedQuantity: currentQuantity,
					stripeCheckoutSessionId: session?.id ?? null,
					stripeSubscriptionId: subscription.id,
					stripeSubscriptionItemId: item.id,
					stripeLatestInvoiceId: invoice?.id ?? null,
					lastError: ready
						? null
						: "Canonical phone add-on state is awaiting payment",
				});
				return {
					state: ready ? "applied" : "waiting_payment",
					stripeSubscriptionId: subscription.id,
					stripeSubscriptionItemId: item.id,
					stripeCheckoutSessionId: session?.id ?? null,
					checkoutUrl: ready
						? null
						: (invoice?.hosted_invoice_url ?? session?.url ?? null),
				};
			}
			if (currentQuantity === claim.row.appliedQuantity) {
				await resetPhoneBillingAfterConfirmedNotApplied(db, claim);
				throw new PhoneOperationError(
					"IN_PROGRESS",
					"Canonical Stripe state confirmed the prior phone mutation was not applied; a new fenced revision is pending",
				);
			}
			throw new PhoneOperationError(
				"MANUAL_REVIEW_REQUIRED",
				"Canonical phone add-on quantity matches neither the applied nor desired quantity",
			);
		}

		if (session?.status === "open") {
			await finishPhoneBillingClaim(db, claim, {
				state: "waiting_payment",
				appliedQuantity: claim.row.appliedQuantity,
				stripeCheckoutSessionId: session.id,
				stripeSubscriptionId: null,
				stripeSubscriptionItemId: null,
				stripeLatestInvoiceId: null,
				lastError: "Canonical phone add-on Checkout is awaiting payment",
			});
			return {
				state: "waiting_payment",
				stripeSubscriptionId: null,
				stripeSubscriptionItemId: null,
				stripeCheckoutSessionId: session.id,
				checkoutUrl: session.url,
			};
		}
		if (session?.status === "expired") {
			await resetPhoneBillingAfterConfirmedNotApplied(db, claim);
			throw new PhoneOperationError(
				"IN_PROGRESS",
				"The ambiguous Checkout expired without a subscription; a new fenced billing revision is pending",
			);
		}
		if (session?.status === "complete") {
			throw new Error(
				"Checkout completed but its subscription is not yet visible canonically",
			);
		}
		throw new Error(
			"No canonical Checkout Session or phone add-on subscription is visible",
		);
	} catch (error) {
		await failPhoneBillingClaim(db, claim, error, true).catch(() => {});
		throw error;
	}
}

async function convergePhoneAddonBilling(
	env: Env,
	db: Database,
	options: {
		organizationId: string;
		checkoutSessionId?: string | null;
		allowCheckout: boolean;
	},
): Promise<PhoneBillingConvergence> {
	const [billingAccount] = await db
		.select({ stripeCustomerId: organizationSubscriptions.stripeCustomerId })
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, options.organizationId))
		.limit(1);
	const customerId = billingAccount?.stripeCustomerId;
	const priceId = env.STRIPE_WA_PHONE_PRICE_ID;
	if (!customerId || !priceId) {
		throw new PhoneOperationError(
			"CONFIG_ERROR",
			"Hosted phone billing requires a Stripe customer and server-owned phone price",
		);
	}

	const target = await ensurePhoneBillingTarget(
		db,
		options.organizationId,
		customerId,
	);
	const returnIfTargetCurrent = (
		result: PhoneBillingConvergence,
	): PhoneBillingConvergence => {
		if (target.operation.desiredQuantity !== target.actualDesiredQuantity) {
			throw new PhoneOperationError(
				"IN_PROGRESS",
				"A prior phone billing revision settled; retry to apply the newly requested quantity",
			);
		}
		return result;
	};
	if (target.operation.state === "manual_review") {
		throw new PhoneOperationError(
			"MANUAL_REVIEW_REQUIRED",
			"Phone add-on billing requires operator reconciliation",
		);
	}
	if (
		target.operation.state === "unknown" ||
		target.operation.state === "request_may_have_been_sent"
	) {
		return returnIfTargetCurrent(
			await reconcileAmbiguousPhoneBilling(env, db, target.operation),
		);
	}
	if (target.operation.state === "applied") {
		return returnIfTargetCurrent({
			state: "applied",
			stripeSubscriptionId: target.operation.stripeSubscriptionId,
			stripeSubscriptionItemId: target.operation.stripeSubscriptionItemId,
			stripeCheckoutSessionId: target.operation.stripeCheckoutSessionId,
			checkoutUrl: null,
		});
	}

	const claim = await claimPhoneBillingOperation(db, target.operation);
	if (!claim) {
		throw new PhoneOperationError(
			"IN_PROGRESS",
			"Phone add-on billing is already in progress",
		);
	}
	let boundaryOpen = false;
	try {
		const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
		await assertPhoneAddonPrice(stripe, priceId);
		let addonSubscription: Stripe.Subscription | null = null;
		let checkoutSession: Stripe.Checkout.Session | null = null;
		const checkoutSessionId =
			claim.row.stripeCheckoutSessionId ??
			(claim.row.stripeSubscriptionId ? null : options.checkoutSessionId);
		if (checkoutSessionId) {
			checkoutSession =
				await stripe.checkout.sessions.retrieve(checkoutSessionId);
			if (!isPhoneBillingCheckoutSession(checkoutSession, claim)) {
				throw new PhoneOperationError(
					"MANUAL_REVIEW_REQUIRED",
					"The Checkout Session does not belong to this fenced phone billing revision",
				);
			}
		} else if (!claim.row.stripeSubscriptionId) {
			const sessions = await listPhoneBillingCheckoutSessions(stripe, claim);
			if (sessions.length > 1) {
				throw new PhoneOperationError(
					"MANUAL_REVIEW_REQUIRED",
					"Multiple Checkout Sessions exist for one phone billing revision",
				);
			}
			checkoutSession = sessions[0] ?? null;
		}
		if (checkoutSession) {
			const checkoutSubscriptionId = subscriptionId(
				checkoutSession.subscription,
			);
			if (checkoutSession.status === "expired" && !checkoutSubscriptionId) {
				await resetPhoneBillingAfterConfirmedNotApplied(db, claim);
				throw new PhoneOperationError(
					"IN_PROGRESS",
					"The unpaid Checkout expired; a new fenced billing revision is pending",
				);
			}
			if (checkoutSession.status !== "expired" || checkoutSubscriptionId) {
				const checkoutPaid =
					checkoutSession.payment_status === "paid" ||
					checkoutSession.payment_status === "no_payment_required";
				if (
					checkoutSession.status !== "complete" ||
					!checkoutPaid ||
					!checkoutSubscriptionId
				) {
					await finishPhoneBillingClaim(db, claim, {
						state: "waiting_payment",
						appliedQuantity: claim.row.appliedQuantity,
						stripeCheckoutSessionId: checkoutSession.id,
						stripeSubscriptionId: claim.row.stripeSubscriptionId,
						stripeSubscriptionItemId: claim.row.stripeSubscriptionItemId,
						stripeLatestInvoiceId: claim.row.stripeLatestInvoiceId,
						lastError: "Phone add-on Checkout is awaiting payment",
					});
					return returnIfTargetCurrent({
						state: "waiting_payment",
						stripeSubscriptionId: claim.row.stripeSubscriptionId,
						stripeSubscriptionItemId: claim.row.stripeSubscriptionItemId,
						stripeCheckoutSessionId: checkoutSession.id,
						checkoutUrl: checkoutSession.url,
					});
				}
				addonSubscription = await stripe.subscriptions.retrieve(
					checkoutSubscriptionId,
					{ expand: ["latest_invoice"] },
				);
			}
		}

		if (!addonSubscription && claim.row.stripeSubscriptionId) {
			try {
				addonSubscription = await stripe.subscriptions.retrieve(
					claim.row.stripeSubscriptionId,
					{ expand: ["latest_invoice"] },
				);
			} catch (error) {
				if (
					!(
						error instanceof Stripe.errors.StripeInvalidRequestError &&
						error.statusCode === 404
					)
				) {
					throw error;
				}
			}
		}
		addonSubscription ??= await findPhoneAddonSubscription(
			stripe,
			customerId,
			options.organizationId,
		);

		if (addonSubscription?.status === "canceled") {
			if (claim.row.desiredQuantity === 0) {
				await finishPhoneBillingClaim(db, claim, {
					state: "applied",
					appliedQuantity: 0,
					stripeCheckoutSessionId:
						checkoutSession?.id ?? claim.row.stripeCheckoutSessionId,
					stripeSubscriptionId: addonSubscription.id,
					stripeSubscriptionItemId:
						addonSubscription.items.data[0]?.id ??
						claim.row.stripeSubscriptionItemId,
					stripeLatestInvoiceId: subscriptionId(
						addonSubscription.latest_invoice,
					),
				});
				return returnIfTargetCurrent({
					state: "applied",
					stripeSubscriptionId: addonSubscription.id,
					stripeSubscriptionItemId:
						addonSubscription.items.data[0]?.id ??
						claim.row.stripeSubscriptionItemId,
					stripeCheckoutSessionId: null,
					checkoutUrl: null,
				});
			}
			addonSubscription = null;
		}

		if (!addonSubscription) {
			if (claim.row.desiredQuantity === 0) {
				await finishPhoneBillingClaim(db, claim, {
					state: "applied",
					appliedQuantity: 0,
					stripeSubscriptionId: claim.row.stripeSubscriptionId,
					stripeSubscriptionItemId: claim.row.stripeSubscriptionItemId,
					stripeLatestInvoiceId: claim.row.stripeLatestInvoiceId,
				});
				return returnIfTargetCurrent({
					state: "applied",
					stripeSubscriptionId: claim.row.stripeSubscriptionId,
					stripeSubscriptionItemId: claim.row.stripeSubscriptionItemId,
					stripeCheckoutSessionId: null,
					checkoutUrl: null,
				});
			}
			if (!options.allowCheckout) {
				throw new PhoneOperationError(
					"IN_PROGRESS",
					"A paid phone add-on subscription is required before this billing target can be applied",
				);
			}

			await markPhoneBillingBoundary(db, claim);
			boundaryOpen = true;
			const session = await stripe.checkout.sessions.create(
				{
					customer: customerId,
					mode: "subscription",
					payment_method_types: ["card"],
					line_items: [{ price: priceId, quantity: claim.row.desiredQuantity }],
					client_reference_id: `${claim.row.id}:${claim.row.revision}`,
					metadata: phoneBillingMetadata(
						options.organizationId,
						claim.row.id,
						claim.row.revision,
					),
					subscription_data: {
						metadata: phoneBillingMetadata(
							options.organizationId,
							claim.row.id,
							claim.row.revision,
						),
					},
					success_url: `${env.API_BASE_URL ?? "https://api.relayapi.dev"}/v1/whatsapp/phone-numbers/provisioned`,
					cancel_url: `${env.API_BASE_URL ?? "https://api.relayapi.dev"}/v1/whatsapp/phone-numbers/provisioned`,
				},
				{
					idempotencyKey: `${claim.row.idempotencyKey}:checkout:${checkoutSession?.id ?? "initial"}`,
				},
			);
			if (!session.url) {
				throw new Error(
					"Stripe returned a phone add-on Checkout Session without a URL",
				);
			}
			await finishPhoneBillingClaim(db, claim, {
				state: "waiting_payment",
				appliedQuantity: 0,
				stripeCheckoutSessionId: session.id,
				stripeSubscriptionId: null,
				stripeSubscriptionItemId: null,
				stripeLatestInvoiceId: null,
				lastError: "Phone add-on Checkout is awaiting payment",
			});
			boundaryOpen = false;
			return returnIfTargetCurrent({
				state: "waiting_payment",
				stripeSubscriptionId: null,
				stripeSubscriptionItemId: null,
				stripeCheckoutSessionId: session.id,
				checkoutUrl: session.url,
			});
		}

		if (!isPhoneAddonSubscription(addonSubscription, options.organizationId)) {
			throw new PhoneOperationError(
				"MANUAL_REVIEW_REQUIRED",
				"Stripe returned a subscription that is not the organization's phone add-on",
			);
		}
		let item = phoneAddonItem(addonSubscription, priceId);
		let currentQuantity = item.quantity ?? 0;
		let invoice = expandedInvoice(addonSubscription.latest_invoice);

		if (addonSubscription.pending_update) {
			await finishPhoneBillingClaim(db, claim, {
				state: "waiting_payment",
				appliedQuantity: currentQuantity,
				stripeCheckoutSessionId:
					checkoutSession?.id ?? claim.row.stripeCheckoutSessionId,
				stripeSubscriptionId: addonSubscription.id,
				stripeSubscriptionItemId: item.id,
				stripeLatestInvoiceId: invoice?.id ?? null,
				lastError: "Phone add-on quantity is awaiting invoice payment",
			});
			return returnIfTargetCurrent({
				state: "waiting_payment",
				stripeSubscriptionId: addonSubscription.id,
				stripeSubscriptionItemId: item.id,
				stripeCheckoutSessionId: options.checkoutSessionId ?? null,
				checkoutUrl:
					invoice?.hosted_invoice_url ?? checkoutSession?.url ?? null,
			});
		}

		if (currentQuantity === claim.row.desiredQuantity) {
			const ready = addonSubscription.status === "active";
			await finishPhoneBillingClaim(db, claim, {
				state: ready ? "applied" : "waiting_payment",
				appliedQuantity: currentQuantity,
				stripeCheckoutSessionId:
					checkoutSession?.id ?? claim.row.stripeCheckoutSessionId,
				stripeSubscriptionId: addonSubscription.id,
				stripeSubscriptionItemId: item.id,
				stripeLatestInvoiceId: invoice?.id ?? null,
				lastError: ready
					? null
					: `Phone add-on subscription is ${addonSubscription.status}`,
			});
			return returnIfTargetCurrent({
				state: ready ? "applied" : "waiting_payment",
				stripeSubscriptionId: addonSubscription.id,
				stripeSubscriptionItemId: item.id,
				stripeCheckoutSessionId: options.checkoutSessionId ?? null,
				checkoutUrl: ready
					? null
					: (invoice?.hosted_invoice_url ?? checkoutSession?.url ?? null),
			});
		}

		await markPhoneBillingBoundary(db, claim);
		boundaryOpen = true;
		if (claim.row.desiredQuantity === 0) {
			addonSubscription = await stripe.subscriptions.cancel(
				addonSubscription.id,
				{},
				{ idempotencyKey: `${claim.row.idempotencyKey}:cancel` },
			);
			currentQuantity = 0;
		} else {
			const increasing = claim.row.desiredQuantity > currentQuantity;
			addonSubscription = await stripe.subscriptions.update(
				addonSubscription.id,
				{
					items: [{ id: item.id, quantity: claim.row.desiredQuantity }],
					...(increasing
						? {
								payment_behavior: "pending_if_incomplete" as const,
								proration_behavior: "always_invoice" as const,
							}
						: { proration_behavior: "none" as const }),
					expand: ["latest_invoice"],
				},
				{ idempotencyKey: `${claim.row.idempotencyKey}:quantity` },
			);
			item = phoneAddonItem(addonSubscription, priceId);
			currentQuantity = item.quantity ?? 0;
		}
		invoice = expandedInvoice(addonSubscription.latest_invoice);
		const increasing = claim.row.desiredQuantity > claim.row.appliedQuantity;
		const applied =
			claim.row.desiredQuantity === 0
				? addonSubscription.status === "canceled"
				: !addonSubscription.pending_update &&
					currentQuantity === claim.row.desiredQuantity &&
					(increasing
						? addonSubscription.status === "active" &&
							invoice?.status === "paid"
						: true);
		await finishPhoneBillingClaim(db, claim, {
			state: applied ? "applied" : "waiting_payment",
			appliedQuantity: currentQuantity,
			stripeCheckoutSessionId:
				checkoutSession?.id ?? claim.row.stripeCheckoutSessionId,
			stripeSubscriptionId: addonSubscription.id,
			stripeSubscriptionItemId: item.id,
			stripeLatestInvoiceId: invoice?.id ?? null,
			lastError: applied
				? null
				: "Phone add-on quantity is awaiting successful invoice payment",
		});
		boundaryOpen = false;
		return returnIfTargetCurrent({
			state: applied ? "applied" : "waiting_payment",
			stripeSubscriptionId: addonSubscription.id,
			stripeSubscriptionItemId: item.id,
			stripeCheckoutSessionId: options.checkoutSessionId ?? null,
			checkoutUrl: applied
				? null
				: (invoice?.hosted_invoice_url ?? checkoutSession?.url ?? null),
		});
	} catch (error) {
		await failPhoneBillingClaim(db, claim, error, boundaryOpen).catch(() => {});
		throw error;
	}
}

/**
 * Webhooks only wake durable work; they do not perform a quantity mutation on
 * the event request path. The next reconciler pass re-reads Stripe canonical
 * state while holding the organization billing authority.
 */
export async function wakePhoneAddonBillingReconciliation(
	db: Database,
	organizationId: string,
	reason: string,
	fence?: StripeOrganizationFence | null,
): Promise<void> {
	const now = new Date();
	await db.transaction(async (tx) => {
		await assertStripeOrganizationFence(tx, fence ?? null);
		await tx
			.update(whatsappPhoneBillingOperations)
			.set({
				nextAttemptAt: now,
				lastError: reason,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneBillingOperations.organizationId, organizationId),
					inArray(whatsappPhoneBillingOperations.state, [
						"waiting_payment",
						"pending",
					]),
				),
			);
		await tx
			.update(whatsappPhoneProvisioningOperations)
			.set({ provisioningNextAttemptAt: now, updatedAt: now })
			.where(
				and(
					eq(
						whatsappPhoneProvisioningOperations.organizationId,
						organizationId,
					),
					eq(whatsappPhoneProvisioningOperations.provisioningPhase, "billing"),
					eq(
						whatsappPhoneProvisioningOperations.provisioningState,
						"waiting_external",
					),
				),
			);
		await tx
			.update(whatsappPhoneReleaseOperations)
			.set({ releaseNextAttemptAt: now, updatedAt: now })
			.where(
				and(
					eq(whatsappPhoneReleaseOperations.organizationId, organizationId),
					eq(whatsappPhoneReleaseOperations.releasePhase, "stripe"),
					inArray(whatsappPhoneReleaseOperations.releaseState, [
						"pending",
						"failed",
					]),
				),
			);
	});
}

export async function getPhoneRow(
	db: Pick<Database, "select">,
	id: string,
): Promise<PhoneRow | null> {
	const [row] = await db
		.select({
			phone: whatsappPhoneNumbers,
			provisioning: whatsappPhoneProvisioningOperations,
			release: whatsappPhoneReleaseOperations,
		})
		.from(whatsappPhoneNumbers)
		.innerJoin(
			whatsappPhoneProvisioningOperations,
			and(
				eq(
					whatsappPhoneProvisioningOperations.phoneNumberId,
					whatsappPhoneNumbers.id,
				),
				eq(
					whatsappPhoneProvisioningOperations.organizationId,
					whatsappPhoneNumbers.organizationId,
				),
			),
		)
		.leftJoin(
			whatsappPhoneReleaseOperations,
			and(
				eq(
					whatsappPhoneReleaseOperations.phoneNumberId,
					whatsappPhoneNumbers.id,
				),
				eq(
					whatsappPhoneReleaseOperations.organizationId,
					whatsappPhoneNumbers.organizationId,
				),
			),
		)
		.where(eq(whatsappPhoneNumbers.id, id))
		.limit(1);
	return row ? combinePhoneRow(row) : null;
}

function combinePhoneRow(row: {
	phone: PhoneEntity;
	provisioning: ProvisioningOperation;
	release: ReleaseOperation | null;
}): PhoneRow {
	const release = row.release
		? row.release
		: {
				releaseOperationId: null,
				releaseUsageReservationId: null,
				releaseReason: null,
				releaseState: null,
				releasePhase: null,
				releaseMetaStatus: null,
				releaseStripeStatus: null,
				releaseTelnyxStatus: null,
				releaseSourceAccountId: null,
				releaseSourceTokenVersion: null,
				releaseAccessTokenCiphertext: null,
				releaseLeaseToken: null,
				releaseLeaseExpiresAt: null,
				releaseRequestMayHaveBeenSentAt: null,
				releaseAttempts: null,
				releaseNextAttemptAt: null,
				releaseLastError: null,
				releaseRequestedAt: null,
				releasedAt: null,
			};
	return {
		...row.phone,
		...row.provisioning,
		...release,
		id: row.phone.id,
		organizationId: row.phone.organizationId,
		createdAt: row.phone.createdAt,
		updatedAt: row.phone.updatedAt,
	} as PhoneRow;
}

async function findMetaPhone(
	accessToken: string,
	wabaId: string,
	phoneNumber: string,
): Promise<{ id: string } | null> {
	const response = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${wabaId}/phone_numbers?fields=id,display_phone_number&limit=100`,
		{
			headers: { Authorization: `Bearer ${accessToken}` },
			timeout: META_TIMEOUT_MS,
			timeoutThroughBody: true,
		},
	);
	if (!response.ok) {
		throw new Error(`Meta phone lookup failed with HTTP ${response.status}`);
	}
	const body = await readResponseJson<{
		data?: Array<{ id?: string; display_phone_number?: string }>;
	}>(response, META_RESPONSE_MAX_BYTES);
	const expected = normalizePhone(phoneNumber);
	const match = body.data?.find(
		(item) =>
			item.id &&
			item.display_phone_number &&
			normalizePhone(item.display_phone_number) === expected,
	);
	return match?.id ? { id: match.id } : null;
}

async function loadProvisioningToken(
	db: Database,
	env: Env,
	row: PhoneRow,
): Promise<{ accessToken: string; wabaId: string; verifiedName: string }> {
	const sourceId = row.provisioningSourceAccountId;
	const wabaId = row.provisioningSourceWabaId;
	const verifiedName = row.provisioningVerifiedName;
	if (!sourceId || !wabaId || !verifiedName) {
		throw new PhoneOperationError(
			"ACCOUNT_CREDENTIAL_UNAVAILABLE",
			"The WhatsApp provisioning source is unavailable",
		);
	}
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, sourceId),
				eq(socialAccounts.organizationId, row.organizationId),
				eq(socialAccounts.platform, "whatsapp"),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	const accountWabaId = (account?.metadata as { waba_id?: string } | null)
		?.waba_id;
	if (!account?.accessToken || accountWabaId !== wabaId) {
		throw new PhoneOperationError(
			"ACCOUNT_CREDENTIAL_UNAVAILABLE",
			"The WhatsApp credential needed to reconcile provisioning is unavailable",
		);
	}
	const accessToken = await decryptAccountToken(
		account.accessToken,
		env.ENCRYPTION_KEY,
		account.id,
		"access_token",
	);
	if (!accessToken) {
		throw new PhoneOperationError(
			"ACCOUNT_CREDENTIAL_UNAVAILABLE",
			"The WhatsApp credential needed to reconcile provisioning is unavailable",
		);
	}
	return {
		accessToken,
		wabaId,
		verifiedName,
	};
}

export async function createPhoneProvisioningOperation(
	db: Database,
	options: {
		organizationId: string;
		operationKey: string | undefined;
		phoneNumber: string;
		request: ProvisioningRequest;
		usageReservation?: UsageReservation;
	},
): Promise<{ row: PhoneRow; reused: boolean }> {
	const { operationKeyHash, requestHash } = await provisioningHashes(
		options.organizationId,
		options.operationKey,
		options.request,
	);

	return db.transaction(async (tx) => {
		// Serialize quota reservations per tenant and with tenant deletion. This is
		// a purchase-only path, so the lock adds no cost to ordinary API traffic.
		const [activeOrganization] = await tx
			.select({ id: organization.id })
			.from(organization)
			.where(
				and(
					eq(organization.id, options.organizationId),
					eq(organization.lifecycleStatus, "active"),
				),
			)
			.for("update")
			.limit(1);
		if (!activeOrganization) {
			throw new PhoneOperationError(
				"ORGANIZATION_UNAVAILABLE",
				"The organization is not available for phone-number purchases",
			);
		}

		const [existing] = await tx
			.select({
				phone: whatsappPhoneNumbers,
				provisioning: whatsappPhoneProvisioningOperations,
			})
			.from(whatsappPhoneProvisioningOperations)
			.innerJoin(
				whatsappPhoneNumbers,
				and(
					eq(
						whatsappPhoneNumbers.id,
						whatsappPhoneProvisioningOperations.phoneNumberId,
					),
					eq(
						whatsappPhoneNumbers.organizationId,
						whatsappPhoneProvisioningOperations.organizationId,
					),
				),
			)
			.where(
				and(
					eq(
						whatsappPhoneProvisioningOperations.organizationId,
						options.organizationId,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningOperationKeyHash,
						operationKeyHash,
					),
				),
			)
			.limit(1);
		if (existing) {
			if (existing.provisioning.provisioningRequestHash !== requestHash) {
				throw new PhoneOperationError(
					"IDEMPOTENCY_KEY_REUSED",
					"Idempotency-Key was already used with a different purchase request",
				);
			}
			return {
				row: combinePhoneRow({
					...existing,
					release: null,
				}),
				reused: true,
			};
		}

		const [active] = await tx
			.select({ value: count() })
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.organizationId, options.organizationId),
					inArray(whatsappPhoneNumbers.status, [
						"purchasing",
						"pending_verification",
						"verified",
						"active",
					]),
				),
			);
		if ((active?.value ?? 0) >= MAX_NUMBERS_PER_ORG) {
			throw new PhoneOperationError(
				"LIMIT_REACHED",
				`Maximum of ${MAX_NUMBERS_PER_ORG} phone numbers per organization`,
			);
		}

		const phoneNumberId = generateId("wpn_");
		const [insertedPhone] = await tx
			.insert(whatsappPhoneNumbers)
			.values({
				id: phoneNumberId,
				organizationId: options.organizationId,
				phoneNumber: options.phoneNumber,
				provider: "telnyx",
				status: "purchasing",
				country: options.request.country,
			})
			.returning();
		if (!insertedPhone) {
			throw new Error("Failed to reserve phone number resource");
		}
		const [insertedOperation] = await tx
			.insert(whatsappPhoneProvisioningOperations)
			.values({
				phoneNumberId,
				organizationId: options.organizationId,
				provisioningUsageReservationId: options.usageReservation?.id ?? null,
				provisioningOperationKeyHash: operationKeyHash,
				provisioningRequestHash: requestHash,
				provisioningSourceAccountId: options.request.account_id,
				provisioningSourceWabaId: options.request.waba_id,
				provisioningVerifiedName: options.request.verified_name,
				provisioningState: "pending",
				provisioningPhase: "selected",
				provisioningNextAttemptAt: new Date(),
			})
			.onConflictDoNothing()
			.returning();
		if (!insertedOperation) {
			throw new PhoneOperationError(
				"IN_PROGRESS",
				"Another phone number operation is already in progress",
			);
		}
		return {
			row: combinePhoneRow({
				phone: insertedPhone,
				provisioning: insertedOperation,
				release: null,
			}),
			reused: false,
		};
	});
}

interface ProvisioningClaim {
	row: PhoneRow;
	leaseToken: number;
}

async function claimProvisioning(
	db: Database,
	id: string,
): Promise<ProvisioningClaim | null> {
	const now = new Date();
	const [claimed] = await db
		.update(whatsappPhoneProvisioningOperations)
		.set({
			provisioningState: "processing",
			provisioningLeaseToken: sql`${whatsappPhoneProvisioningOperations.provisioningLeaseToken} + 1`,
			provisioningLeaseExpiresAt: new Date(
				now.getTime() + PROVISIONING_LEASE_MS,
			),
			provisioningAttempts: sql`${whatsappPhoneProvisioningOperations.provisioningAttempts} + 1`,
			provisioningLastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneProvisioningOperations.phoneNumberId, id),
				or(
					eq(whatsappPhoneProvisioningOperations.provisioningState, "pending"),
					eq(whatsappPhoneProvisioningOperations.provisioningState, "failed"),
					eq(
						whatsappPhoneProvisioningOperations.provisioningState,
						"waiting_external",
					),
					and(
						eq(
							whatsappPhoneProvisioningOperations.provisioningState,
							"processing",
						),
						lte(
							whatsappPhoneProvisioningOperations.provisioningLeaseExpiresAt,
							now,
						),
						isNull(
							whatsappPhoneProvisioningOperations.provisioningRequestMayHaveBeenSentAt,
						),
					),
				),
			),
		)
		.returning();
	if (!claimed) return null;
	const row = await getPhoneRow(db, claimed.phoneNumberId);
	return row ? { row, leaseToken: claimed.provisioningLeaseToken } : null;
}

async function markProvisioningBoundary(
	db: Database,
	claim: ProvisioningClaim,
	phase: "telnyx_order" | "billing" | "meta_registration",
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(whatsappPhoneProvisioningOperations)
		.set({
			provisioningState: "request_may_have_been_sent",
			provisioningPhase: phase,
			provisioningRequestMayHaveBeenSentAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneProvisioningOperations.phoneNumberId, claim.row.id),
				eq(
					whatsappPhoneProvisioningOperations.provisioningLeaseToken,
					claim.leaseToken,
				),
				eq(whatsappPhoneProvisioningOperations.provisioningState, "processing"),
			),
		)
		.returning({
			id: whatsappPhoneProvisioningOperations.provisioningOperationId,
		});
	if (updated.length !== 1) {
		throw new PhoneOperationError(
			"OPERATION_LEASE_LOST",
			"Provisioning lease was lost before the provider request",
		);
	}
}

async function confirmProvisioningPhase(
	db: Database,
	claim: ProvisioningClaim,
	values: {
		provisioningPhase:
			| "telnyx_order"
			| "billing"
			| "meta_registration"
			| "completed";
		telnyxOrderId?: string;
		phoneNumber?: string;
		stripePhoneSubscriptionId?: string;
		stripeSubscriptionItemId?: string;
		stripeCheckoutSessionId?: string;
		stripeCheckoutUrl?: string | null;
		waPhoneNumberId?: string;
		status?: "pending_verification";
	},
): Promise<void> {
	await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(whatsappPhoneProvisioningOperations)
			.set({
				provisioningPhase: values.provisioningPhase,
				provisioningState: "processing",
				provisioningRequestMayHaveBeenSentAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(whatsappPhoneProvisioningOperations.phoneNumberId, claim.row.id),
					eq(
						whatsappPhoneProvisioningOperations.provisioningLeaseToken,
						claim.leaseToken,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningState,
						"request_may_have_been_sent",
					),
				),
			)
			.returning({
				id: whatsappPhoneProvisioningOperations.provisioningOperationId,
			});
		if (!updated) throw new Error("Provisioning phase fence lost");
		const parentPatch = {
			...(values.telnyxOrderId ? { telnyxOrderId: values.telnyxOrderId } : {}),
			...(values.phoneNumber ? { phoneNumber: values.phoneNumber } : {}),
			...(values.stripePhoneSubscriptionId
				? { stripePhoneSubscriptionId: values.stripePhoneSubscriptionId }
				: {}),
			...(values.stripeSubscriptionItemId
				? { stripeSubscriptionItemId: values.stripeSubscriptionItemId }
				: {}),
			...(values.waPhoneNumberId
				? { waPhoneNumberId: values.waPhoneNumberId }
				: {}),
			...(values.status ? { status: values.status } : {}),
		};
		if (Object.keys(parentPatch).length > 0) {
			await tx
				.update(whatsappPhoneNumbers)
				.set({ ...parentPatch, updatedAt: new Date() })
				.where(eq(whatsappPhoneNumbers.id, claim.row.id));
		}
		if (
			values.stripeCheckoutSessionId !== undefined ||
			values.stripeCheckoutUrl !== undefined
		) {
			await tx
				.update(whatsappPhoneProvisioningOperations)
				.set({
					stripeCheckoutSessionId: values.stripeCheckoutSessionId,
					stripeCheckoutUrl: values.stripeCheckoutUrl,
					updatedAt: new Date(),
				})
				.where(
					eq(
						whatsappPhoneProvisioningOperations.provisioningOperationId,
						updated.id,
					),
				);
		}
	});
}

async function advanceProvisioningWithoutProviderBoundary(
	db: Database,
	claim: ProvisioningClaim,
	values: {
		provisioningPhase: "billing" | "telnyx_order" | "meta_registration";
		stripePhoneSubscriptionId?: string;
		stripeSubscriptionItemId?: string;
		stripeCheckoutSessionId?: string;
		stripeCheckoutUrl?: string | null;
	},
): Promise<PhoneRow> {
	await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(whatsappPhoneProvisioningOperations)
			.set({
				provisioningPhase: values.provisioningPhase,
				provisioningState: "processing",
				provisioningRequestMayHaveBeenSentAt: null,
				...(values.stripeCheckoutSessionId !== undefined
					? { stripeCheckoutSessionId: values.stripeCheckoutSessionId }
					: {}),
				...(values.stripeCheckoutUrl !== undefined
					? { stripeCheckoutUrl: values.stripeCheckoutUrl }
					: {}),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(whatsappPhoneProvisioningOperations.phoneNumberId, claim.row.id),
					eq(
						whatsappPhoneProvisioningOperations.provisioningLeaseToken,
						claim.leaseToken,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningState,
						"processing",
					),
				),
			)
			.returning({
				id: whatsappPhoneProvisioningOperations.provisioningOperationId,
			});
		if (!updated) throw new Error("Phone provisioning phase fence lost");
		if (values.stripePhoneSubscriptionId || values.stripeSubscriptionItemId) {
			await tx
				.update(whatsappPhoneNumbers)
				.set({
					...(values.stripePhoneSubscriptionId
						? {
								stripePhoneSubscriptionId: values.stripePhoneSubscriptionId,
							}
						: {}),
					...(values.stripeSubscriptionItemId
						? {
								stripeSubscriptionItemId: values.stripeSubscriptionItemId,
							}
						: {}),
					updatedAt: new Date(),
				})
				.where(eq(whatsappPhoneNumbers.id, claim.row.id));
		}
	});
	const row = await getPhoneRow(db, claim.row.id);
	if (!row) throw new Error("Phone provisioning row disappeared");
	return row;
}

async function waitForPhonePayment(
	db: Database,
	claim: ProvisioningClaim,
	message: string,
	checkoutUrl?: string | null,
): Promise<PhoneRow> {
	const [updated] = await db
		.update(whatsappPhoneProvisioningOperations)
		.set({
			provisioningState: "waiting_external",
			provisioningLeaseExpiresAt: null,
			provisioningRequestMayHaveBeenSentAt: null,
			provisioningLastError: message,
			provisioningNextAttemptAt: new Date(
				Date.now() + PHONE_PAYMENT_RECHECK_MS,
			),
			...(checkoutUrl !== undefined ? { stripeCheckoutUrl: checkoutUrl } : {}),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneProvisioningOperations.phoneNumberId, claim.row.id),
				eq(
					whatsappPhoneProvisioningOperations.provisioningLeaseToken,
					claim.leaseToken,
				),
				eq(whatsappPhoneProvisioningOperations.provisioningState, "processing"),
			),
		)
		.returning({
			id: whatsappPhoneProvisioningOperations.provisioningOperationId,
		});
	if (!updated) throw new Error("Phone payment wait fence lost");
	const row = await getPhoneRow(db, claim.row.id);
	if (!row) throw new Error("Phone payment wait row disappeared");
	return row;
}

async function failProvisioning(
	db: Database,
	claim: ProvisioningClaim,
	error: unknown,
	boundaryOpen: boolean,
): Promise<void> {
	const attempts = claim.row.provisioningAttempts;
	await db
		.update(whatsappPhoneProvisioningOperations)
		.set({
			provisioningState: boundaryOpen
				? "unknown"
				: attempts >= MAX_RECONCILIATION_ATTEMPTS
					? "manual_review"
					: "failed",
			provisioningLeaseExpiresAt: null,
			provisioningLastError:
				error instanceof Error ? error.message : String(error),
			provisioningNextAttemptAt: new Date(
				Date.now() + delayForAttempt(attempts),
			),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneProvisioningOperations.phoneNumberId, claim.row.id),
				eq(
					whatsappPhoneProvisioningOperations.provisioningLeaseToken,
					claim.leaseToken,
				),
				inArray(whatsappPhoneProvisioningOperations.provisioningState, [
					"processing",
					"request_may_have_been_sent",
				]),
			),
		);
}

export async function continuePhoneProvisioning(
	env: Env,
	db: Database,
	id: string,
): Promise<PhoneRow> {
	const before = await getPhoneRow(db, id);
	if (!before)
		throw new PhoneOperationError("NOT_FOUND", "Phone operation not found");
	if (before.provisioningState === "completed") return before;
	if (before.provisioningState === "cancelled") {
		throw new PhoneOperationError(
			"OPERATION_CANCELLED",
			"Phone provisioning was cancelled before completion",
		);
	}
	if (before.provisioningState === "manual_review") {
		throw new PhoneOperationError(
			"MANUAL_REVIEW_REQUIRED",
			"Phone provisioning requires manual provider review",
		);
	}
	if (
		before.provisioningState === "unknown" ||
		before.provisioningState === "request_may_have_been_sent"
	) {
		throw new PhoneOperationError(
			"UNKNOWN_EXTERNAL_OUTCOME",
			"The phone provider outcome is being reconciled; no purchase was replayed",
		);
	}

	const claim = await claimProvisioning(db, id);
	if (!claim) {
		throw new PhoneOperationError(
			"IN_PROGRESS",
			"Phone provisioning is already in progress",
		);
	}
	let row = claim.row;
	let boundaryOpen = false;

	try {
		if (row.provisioningPhase === "selected") {
			row = await advanceProvisioningWithoutProviderBoundary(db, claim, {
				provisioningPhase: "billing",
			});
		}

		if (row.provisioningPhase === "billing") {
			if (isSelfHosted(env)) {
				row = await advanceProvisioningWithoutProviderBoundary(db, claim, {
					provisioningPhase: "telnyx_order",
				});
			} else {
				const billing = await convergePhoneAddonBilling(env, db, {
					organizationId: row.organizationId,
					checkoutSessionId: row.stripeCheckoutSessionId,
					allowCheckout: true,
				});
				if (billing.state === "waiting_payment") {
					row = await advanceProvisioningWithoutProviderBoundary(db, claim, {
						provisioningPhase: "billing",
						...(billing.stripeSubscriptionId
							? {
									stripePhoneSubscriptionId: billing.stripeSubscriptionId,
								}
							: {}),
						...(billing.stripeSubscriptionItemId
							? {
									stripeSubscriptionItemId: billing.stripeSubscriptionItemId,
								}
							: {}),
						...(billing.stripeCheckoutSessionId
							? {
									stripeCheckoutSessionId: billing.stripeCheckoutSessionId,
								}
							: {}),
						stripeCheckoutUrl: billing.checkoutUrl,
					});
					return waitForPhonePayment(
						db,
						claim,
						"Phone add-on billing is awaiting successful payment",
						billing.checkoutUrl,
					);
				}
				if (
					!billing.stripeSubscriptionId ||
					!billing.stripeSubscriptionItemId
				) {
					throw new PhoneOperationError(
						"MANUAL_REVIEW_REQUIRED",
						"Applied phone billing is missing its dedicated Stripe subscription identity",
					);
				}
				row = await advanceProvisioningWithoutProviderBoundary(db, claim, {
					provisioningPhase: "telnyx_order",
					stripePhoneSubscriptionId: billing.stripeSubscriptionId,
					stripeSubscriptionItemId: billing.stripeSubscriptionItemId,
					stripeCheckoutUrl: null,
				});
			}
		}

		if (!row.telnyxOrderId) {
			const telnyxApiKey = requireTelnyxApiKey(env);
			await markProvisioningBoundary(db, claim, "telnyx_order");
			boundaryOpen = true;
			const ordered = await orderNumber(
				telnyxApiKey,
				row.phoneNumber,
				row.provisioningOperationId,
			);
			await confirmProvisioningPhase(db, claim, {
				telnyxOrderId: ordered.orderId,
				phoneNumber: ordered.phoneNumbers[0] ?? row.phoneNumber,
				provisioningPhase: "telnyx_order",
			});
			boundaryOpen = false;
			row = {
				...row,
				telnyxOrderId: ordered.orderId,
				phoneNumber: ordered.phoneNumbers[0] ?? row.phoneNumber,
				provisioningPhase: "telnyx_order",
			};
		}

		if (row.provisioningPhase === "telnyx_order" || !row.providerNumberId) {
			const owned = await findOwnedPhoneNumber(
				requireTelnyxApiKey(env),
				row.phoneNumber,
			);
			if (!owned) {
				await db
					.update(whatsappPhoneProvisioningOperations)
					.set({
						provisioningState: "waiting_external",
						provisioningLeaseExpiresAt: null,
						provisioningLastError:
							"Telnyx order is not yet visible as an active phone number",
						provisioningNextAttemptAt: new Date(Date.now() + 60_000),
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneProvisioningOperations.phoneNumberId, row.id),
							eq(
								whatsappPhoneProvisioningOperations.provisioningLeaseToken,
								claim.leaseToken,
							),
							eq(
								whatsappPhoneProvisioningOperations.provisioningState,
								"processing",
							),
						),
					);
				throw new PhoneOperationError(
					"TELNYX_ORDER_PENDING",
					"The Telnyx order is committed and awaiting provider activation",
				);
			}
			await db.transaction(async (tx) => {
				const [updated] = await tx
					.update(whatsappPhoneProvisioningOperations)
					.set({
						provisioningPhase: "meta_registration",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneProvisioningOperations.phoneNumberId, row.id),
							eq(
								whatsappPhoneProvisioningOperations.provisioningLeaseToken,
								claim.leaseToken,
							),
						),
					)
					.returning({
						id: whatsappPhoneProvisioningOperations.provisioningOperationId,
					});
				if (!updated) throw new Error("Telnyx activation fence lost");
				await tx
					.update(whatsappPhoneNumbers)
					.set({
						providerNumberId: owned.id,
						phoneNumber: owned.phoneNumber,
						updatedAt: new Date(),
					})
					.where(eq(whatsappPhoneNumbers.id, row.id));
			});
			row = {
				...row,
				providerNumberId: owned.id,
				phoneNumber: owned.phoneNumber,
				provisioningPhase: "meta_registration",
			};
		}

		if (row.provisioningPhase === "meta_registration" && !row.waPhoneNumberId) {
			const auth = await loadProvisioningToken(db, env, row);
			const existing = await findMetaPhone(
				auth.accessToken,
				auth.wabaId,
				row.phoneNumber,
			);
			let metaPhoneId = existing?.id;
			if (!metaPhoneId) {
				await markProvisioningBoundary(db, claim, "meta_registration");
				boundaryOpen = true;
				const response = await fetchWithTimeout(
					`${GRAPH_BASE.facebook}/${auth.wabaId}/phone_numbers`,
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${auth.accessToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							cc: row.country === "US" ? "1" : undefined,
							phone_number: row.phoneNumber.replace(/^\+1/, ""),
							verified_name: auth.verifiedName,
						}),
						timeout: META_TIMEOUT_MS,
						timeoutThroughBody: true,
					},
				);
				if (!response.ok) {
					throw new Error(
						`Meta phone registration failed with HTTP ${response.status}`,
					);
				}
				const body = await readResponseJson<{ id?: string }>(
					response,
					META_RESPONSE_MAX_BYTES,
				);
				metaPhoneId = body.id;
				if (!metaPhoneId) {
					throw new Error("Meta accepted registration without a phone id");
				}
				await confirmProvisioningPhase(db, claim, {
					waPhoneNumberId: metaPhoneId,
					status: "pending_verification",
					provisioningPhase: "completed",
				});
				boundaryOpen = false;
			}
			row = {
				...row,
				waPhoneNumberId: metaPhoneId,
				status: "pending_verification",
				provisioningPhase: "completed",
			};
		}

		if (row.waPhoneNumberId && row.provisioningPhase === "completed") {
			const completedAt = new Date();
			await db.transaction(async (tx) => {
				const [completed] = await tx
					.update(whatsappPhoneProvisioningOperations)
					.set({
						provisioningState: "completed",
						provisioningPhase: "completed",
						provisioningLeaseExpiresAt: null,
						provisioningRequestMayHaveBeenSentAt: null,
						provisioningLastError: null,
						provisioningVerifiedName: null,
						provisioningDetailExpiresAt: new Date(
							completedAt.getTime() + PROVISIONING_DETAIL_RETENTION_MS,
						),
						updatedAt: completedAt,
					})
					.where(
						and(
							eq(whatsappPhoneProvisioningOperations.phoneNumberId, row.id),
							eq(
								whatsappPhoneProvisioningOperations.provisioningLeaseToken,
								claim.leaseToken,
							),
							eq(
								whatsappPhoneProvisioningOperations.provisioningState,
								"processing",
							),
						),
					)
					.returning({
						id: whatsappPhoneProvisioningOperations.provisioningOperationId,
					});
				if (!completed) throw new Error("Provisioning completion fence lost");
				await tx
					.update(whatsappPhoneNumbers)
					.set({
						waPhoneNumberId: row.waPhoneNumberId,
						status: "pending_verification",
						updatedAt: completedAt,
					})
					.where(eq(whatsappPhoneNumbers.id, row.id));
			});
			const completed = await getPhoneRow(db, row.id);
			if (!completed) throw new Error("Provisioned phone row disappeared");
			return completed;
		}

		const completed = await getPhoneRow(db, row.id);
		if (!completed) throw new Error("Provisioned phone row disappeared");
		return completed;
	} catch (error) {
		await failProvisioning(db, claim, error, boundaryOpen).catch(() => {});
		throw error;
	}
}

async function deferProvisioningReconciliation(
	db: Database,
	row: PhoneRow,
	leaseToken: number,
	error: unknown,
	waitingForActivation = false,
): Promise<void> {
	const attempts = waitingForActivation
		? row.provisioningAttempts
		: row.provisioningAttempts + 1;
	await db
		.update(whatsappPhoneProvisioningOperations)
		.set({
			provisioningState: waitingForActivation
				? "waiting_external"
				: attempts >= MAX_RECONCILIATION_ATTEMPTS
					? "manual_review"
					: "unknown",
			provisioningAttempts: attempts,
			provisioningLeaseExpiresAt: null,
			provisioningLastError:
				error instanceof Error ? error.message : String(error),
			provisioningNextAttemptAt: new Date(
				Date.now() +
					(waitingForActivation ? 5 * 60_000 : delayForAttempt(attempts)),
			),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneProvisioningOperations.phoneNumberId, row.id),
				eq(
					whatsappPhoneProvisioningOperations.provisioningLeaseToken,
					leaseToken,
				),
				eq(whatsappPhoneProvisioningOperations.provisioningState, "processing"),
			),
		);
}

export async function reconcilePhoneProvisioningOperations(
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidateRows = await db
		.select({
			phone: whatsappPhoneNumbers,
			provisioning: whatsappPhoneProvisioningOperations,
		})
		.from(whatsappPhoneProvisioningOperations)
		.innerJoin(
			whatsappPhoneNumbers,
			and(
				eq(
					whatsappPhoneNumbers.id,
					whatsappPhoneProvisioningOperations.phoneNumberId,
				),
				eq(
					whatsappPhoneNumbers.organizationId,
					whatsappPhoneProvisioningOperations.organizationId,
				),
			),
		)
		.where(
			and(
				or(
					inArray(whatsappPhoneProvisioningOperations.provisioningState, [
						"pending",
						"failed",
						"unknown",
						"waiting_external",
						"request_may_have_been_sent",
						"processing",
					]),
				),
				lte(whatsappPhoneProvisioningOperations.provisioningNextAttemptAt, now),
				or(
					inArray(whatsappPhoneProvisioningOperations.provisioningState, [
						"pending",
						"unknown",
						"waiting_external",
						"request_may_have_been_sent",
						"failed",
					]),
					lte(
						whatsappPhoneProvisioningOperations.provisioningLeaseExpiresAt,
						now,
					),
				),
			),
		)
		.orderBy(
			whatsappPhoneProvisioningOperations.provisioningNextAttemptAt,
			whatsappPhoneProvisioningOperations.phoneNumberId,
		)
		.limit(5);
	const candidates = candidateRows.map((row) =>
		combinePhoneRow({ ...row, release: null }),
	);

	for (const candidate of candidates) {
		if (
			(candidate.provisioningState === "pending" ||
				candidate.provisioningState === "failed") &&
			!candidate.provisioningRequestMayHaveBeenSentAt
		) {
			await continuePhoneProvisioning(env, db, candidate.id).catch((error) => {
				console.error("Failed to resume safe phone provisioning operation", {
					phoneNumberId: candidate.id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
			continue;
		}
		if (
			candidate.provisioningState === "processing" &&
			!candidate.provisioningRequestMayHaveBeenSentAt
		) {
			const [released] = await db
				.update(whatsappPhoneProvisioningOperations)
				.set({
					provisioningState: "failed",
					provisioningLeaseExpiresAt: null,
					provisioningLastError:
						"Lease expired outside a provider boundary; safe to resume",
					updatedAt: now,
				})
				.where(
					and(
						eq(whatsappPhoneProvisioningOperations.phoneNumberId, candidate.id),
						eq(
							whatsappPhoneProvisioningOperations.provisioningLeaseToken,
							candidate.provisioningLeaseToken,
						),
						eq(
							whatsappPhoneProvisioningOperations.provisioningState,
							"processing",
						),
						lte(
							whatsappPhoneProvisioningOperations.provisioningLeaseExpiresAt,
							now,
						),
					),
				)
				.returning({
					phoneNumberId: whatsappPhoneProvisioningOperations.phoneNumberId,
				});
			if (released) {
				await continuePhoneProvisioning(env, db, released.phoneNumberId).catch(
					(error) => {
						console.error("Failed to resume expired phone provisioning lease", {
							phoneNumberId: released.phoneNumberId,
							error: error instanceof Error ? error.message : String(error),
						});
					},
				);
			}
			continue;
		}

		const [claimedOperation] = await db
			.update(whatsappPhoneProvisioningOperations)
			.set({
				provisioningState: "processing",
				provisioningLeaseToken: sql`${whatsappPhoneProvisioningOperations.provisioningLeaseToken} + 1`,
				provisioningLeaseExpiresAt: new Date(
					now.getTime() + PROVISIONING_LEASE_MS,
				),
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneProvisioningOperations.phoneNumberId, candidate.id),
					eq(
						whatsappPhoneProvisioningOperations.provisioningLeaseToken,
						candidate.provisioningLeaseToken,
					),
					inArray(whatsappPhoneProvisioningOperations.provisioningState, [
						"unknown",
						"waiting_external",
						"request_may_have_been_sent",
						"processing",
						"failed",
					]),
				),
			)
			.returning();
		if (!claimedOperation) continue;
		const operation = await getPhoneRow(db, claimedOperation.phoneNumberId);
		if (!operation) continue;

		try {
			if (operation.provisioningPhase === "telnyx_order") {
				const telnyxApiKey = requireTelnyxApiKey(env);
				let telnyxOrderId = operation.telnyxOrderId;
				let phoneNumber = operation.phoneNumber;
				if (!telnyxOrderId) {
					const order = await findNumberOrderByCustomerReference(
						telnyxApiKey,
						operation.provisioningOperationId,
					);
					if (!order) {
						await deferProvisioningReconciliation(
							db,
							operation,
							operation.provisioningLeaseToken,
							"Telnyx order is not visible by customer_reference",
						);
						continue;
					}
					telnyxOrderId = order.orderId;
					phoneNumber = order.phoneNumbers[0] ?? phoneNumber;
				}

				const owned = await findOwnedPhoneNumber(telnyxApiKey, phoneNumber);
				if (!owned) {
					await db.transaction(async (tx) => {
						const [fenced] = await tx
							.update(whatsappPhoneProvisioningOperations)
							.set({ updatedAt: new Date() })
							.where(
								and(
									eq(
										whatsappPhoneProvisioningOperations.phoneNumberId,
										operation.id,
									),
									eq(
										whatsappPhoneProvisioningOperations.provisioningLeaseToken,
										operation.provisioningLeaseToken,
									),
									eq(
										whatsappPhoneProvisioningOperations.provisioningState,
										"processing",
									),
								),
							)
							.returning({
								id: whatsappPhoneProvisioningOperations.provisioningOperationId,
							});
						if (!fenced) return;
						await tx
							.update(whatsappPhoneNumbers)
							.set({ telnyxOrderId, phoneNumber, updatedAt: new Date() })
							.where(eq(whatsappPhoneNumbers.id, operation.id));
					});
					await deferProvisioningReconciliation(
						db,
						operation,
						operation.provisioningLeaseToken,
						"Telnyx order is awaiting phone-number activation",
						true,
					);
					continue;
				}

				await db.transaction(async (tx) => {
					const [fenced] = await tx
						.update(whatsappPhoneProvisioningOperations)
						.set({
							provisioningState: "failed",
							provisioningPhase: "meta_registration",
							provisioningRequestMayHaveBeenSentAt: null,
							provisioningLeaseExpiresAt: null,
							updatedAt: new Date(),
						})
						.where(
							and(
								eq(
									whatsappPhoneProvisioningOperations.phoneNumberId,
									operation.id,
								),
								eq(
									whatsappPhoneProvisioningOperations.provisioningLeaseToken,
									operation.provisioningLeaseToken,
								),
								eq(
									whatsappPhoneProvisioningOperations.provisioningState,
									"processing",
								),
							),
						)
						.returning({
							id: whatsappPhoneProvisioningOperations.provisioningOperationId,
						});
					if (!fenced) return;
					await tx
						.update(whatsappPhoneNumbers)
						.set({
							telnyxOrderId,
							providerNumberId: owned.id,
							phoneNumber: owned.phoneNumber,
							updatedAt: new Date(),
						})
						.where(eq(whatsappPhoneNumbers.id, operation.id));
				});
				await continuePhoneProvisioning(env, db, operation.id);
				continue;
			}

			if (operation.provisioningPhase === "billing") {
				// Stripe mutations are keyed by the durable operation ID, so a replay
				// of this specific phase is provider-idempotent.
				await db
					.update(whatsappPhoneProvisioningOperations)
					.set({
						provisioningState: "failed",
						provisioningRequestMayHaveBeenSentAt: null,
						provisioningLeaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(
								whatsappPhoneProvisioningOperations.phoneNumberId,
								operation.id,
							),
							eq(
								whatsappPhoneProvisioningOperations.provisioningLeaseToken,
								operation.provisioningLeaseToken,
							),
							eq(
								whatsappPhoneProvisioningOperations.provisioningState,
								"processing",
							),
						),
					);
				await continuePhoneProvisioning(env, db, operation.id);
				continue;
			}

			if (operation.provisioningPhase === "meta_registration") {
				const auth = await loadProvisioningToken(db, env, operation);
				const existing = await findMetaPhone(
					auth.accessToken,
					auth.wabaId,
					operation.phoneNumber,
				);
				if (!existing) {
					await deferProvisioningReconciliation(
						db,
						operation,
						operation.provisioningLeaseToken,
						"Meta registration was not visible; automatic replay is disabled",
					);
					continue;
				}
				const completedAt = new Date();
				await db.transaction(async (tx) => {
					const [fenced] = await tx
						.update(whatsappPhoneProvisioningOperations)
						.set({
							provisioningState: "completed",
							provisioningPhase: "completed",
							provisioningRequestMayHaveBeenSentAt: null,
							provisioningLeaseExpiresAt: null,
							provisioningLastError: null,
							provisioningVerifiedName: null,
							provisioningDetailExpiresAt: new Date(
								completedAt.getTime() + PROVISIONING_DETAIL_RETENTION_MS,
							),
							updatedAt: completedAt,
						})
						.where(
							and(
								eq(
									whatsappPhoneProvisioningOperations.phoneNumberId,
									operation.id,
								),
								eq(
									whatsappPhoneProvisioningOperations.provisioningLeaseToken,
									operation.provisioningLeaseToken,
								),
								eq(
									whatsappPhoneProvisioningOperations.provisioningState,
									"processing",
								),
							),
						)
						.returning({
							id: whatsappPhoneProvisioningOperations.provisioningOperationId,
						});
					if (!fenced) return;
					await tx
						.update(whatsappPhoneNumbers)
						.set({
							waPhoneNumberId: existing.id,
							status: "pending_verification",
							updatedAt: completedAt,
						})
						.where(eq(whatsappPhoneNumbers.id, operation.id));
				});
			}
		} catch (error) {
			await deferProvisioningReconciliation(
				db,
				operation,
				operation.provisioningLeaseToken,
				error,
			);
		}
	}
}

interface ReleaseSource {
	id: string;
	tokenVersion: number;
	accessToken: string | null;
	metadata: unknown;
}

async function resolveReleaseSource(
	db: Pick<Database, "select">,
	row: PhoneRow,
): Promise<ReleaseSource | null> {
	// Release must use the credential captured by the durable provisioning
	// operation. A deletion request may already have fenced it as disconnecting,
	// but the exact versioned ciphertext remains valid for this cleanup snapshot.
	// `socialAccountId` identifies the resulting phone account and is not a
	// compatibility fallback: in a multi-WABA organization it may point at a
	// different credential than the account that initiated this purchase.
	const sourceAccountId = row.provisioningSourceAccountId;
	const sourceWabaId = row.provisioningSourceWabaId;
	if (!sourceAccountId || !sourceWabaId) return null;
	const [account] = await db
		.select({
			id: socialAccounts.id,
			tokenVersion: socialAccounts.tokenVersion,
			accessToken: socialAccounts.accessToken,
			metadata: socialAccounts.metadata,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, sourceAccountId),
				eq(socialAccounts.organizationId, row.organizationId),
				eq(socialAccounts.platform, "whatsapp"),
				inArray(socialAccounts.lifecycleStatus, ["active", "disconnecting"]),
			),
		)
		.for("share")
		.limit(1);
	const accountWabaId = (account?.metadata as { waba_id?: string } | null)
		?.waba_id;
	return account?.accessToken && accountWabaId === sourceWabaId
		? account
		: null;
}

function releaseHasConfirmedProviderEffect(row: PhoneRow): boolean {
	return [
		row.releaseMetaStatus,
		row.releaseStripeStatus,
		row.releaseTelnyxStatus,
	].includes("confirmed");
}

function releaseTakeoverIsProvenNoEffect(row: PhoneRow): boolean {
	if (
		row.releaseRequestMayHaveBeenSentAt !== null ||
		releaseHasConfirmedProviderEffect(row)
	) {
		return false;
	}
	if (row.releaseState === "cancelled") return true;
	return (
		["pending", "failed", "processing"].includes(row.releaseState ?? "") &&
		row.releaseRequestMayHaveBeenSentAt === null
	);
}

/**
 * Tenant/workspace erasure is system-authorized cleanup. It must be able to
 * supersede a user-requested release after that user's authority is revoked,
 * without replaying a provider boundary whose outcome may be ambiguous.
 *
 * The release row is updated in place so provider evidence and the stable
 * operation identity survive. Incrementing the lease token fences a worker
 * that read the old user authority before this transaction committed.
 */
async function takeOverUserReleaseForTenantDeletion(
	tx: Transaction,
	joined: {
		phone: PhoneEntity;
		provisioning: ProvisioningOperation;
		release: ReleaseOperation | null;
	},
	row: PhoneRow,
): Promise<PhoneRow> {
	if (
		!row.releaseOperationId ||
		row.releaseReason !== "user_requested" ||
		!row.releaseState ||
		!row.releasePhase ||
		!row.releasePriorPhoneStatus ||
		!row.releaseNextAttemptAt
	) {
		throw new Error("Phone release takeover requires a user release snapshot");
	}

	const now = new Date();
	if (
		row.releaseState === "cancelled" &&
		!isReleasePriorPhoneStatus(row.status)
	) {
		throw new Error("Phone release cannot preserve an unknown prior status");
	}
	const provenNoEffect = releaseTakeoverIsProvenNoEffect(row);
	const ambiguousBoundary =
		row.releaseState === "request_may_have_been_sent" ||
		row.releaseState === "unknown" ||
		row.releaseRequestMayHaveBeenSentAt !== null;
	const preserveManualReview = row.releaseState === "manual_review";
	const canContinue = !ambiguousBoundary && !preserveManualReview;

	let source: Pick<
		ReleaseSource,
		"id" | "tokenVersion" | "accessToken"
	> | null =
		row.releaseSourceAccountId !== null &&
		row.releaseSourceTokenVersion !== null &&
		row.releaseAccessTokenCiphertext !== null
			? {
					id: row.releaseSourceAccountId,
					tokenVersion: row.releaseSourceTokenVersion,
					accessToken: row.releaseAccessTokenCiphertext,
				}
			: null;
	if (
		row.releaseState === "cancelled" ||
		(canContinue &&
			row.releasePhase === "meta" &&
			row.releaseMetaStatus === "pending" &&
			row.waPhoneNumberId !== null &&
			!source)
	) {
		source = await resolveReleaseSource(tx, row);
	}

	const missingMandatoryMetaCredential =
		canContinue &&
		row.releasePhase === "meta" &&
		row.releaseMetaStatus === "pending" &&
		row.waPhoneNumberId !== null &&
		!source;
	const nextState = preserveManualReview
		? "manual_review"
		: ambiguousBoundary
			? "unknown"
			: missingMandatoryMetaCredential
				? "manual_review"
				: "pending";
	const nextRequestMarker =
		nextState === "unknown" || nextState === "manual_review"
			? row.releaseRequestMayHaveBeenSentAt
			: null;

	const [takenOver] = await tx
		.update(whatsappPhoneReleaseOperations)
		.set({
			releaseReason: "tenant_deleted",
			...releaseAuthorityValues(null),
			releaseAuthorityRevokedAt: null,
			releaseUsageReservationId: provenNoEffect
				? null
				: row.releaseUsageReservationId,
			releasePriorPhoneStatus:
				row.releaseState === "cancelled"
					? (row.status as ReleasePriorPhoneStatus)
					: row.releasePriorPhoneStatus,
			releaseState: nextState,
			releaseLeaseToken: sql`${whatsappPhoneReleaseOperations.releaseLeaseToken} + 1`,
			releaseLeaseExpiresAt: null,
			releaseRequestMayHaveBeenSentAt: nextRequestMarker,
			releaseNextAttemptAt:
				nextState === "manual_review" ? row.releaseNextAttemptAt : now,
			releaseSourceAccountId: source?.id ?? null,
			releaseSourceTokenVersion: source?.tokenVersion ?? null,
			releaseAccessTokenCiphertext: source?.accessToken ?? null,
			releaseLastError: missingMandatoryMetaCredential
				? "WhatsApp credential unavailable for mandatory deregistration"
				: nextState === "unknown" || nextState === "manual_review"
					? row.releaseLastError
					: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(
					whatsappPhoneReleaseOperations.releaseOperationId,
					row.releaseOperationId,
				),
				eq(whatsappPhoneReleaseOperations.phoneNumberId, row.id),
				eq(whatsappPhoneReleaseOperations.organizationId, row.organizationId),
				eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested"),
				eq(whatsappPhoneReleaseOperations.releaseState, row.releaseState),
				eq(whatsappPhoneReleaseOperations.releasePhase, row.releasePhase),
				eq(
					whatsappPhoneReleaseOperations.releaseLeaseToken,
					row.releaseLeaseToken ?? -1,
				),
				row.releaseLeaseExpiresAt
					? eq(
							whatsappPhoneReleaseOperations.releaseLeaseExpiresAt,
							row.releaseLeaseExpiresAt,
						)
					: isNull(whatsappPhoneReleaseOperations.releaseLeaseExpiresAt),
				row.releaseRequestMayHaveBeenSentAt
					? eq(
							whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
							row.releaseRequestMayHaveBeenSentAt,
						)
					: isNull(
							whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
						),
				row.releaseAuthorityRevision === null
					? isNull(whatsappPhoneReleaseOperations.releaseAuthorityRevision)
					: eq(
							whatsappPhoneReleaseOperations.releaseAuthorityRevision,
							row.releaseAuthorityRevision,
						),
			),
		)
		.returning();
	if (!takenOver) {
		throw new PhoneOperationError(
			"IN_PROGRESS",
			"Phone release advanced while tenant deletion was taking it over",
		);
	}

	if (provenNoEffect) {
		await settleLinkedDurableUsageInTransaction(tx, {
			organizationId: row.organizationId,
			usageReservationId: row.releaseUsageReservationId,
			committed: false,
		});
	}

	let phone = joined.phone;
	if (row.releaseState === "cancelled") {
		const [restagedPhone] = await tx
			.update(whatsappPhoneNumbers)
			.set({ status: "releasing", updatedAt: now })
			.where(
				and(
					eq(whatsappPhoneNumbers.id, row.id),
					eq(whatsappPhoneNumbers.organizationId, row.organizationId),
					eq(whatsappPhoneNumbers.status, row.status),
				),
			)
			.returning();
		if (!restagedPhone) {
			throw new PhoneOperationError(
				"IN_PROGRESS",
				"Phone state changed while tenant deletion was restaging its release",
			);
		}
		phone = restagedPhone;
	}

	return combinePhoneRow({
		phone,
		provisioning: joined.provisioning,
		release: takenOver,
	});
}

export async function stagePhoneRelease(
	db: Database,
	organizationId: string,
	phoneId: string,
	reason: ReleaseReason,
	usageReservation?: UsageReservation,
	authorityAdmission?: DurableCredentialAuthorityAdmission,
): Promise<PhoneRow> {
	return db.transaction(async (tx) => {
		const [joined] = await tx
			.select({
				phone: whatsappPhoneNumbers,
				provisioning: whatsappPhoneProvisioningOperations,
				release: whatsappPhoneReleaseOperations,
			})
			.from(whatsappPhoneNumbers)
			.innerJoin(
				whatsappPhoneProvisioningOperations,
				and(
					eq(
						whatsappPhoneProvisioningOperations.phoneNumberId,
						whatsappPhoneNumbers.id,
					),
					eq(
						whatsappPhoneProvisioningOperations.organizationId,
						whatsappPhoneNumbers.organizationId,
					),
				),
			)
			.leftJoin(
				whatsappPhoneReleaseOperations,
				and(
					eq(
						whatsappPhoneReleaseOperations.phoneNumberId,
						whatsappPhoneNumbers.id,
					),
					eq(
						whatsappPhoneReleaseOperations.organizationId,
						whatsappPhoneNumbers.organizationId,
					),
				),
			)
			.where(
				and(
					eq(whatsappPhoneNumbers.id, phoneId),
					eq(whatsappPhoneNumbers.organizationId, organizationId),
				),
			)
			.limit(1);
		if (!joined)
			throw new PhoneOperationError("NOT_FOUND", "Phone number not found");
		const row = combinePhoneRow(joined);
		const adoptRequestReservation = async (release: PhoneRow) => {
			await adoptDurableUsageReservationInTransaction(
				tx,
				release.releaseUsageReservationId,
				usageReservation,
			);
			return release;
		};
		let durableAuthority: DurableCredentialAuthoritySnapshot | null = null;
		if (reason === "user_requested") {
			if (!authorityAdmission) {
				throw new PhoneOperationError(
					"CREDENTIAL_NO_LONGER_AUTHORIZED",
					"Phone release admission requires live billing authority",
				);
			}
			const [sourceScope] = row.provisioningSourceAccountId
				? await tx
						.select({ workspaceId: socialAccounts.workspaceId })
						.from(socialAccounts)
						.where(
							and(
								eq(socialAccounts.id, row.provisioningSourceAccountId),
								eq(socialAccounts.organizationId, organizationId),
							),
						)
						.for("share")
						.limit(1)
				: [];
			const workspaceId = sourceScope?.workspaceId ?? null;
			const admitted = await authorityAdmission(tx, {
				workspaceId,
				requireAllWorkspaceScope: workspaceId === null,
			});
			if (!admitted.ok) {
				throw new PhoneOperationError(
					"CREDENTIAL_NO_LONGER_AUTHORIZED",
					admitted.message,
				);
			}
			durableAuthority = admitted.value;
		}
		if (
			reason === "user_requested" &&
			row.releaseReason === "user_requested" &&
			durableAuthority &&
			!sameReleaseAuthority(row, durableAuthority) &&
			row.releaseState !== "cancelled"
		) {
			throw new PhoneOperationError(
				"CREDENTIAL_NO_LONGER_AUTHORIZED",
				"This phone release belongs to a different or revoked credential authority",
			);
		}
		if (row.releaseState === "completed" || row.status === "released") {
			return adoptRequestReservation(row);
		}
		if (
			reason === "tenant_deleted" &&
			row.releaseReason === "user_requested" &&
			row.releaseState
		) {
			return takeOverUserReleaseForTenantDeletion(tx, joined, row);
		}
		if (row.releaseState === "revocation_pending") {
			throw new PhoneOperationError(
				"AUTHORITY_REVOKED_PENDING",
				"The admitting credential was revoked after a release effect; destructive continuation is blocked",
			);
		}
		if (
			row.releaseState === "cancelled" &&
			reason === "user_requested" &&
			durableAuthority
		) {
			if (!isReleasePriorPhoneStatus(row.status)) {
				throw new Error(
					"Phone release cannot preserve an unknown prior status",
				);
			}
			const source = await resolveReleaseSource(tx, row);
			const replacement: DurableCredentialAuthoritySnapshot = {
				...durableAuthority,
				revision: (row.releaseAuthorityRevision ?? 0) + 1,
			};
			const now = new Date();
			await settleLinkedDurableUsageInTransaction(tx, {
				organizationId: row.organizationId,
				usageReservationId: row.releaseUsageReservationId,
				committed: false,
			});
			const [restaged] = await tx
				.update(whatsappPhoneReleaseOperations)
				.set({
					...releaseAuthorityValues(replacement),
					releaseUsageReservationId: usageReservation?.id ?? null,
					releasePriorPhoneStatus: row.status,
					releaseAuthorityRevokedAt: null,
					releaseState:
						source || !row.waPhoneNumberId ? "pending" : "manual_review",
					releaseLeaseExpiresAt: null,
					releaseRequestMayHaveBeenSentAt: null,
					releaseAttempts: 0,
					releaseNextAttemptAt: now,
					releaseSourceAccountId: source?.id ?? null,
					releaseSourceTokenVersion: source?.tokenVersion ?? null,
					releaseAccessTokenCiphertext: source?.accessToken ?? null,
					releaseLastError:
						!source && row.waPhoneNumberId
							? "WhatsApp credential unavailable for mandatory deregistration"
							: null,
					releaseRequestedAt: now,
					updatedAt: now,
				})
				.where(
					and(
						eq(whatsappPhoneReleaseOperations.phoneNumberId, row.id),
						eq(whatsappPhoneReleaseOperations.releaseState, "cancelled"),
					),
				)
				.returning();
			if (!restaged) {
				throw new PhoneOperationError(
					"IN_PROGRESS",
					"Phone release authority changed while it was being restaged",
				);
			}
			const [restagedPhone] = await tx
				.update(whatsappPhoneNumbers)
				.set({ status: "releasing", updatedAt: now })
				.where(
					and(
						eq(whatsappPhoneNumbers.id, row.id),
						eq(whatsappPhoneNumbers.organizationId, row.organizationId),
						eq(whatsappPhoneNumbers.status, row.status),
					),
				)
				.returning();
			if (!restagedPhone) {
				throw new PhoneOperationError(
					"IN_PROGRESS",
					"Phone state changed while its release was being restaged",
				);
			}
			return adoptRequestReservation(
				combinePhoneRow({
					...joined,
					phone: restagedPhone,
					release: restaged,
				}),
			);
		}
		if (row.releaseState === "failed") {
			const [retryable] = await tx
				.update(whatsappPhoneReleaseOperations)
				.set({
					releaseState: "pending",
					releaseLeaseExpiresAt: null,
					releaseRequestMayHaveBeenSentAt: null,
					releaseNextAttemptAt: new Date(),
					releaseLastError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(whatsappPhoneReleaseOperations.phoneNumberId, row.id),
						eq(
							whatsappPhoneReleaseOperations.organizationId,
							row.organizationId,
						),
						eq(whatsappPhoneReleaseOperations.releaseState, "failed"),
						eq(
							whatsappPhoneReleaseOperations.releaseLeaseToken,
							row.releaseLeaseToken ?? -1,
						),
						row.releaseLeaseExpiresAt
							? eq(
									whatsappPhoneReleaseOperations.releaseLeaseExpiresAt,
									row.releaseLeaseExpiresAt,
								)
							: isNull(whatsappPhoneReleaseOperations.releaseLeaseExpiresAt),
						row.releaseRequestMayHaveBeenSentAt
							? eq(
									whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
									row.releaseRequestMayHaveBeenSentAt,
								)
							: isNull(
									whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
								),
						eq(
							whatsappPhoneReleaseOperations.releasePhase,
							row.releasePhase ?? "meta",
						),
					),
				)
				.returning();
			if (retryable) {
				return adoptRequestReservation(
					combinePhoneRow({ ...joined, release: retryable }),
				);
			}
			const current = await getPhoneRow(tx, row.id);
			if (!current) {
				throw new PhoneOperationError("NOT_FOUND", "Phone number not found");
			}
			return adoptRequestReservation(current);
		}
		// Unknown/manual-review operations must never be converted back to pending:
		// that would replay a provider call whose first outcome is ambiguous.
		if (row.releaseState) return adoptRequestReservation(row);
		const now = new Date();
		const provisioningComplete =
			row.provisioningState === "completed" ||
			row.provisioningState === "cancelled";
		const billingOnlyProvisioning =
			!provisioningComplete &&
			(row.provisioningPhase === "selected" ||
				row.provisioningPhase === "billing") &&
			!row.telnyxOrderId &&
			!row.providerNumberId &&
			!row.waPhoneNumberId;
		const provisioningSafeToCancel =
			!provisioningComplete &&
			(billingOnlyProvisioning ||
				((row.provisioningState === "pending" ||
					row.provisioningState === "failed") &&
					!row.provisioningRequestMayHaveBeenSentAt &&
					!row.telnyxOrderId &&
					!row.providerNumberId &&
					!row.stripePhoneSubscriptionId &&
					!row.stripeSubscriptionItemId &&
					!row.stripeCheckoutSessionId &&
					!row.waPhoneNumberId));
		const provisioningAmbiguous =
			!provisioningComplete && !provisioningSafeToCancel;
		const [fencedProvisioning] = await tx
			.update(whatsappPhoneProvisioningOperations)
			.set({
				provisioningLeaseToken: sql`${whatsappPhoneProvisioningOperations.provisioningLeaseToken} + 1`,
				provisioningLeaseExpiresAt: null,
				...(provisioningSafeToCancel || provisioningAmbiguous
					? {
							provisioningState: provisioningAmbiguous
								? "manual_review"
								: "cancelled",
							provisioningLastError: provisioningAmbiguous
								? "Tenant deletion fenced an incomplete provisioning operation with a potentially external outcome"
								: billingOnlyProvisioning
									? "Provisioning cancelled before telecom provider I/O; phone billing will converge during release"
									: "Provisioning cancelled before provider I/O",
							...(provisioningSafeToCancel
								? {
										provisioningVerifiedName: null,
										stripeCheckoutUrl: null,
										provisioningDetailExpiresAt: now,
										provisioningDetailRedactedAt: now,
									}
								: {}),
						}
					: {}),
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneProvisioningOperations.phoneNumberId, row.id),
					eq(
						whatsappPhoneProvisioningOperations.organizationId,
						row.organizationId,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningState,
						row.provisioningState,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningLeaseToken,
						row.provisioningLeaseToken,
					),
					eq(
						whatsappPhoneProvisioningOperations.provisioningPhase,
						row.provisioningPhase,
					),
					row.provisioningLeaseExpiresAt
						? eq(
								whatsappPhoneProvisioningOperations.provisioningLeaseExpiresAt,
								row.provisioningLeaseExpiresAt,
							)
						: isNull(
								whatsappPhoneProvisioningOperations.provisioningLeaseExpiresAt,
							),
					row.provisioningRequestMayHaveBeenSentAt
						? eq(
								whatsappPhoneProvisioningOperations.provisioningRequestMayHaveBeenSentAt,
								row.provisioningRequestMayHaveBeenSentAt,
							)
						: isNull(
								whatsappPhoneProvisioningOperations.provisioningRequestMayHaveBeenSentAt,
							),
				),
			)
			.returning();
		if (!fencedProvisioning) {
			const current = await getPhoneRow(tx, row.id);
			if (!current) {
				throw new PhoneOperationError("NOT_FOUND", "Phone number not found");
			}
			if (current.releaseState) return current;
			throw new PhoneOperationError(
				"IN_PROGRESS",
				"Phone provisioning advanced while release was being staged; retry with the same Idempotency-Key",
			);
		}
		const fencedRow = combinePhoneRow({
			phone: joined.phone,
			provisioning: fencedProvisioning,
			release: null,
		});
		if (fencedRow.status === "released") {
			return adoptRequestReservation(fencedRow);
		}
		if (!isReleasePriorPhoneStatus(fencedRow.status)) {
			throw new Error("Phone release cannot preserve an unknown prior status");
		}
		const priorPhoneStatus = fencedRow.status;
		const source = await resolveReleaseSource(tx, fencedRow);
		const [stagedPhone] = await tx
			.update(whatsappPhoneNumbers)
			.set({
				status: "releasing",
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneNumbers.id, fencedRow.id),
					eq(whatsappPhoneNumbers.organizationId, fencedRow.organizationId),
				),
			)
			.returning();
		if (!stagedPhone) throw new Error("Failed to stage phone release");
		const [staged] = await tx
			.insert(whatsappPhoneReleaseOperations)
			.values({
				phoneNumberId: fencedRow.id,
				organizationId,
				releaseUsageReservationId:
					reason === "user_requested" ? (usageReservation?.id ?? null) : null,
				releaseOperationId: generateId("wro_"),
				releaseReason: reason,
				...releaseAuthorityValues(durableAuthority),
				releasePriorPhoneStatus: priorPhoneStatus,
				releaseState: provisioningAmbiguous
					? "manual_review"
					: source || !row.waPhoneNumberId
						? "pending"
						: "manual_review",
				releasePhase: "meta",
				releaseMetaStatus: fencedRow.waPhoneNumberId
					? "pending"
					: "not_required",
				// Every hosted release must converge the organization authority even
				// when this row crashed before its Stripe identity was projected.
				releaseStripeStatus: "pending",
				releaseTelnyxStatus:
					fencedRow.providerNumberId || fencedRow.telnyxOrderId
						? "pending"
						: "not_required",
				releaseSourceAccountId: source?.id ?? null,
				releaseSourceTokenVersion: source?.tokenVersion ?? null,
				releaseAccessTokenCiphertext: source?.accessToken ?? null,
				releaseNextAttemptAt: now,
				releaseLastError: provisioningAmbiguous
					? "Incomplete provisioning has an ambiguous external outcome; correlate providers by provisioning operation ID"
					: !source && fencedRow.waPhoneNumberId
						? "WhatsApp credential unavailable for mandatory deregistration"
						: null,
				releaseRequestedAt: now,
				updatedAt: now,
			})
			.returning();
		if (!staged) throw new Error("Failed to stage phone release");
		return adoptRequestReservation(
			combinePhoneRow({
				phone: stagedPhone,
				provisioning: fencedProvisioning,
				release: staged,
			}),
		);
	});
}

export async function stageTenantPhoneReleases(
	db: Database,
	organizationId: string,
): Promise<PhoneRow[]> {
	const rows = await db
		.select({ id: whatsappPhoneNumbers.id })
		.from(whatsappPhoneNumbers)
		.leftJoin(
			whatsappPhoneReleaseOperations,
			eq(whatsappPhoneReleaseOperations.phoneNumberId, whatsappPhoneNumbers.id),
		)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				ne(whatsappPhoneNumbers.status, "released"),
				or(
					isNull(whatsappPhoneReleaseOperations.releaseOperationId),
					and(
						eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested"),
						ne(whatsappPhoneReleaseOperations.releaseState, "completed"),
					),
				),
			),
		)
		.orderBy(whatsappPhoneNumbers.id);
	const staged: PhoneRow[] = [];
	for (const row of rows) {
		staged.push(
			await stagePhoneRelease(db, organizationId, row.id, "tenant_deleted"),
		);
	}
	return staged;
}

export async function stageWorkspacePhoneReleases(
	db: Database,
	organizationId: string,
	workspaceId: string,
): Promise<PhoneRow[]> {
	const rows = await db
		.select({ id: whatsappPhoneNumbers.id })
		.from(whatsappPhoneNumbers)
		.innerJoin(
			whatsappPhoneProvisioningOperations,
			and(
				eq(
					whatsappPhoneProvisioningOperations.phoneNumberId,
					whatsappPhoneNumbers.id,
				),
				eq(whatsappPhoneProvisioningOperations.organizationId, organizationId),
			),
		)
		.innerJoin(
			socialAccounts,
			and(
				eq(
					socialAccounts.id,
					whatsappPhoneProvisioningOperations.provisioningSourceAccountId,
				),
				eq(socialAccounts.organizationId, organizationId),
			),
		)
		.leftJoin(
			whatsappPhoneReleaseOperations,
			eq(whatsappPhoneReleaseOperations.phoneNumberId, whatsappPhoneNumbers.id),
		)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				eq(socialAccounts.workspaceId, workspaceId),
				ne(whatsappPhoneNumbers.status, "released"),
				or(
					isNull(whatsappPhoneReleaseOperations.releaseOperationId),
					and(
						eq(whatsappPhoneReleaseOperations.releaseReason, "user_requested"),
						ne(whatsappPhoneReleaseOperations.releaseState, "completed"),
					),
				),
			),
		)
		.orderBy(whatsappPhoneNumbers.id);
	const staged: PhoneRow[] = [];
	for (const row of rows) {
		staged.push(
			await stagePhoneRelease(db, organizationId, row.id, "tenant_deleted"),
		);
	}
	return staged;
}

interface ReleaseClaim {
	row: PhoneRow;
	leaseToken: number;
}

async function claimRelease(
	db: Database,
	id: string,
): Promise<ReleaseClaim | null> {
	const now = new Date();
	const [claimed] = await db
		.update(whatsappPhoneReleaseOperations)
		.set({
			releaseState: "processing",
			releaseLeaseToken: sql`${whatsappPhoneReleaseOperations.releaseLeaseToken} + 1`,
			releaseLeaseExpiresAt: new Date(now.getTime() + RELEASE_LEASE_MS),
			releaseAttempts: sql`${whatsappPhoneReleaseOperations.releaseAttempts} + 1`,
			releaseLastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneReleaseOperations.phoneNumberId, id),
				or(
					eq(whatsappPhoneReleaseOperations.releaseState, "pending"),
					eq(whatsappPhoneReleaseOperations.releaseState, "failed"),
					and(
						eq(whatsappPhoneReleaseOperations.releaseState, "processing"),
						lte(whatsappPhoneReleaseOperations.releaseLeaseExpiresAt, now),
						isNull(
							whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
						),
					),
				),
			),
		)
		.returning();
	if (!claimed) return null;
	const row = await getPhoneRow(db, claimed.phoneNumberId);
	return row ? { row, leaseToken: claimed.releaseLeaseToken } : null;
}

async function markReleaseBoundary(
	db: Database,
	claim: ReleaseClaim,
	phase: "meta" | "stripe" | "telnyx",
): Promise<void> {
	const outcome = await db.transaction(async (tx) => {
		const snapshot = releaseAuthoritySnapshot(claim.row);
		const authority = snapshot
			? await revalidateDurableCredentialAuthority(
					tx,
					snapshot,
					"manage_billing",
				)
			: ({ ok: true, value: null } as const);
		const current = await getPhoneRow(tx, claim.row.id);
		if (
			!current ||
			current.releaseLeaseToken !== claim.leaseToken ||
			current.releaseState !== "processing" ||
			current.releasePhase !== phase ||
			current.releaseAuthorityRevision !== claim.row.releaseAuthorityRevision
		) {
			return { kind: "lease_lost" } as const;
		}
		const now = new Date();
		if (!authority.ok) {
			const hasEffect =
				current.releaseRequestMayHaveBeenSentAt !== null ||
				current.releaseMetaStatus === "confirmed" ||
				current.releaseStripeStatus === "confirmed" ||
				current.releaseTelnyxStatus === "confirmed";
			const state = hasEffect ? "revocation_pending" : "cancelled";
			const [revoked] = await tx
				.update(whatsappPhoneReleaseOperations)
				.set({
					releaseState: state,
					releaseAuthorityRevokedAt: now,
					releaseLeaseExpiresAt: null,
					releaseLastError: authority.message,
					...(hasEffect
						? {}
						: {
								releaseSourceAccountId: null,
								releaseSourceTokenVersion: null,
								releaseAccessTokenCiphertext: null,
							}),
					updatedAt: now,
				})
				.where(
					and(
						eq(whatsappPhoneReleaseOperations.phoneNumberId, current.id),
						eq(
							whatsappPhoneReleaseOperations.releaseLeaseToken,
							claim.leaseToken,
						),
						eq(whatsappPhoneReleaseOperations.releaseState, "processing"),
						eq(whatsappPhoneReleaseOperations.releasePhase, phase),
						claim.row.releaseAuthorityRevision === null
							? isNull(whatsappPhoneReleaseOperations.releaseAuthorityRevision)
							: eq(
									whatsappPhoneReleaseOperations.releaseAuthorityRevision,
									claim.row.releaseAuthorityRevision,
								),
					),
				)
				.returning({ id: whatsappPhoneReleaseOperations.releaseOperationId });
			if (!revoked) return { kind: "lease_lost" } as const;
			if (!hasEffect) {
				if (!current.releasePriorPhoneStatus) {
					throw new Error("Phone release lost its prior phone status");
				}
				await tx
					.update(whatsappPhoneNumbers)
					.set({ status: current.releasePriorPhoneStatus, updatedAt: now })
					.where(
						and(
							eq(whatsappPhoneNumbers.id, current.id),
							eq(whatsappPhoneNumbers.organizationId, current.organizationId),
						),
					);
			}
			return {
				kind: state,
				organizationId: current.organizationId,
				usageReservationId: current.releaseUsageReservationId,
			} as const;
		}
		const updated = await tx
			.update(whatsappPhoneReleaseOperations)
			.set({
				releaseState: "request_may_have_been_sent",
				releasePhase: phase,
				releaseRequestMayHaveBeenSentAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneReleaseOperations.phoneNumberId, claim.row.id),
					eq(
						whatsappPhoneReleaseOperations.releaseLeaseToken,
						claim.leaseToken,
					),
					eq(whatsappPhoneReleaseOperations.releaseState, "processing"),
					eq(whatsappPhoneReleaseOperations.releasePhase, phase),
					claim.row.releaseAuthorityRevision === null
						? isNull(whatsappPhoneReleaseOperations.releaseAuthorityRevision)
						: eq(
								whatsappPhoneReleaseOperations.releaseAuthorityRevision,
								claim.row.releaseAuthorityRevision,
							),
				),
			)
			.returning({ id: whatsappPhoneReleaseOperations.releaseOperationId });
		return updated.length === 1
			? ({ kind: "opened" } as const)
			: ({ kind: "lease_lost" } as const);
	});
	if (outcome.kind === "cancelled") {
		await settleLinkedDurableUsage(db, {
			organizationId: outcome.organizationId,
			usageReservationId: outcome.usageReservationId,
			committed: false,
		});
		throw new PhoneOperationError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"The release was cancelled because its admitting credential is no longer authorized",
		);
	}
	if (outcome.kind === "revocation_pending") {
		throw new PhoneOperationError(
			"AUTHORITY_REVOKED_PENDING",
			"The admitting credential was revoked after a release effect; destructive continuation is blocked",
		);
	}
	if (outcome.kind === "lease_lost")
		throw new Error("Phone release boundary fence lost");
}

async function confirmReleasePhase(
	db: Database,
	claim: ReleaseClaim,
	values: Partial<typeof whatsappPhoneReleaseOperations.$inferInsert>,
): Promise<void> {
	const updated = await db
		.update(whatsappPhoneReleaseOperations)
		.set({
			...values,
			releaseState: "processing",
			releaseRequestMayHaveBeenSentAt: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneReleaseOperations.phoneNumberId, claim.row.id),
				eq(whatsappPhoneReleaseOperations.releaseLeaseToken, claim.leaseToken),
				eq(
					whatsappPhoneReleaseOperations.releaseState,
					"request_may_have_been_sent",
				),
			),
		)
		.returning({ id: whatsappPhoneReleaseOperations.releaseOperationId });
	if (updated.length !== 1) throw new Error("Phone release phase fence lost");
}

async function advanceReleaseWithoutProviderBoundary(
	db: Database,
	claim: ReleaseClaim,
	phase: "meta" | "stripe" | "telnyx" | "completed",
	values: Partial<typeof whatsappPhoneReleaseOperations.$inferInsert>,
	phoneValues?: Partial<typeof whatsappPhoneNumbers.$inferInsert>,
): Promise<void> {
	const outcome = await db.transaction(async (tx) => {
		const snapshot = releaseAuthoritySnapshot(claim.row);
		const authority = snapshot
			? await revalidateDurableCredentialAuthority(
					tx,
					snapshot,
					"manage_billing",
				)
			: ({ ok: true, value: null } as const);
		const current = await getPhoneRow(tx, claim.row.id);
		if (
			!current ||
			current.releaseLeaseToken !== claim.leaseToken ||
			current.releaseState !== "processing" ||
			current.releasePhase !== phase ||
			current.releaseAuthorityRevision !== claim.row.releaseAuthorityRevision
		) {
			return { kind: "lease_lost" } as const;
		}
		const now = new Date();
		if (!authority.ok) {
			const hasEffect =
				current.releaseRequestMayHaveBeenSentAt !== null ||
				current.releaseMetaStatus === "confirmed" ||
				current.releaseStripeStatus === "confirmed" ||
				current.releaseTelnyxStatus === "confirmed";
			const state = hasEffect ? "revocation_pending" : "cancelled";
			const [revoked] = await tx
				.update(whatsappPhoneReleaseOperations)
				.set({
					releaseState: state,
					releaseAuthorityRevokedAt: now,
					releaseLeaseExpiresAt: null,
					releaseLastError: authority.message,
					...(hasEffect
						? {}
						: {
								releaseSourceAccountId: null,
								releaseSourceTokenVersion: null,
								releaseAccessTokenCiphertext: null,
							}),
					updatedAt: now,
				})
				.where(
					and(
						eq(whatsappPhoneReleaseOperations.phoneNumberId, current.id),
						eq(
							whatsappPhoneReleaseOperations.releaseLeaseToken,
							claim.leaseToken,
						),
						eq(whatsappPhoneReleaseOperations.releaseState, "processing"),
						eq(whatsappPhoneReleaseOperations.releasePhase, phase),
						claim.row.releaseAuthorityRevision === null
							? isNull(whatsappPhoneReleaseOperations.releaseAuthorityRevision)
							: eq(
									whatsappPhoneReleaseOperations.releaseAuthorityRevision,
									claim.row.releaseAuthorityRevision,
								),
					),
				)
				.returning({ id: whatsappPhoneReleaseOperations.releaseOperationId });
			if (!revoked) return { kind: "lease_lost" } as const;
			if (!hasEffect) {
				if (!current.releasePriorPhoneStatus) {
					throw new Error("Phone release lost its prior phone status");
				}
				await tx
					.update(whatsappPhoneNumbers)
					.set({ status: current.releasePriorPhoneStatus, updatedAt: now })
					.where(
						and(
							eq(whatsappPhoneNumbers.id, current.id),
							eq(whatsappPhoneNumbers.organizationId, current.organizationId),
						),
					);
			}
			return {
				kind: state,
				organizationId: current.organizationId,
				usageReservationId: current.releaseUsageReservationId,
			} as const;
		}
		const updated = await tx
			.update(whatsappPhoneReleaseOperations)
			.set({ ...values, updatedAt: now })
			.where(
				and(
					eq(whatsappPhoneReleaseOperations.phoneNumberId, claim.row.id),
					eq(
						whatsappPhoneReleaseOperations.releaseLeaseToken,
						claim.leaseToken,
					),
					eq(whatsappPhoneReleaseOperations.releaseState, "processing"),
					eq(whatsappPhoneReleaseOperations.releasePhase, phase),
					isNull(
						whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
					),
					claim.row.releaseAuthorityRevision === null
						? isNull(whatsappPhoneReleaseOperations.releaseAuthorityRevision)
						: eq(
								whatsappPhoneReleaseOperations.releaseAuthorityRevision,
								claim.row.releaseAuthorityRevision,
							),
				),
			)
			.returning({ id: whatsappPhoneReleaseOperations.releaseOperationId });
		if (updated.length === 1 && phoneValues) {
			const phoneUpdated = await tx
				.update(whatsappPhoneNumbers)
				.set({ ...phoneValues, updatedAt: now })
				.where(
					and(
						eq(whatsappPhoneNumbers.id, current.id),
						eq(whatsappPhoneNumbers.organizationId, current.organizationId),
						eq(whatsappPhoneNumbers.status, "releasing"),
					),
				)
				.returning({ id: whatsappPhoneNumbers.id });
			if (phoneUpdated.length !== 1) {
				throw new Error("Phone release projection fence lost");
			}
		}
		return updated.length === 1
			? ({ kind: "advanced" } as const)
			: ({ kind: "lease_lost" } as const);
	});
	if (outcome.kind === "cancelled") {
		await settleLinkedDurableUsage(db, {
			organizationId: outcome.organizationId,
			usageReservationId: outcome.usageReservationId,
			committed: false,
		});
		throw new PhoneOperationError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"The release was cancelled because its admitting credential is no longer authorized",
		);
	}
	if (outcome.kind === "revocation_pending") {
		throw new PhoneOperationError(
			"AUTHORITY_REVOKED_PENDING",
			"The admitting credential was revoked after a release effect; destructive continuation is blocked",
		);
	}
	if (outcome.kind === "lease_lost") {
		throw new Error("Phone release non-provider phase fence lost");
	}
}

async function loadReleaseAccessToken(
	env: Env,
	row: PhoneRow,
): Promise<string> {
	if (!row.releaseSourceAccountId || !row.releaseAccessTokenCiphertext) {
		throw new PhoneOperationError(
			"MANUAL_REVIEW_REQUIRED",
			"WhatsApp credential unavailable for mandatory deregistration",
		);
	}
	const token = await decryptAccountToken(
		row.releaseAccessTokenCiphertext,
		env.ENCRYPTION_KEY,
		row.releaseSourceAccountId,
		"access_token",
	);
	if (!token) throw new Error("WhatsApp release credential decrypted empty");
	return token;
}

async function failRelease(
	db: Database,
	claim: ReleaseClaim,
	error: unknown,
	boundaryOpen: boolean,
): Promise<void> {
	const manual =
		error instanceof PhoneOperationError &&
		error.code === "MANUAL_REVIEW_REQUIRED";
	const attempts = claim.row.releaseAttempts ?? 0;
	await db
		.update(whatsappPhoneReleaseOperations)
		.set({
			releaseState:
				manual || (!boundaryOpen && attempts >= MAX_RECONCILIATION_ATTEMPTS)
					? "manual_review"
					: boundaryOpen
						? "unknown"
						: "failed",
			releaseLeaseExpiresAt: null,
			releaseLastError: error instanceof Error ? error.message : String(error),
			releaseNextAttemptAt: new Date(Date.now() + delayForAttempt(attempts)),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneReleaseOperations.phoneNumberId, claim.row.id),
				eq(whatsappPhoneReleaseOperations.releaseLeaseToken, claim.leaseToken),
				inArray(whatsappPhoneReleaseOperations.releaseState, [
					"processing",
					"request_may_have_been_sent",
				]),
			),
		);
}

export async function processPhoneRelease(
	env: Env,
	db: Database,
	id: string,
): Promise<PhoneRow> {
	const before = await getPhoneRow(db, id);
	if (!before)
		throw new PhoneOperationError("NOT_FOUND", "Phone number not found");
	if (before.releaseState === "completed" || before.status === "released") {
		return before;
	}
	if (before.releaseState === "cancelled") {
		throw new PhoneOperationError(
			"CREDENTIAL_NO_LONGER_AUTHORIZED",
			"The release was cancelled because its admitting credential was revoked",
		);
	}
	if (before.releaseState === "revocation_pending") {
		throw new PhoneOperationError(
			"AUTHORITY_REVOKED_PENDING",
			"The admitting credential was revoked after a release effect; destructive continuation is blocked",
		);
	}
	if (before.releaseState === "manual_review") {
		throw new PhoneOperationError(
			"MANUAL_REVIEW_REQUIRED",
			"Phone release requires manual provider review",
		);
	}
	if (
		before.releaseState === "unknown" ||
		before.releaseState === "request_may_have_been_sent"
	) {
		throw new PhoneOperationError(
			"UNKNOWN_EXTERNAL_OUTCOME",
			"A provider release outcome is being reconciled",
		);
	}
	const claim = await claimRelease(db, id);
	if (!claim) {
		throw new PhoneOperationError(
			"IN_PROGRESS",
			"Phone release is already in progress",
		);
	}
	let row = claim.row;
	let boundaryOpen = false;

	try {
		if (row.releaseMetaStatus === "pending" && row.waPhoneNumberId) {
			const accessToken = await loadReleaseAccessToken(env, row);
			await markReleaseBoundary(db, claim, "meta");
			boundaryOpen = true;
			const response = await fetchWithTimeout(
				`${GRAPH_BASE.facebook}/${row.waPhoneNumberId}/deregister`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
					timeout: META_TIMEOUT_MS,
					timeoutThroughBody: true,
				},
			);
			if (!response.ok) {
				throw new Error(
					`Meta deregistration failed with HTTP ${response.status}`,
				);
			}
			const metaResult = await readResponseJson<{ success?: boolean }>(
				response,
				META_RESPONSE_MAX_BYTES,
			);
			if (metaResult.success !== true) {
				throw new Error("Meta deregistration did not return success=true");
			}
			await confirmReleasePhase(db, claim, {
				releaseMetaStatus: "confirmed",
				releasePhase: "stripe",
			});
			boundaryOpen = false;
			row = {
				...row,
				releaseMetaStatus: "confirmed",
				releasePhase: "stripe",
			};
		}
		if (row.releaseMetaStatus === "not_required") {
			await advanceReleaseWithoutProviderBoundary(db, claim, "meta", {
				releasePhase: "stripe",
			});
			row = { ...row, releasePhase: "stripe" };
		}

		if (row.releaseStripeStatus === "pending") {
			if (isSelfHosted(env)) {
				await advanceReleaseWithoutProviderBoundary(db, claim, "stripe", {
					releaseStripeStatus: "confirmed",
					releasePhase: "telnyx",
				});
				row = {
					...row,
					releaseStripeStatus: "confirmed",
					releasePhase: "telnyx",
				};
			} else {
				await markReleaseBoundary(db, claim, "stripe");
				boundaryOpen = true;
				let checkoutSessionId = row.stripeCheckoutSessionId;
				if (checkoutSessionId) {
					const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
					const session =
						await stripe.checkout.sessions.retrieve(checkoutSessionId);
					if (session.status === "open") {
						await stripe.checkout.sessions.expire(
							checkoutSessionId,
							{},
							{
								idempotencyKey: `wa-phone-release:${row.releaseOperationId}:checkout`,
							},
						);
						checkoutSessionId = null;
					}
				}

				const billing = await convergePhoneAddonBilling(env, db, {
					organizationId: row.organizationId,
					checkoutSessionId,
					allowCheckout: false,
				});
				if (billing.state !== "applied") {
					throw new PhoneOperationError(
						"IN_PROGRESS",
						"Phone add-on billing must settle before provider release can complete",
					);
				}
				await confirmReleasePhase(db, claim, {
					releaseStripeStatus: "confirmed",
					releasePhase: "telnyx",
				});
				boundaryOpen = false;
				row = {
					...row,
					releaseStripeStatus: "confirmed",
					releasePhase: "telnyx",
				};
			}
		}
		if (row.releaseStripeStatus === "not_required") {
			await advanceReleaseWithoutProviderBoundary(db, claim, "stripe", {
				releasePhase: "telnyx",
			});
			row = { ...row, releasePhase: "telnyx" };
		}

		if (row.releaseTelnyxStatus === "pending") {
			const telnyxApiKey = requireTelnyxApiKey(env);
			let providerNumberId = row.providerNumberId;
			if (
				providerNumberId &&
				!(await telnyxPhoneNumberExists(telnyxApiKey, providerNumberId))
			) {
				providerNumberId = null;
			}
			if (!providerNumberId) {
				const owned = await findOwnedPhoneNumber(telnyxApiKey, row.phoneNumber);
				providerNumberId = owned?.id ?? null;
			}
			if (providerNumberId) {
				await db.transaction(async (tx) => {
					const [fenced] = await tx
						.update(whatsappPhoneReleaseOperations)
						.set({ updatedAt: new Date() })
						.where(
							and(
								eq(whatsappPhoneReleaseOperations.phoneNumberId, row.id),
								eq(
									whatsappPhoneReleaseOperations.releaseLeaseToken,
									claim.leaseToken,
								),
								eq(whatsappPhoneReleaseOperations.releaseState, "processing"),
							),
						)
						.returning({
							id: whatsappPhoneReleaseOperations.releaseOperationId,
						});
					if (!fenced) throw new Error("Phone release lease lost");
					await tx
						.update(whatsappPhoneNumbers)
						.set({ providerNumberId, updatedAt: new Date() })
						.where(eq(whatsappPhoneNumbers.id, row.id));
				});
				await markReleaseBoundary(db, claim, "telnyx");
				boundaryOpen = true;
				try {
					await releaseNumber(telnyxApiKey, providerNumberId);
				} catch (error) {
					if (!(error instanceof TelnyxError && error.status === 404))
						throw error;
				}
				await confirmReleasePhase(db, claim, {
					releaseTelnyxStatus: "confirmed",
					releasePhase: "completed",
				});
				boundaryOpen = false;
			} else {
				await advanceReleaseWithoutProviderBoundary(db, claim, "telnyx", {
					releaseTelnyxStatus: "confirmed",
					releasePhase: "completed",
				});
			}
			row = {
				...row,
				releaseTelnyxStatus: "confirmed",
				releasePhase: "completed",
			};
		}
		if (row.releaseTelnyxStatus === "not_required") {
			await advanceReleaseWithoutProviderBoundary(db, claim, "telnyx", {
				releasePhase: "completed",
			});
			row = { ...row, releasePhase: "completed" };
		}

		const mandatoryComplete =
			["confirmed", "not_required"].includes(row.releaseMetaStatus ?? "") &&
			["confirmed", "not_required"].includes(row.releaseStripeStatus ?? "") &&
			["confirmed", "not_required"].includes(row.releaseTelnyxStatus ?? "");
		if (!mandatoryComplete) {
			throw new Error("Mandatory provider releases are not confirmed");
		}
		const now = new Date();
		await advanceReleaseWithoutProviderBoundary(
			db,
			claim,
			"completed",
			{
				releaseState: "completed",
				releasePhase: "completed",
				releaseLeaseExpiresAt: null,
				releaseRequestMayHaveBeenSentAt: null,
				releaseLastError: null,
				releaseSourceAccountId: null,
				releaseSourceTokenVersion: null,
				releaseAccessTokenCiphertext: null,
				releasedAt: now,
			},
			{ status: "released", socialAccountId: null },
		);
		const completed = await getPhoneRow(db, row.id);
		if (!completed) throw new Error("Released phone row disappeared");
		return completed;
	} catch (error) {
		await failRelease(db, claim, error, boundaryOpen).catch(() => {});
		throw error;
	}
}

export async function processDuePhoneReleases(
	env: Env,
	options: { organizationId?: string; limit?: number } = {},
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const conditions = [
		inArray(whatsappPhoneReleaseOperations.releaseState, [
			"pending",
			"failed",
			"unknown",
			"request_may_have_been_sent",
			"processing",
		]),
		or(
			isNull(whatsappPhoneReleaseOperations.releaseNextAttemptAt),
			lte(whatsappPhoneReleaseOperations.releaseNextAttemptAt, now),
		),
	];
	if (options.organizationId) {
		conditions.push(
			eq(whatsappPhoneReleaseOperations.organizationId, options.organizationId),
		);
	}
	const joinedRows = await db
		.select({
			phone: whatsappPhoneNumbers,
			provisioning: whatsappPhoneProvisioningOperations,
			release: whatsappPhoneReleaseOperations,
		})
		.from(whatsappPhoneReleaseOperations)
		.innerJoin(
			whatsappPhoneNumbers,
			and(
				eq(
					whatsappPhoneNumbers.id,
					whatsappPhoneReleaseOperations.phoneNumberId,
				),
				eq(
					whatsappPhoneNumbers.organizationId,
					whatsappPhoneReleaseOperations.organizationId,
				),
			),
		)
		.innerJoin(
			whatsappPhoneProvisioningOperations,
			and(
				eq(
					whatsappPhoneProvisioningOperations.phoneNumberId,
					whatsappPhoneNumbers.id,
				),
				eq(
					whatsappPhoneProvisioningOperations.organizationId,
					whatsappPhoneNumbers.organizationId,
				),
			),
		)
		.where(and(...conditions))
		.orderBy(
			whatsappPhoneReleaseOperations.releaseNextAttemptAt,
			whatsappPhoneReleaseOperations.phoneNumberId,
		)
		.limit(Math.min(options.limit ?? 5, 5));
	const rows = joinedRows.map(combinePhoneRow);

	for (const row of rows) {
		try {
			const expectedState = row.releaseState;
			if (!expectedState) continue;
			const snapshotFence = and(
				eq(whatsappPhoneReleaseOperations.phoneNumberId, row.id),
				eq(whatsappPhoneReleaseOperations.releaseState, expectedState),
				eq(
					whatsappPhoneReleaseOperations.releaseLeaseToken,
					row.releaseLeaseToken ?? -1,
				),
				row.releaseLeaseExpiresAt
					? eq(
							whatsappPhoneReleaseOperations.releaseLeaseExpiresAt,
							row.releaseLeaseExpiresAt,
						)
					: isNull(whatsappPhoneReleaseOperations.releaseLeaseExpiresAt),
				row.releaseRequestMayHaveBeenSentAt
					? eq(
							whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
							row.releaseRequestMayHaveBeenSentAt,
						)
					: isNull(
							whatsappPhoneReleaseOperations.releaseRequestMayHaveBeenSentAt,
						),
				row.releasePhase
					? eq(whatsappPhoneReleaseOperations.releasePhase, row.releasePhase)
					: isNull(whatsappPhoneReleaseOperations.releasePhase),
			);
			if (
				row.releaseState === "processing" &&
				row.releaseLeaseExpiresAt &&
				row.releaseLeaseExpiresAt <= now &&
				!row.releaseRequestMayHaveBeenSentAt
			) {
				const [recovered] = await db
					.update(whatsappPhoneReleaseOperations)
					.set({
						releaseState: "failed",
						releaseLeaseExpiresAt: null,
						releaseLastError:
							"Lease expired before provider boundary; safe to retry",
						updatedAt: now,
					})
					.where(snapshotFence)
					.returning({
						id: whatsappPhoneReleaseOperations.releaseOperationId,
					});
				if (!recovered) continue;
				await processPhoneRelease(env, db, row.id);
				continue;
			}
			if (
				row.releaseState === "unknown" ||
				row.releaseState === "request_may_have_been_sent"
			) {
				if (row.releasePhase === "meta") {
					// Meta has no provider idempotency key for deregistration and its
					// phone node can remain readable after deregistration. Do not guess.
					await db
						.update(whatsappPhoneReleaseOperations)
						.set({
							releaseState: "manual_review",
							releaseMetaStatus: "unknown",
							releaseLeaseExpiresAt: null,
							releaseLastError:
								"Meta deregistration outcome is ambiguous; automatic replay disabled",
							updatedAt: new Date(),
						})
						.where(snapshotFence)
						.returning({
							id: whatsappPhoneReleaseOperations.releaseOperationId,
						});
					continue;
				}
				if (row.releasePhase === "stripe") {
					const [recovered] = await db
						.update(whatsappPhoneReleaseOperations)
						.set({
							releaseState: "failed",
							releaseRequestMayHaveBeenSentAt: null,
							releaseLeaseExpiresAt: null,
							updatedAt: new Date(),
						})
						.where(snapshotFence)
						.returning({
							id: whatsappPhoneReleaseOperations.releaseOperationId,
						});
					if (!recovered) continue;
					await processPhoneRelease(env, db, row.id);
					continue;
				}
				if (row.releasePhase === "telnyx") {
					const telnyxApiKey = requireTelnyxApiKey(env);
					let providerNumberId = row.providerNumberId;
					if (
						providerNumberId &&
						!(await telnyxPhoneNumberExists(telnyxApiKey, providerNumberId))
					) {
						providerNumberId = null;
					}
					if (!providerNumberId) {
						providerNumberId =
							(await findOwnedPhoneNumber(telnyxApiKey, row.phoneNumber))?.id ??
							null;
					}
					const recovered = await db.transaction(async (tx) => {
						const [fenced] = await tx
							.update(whatsappPhoneReleaseOperations)
							.set({
								releaseState: "failed",
								releaseRequestMayHaveBeenSentAt: null,
								releaseLeaseExpiresAt: null,
								releaseTelnyxStatus: providerNumberId ? "pending" : "confirmed",
								releasePhase: providerNumberId ? "telnyx" : "completed",
								updatedAt: new Date(),
							})
							.where(snapshotFence)
							.returning({
								id: whatsappPhoneReleaseOperations.releaseOperationId,
							});
						if (!fenced) return null;
						await tx
							.update(whatsappPhoneNumbers)
							.set({ providerNumberId, updatedAt: new Date() })
							.where(eq(whatsappPhoneNumbers.id, row.id));
						return fenced;
					});
					if (!recovered) continue;
					await processPhoneRelease(env, db, row.id);
					continue;
				}
				if (row.releasePhase === "completed") {
					// Every provider phase is already confirmed. Only the final local
					// projection remains, so retry as a DB-only failed operation instead of
					// leaving an unreconcilable unknown state.
					const [recovered] = await db
						.update(whatsappPhoneReleaseOperations)
						.set({
							releaseState: "failed",
							releaseRequestMayHaveBeenSentAt: null,
							releaseLeaseExpiresAt: null,
							releaseLastError:
								"Provider releases are complete; retrying the local completion projection",
							updatedAt: new Date(),
						})
						.where(snapshotFence)
						.returning({
							id: whatsappPhoneReleaseOperations.releaseOperationId,
						});
					if (!recovered) continue;
					await processPhoneRelease(env, db, row.id);
					continue;
				}
			}
			await processPhoneRelease(env, db, row.id);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: "phone release reconciliation failed",
					phone_number_id: row.id,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}
}

export async function countIncompletePhoneReleases(
	db: Database,
	organizationId: string,
): Promise<{ incomplete: number; manualReview: number }> {
	const [incomplete, manual] = await Promise.all([
		db
			.select({ value: count() })
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.organizationId, organizationId),
					ne(whatsappPhoneNumbers.status, "released"),
				),
			),
		db
			.select({ value: count() })
			.from(whatsappPhoneReleaseOperations)
			.where(
				and(
					eq(whatsappPhoneReleaseOperations.organizationId, organizationId),
					eq(whatsappPhoneReleaseOperations.releaseState, "manual_review"),
				),
			),
	]);
	return {
		incomplete: incomplete[0]?.value ?? 0,
		manualReview: manual[0]?.value ?? 0,
	};
}

/**
 * Shred terminal checkout URLs after their seven-day response/recovery window.
 * The durable operation identity and provider receipt IDs remain available for
 * reconciliation; legal holds never extend bearer-like redirect material.
 */
export async function redactExpiredPhoneProvisioningDetails(
	env: Env,
	options?: { db?: Database; now?: Date },
): Promise<number> {
	const db = options?.db ?? createDb(env.HYPERDRIVE.connectionString);
	const now = options?.now ?? new Date();
	let redactedCount = 0;

	for (
		let pass = 0;
		pass < PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES;
		pass++
	) {
		const redacted = await db
			.update(whatsappPhoneProvisioningOperations)
			.set({
				stripeCheckoutUrl: null,
				provisioningDetailRedactedAt: now,
				updatedAt: now,
			})
			.where(
				inArray(
					whatsappPhoneProvisioningOperations.provisioningOperationId,
					db
						.select({
							id: whatsappPhoneProvisioningOperations.provisioningOperationId,
						})
						.from(whatsappPhoneProvisioningOperations)
						.where(
							and(
								inArray(whatsappPhoneProvisioningOperations.provisioningState, [
									"completed",
									"cancelled",
								]),
								lte(
									whatsappPhoneProvisioningOperations.provisioningDetailExpiresAt,
									now,
								),
								isNull(
									whatsappPhoneProvisioningOperations.provisioningDetailRedactedAt,
								),
							),
						)
						.orderBy(
							whatsappPhoneProvisioningOperations.provisioningDetailExpiresAt,
							whatsappPhoneProvisioningOperations.provisioningOperationId,
						)
						.limit(PHONE_PROVISIONING_DETAIL_REDACTION_BATCH),
				),
			)
			.returning({
				id: whatsappPhoneProvisioningOperations.provisioningOperationId,
			});
		redactedCount += redacted.length;
		if (redacted.length < PHONE_PROVISIONING_DETAIL_REDACTION_BATCH) break;
	}

	if (
		redactedCount ===
		PHONE_PROVISIONING_DETAIL_REDACTION_BATCH *
			PHONE_PROVISIONING_DETAIL_REDACTION_MAX_PASSES
	) {
		console.warn(
			JSON.stringify({
				message: "phone provisioning detail-redaction backlog remains",
				redacted_count: redactedCount,
			}),
		);
	}
	return redactedCount;
}
