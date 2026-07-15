import {
	createDb,
	type Database,
	eq,
	generateId,
	organization,
	organizationSubscriptions,
	socialAccounts,
	whatsappPhoneNumbers,
} from "@relayapi/db";
import { and, count, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { GRAPH_BASE } from "../config/api-versions";
import { decryptAccountToken } from "../lib/account-token-crypto";
import { durableOperationHashes } from "../lib/durable-operation";
import { readResponseJson } from "../lib/fetch-public-url";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import type { Env } from "../types";
import { createStripeClient } from "./stripe";
import {
	findNumberOrderByCustomerReference,
	findOwnedPhoneNumber,
	orderNumber,
	releaseNumber,
	TelnyxError,
	telnyxPhoneNumberExists,
} from "./telnyx";

const PROVISIONING_LEASE_MS = 2 * 60_000;
const RELEASE_LEASE_MS = 5 * 60_000;
const MAX_NUMBERS_PER_ORG = 5;
const MAX_RECONCILIATION_ATTEMPTS = 5;
const META_TIMEOUT_MS = 5_000;
const META_RESPONSE_MAX_BYTES = 256 * 1024;

type PhoneRow = typeof whatsappPhoneNumbers.$inferSelect;
type ReleaseReason = "user_requested" | "tenant_deleted";

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
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, options.organizationId),
				eq(whatsappPhoneNumbers.provisioningOperationKeyHash, operationKeyHash),
			),
		)
		.limit(1);
	if (!existing) return null;
	if (existing.provisioningRequestHash !== requestHash) {
		throw new PhoneOperationError(
			"IDEMPOTENCY_KEY_REUSED",
			"Idempotency-Key was already used with a different purchase request",
		);
	}
	return existing;
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

async function getPhoneRow(db: Database, id: string): Promise<PhoneRow | null> {
	const [row] = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(eq(whatsappPhoneNumbers.id, id))
		.limit(1);
	return row ?? null;
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
	const request = row.provisioningRequest as ProvisioningRequest;
	const sourceId = row.provisioningSourceAccountId;
	if (!sourceId) {
		throw new PhoneOperationError(
			"ACCOUNT_CREDENTIAL_UNAVAILABLE",
			"The WhatsApp credential needed to reconcile provisioning is unavailable",
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
	if (!account?.accessToken || accountWabaId !== request.waba_id) {
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
		wabaId: request.waba_id,
		verifiedName: request.verified_name,
	};
}

export async function createPhoneProvisioningOperation(
	db: Database,
	options: {
		organizationId: string;
		operationKey: string | undefined;
		phoneNumber: string;
		request: ProvisioningRequest;
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
			.select()
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.organizationId, options.organizationId),
					eq(
						whatsappPhoneNumbers.provisioningOperationKeyHash,
						operationKeyHash,
					),
				),
			)
			.limit(1);
		if (existing) {
			if (existing.provisioningRequestHash !== requestHash) {
				throw new PhoneOperationError(
					"IDEMPOTENCY_KEY_REUSED",
					"Idempotency-Key was already used with a different purchase request",
				);
			}
			return { row: existing, reused: true };
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

		const [inserted] = await tx
			.insert(whatsappPhoneNumbers)
			.values({
				organizationId: options.organizationId,
				phoneNumber: options.phoneNumber,
				provider: "telnyx",
				status: "purchasing",
				country: options.request.country,
				provisioningOperationKeyHash: operationKeyHash,
				provisioningRequestHash: requestHash,
				provisioningSourceAccountId: options.request.account_id,
				provisioningState: "pending",
				provisioningPhase: "selected",
				provisioningRequest: options.request,
				provisioningNextAttemptAt: new Date(),
			})
			.onConflictDoNothing()
			.returning();
		if (!inserted) {
			throw new PhoneOperationError(
				"IN_PROGRESS",
				"Another phone number operation is already in progress",
			);
		}
		return { row: inserted, reused: false };
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
		.update(whatsappPhoneNumbers)
		.set({
			provisioningState: "processing",
			provisioningLeaseToken: sql`${whatsappPhoneNumbers.provisioningLeaseToken} + 1`,
			provisioningLeaseExpiresAt: new Date(
				now.getTime() + PROVISIONING_LEASE_MS,
			),
			provisioningAttempts: sql`${whatsappPhoneNumbers.provisioningAttempts} + 1`,
			provisioningLastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneNumbers.id, id),
				or(
					eq(whatsappPhoneNumbers.provisioningState, "pending"),
					eq(whatsappPhoneNumbers.provisioningState, "failed"),
					and(
						eq(whatsappPhoneNumbers.provisioningState, "processing"),
						lte(whatsappPhoneNumbers.provisioningLeaseExpiresAt, now),
						isNull(whatsappPhoneNumbers.provisioningRequestMayHaveBeenSentAt),
					),
				),
			),
		)
		.returning();
	return claimed
		? { row: claimed, leaseToken: claimed.provisioningLeaseToken }
		: null;
}

async function markProvisioningBoundary(
	db: Database,
	claim: ProvisioningClaim,
	phase: "telnyx_order" | "billing" | "meta_registration",
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(whatsappPhoneNumbers)
		.set({
			provisioningState: "request_may_have_been_sent",
			provisioningPhase: phase,
			provisioningRequestMayHaveBeenSentAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneNumbers.id, claim.row.id),
				eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
				eq(whatsappPhoneNumbers.provisioningState, "processing"),
			),
		)
		.returning({ id: whatsappPhoneNumbers.id });
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
	values: Partial<typeof whatsappPhoneNumbers.$inferInsert>,
): Promise<void> {
	const updated = await db
		.update(whatsappPhoneNumbers)
		.set({
			...values,
			provisioningState: "processing",
			provisioningRequestMayHaveBeenSentAt: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneNumbers.id, claim.row.id),
				eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
				eq(
					whatsappPhoneNumbers.provisioningState,
					"request_may_have_been_sent",
				),
			),
		)
		.returning({ id: whatsappPhoneNumbers.id });
	if (updated.length !== 1) throw new Error("Provisioning phase fence lost");
}

async function failProvisioning(
	db: Database,
	claim: ProvisioningClaim,
	error: unknown,
	boundaryOpen: boolean,
): Promise<void> {
	const attempts = claim.row.provisioningAttempts + 1;
	await db
		.update(whatsappPhoneNumbers)
		.set({
			provisioningState: boundaryOpen ? "unknown" : "failed",
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
				eq(whatsappPhoneNumbers.id, claim.row.id),
				eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
				inArray(whatsappPhoneNumbers.provisioningState, [
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
	if (before.provisioningState === "waiting_external") {
		throw new PhoneOperationError(
			"TELNYX_ORDER_PENDING",
			"The Telnyx order is committed and awaiting provider activation",
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
					.update(whatsappPhoneNumbers)
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
							eq(whatsappPhoneNumbers.id, row.id),
							eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
							eq(whatsappPhoneNumbers.provisioningState, "processing"),
						),
					);
				throw new PhoneOperationError(
					"TELNYX_ORDER_PENDING",
					"The Telnyx order is committed and awaiting provider activation",
				);
			}
			const updated = await db
				.update(whatsappPhoneNumbers)
				.set({
					providerNumberId: owned.id,
					phoneNumber: owned.phoneNumber,
					provisioningPhase: "billing",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(whatsappPhoneNumbers.id, row.id),
						eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
					),
				)
				.returning({ id: whatsappPhoneNumbers.id });
			if (updated.length !== 1) throw new Error("Telnyx activation fence lost");
			row = {
				...row,
				providerNumberId: owned.id,
				phoneNumber: owned.phoneNumber,
				provisioningPhase: "billing",
			};
		}

		if (row.provisioningPhase === "billing") {
			const [subscription] = await db
				.select()
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.organizationId, row.organizationId))
				.limit(1);
			if (
				subscription?.stripeSubscriptionId &&
				env.STRIPE_WA_PHONE_PRICE_ID &&
				!row.stripeSubscriptionItemId
			) {
				await markProvisioningBoundary(db, claim, "billing");
				boundaryOpen = true;
				const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
				const item = await stripe.subscriptionItems.create(
					{
						subscription: subscription.stripeSubscriptionId,
						price: env.STRIPE_WA_PHONE_PRICE_ID,
						quantity: 1,
					},
					{
						idempotencyKey: `wa-phone-sub-item:${row.provisioningOperationId}`,
					},
				);
				await confirmProvisioningPhase(db, claim, {
					stripeSubscriptionItemId: item.id,
					provisioningPhase: "meta_registration",
				});
				boundaryOpen = false;
				row = {
					...row,
					stripeSubscriptionItemId: item.id,
					provisioningPhase: "meta_registration",
				};
			} else if (
				subscription?.stripeCustomerId &&
				env.STRIPE_WA_PHONE_PRICE_ID &&
				!row.stripeCheckoutUrl
			) {
				await markProvisioningBoundary(db, claim, "billing");
				boundaryOpen = true;
				const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
				const session = await stripe.checkout.sessions.create(
					{
						customer: subscription.stripeCustomerId,
						mode: "subscription",
						line_items: [{ price: env.STRIPE_WA_PHONE_PRICE_ID, quantity: 1 }],
						metadata: {
							type: "wa_phone_number",
							phoneNumberId: row.id,
							organizationId: row.organizationId,
							provisioningOperationId: row.provisioningOperationId,
						},
						success_url: `${env.API_BASE_URL ?? "https://api.relayapi.dev"}/v1/whatsapp/phone-numbers/${row.id}`,
						cancel_url: `${env.API_BASE_URL ?? "https://api.relayapi.dev"}/v1/whatsapp/phone-numbers/${row.id}`,
					},
					{
						idempotencyKey: `wa-phone-checkout:${row.provisioningOperationId}`,
					},
				);
				await confirmProvisioningPhase(db, claim, {
					stripeCheckoutSessionId: session.id,
					stripeCheckoutUrl: session.url,
					provisioningPhase: "meta_registration",
				});
				boundaryOpen = false;
				row = {
					...row,
					stripeCheckoutSessionId: session.id,
					stripeCheckoutUrl: session.url,
					provisioningPhase: "meta_registration",
				};
			} else {
				await db
					.update(whatsappPhoneNumbers)
					.set({
						provisioningPhase: "meta_registration",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneNumbers.id, row.id),
							eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
						),
					);
				row = { ...row, provisioningPhase: "meta_registration" };
			}
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
			const [completed] = await db
				.update(whatsappPhoneNumbers)
				.set({
					waPhoneNumberId: row.waPhoneNumberId,
					status: "pending_verification",
					provisioningState: "completed",
					provisioningPhase: "completed",
					provisioningLeaseExpiresAt: null,
					provisioningRequestMayHaveBeenSentAt: null,
					provisioningLastError: null,
					updatedAt: completedAt,
				})
				.where(
					and(
						eq(whatsappPhoneNumbers.id, row.id),
						eq(whatsappPhoneNumbers.provisioningLeaseToken, claim.leaseToken),
						eq(whatsappPhoneNumbers.provisioningState, "processing"),
					),
				)
				.returning();
			if (!completed) throw new Error("Provisioning completion fence lost");
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
		.update(whatsappPhoneNumbers)
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
				eq(whatsappPhoneNumbers.id, row.id),
				eq(whatsappPhoneNumbers.provisioningLeaseToken, leaseToken),
				eq(whatsappPhoneNumbers.provisioningState, "processing"),
			),
		);
}

export async function reconcilePhoneProvisioningOperations(
	env: Env,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const candidates = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				inArray(whatsappPhoneNumbers.provisioningState, [
					"unknown",
					"waiting_external",
					"request_may_have_been_sent",
					"processing",
				]),
				lte(whatsappPhoneNumbers.provisioningNextAttemptAt, now),
				or(
					inArray(whatsappPhoneNumbers.provisioningState, [
						"unknown",
						"waiting_external",
						"request_may_have_been_sent",
					]),
					lte(whatsappPhoneNumbers.provisioningLeaseExpiresAt, now),
				),
			),
		)
		.orderBy(
			whatsappPhoneNumbers.provisioningNextAttemptAt,
			whatsappPhoneNumbers.id,
		)
		.limit(5);

	for (const candidate of candidates) {
		if (
			candidate.provisioningState === "processing" &&
			!candidate.provisioningRequestMayHaveBeenSentAt
		) {
			await db
				.update(whatsappPhoneNumbers)
				.set({
					provisioningState: "failed",
					provisioningLeaseExpiresAt: null,
					provisioningLastError:
						"Lease expired outside a provider boundary; safe to resume",
					updatedAt: now,
				})
				.where(
					and(
						eq(whatsappPhoneNumbers.id, candidate.id),
						eq(
							whatsappPhoneNumbers.provisioningLeaseToken,
							candidate.provisioningLeaseToken,
						),
						eq(whatsappPhoneNumbers.provisioningState, "processing"),
						lte(whatsappPhoneNumbers.provisioningLeaseExpiresAt, now),
					),
				);
			continue;
		}

		const [operation] = await db
			.update(whatsappPhoneNumbers)
			.set({
				provisioningState: "processing",
				provisioningLeaseToken: sql`${whatsappPhoneNumbers.provisioningLeaseToken} + 1`,
				provisioningLeaseExpiresAt: new Date(
					now.getTime() + PROVISIONING_LEASE_MS,
				),
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneNumbers.id, candidate.id),
					eq(
						whatsappPhoneNumbers.provisioningLeaseToken,
						candidate.provisioningLeaseToken,
					),
					inArray(whatsappPhoneNumbers.provisioningState, [
						"unknown",
						"waiting_external",
						"request_may_have_been_sent",
						"processing",
					]),
				),
			)
			.returning();
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
					await db
						.update(whatsappPhoneNumbers)
						.set({ telnyxOrderId, phoneNumber, updatedAt: new Date() })
						.where(
							and(
								eq(whatsappPhoneNumbers.id, operation.id),
								eq(
									whatsappPhoneNumbers.provisioningLeaseToken,
									operation.provisioningLeaseToken,
								),
								eq(whatsappPhoneNumbers.provisioningState, "processing"),
							),
						);
					await deferProvisioningReconciliation(
						db,
						operation,
						operation.provisioningLeaseToken,
						"Telnyx order is awaiting phone-number activation",
						true,
					);
					continue;
				}

				await db
					.update(whatsappPhoneNumbers)
					.set({
						telnyxOrderId,
						providerNumberId: owned.id,
						phoneNumber: owned.phoneNumber,
						provisioningState: "failed",
						provisioningPhase: "billing",
						provisioningRequestMayHaveBeenSentAt: null,
						provisioningLeaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneNumbers.id, operation.id),
							eq(
								whatsappPhoneNumbers.provisioningLeaseToken,
								operation.provisioningLeaseToken,
							),
							eq(whatsappPhoneNumbers.provisioningState, "processing"),
						),
					);
				await continuePhoneProvisioning(env, db, operation.id);
				continue;
			}

			if (operation.provisioningPhase === "billing") {
				// Stripe mutations are keyed by the durable operation ID, so a replay
				// of this specific phase is provider-idempotent.
				await db
					.update(whatsappPhoneNumbers)
					.set({
						provisioningState: "failed",
						provisioningRequestMayHaveBeenSentAt: null,
						provisioningLeaseExpiresAt: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneNumbers.id, operation.id),
							eq(
								whatsappPhoneNumbers.provisioningLeaseToken,
								operation.provisioningLeaseToken,
							),
							eq(whatsappPhoneNumbers.provisioningState, "processing"),
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
				await db
					.update(whatsappPhoneNumbers)
					.set({
						waPhoneNumberId: existing.id,
						status: "pending_verification",
						provisioningState: "completed",
						provisioningPhase: "completed",
						provisioningRequestMayHaveBeenSentAt: null,
						provisioningLeaseExpiresAt: null,
						provisioningLastError: null,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneNumbers.id, operation.id),
							eq(
								whatsappPhoneNumbers.provisioningLeaseToken,
								operation.provisioningLeaseToken,
							),
							eq(whatsappPhoneNumbers.provisioningState, "processing"),
						),
					);
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
	const request = row.provisioningRequest as ProvisioningRequest | null;
	if (!sourceAccountId || !request?.waba_id) return null;
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
		.limit(1);
	const accountWabaId = (account?.metadata as { waba_id?: string } | null)
		?.waba_id;
	return account?.accessToken && accountWabaId === request.waba_id
		? account
		: null;
}

export async function stagePhoneRelease(
	db: Database,
	organizationId: string,
	phoneId: string,
	reason: ReleaseReason,
): Promise<PhoneRow> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select()
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.id, phoneId),
					eq(whatsappPhoneNumbers.organizationId, organizationId),
				),
			)
			.for("update")
			.limit(1);
		if (!row)
			throw new PhoneOperationError("NOT_FOUND", "Phone number not found");
		if (row.releaseState === "completed" || row.status === "released")
			return row;
		if (row.releaseState === "failed") {
			const [retryable] = await tx
				.update(whatsappPhoneNumbers)
				.set({
					releaseState: "pending",
					releaseLeaseExpiresAt: null,
					releaseNextAttemptAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(whatsappPhoneNumbers.id, row.id))
				.returning();
			return retryable ?? row;
		}
		// Unknown/manual-review operations must never be converted back to pending:
		// that would replay a provider call whose first outcome is ambiguous.
		if (row.releaseState) return row;
		const source = await resolveReleaseSource(tx, row);
		const now = new Date();
		const provisioningComplete =
			row.provisioningState === "completed" ||
			row.provisioningState === "cancelled";
		const provisioningSafeToCancel =
			!provisioningComplete &&
			(row.provisioningState === "pending" ||
				row.provisioningState === "failed") &&
			!row.provisioningRequestMayHaveBeenSentAt &&
			!row.telnyxOrderId &&
			!row.providerNumberId &&
			!row.stripeSubscriptionItemId &&
			!row.stripeCheckoutSessionId &&
			!row.waPhoneNumberId;
		const provisioningAmbiguous =
			!provisioningComplete && !provisioningSafeToCancel;
		const [staged] = await tx
			.update(whatsappPhoneNumbers)
			.set({
				status: "releasing",
				...(provisioningSafeToCancel || provisioningAmbiguous
					? {
							provisioningState: provisioningAmbiguous
								? ("manual_review" as const)
								: ("cancelled" as const),
							provisioningLeaseToken: sql`${whatsappPhoneNumbers.provisioningLeaseToken} + 1`,
							provisioningLeaseExpiresAt: null,
							provisioningLastError: provisioningAmbiguous
								? "Tenant deletion fenced an incomplete provisioning operation with a potentially external outcome"
								: "Provisioning cancelled before provider I/O",
						}
					: {}),
				releaseOperationId: row.releaseOperationId ?? generateId("wro_"),
				releaseReason: reason,
				releaseState: provisioningAmbiguous
					? "manual_review"
					: source || !row.waPhoneNumberId
						? "pending"
						: "manual_review",
				releasePhase: "meta",
				releaseMetaStatus: row.waPhoneNumberId ? "pending" : "not_required",
				releaseStripeStatus:
					row.stripeSubscriptionItemId || row.stripeCheckoutSessionId
						? "pending"
						: "not_required",
				releaseTelnyxStatus:
					row.providerNumberId || row.telnyxOrderId
						? "pending"
						: "not_required",
				releaseSourceAccountId: source?.id ?? null,
				releaseSourceTokenVersion: source?.tokenVersion ?? null,
				releaseAccessTokenCiphertext: source?.accessToken ?? null,
				releaseNextAttemptAt: now,
				releaseLastError: provisioningAmbiguous
					? "Incomplete provisioning has an ambiguous external outcome; correlate providers by provisioning operation ID"
					: !source && row.waPhoneNumberId
						? "WhatsApp credential unavailable for mandatory deregistration"
						: null,
				releaseRequestedAt: row.releaseRequestedAt ?? now,
				updatedAt: now,
			})
			.where(eq(whatsappPhoneNumbers.id, row.id))
			.returning();
		if (!staged) throw new Error("Failed to stage phone release");
		return staged;
	});
}

export async function stageTenantPhoneReleases(
	db: Database,
	organizationId: string,
): Promise<PhoneRow[]> {
	const rows = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				ne(whatsappPhoneNumbers.status, "released"),
				isNull(whatsappPhoneNumbers.releaseState),
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
			socialAccounts,
			and(
				eq(socialAccounts.id, whatsappPhoneNumbers.provisioningSourceAccountId),
				eq(socialAccounts.organizationId, organizationId),
			),
		)
		.where(
			and(
				eq(whatsappPhoneNumbers.organizationId, organizationId),
				eq(socialAccounts.workspaceId, workspaceId),
				ne(whatsappPhoneNumbers.status, "released"),
				isNull(whatsappPhoneNumbers.releaseState),
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
		.update(whatsappPhoneNumbers)
		.set({
			releaseState: "processing",
			releaseLeaseToken: sql`${whatsappPhoneNumbers.releaseLeaseToken} + 1`,
			releaseLeaseExpiresAt: new Date(now.getTime() + RELEASE_LEASE_MS),
			releaseAttempts: sql`${whatsappPhoneNumbers.releaseAttempts} + 1`,
			releaseLastError: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneNumbers.id, id),
				or(
					eq(whatsappPhoneNumbers.releaseState, "pending"),
					eq(whatsappPhoneNumbers.releaseState, "failed"),
					and(
						eq(whatsappPhoneNumbers.releaseState, "processing"),
						lte(whatsappPhoneNumbers.releaseLeaseExpiresAt, now),
						isNull(whatsappPhoneNumbers.releaseRequestMayHaveBeenSentAt),
					),
				),
			),
		)
		.returning();
	return claimed
		? { row: claimed, leaseToken: claimed.releaseLeaseToken }
		: null;
}

async function markReleaseBoundary(
	db: Database,
	claim: ReleaseClaim,
	phase: "meta" | "stripe" | "telnyx",
): Promise<void> {
	const now = new Date();
	const updated = await db
		.update(whatsappPhoneNumbers)
		.set({
			releaseState: "request_may_have_been_sent",
			releasePhase: phase,
			releaseRequestMayHaveBeenSentAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(whatsappPhoneNumbers.id, claim.row.id),
				eq(whatsappPhoneNumbers.releaseLeaseToken, claim.leaseToken),
				eq(whatsappPhoneNumbers.releaseState, "processing"),
			),
		)
		.returning({ id: whatsappPhoneNumbers.id });
	if (updated.length !== 1)
		throw new Error("Phone release boundary fence lost");
}

async function confirmReleasePhase(
	db: Database,
	claim: ReleaseClaim,
	values: Partial<typeof whatsappPhoneNumbers.$inferInsert>,
): Promise<void> {
	const updated = await db
		.update(whatsappPhoneNumbers)
		.set({
			...values,
			releaseState: "processing",
			releaseRequestMayHaveBeenSentAt: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(whatsappPhoneNumbers.id, claim.row.id),
				eq(whatsappPhoneNumbers.releaseLeaseToken, claim.leaseToken),
				eq(whatsappPhoneNumbers.releaseState, "request_may_have_been_sent"),
			),
		)
		.returning({ id: whatsappPhoneNumbers.id });
	if (updated.length !== 1) throw new Error("Phone release phase fence lost");
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
	const attempts = claim.row.releaseAttempts + 1;
	await db
		.update(whatsappPhoneNumbers)
		.set({
			releaseState: manual
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
				eq(whatsappPhoneNumbers.id, claim.row.id),
				eq(whatsappPhoneNumbers.releaseLeaseToken, claim.leaseToken),
				inArray(whatsappPhoneNumbers.releaseState, [
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
			row = { ...row, releasePhase: "stripe" };
		}

		if (row.releaseStripeStatus === "pending") {
			await markReleaseBoundary(db, claim, "stripe");
			boundaryOpen = true;
			try {
				const stripe = await createStripeClient(env.STRIPE_SECRET_KEY);
				if (row.stripeSubscriptionItemId) {
					await stripe.subscriptionItems.del(
						row.stripeSubscriptionItemId,
						{},
						{
							idempotencyKey: `wa-phone-release:${row.releaseOperationId}:stripe-item`,
						},
					);
				}
				if (row.stripeCheckoutSessionId) {
					const session = await stripe.checkout.sessions.retrieve(
						row.stripeCheckoutSessionId,
					);
					if (session.status === "open") {
						await stripe.checkout.sessions.expire(
							row.stripeCheckoutSessionId,
							{},
							{
								idempotencyKey: `wa-phone-release:${row.releaseOperationId}:checkout`,
							},
						);
					} else if (session.status === "complete") {
						throw new PhoneOperationError(
							"MANUAL_REVIEW_REQUIRED",
							"Completed phone checkout requires billing reconciliation before release",
						);
					}
				}
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
		if (row.releaseStripeStatus === "not_required") {
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
				await db
					.update(whatsappPhoneNumbers)
					.set({ providerNumberId, updatedAt: new Date() })
					.where(
						and(
							eq(whatsappPhoneNumbers.id, row.id),
							eq(whatsappPhoneNumbers.releaseLeaseToken, claim.leaseToken),
							eq(whatsappPhoneNumbers.releaseState, "processing"),
						),
					);
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
				await db
					.update(whatsappPhoneNumbers)
					.set({
						releaseTelnyxStatus: "confirmed",
						releasePhase: "completed",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(whatsappPhoneNumbers.id, row.id),
							eq(whatsappPhoneNumbers.releaseLeaseToken, claim.leaseToken),
						),
					);
			}
			row = {
				...row,
				releaseTelnyxStatus: "confirmed",
				releasePhase: "completed",
			};
		}

		const mandatoryComplete =
			["confirmed", "not_required"].includes(row.releaseMetaStatus ?? "") &&
			["confirmed", "not_required"].includes(row.releaseStripeStatus ?? "") &&
			["confirmed", "not_required"].includes(row.releaseTelnyxStatus ?? "");
		if (!mandatoryComplete) {
			throw new Error("Mandatory provider releases are not confirmed");
		}
		const now = new Date();
		const [completed] = await db
			.update(whatsappPhoneNumbers)
			.set({
				status: "released",
				socialAccountId: null,
				releaseState: "completed",
				releasePhase: "completed",
				releaseLeaseExpiresAt: null,
				releaseRequestMayHaveBeenSentAt: null,
				releaseLastError: null,
				releaseAccessTokenCiphertext: null,
				releasedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(whatsappPhoneNumbers.id, row.id),
					eq(whatsappPhoneNumbers.releaseLeaseToken, claim.leaseToken),
					eq(whatsappPhoneNumbers.releaseState, "processing"),
				),
			)
			.returning();
		if (!completed) throw new Error("Phone release completion fence lost");
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
		inArray(whatsappPhoneNumbers.releaseState, [
			"pending",
			"failed",
			"unknown",
			"request_may_have_been_sent",
			"processing",
		]),
		or(
			isNull(whatsappPhoneNumbers.releaseNextAttemptAt),
			lte(whatsappPhoneNumbers.releaseNextAttemptAt, now),
		),
	];
	if (options.organizationId) {
		conditions.push(
			eq(whatsappPhoneNumbers.organizationId, options.organizationId),
		);
	}
	const rows = await db
		.select()
		.from(whatsappPhoneNumbers)
		.where(and(...conditions))
		.orderBy(whatsappPhoneNumbers.releaseNextAttemptAt, whatsappPhoneNumbers.id)
		.limit(Math.min(options.limit ?? 5, 5));

	for (const row of rows) {
		try {
			const expectedState = row.releaseState;
			if (!expectedState) continue;
			const snapshotFence = and(
				eq(whatsappPhoneNumbers.id, row.id),
				eq(whatsappPhoneNumbers.releaseState, expectedState),
				eq(whatsappPhoneNumbers.releaseLeaseToken, row.releaseLeaseToken),
				row.releaseLeaseExpiresAt
					? eq(
							whatsappPhoneNumbers.releaseLeaseExpiresAt,
							row.releaseLeaseExpiresAt,
						)
					: isNull(whatsappPhoneNumbers.releaseLeaseExpiresAt),
				row.releaseRequestMayHaveBeenSentAt
					? eq(
							whatsappPhoneNumbers.releaseRequestMayHaveBeenSentAt,
							row.releaseRequestMayHaveBeenSentAt,
						)
					: isNull(whatsappPhoneNumbers.releaseRequestMayHaveBeenSentAt),
				row.releasePhase
					? eq(whatsappPhoneNumbers.releasePhase, row.releasePhase)
					: isNull(whatsappPhoneNumbers.releasePhase),
			);
			if (
				row.releaseState === "processing" &&
				row.releaseLeaseExpiresAt &&
				row.releaseLeaseExpiresAt <= now &&
				!row.releaseRequestMayHaveBeenSentAt
			) {
				const [recovered] = await db
					.update(whatsappPhoneNumbers)
					.set({
						releaseState: "failed",
						releaseLeaseExpiresAt: null,
						releaseLastError:
							"Lease expired before provider boundary; safe to retry",
						updatedAt: now,
					})
					.where(snapshotFence)
					.returning({ id: whatsappPhoneNumbers.id });
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
						.update(whatsappPhoneNumbers)
						.set({
							releaseState: "manual_review",
							releaseMetaStatus: "unknown",
							releaseLeaseExpiresAt: null,
							releaseLastError:
								"Meta deregistration outcome is ambiguous; automatic replay disabled",
							updatedAt: new Date(),
						})
						.where(snapshotFence)
						.returning({ id: whatsappPhoneNumbers.id });
					continue;
				}
				if (row.releasePhase === "stripe") {
					const [recovered] = await db
						.update(whatsappPhoneNumbers)
						.set({
							releaseState: "failed",
							releaseRequestMayHaveBeenSentAt: null,
							releaseLeaseExpiresAt: null,
							updatedAt: new Date(),
						})
						.where(snapshotFence)
						.returning({ id: whatsappPhoneNumbers.id });
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
					const [recovered] = await db
						.update(whatsappPhoneNumbers)
						.set({
							releaseState: "failed",
							releaseRequestMayHaveBeenSentAt: null,
							releaseLeaseExpiresAt: null,
							providerNumberId,
							releaseTelnyxStatus: providerNumberId ? "pending" : "confirmed",
							releasePhase: providerNumberId ? "telnyx" : "completed",
							updatedAt: new Date(),
						})
						.where(snapshotFence)
						.returning({ id: whatsappPhoneNumbers.id });
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
			.from(whatsappPhoneNumbers)
			.where(
				and(
					eq(whatsappPhoneNumbers.organizationId, organizationId),
					eq(whatsappPhoneNumbers.releaseState, "manual_review"),
				),
			),
	]);
	return {
		incomplete: incomplete[0]?.value ?? 0,
		manualReview: manual[0]?.value ?? 0,
	};
}
