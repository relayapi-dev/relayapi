import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
	adAccounts,
	adCampaigns,
	createDb,
	socialAccounts,
	whatsappPhoneNumbers,
} from "@relayapi/db";
import { GRAPH_BASE } from "../src/config/api-versions";
import {
	STRIPE_MANAGED_BY_KEY,
	STRIPE_MANAGED_BY_VALUE,
	STRIPE_SUBSCRIPTION_ROLE_KEY,
} from "../src/config/billing";
import { decryptAccountToken } from "../src/lib/account-token-crypto";
import {
	getMetaAdsUserAccessToken,
	resolveAdsAccessToken,
} from "../src/services/ad-access-token";
import { createStripeClient } from "../src/services/stripe";
import {
	listNumberOrders,
	listOwnedPhoneNumbers,
} from "../src/services/telnyx";
import type { Env } from "../src/types";

const CONNECTION_ENV =
	"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
const GRAPH_PAGE_LIMIT = 10_000;
const GRAPH_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const TELNYX_API_BASE = "https://api.telnyx.com/v2";
const TELNYX_PAGE_LIMIT = 10_000;
const TELNYX_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;

type ProviderBlocker = {
	provider: "stripe" | "telnyx" | "meta";
	kind: string;
	id: string;
	status: string | null;
	managed: boolean;
};

type StripeCustomer = {
	id: string;
	deleted?: boolean;
	balance: number;
	currency?: string | null;
	invoice_credit_balance?: Record<string, number>;
	metadata?: Record<string, string> | null;
};

type StripeSubscription = {
	id: string;
	customer: string | { id: string };
	status: string;
	metadata?: Record<string, string> | null;
	cancel_at_period_end?: boolean;
	items: {
		data: Array<{
			id: string;
			quantity?: number | null;
			price: { id: string };
		}>;
	};
};

type StripeCheckoutSession = {
	id: string;
	customer: string | { id: string } | null;
	status: string | null;
	payment_status: string;
	mode: string;
	subscription: string | { id: string } | null;
	metadata?: Record<string, string> | null;
};

type StripeInvoice = {
	id: string;
	customer: string | { id: string } | null;
	subscription?: string | { id: string } | null;
	status: string | null;
	currency: string;
	amount_due: number;
	metadata?: Record<string, string> | null;
};

type StripeInvoiceItem = {
	id: string;
	customer: string | { id: string };
	invoice: string | { id: string } | null;
	subscription?: string | { id: string } | null;
	currency: string;
	amount: number;
	metadata?: Record<string, string> | null;
};

type StripeSubscriptionSchedule = {
	id: string;
	customer: string | { id: string } | null;
	status: string;
	subscription?: string | { id: string } | null;
	released_subscription?: string | { id: string } | null;
	metadata?: Record<string, string> | null;
};

type StripePaymentIntent = {
	id: string;
	customer: string | { id: string } | null;
	status: string;
	amount: number;
	currency: string;
	metadata?: Record<string, string> | null;
};

type StripeCharge = {
	id: string;
	amount: number;
	amount_captured: number;
	amount_refunded: number;
	currency: string;
	status: string;
	paid: boolean;
	captured: boolean;
	disputed: boolean;
	refunded: boolean;
	customer?: string | { id: string } | null;
	payment_intent?: string | { id: string } | null;
	metadata?: Record<string, string> | null;
};

type StripeRefund = {
	id: string;
	status: string | null;
	amount: number;
	currency: string;
	charge: string | { id: string } | null;
	payment_intent: string | { id: string } | null;
	metadata?: Record<string, string> | null;
};

type StripeDispute = {
	id: string;
	status: string;
	amount: number;
	currency: string;
	charge: string | { id: string };
	payment_intent?: string | { id: string } | null;
	metadata?: Record<string, string> | null;
};

type StripePaymentLink = {
	id: string;
	active: boolean;
	metadata?: Record<string, string> | null;
};

type StripeSetupIntent = {
	id: string;
	customer: string | { id: string } | null;
	status: string;
	payment_method_types: string[];
	metadata?: Record<string, string> | null;
};

type StripeTopup = {
	id: string;
	status: string;
	amount: number;
	currency: string;
	metadata?: Record<string, string> | null;
};

type StripePayout = {
	id: string;
	status: string;
	amount: number;
	currency: string;
	automatic?: boolean;
	metadata?: Record<string, string> | null;
};

type StripeBalanceAmount = {
	amount: number;
	currency: string;
};

export type TelnyxFutureMoneyAllocations = {
	balance: {
		balance: string | null;
		pending: string | null;
		creditLimit: string | null;
		availableCredit: string | null;
		currency: string | null;
	};
	numberBlockOrders: Array<{
		id: string;
		status: string | null;
		customerReference: string | null;
		startingNumber: string | null;
		range: number | null;
		phoneNumbersCount: number | null;
		updatedAt: string | null;
	}>;
	advancedOrders: Array<{
		id: string;
		statuses: string[];
		customerReference: string | null;
		quantity: number | null;
		numberOrderIds: string[];
	}>;
	inexplicitNumberOrders: Array<{
		id: string;
		customerReference: string | null;
		updatedAt: string | null;
		orderingGroups: Array<{
			index: number;
			status: string | null;
			countRequested: number | null;
			countAllocated: number | null;
			numberOrderIds: string[];
		}>;
	}>;
	portingOrders: Array<{
		id: string;
		status: string | null;
		customerReference: string | null;
		phoneNumbersCount: number | null;
		updatedAt: string | null;
	}>;
	portingPhoneNumbers: Array<{
		portingOrderId: string;
		phoneNumber: string;
		portingOrderStatus: string | null;
		activationStatus: string | null;
	}>;
	portOuts: Array<{
		id: string;
		status: string | null;
		hostMessaging: boolean | null;
		phoneNumbers: string[];
		updatedAt: string | null;
	}>;
};

export type ProviderInventorySources = {
	socialAccounts: Array<{
		id: string;
		organizationId: string;
		platform: string;
		accessToken: string | null;
		tokenVersion: number;
		metadata: unknown;
		lifecycleStatus: string;
	}>;
	adAccounts: Array<{
		id: string;
		organizationId: string;
		socialAccountId: string | null;
		platform: string;
		platformAdAccountId: string;
		status: string | null;
	}>;
	adCampaigns: Array<{
		id: string;
		organizationId: string;
		adAccountId: string;
		platform: string;
		platformCampaignId: string | null;
		status: string;
	}>;
	whatsappPhoneNumbers: Array<{
		id: string;
		organizationId: string;
		socialAccountId: string | null;
		providerNumberId: string | null;
		waPhoneNumberId: string | null;
		status: string;
	}>;
};

export type PreliveProviderInventory = {
	schemaVersion: 2;
	targetBaselineGeneration: 2;
	scope: "relayapi_integrated_provider_money_surfaces";
	stripe: {
		terminalReversalPolicy:
			| "block_terminal_history"
			| "accept_network_reversal_tail";
		account: {
			id: string;
			country: string | null;
			defaultCurrency: string | null;
			livemode: boolean;
			payoutScheduleInterval: string | null;
			debitNegativeBalances: boolean | null;
		};
		attestations: {
			bankTransferFundingInstructions: "never_enabled";
			legacyReceiverSources: "never_enabled";
			connect: "never_enabled";
			livePricingTables: "none";
			accountDedicatedToRelayapi: true;
			unsupportedProductsDisabled: true;
		};
		customers: Array<{
			id: string;
			organizationId: string | null;
			managed: boolean;
			balance: number;
			currency: string | null;
			invoiceCreditBalance: Array<{ currency: string; amount: number }>;
		}>;
		subscriptions: Array<{
			id: string;
			customerId: string;
			status: string;
			organizationId: string | null;
			role: string | null;
			managed: boolean;
			cancelAtPeriodEnd: boolean;
			items: Array<{
				id: string;
				priceId: string;
				quantity: number | null;
			}>;
		}>;
		openCheckoutSessions: Array<{
			id: string;
			customerId: string | null;
			subscriptionId: string | null;
			status: string | null;
			paymentStatus: string;
			mode: string;
			organizationId: string | null;
			managed: boolean;
		}>;
		collectibleInvoices: Array<{
			id: string;
			customerId: string | null;
			subscriptionId: string | null;
			status: string | null;
			currency: string;
			amountDue: number;
			organizationId: string | null;
			managed: boolean;
		}>;
		pendingInvoiceItems: Array<{
			id: string;
			customerId: string;
			subscriptionId: string | null;
			currency: string;
			amount: number;
			organizationId: string | null;
			managed: boolean;
		}>;
		subscriptionSchedules: Array<{
			id: string;
			customerId: string | null;
			status: string;
			subscriptionId: string | null;
			releasedSubscriptionId: string | null;
			organizationId: string | null;
			managed: boolean;
		}>;
		paymentIntents: Array<{
			id: string;
			customerId: string | null;
			status: string;
			amount: number;
			currency: string;
			organizationId: string | null;
			managed: boolean;
		}>;
		charges: Array<{
			id: string;
			customerId: string | null;
			paymentIntentId: string | null;
			amount: number;
			amountCaptured: number;
			amountRefunded: number;
			currency: string;
			status: string;
			paid: boolean;
			captured: boolean;
			disputed: boolean;
			refunded: boolean;
			managed: boolean;
		}>;
		refunds: Array<{
			id: string;
			status: string | null;
			amount: number;
			currency: string;
			chargeId: string | null;
			paymentIntentId: string | null;
			managed: boolean;
		}>;
		disputes: Array<{
			id: string;
			status: string;
			amount: number;
			currency: string;
			chargeId: string;
			paymentIntentId: string | null;
			managed: boolean;
		}>;
		activePaymentLinks: Array<{
			id: string;
			managed: boolean;
		}>;
		customerCashBalances: Array<{
			customerId: string;
			managed: boolean;
			available: Array<{ currency: string; amount: number }>;
		}>;
		setupIntents: Array<{
			id: string;
			customerId: string | null;
			status: string;
			paymentMethodTypes: string[];
			managed: boolean;
		}>;
		topups: Array<{
			id: string;
			status: string;
			amount: number;
			currency: string;
			managed: boolean;
		}>;
		payouts: Array<{
			id: string;
			status: string;
			amount: number;
			currency: string;
			automatic: boolean | null;
			managed: boolean;
		}>;
		balance: {
			livemode: boolean;
			available: Array<{ currency: string; amount: number }>;
			pending: Array<{ currency: string; amount: number }>;
			connectReserved: Array<{ currency: string; amount: number }>;
		};
		balanceSettings: {
			debitNegativeBalances: boolean | null;
			payoutScheduleInterval: string | null;
			payoutStatus: string | null;
			automaticTransferRuleCurrencies: string[];
		};
	};
	telnyx: {
		credentialSha256: string;
		attestations: {
			accountDedicatedToRelayapi: true;
			unsupportedProductsDisabled: true;
			scheduledPayments: "disabled";
			autoRecharge: "disabled";
		};
		balance: TelnyxFutureMoneyAllocations["balance"];
		phoneNumbers: Array<{
			id: string;
			phoneNumberSha256: string;
			status: string | null;
			customerReferenceSha256: string | null;
		}>;
		numberOrders: Array<{
			id: string;
			status: string;
			customerReferenceSha256: string | null;
			phoneNumberSha256: string[];
			updatedAt: string | null;
		}>;
		numberBlockOrders: Array<{
			id: string;
			status: string | null;
			customerReferenceSha256: string | null;
			startingNumberSha256: string | null;
			range: number | null;
			phoneNumbersCount: number | null;
			updatedAt: string | null;
		}>;
		advancedOrders: Array<{
			id: string;
			statuses: string[];
			customerReferenceSha256: string | null;
			quantity: number | null;
			numberOrderIds: string[];
		}>;
		inexplicitNumberOrders: Array<{
			id: string;
			customerReferenceSha256: string | null;
			updatedAt: string | null;
			orderingGroups: Array<{
				index: number;
				status: string | null;
				countRequested: number | null;
				countAllocated: number | null;
				numberOrderIds: string[];
			}>;
		}>;
		portingOrders: Array<{
			id: string;
			status: string | null;
			customerReferenceSha256: string | null;
			phoneNumbersCount: number | null;
			updatedAt: string | null;
		}>;
		portingPhoneNumbers: Array<{
			portingOrderId: string;
			phoneNumberSha256: string;
			portingOrderStatus: string | null;
			activationStatus: string | null;
			ownedPhoneNumberId: string | null;
		}>;
		portOuts: Array<{
			id: string;
			status: string | null;
			hostMessaging: boolean | null;
			phoneNumberSha256: string[];
			updatedAt: string | null;
		}>;
	};
	meta: {
		sourceRowsSha256: string;
		attestations: {
			whatsappOutstandingInvoicesZero: true;
			whatsappAutomaticPaymentsDisabled: true;
		};
		systemAuthority: {
			businessId: string;
			credentialSha256: string;
		};
		authorityGaps: Array<{
			kind: "ads" | "whatsapp";
			localId: string;
			reason: string;
		}>;
		authorities: Array<{
			kind: "ads" | "whatsapp";
			socialAccountId: string;
			organizationId: string;
			providerAuthorityId: string;
			tokenVersion: number;
			credentialCiphertextSha256: string;
		}>;
		extendedCredits: Array<{
			id: string;
			balance: { amount: string | null; currency: string | null };
			creditAvailable: { amount: string | null; currency: string | null };
			creditType: string | null;
		}>;
		adAccounts: Array<{
			id: string;
			accountStatus: number | string | null;
			currency: string | null;
			balance: string | null;
			authoritySocialAccountIds: string[];
		}>;
		campaigns: Array<{
			id: string;
			status: string | null;
			effectiveStatus: string | null;
			authorityAdAccountIds: string[];
			localCampaignIds: string[];
			terminal: boolean;
		}>;
		whatsappPhoneNumbers: Array<{
			id: string;
			wabaId: string;
			codeVerificationStatus: string | null;
			qualityRating: string | null;
			authoritySocialAccountIds: string[];
		}>;
	};
	blockingResources: ProviderBlocker[];
};

type StripeInventoryClient = {
	accounts: {
		retrieveCurrent(): Promise<{
			id: string;
			country?: string | null;
			default_currency?: string | null;
			settings?: {
				payouts?: {
					debit_negative_balances?: boolean;
					schedule?: { interval?: string };
				};
			} | null;
		}>;
	};
	customers: {
		list(input: { limit: number }): AsyncIterable<StripeCustomer>;
		retrieveCashBalance(customerId: string): Promise<{
			livemode: boolean;
			available?: Record<string, number> | null;
		}>;
	};
	subscriptions: {
		list(input: {
			limit: number;
			status: "all";
		}): AsyncIterable<StripeSubscription>;
	};
	checkout: {
		sessions: {
			list(input: {
				limit: number;
				status: "open";
			}): AsyncIterable<StripeCheckoutSession>;
		};
	};
	invoices: {
		list(input: {
			limit: number;
			status: "draft" | "open";
		}): AsyncIterable<StripeInvoice>;
	};
	invoiceItems: {
		list(input: {
			limit: number;
			pending: true;
		}): AsyncIterable<StripeInvoiceItem>;
	};
	subscriptionSchedules: {
		list(input: { limit: number }): AsyncIterable<StripeSubscriptionSchedule>;
	};
	paymentIntents: {
		list(input: { limit: number }): AsyncIterable<StripePaymentIntent>;
	};
	charges: {
		list(input: { limit: number }): AsyncIterable<StripeCharge>;
	};
	refunds: {
		list(input: { limit: number }): AsyncIterable<StripeRefund>;
	};
	disputes: {
		list(input: { limit: number }): AsyncIterable<StripeDispute>;
	};
	paymentLinks: {
		list(input: {
			limit: number;
			active: true;
		}): AsyncIterable<StripePaymentLink>;
	};
	setupIntents: {
		list(input: { limit: number }): AsyncIterable<StripeSetupIntent>;
	};
	topups: {
		list(input: { limit: number }): AsyncIterable<StripeTopup>;
	};
	payouts: {
		list(input: { limit: number }): AsyncIterable<StripePayout>;
	};
	balance: {
		retrieve(): Promise<{
			livemode: boolean;
			available: StripeBalanceAmount[];
			pending: StripeBalanceAmount[];
			connect_reserved?: StripeBalanceAmount[];
		}>;
	};
	balanceSettings: {
		retrieve(): Promise<{
			payments?: {
				debit_negative_balances?: boolean | null;
				payouts?: {
					status?: string;
					schedule?: { interval?: string | null } | null;
					automatic_transfer_rules_by_currency?: Record<
						string,
						unknown[]
					> | null;
				} | null;
			};
		}>;
	};
};

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function requireTrueAttestation(name: string): true {
	if (required(name) !== "true") {
		throw new Error(`${name} must be exactly true`);
	}
	return true;
}

function requireNeverEnabledAttestation(name: string): "never_enabled" {
	if (required(name) !== "NEVER_ENABLED") {
		throw new Error(`${name} must be exactly NEVER_ENABLED`);
	}
	return "never_enabled";
}

function requireNoLivePricingTables(name: string): "none" {
	if (required(name) !== "NO_LIVE_PRICING_TABLES") {
		throw new Error(`${name} must be exactly NO_LIVE_PRICING_TABLES`);
	}
	return "none";
}

function requireDisabledAttestation(name: string): "disabled" {
	if (required(name) !== "DISABLED") {
		throw new Error(`${name} must be exactly DISABLED`);
	}
	return "disabled";
}

function requireTerminalReversalPolicy(
	name: string,
): "block_terminal_history" | "accept_network_reversal_tail" {
	const value = required(name);
	if (
		value !== "block_terminal_history" &&
		value !== "accept_network_reversal_tail"
	) {
		throw new Error(
			`${name} must be exactly block_terminal_history or accept_network_reversal_tail`,
		);
	}
	return value;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonicalize(nested)]),
		);
	}
	return value;
}

export function canonicalProviderInventory(
	inventory: PreliveProviderInventory,
): string {
	return `${JSON.stringify(canonicalize(inventory), null, 2)}\n`;
}

export function providerInventorySha256(
	inventory: PreliveProviderInventory,
): string {
	return sha256(canonicalProviderInventory(inventory));
}

export function assertStableProviderInventories(
	first: PreliveProviderInventory,
	second: PreliveProviderInventory,
): void {
	if (
		canonicalProviderInventory(first) !== canonicalProviderInventory(second)
	) {
		throw new Error(
			"Provider inventory changed between consecutive complete captures",
		);
	}
}

function parseProviderInventory(source: string): PreliveProviderInventory {
	const inventory = JSON.parse(source) as PreliveProviderInventory;
	if (
		inventory.schemaVersion !== 2 ||
		inventory.targetBaselineGeneration !== 2 ||
		inventory.scope !== "relayapi_integrated_provider_money_surfaces" ||
		!inventory.stripe?.account?.id ||
		inventory.stripe.account.livemode !== true ||
		!["block_terminal_history", "accept_network_reversal_tail"].includes(
			inventory.stripe.terminalReversalPolicy,
		) ||
		inventory.stripe.attestations?.bankTransferFundingInstructions !==
			"never_enabled" ||
		inventory.stripe.attestations?.legacyReceiverSources !== "never_enabled" ||
		inventory.stripe.attestations?.connect !== "never_enabled" ||
		inventory.stripe.attestations?.livePricingTables !== "none" ||
		inventory.stripe.attestations?.accountDedicatedToRelayapi !== true ||
		inventory.stripe.attestations?.unsupportedProductsDisabled !== true ||
		!Array.isArray(inventory.stripe.customers) ||
		!inventory.stripe.customers.every(
			(customer) =>
				Number.isSafeInteger(customer.balance) &&
				Array.isArray(customer.invoiceCreditBalance),
		) ||
		!Array.isArray(inventory.stripe.subscriptions) ||
		!Array.isArray(inventory.stripe.subscriptionSchedules) ||
		!Array.isArray(inventory.stripe.paymentIntents) ||
		!Array.isArray(inventory.stripe.charges) ||
		!Array.isArray(inventory.stripe.refunds) ||
		!Array.isArray(inventory.stripe.disputes) ||
		!Array.isArray(inventory.stripe.activePaymentLinks) ||
		!Array.isArray(inventory.stripe.customerCashBalances) ||
		!Array.isArray(inventory.stripe.setupIntents) ||
		!Array.isArray(inventory.stripe.topups) ||
		!Array.isArray(inventory.stripe.payouts) ||
		!Array.isArray(inventory.stripe.balance?.available) ||
		!Array.isArray(inventory.stripe.balance?.pending) ||
		!Array.isArray(inventory.stripe.balance?.connectReserved) ||
		!inventory.stripe.balanceSettings ||
		!/^[0-9a-f]{64}$/.test(inventory.telnyx?.credentialSha256 ?? "") ||
		inventory.telnyx?.attestations?.accountDedicatedToRelayapi !== true ||
		inventory.telnyx?.attestations?.unsupportedProductsDisabled !== true ||
		inventory.telnyx?.attestations?.scheduledPayments !== "disabled" ||
		inventory.telnyx?.attestations?.autoRecharge !== "disabled" ||
		!inventory.telnyx?.balance ||
		!Array.isArray(inventory.telnyx?.phoneNumbers) ||
		!Array.isArray(inventory.telnyx?.numberOrders) ||
		!Array.isArray(inventory.telnyx?.numberBlockOrders) ||
		!Array.isArray(inventory.telnyx?.advancedOrders) ||
		!Array.isArray(inventory.telnyx?.inexplicitNumberOrders) ||
		!Array.isArray(inventory.telnyx?.portingOrders) ||
		!Array.isArray(inventory.telnyx?.portingPhoneNumbers) ||
		!Array.isArray(inventory.telnyx?.portOuts) ||
		!inventory.meta?.systemAuthority?.businessId ||
		inventory.meta?.attestations?.whatsappOutstandingInvoicesZero !== true ||
		inventory.meta?.attestations?.whatsappAutomaticPaymentsDisabled !== true ||
		!/^[0-9a-f]{64}$/.test(
			inventory.meta?.systemAuthority?.credentialSha256 ?? "",
		) ||
		!Array.isArray(inventory.meta?.authorities) ||
		!Array.isArray(inventory.meta?.authorityGaps) ||
		!Array.isArray(inventory.meta?.extendedCredits) ||
		!inventory.meta.extendedCredits.every(
			(credit) =>
				Boolean(credit.id) &&
				typeof credit.balance?.amount === "string" &&
				typeof credit.balance?.currency === "string" &&
				typeof credit.creditAvailable?.amount === "string" &&
				typeof credit.creditAvailable?.currency === "string",
		) ||
		!Array.isArray(inventory.blockingResources)
	) {
		throw new Error("Approved provider inventory has an invalid shape");
	}
	return inventory;
}

function providerId(
	value: string | { id: string } | null | undefined,
): string | null {
	if (typeof value === "string") return value;
	return value?.id ?? null;
}

function metadataOrganizationId(
	metadata: Record<string, string> | null | undefined,
): string | null {
	return (
		metadata?.organizationId ??
		metadata?.organization_id ??
		metadata?.relayapi_organization_id ??
		null
	);
}

/**
 * Stripe documents that live secret and restricted keys use the `*_live_`
 * mode marker. Test-mode objects are isolated from live-mode objects, so an
 * inventory made with either test-key class cannot authorize a production
 * cutover.
 *
 * Official docs:
 * https://docs.stripe.com/api/authentication
 * https://docs.stripe.com/testing-use-cases
 */
export function stripeApiKeyIsLive(apiKey: string): boolean {
	return /^(?:sk|rk)_live_/.test(apiKey);
}

export function telnyxApiKeyFingerprint(apiKey: string): string {
	// This is a deterministic fingerprint of a high-entropy provider credential,
	// not a password verifier. The domain prefix prevents cross-purpose reuse.
	return new Bun.CryptoHasher("sha256")
		.update(`relayapi:telnyx-inventory-credential:v1:${apiKey}`)
		.digest("hex");
}

function assertSha256(value: string, name: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) {
		throw new Error(`${name} must be a lowercase SHA-256`);
	}
}

function phoneNumberFingerprint(phoneNumber: string): string {
	const canonical = phoneNumber.replace(/\D/g, "");
	if (!canonical) throw new Error("Telnyx returned an invalid phone number");
	return sha256(canonical);
}

function stripeCurrencyAmounts(
	values: Record<string, number> | StripeBalanceAmount[] | null | undefined,
	context: string,
): Array<{ currency: string; amount: number }> {
	const entries = Array.isArray(values)
		? values.map(({ currency, amount }) => [currency, amount] as const)
		: Object.entries(values ?? {});
	const normalized = entries.map(([currency, amount]) => {
		if (
			!currency ||
			currency !== currency.toLowerCase() ||
			!Number.isSafeInteger(amount)
		) {
			throw new Error(`${context} returned an invalid currency amount`);
		}
		return { currency, amount };
	});
	assertUniqueRows(normalized, (entry) => entry.currency, context);
	return normalized.sort((left, right) =>
		left.currency.localeCompare(right.currency),
	);
}

function relayManaged(
	metadata: Record<string, string> | null | undefined,
): boolean {
	return (
		metadata?.[STRIPE_MANAGED_BY_KEY] === STRIPE_MANAGED_BY_VALUE ||
		metadataOrganizationId(metadata) !== null ||
		typeof metadata?.relayapi_operation_id === "string"
	);
}

function compareBlockers(
	left: ProviderBlocker,
	right: ProviderBlocker,
): number {
	return `${left.provider}\0${left.kind}\0${left.id}`.localeCompare(
		`${right.provider}\0${right.kind}\0${right.id}`,
	);
}

function metaBalanceIsZero(balance: string | null): boolean {
	return balance !== null && /^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(balance.trim());
}

function metaAccountStatusIsSettled(status: number | string | null): boolean {
	const numeric =
		typeof status === "number"
			? status
			: typeof status === "string" && /^\d+$/.test(status)
				? Number(status)
				: Number.NaN;
	// Official AdAccount states: ACTIVE, DISABLED, and CLOSED are the only
	// states that do not themselves describe an unresolved settlement edge.
	return numeric === 1 || numeric === 2 || numeric === 101;
}

async function captureStripeInventory(input: {
	stripe: StripeInventoryClient;
	livemode: boolean;
	expectedAccountId: string;
	terminalReversalPolicy:
		| "block_terminal_history"
		| "accept_network_reversal_tail";
	attestations: {
		bankTransferFundingInstructions: "never_enabled";
		legacyReceiverSources: "never_enabled";
		connect: "never_enabled";
		livePricingTables: "none";
		accountDedicatedToRelayapi: true;
		unsupportedProductsDisabled: true;
	};
	serverPriceIds: Set<string>;
}): Promise<PreliveProviderInventory["stripe"]> {
	if (!input.livemode) {
		throw new Error("Stripe provider inventory requires a live-mode API key");
	}
	const account = await input.stripe.accounts.retrieveCurrent();
	if (account.id !== input.expectedAccountId) {
		throw new Error(
			`Stripe account identity mismatch: expected ${input.expectedAccountId}, got ${account.id}`,
		);
	}
	if (
		input.attestations.bankTransferFundingInstructions !== "never_enabled" ||
		input.attestations.legacyReceiverSources !== "never_enabled" ||
		input.attestations.connect !== "never_enabled" ||
		input.attestations.livePricingTables !== "none" ||
		input.attestations.accountDedicatedToRelayapi !== true ||
		input.attestations.unsupportedProductsDisabled !== true
	) {
		throw new Error("Stripe provider-scope attestations are incomplete");
	}
	const customers: PreliveProviderInventory["stripe"]["customers"] = [];
	const managedCustomerIds = new Set<string>();
	// Customer invoice credit/debit balances are distinct from Cash Balance and
	// are automatically applied when a later invoice finalizes.
	// https://docs.stripe.com/api/customers/object#customer_object-balance
	// https://docs.stripe.com/api/customers/object#customer_object-invoice_credit_balance
	for await (const customer of input.stripe.customers.list({ limit: 100 })) {
		if (customer.deleted) continue;
		if (!Number.isSafeInteger(customer.balance)) {
			throw new Error(
				`Stripe customer ${customer.id} returned an invalid balance`,
			);
		}
		const organizationId = metadataOrganizationId(customer.metadata);
		const managed = relayManaged(customer.metadata);
		if (managed) managedCustomerIds.add(customer.id);
		customers.push({
			id: customer.id,
			organizationId,
			managed,
			balance: customer.balance,
			currency: customer.currency ?? null,
			invoiceCreditBalance: stripeCurrencyAmounts(
				customer.invoice_credit_balance,
				`Stripe customer ${customer.id} invoice credit balance`,
			),
		});
	}

	const subscriptions: PreliveProviderInventory["stripe"]["subscriptions"] = [];
	for await (const subscription of input.stripe.subscriptions.list({
		limit: 100,
		status: "all",
	})) {
		const customerId = providerId(subscription.customer);
		if (!customerId)
			throw new Error(`Stripe subscription ${subscription.id} has no customer`);
		const items = subscription.items.data
			.map((item) => ({
				id: item.id,
				priceId: item.price.id,
				quantity: typeof item.quantity === "number" ? item.quantity : null,
			}))
			.sort((left, right) => left.id.localeCompare(right.id));
		const managed =
			relayManaged(subscription.metadata) ||
			managedCustomerIds.has(customerId) ||
			items.some(({ priceId }) => input.serverPriceIds.has(priceId));
		if (managed) managedCustomerIds.add(customerId);
		subscriptions.push({
			id: subscription.id,
			customerId,
			status: subscription.status,
			organizationId: metadataOrganizationId(subscription.metadata),
			role: subscription.metadata?.[STRIPE_SUBSCRIPTION_ROLE_KEY] ?? null,
			managed,
			cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
			items,
		});
	}

	for (const customer of customers) {
		if (managedCustomerIds.has(customer.id)) customer.managed = true;
	}
	customers.sort((left, right) => left.id.localeCompare(right.id));
	subscriptions.sort((left, right) => left.id.localeCompare(right.id));

	// A customer's available cash balance is real money that can later be
	// reconciled into a payment or returned. Stripe has no account-wide cash
	// balance list, so retrieve it for every account-wide customer row.
	// Official docs: https://docs.stripe.com/api/cash_balance/retrieve
	const customerCashBalances: PreliveProviderInventory["stripe"]["customerCashBalances"] =
		[];
	for (const customer of customers) {
		const cashBalance = await input.stripe.customers.retrieveCashBalance(
			customer.id,
		);
		if (cashBalance.livemode !== true) {
			throw new Error(
				`Stripe cash balance for ${customer.id} was not read in live mode`,
			);
		}
		customerCashBalances.push({
			customerId: customer.id,
			managed: customer.managed,
			available: stripeCurrencyAmounts(
				cashBalance.available,
				`Stripe cash balance ${customer.id}`,
			),
		});
	}

	const openCheckoutSessions: PreliveProviderInventory["stripe"]["openCheckoutSessions"] =
		[];
	for await (const session of input.stripe.checkout.sessions.list({
		limit: 100,
		status: "open",
	})) {
		const customerId = providerId(session.customer);
		openCheckoutSessions.push({
			id: session.id,
			customerId,
			subscriptionId: providerId(session.subscription),
			status: session.status,
			paymentStatus: session.payment_status,
			mode: session.mode,
			organizationId: metadataOrganizationId(session.metadata),
			managed:
				relayManaged(session.metadata) ||
				(customerId !== null && managedCustomerIds.has(customerId)),
		});
	}
	openCheckoutSessions.sort((left, right) => left.id.localeCompare(right.id));

	const collectibleInvoices: PreliveProviderInventory["stripe"]["collectibleInvoices"] =
		[];
	for (const status of ["draft", "open"] as const) {
		for await (const invoice of input.stripe.invoices.list({
			limit: 100,
			status,
		})) {
			const customerId = providerId(invoice.customer);
			collectibleInvoices.push({
				id: invoice.id,
				customerId,
				subscriptionId: providerId(invoice.subscription),
				status: invoice.status,
				currency: invoice.currency,
				amountDue: invoice.amount_due,
				organizationId: metadataOrganizationId(invoice.metadata),
				managed:
					relayManaged(invoice.metadata) ||
					(customerId !== null && managedCustomerIds.has(customerId)),
			});
		}
	}
	collectibleInvoices.sort((left, right) => left.id.localeCompare(right.id));

	const pendingInvoiceItems: PreliveProviderInventory["stripe"]["pendingInvoiceItems"] =
		[];
	for await (const item of input.stripe.invoiceItems.list({
		limit: 100,
		pending: true,
	})) {
		const customerId = providerId(item.customer);
		if (!customerId)
			throw new Error(`Stripe invoice item ${item.id} has no customer`);
		pendingInvoiceItems.push({
			id: item.id,
			customerId,
			subscriptionId: providerId(item.subscription),
			currency: item.currency,
			amount: item.amount,
			organizationId: metadataOrganizationId(item.metadata),
			managed:
				relayManaged(item.metadata) || managedCustomerIds.has(customerId),
		});
	}
	pendingInvoiceItems.sort((left, right) => left.id.localeCompare(right.id));

	const subscriptionSchedules: PreliveProviderInventory["stripe"]["subscriptionSchedules"] =
		[];
	for await (const schedule of input.stripe.subscriptionSchedules.list({
		limit: 100,
	})) {
		const customerId = providerId(schedule.customer);
		subscriptionSchedules.push({
			id: schedule.id,
			customerId,
			status: schedule.status,
			subscriptionId: providerId(schedule.subscription),
			releasedSubscriptionId: providerId(schedule.released_subscription),
			organizationId: metadataOrganizationId(schedule.metadata),
			managed:
				relayManaged(schedule.metadata) ||
				(customerId !== null && managedCustomerIds.has(customerId)),
		});
	}
	subscriptionSchedules.sort((left, right) => left.id.localeCompare(right.id));

	const paymentIntents: PreliveProviderInventory["stripe"]["paymentIntents"] =
		[];
	const managedPaymentIntentIds = new Set<string>();
	for await (const intent of input.stripe.paymentIntents.list({ limit: 100 })) {
		const customerId = providerId(intent.customer);
		const managed =
			relayManaged(intent.metadata) ||
			(customerId !== null && managedCustomerIds.has(customerId));
		if (managed) managedPaymentIntentIds.add(intent.id);
		paymentIntents.push({
			id: intent.id,
			customerId,
			status: intent.status,
			amount: intent.amount,
			currency: intent.currency,
			organizationId: metadataOrganizationId(intent.metadata),
			managed,
		});
	}
	paymentIntents.sort((left, right) => left.id.localeCompare(right.id));

	// Charges capture terminal card/network history that may not be represented
	// by a PaymentIntent (including legacy Source-based charges). Whether that
	// reversal tail is accepted is an explicit cutover policy below.
	// https://docs.stripe.com/api/charges/list
	const charges: PreliveProviderInventory["stripe"]["charges"] = [];
	for await (const charge of input.stripe.charges.list({ limit: 100 })) {
		const customerId = providerId(charge.customer);
		const paymentIntentId = providerId(charge.payment_intent);
		charges.push({
			id: charge.id,
			customerId,
			paymentIntentId,
			amount: charge.amount,
			amountCaptured: charge.amount_captured,
			amountRefunded: charge.amount_refunded,
			currency: charge.currency,
			status: charge.status,
			paid: charge.paid,
			captured: charge.captured,
			disputed: charge.disputed,
			refunded: charge.refunded,
			managed:
				relayManaged(charge.metadata) ||
				(customerId !== null && managedCustomerIds.has(customerId)) ||
				(paymentIntentId !== null &&
					managedPaymentIntentIds.has(paymentIntentId)),
		});
	}
	assertUniqueRows(charges, (charge) => charge.id, "Stripe charge inventory");
	charges.sort((left, right) => left.id.localeCompare(right.id));

	const refunds: PreliveProviderInventory["stripe"]["refunds"] = [];
	for await (const refund of input.stripe.refunds.list({ limit: 100 })) {
		const paymentIntentId = providerId(refund.payment_intent);
		refunds.push({
			id: refund.id,
			status: refund.status,
			amount: refund.amount,
			currency: refund.currency,
			chargeId: providerId(refund.charge),
			paymentIntentId,
			managed:
				relayManaged(refund.metadata) ||
				(paymentIntentId !== null &&
					managedPaymentIntentIds.has(paymentIntentId)),
		});
	}
	refunds.sort((left, right) => left.id.localeCompare(right.id));

	const disputes: PreliveProviderInventory["stripe"]["disputes"] = [];
	for await (const dispute of input.stripe.disputes.list({ limit: 100 })) {
		const paymentIntentId = providerId(dispute.payment_intent);
		const chargeId = providerId(dispute.charge);
		if (!chargeId)
			throw new Error(`Stripe dispute ${dispute.id} has no charge`);
		disputes.push({
			id: dispute.id,
			status: dispute.status,
			amount: dispute.amount,
			currency: dispute.currency,
			chargeId,
			paymentIntentId,
			managed:
				relayManaged(dispute.metadata) ||
				(paymentIntentId !== null &&
					managedPaymentIntentIds.has(paymentIntentId)),
		});
	}
	disputes.sort((left, right) => left.id.localeCompare(right.id));

	// Active Payment Links can create new Checkout Sessions and money movement
	// after every currently-open Session has been drained, so the account-wide
	// active set is itself a cutover blocker.
	// Official docs: https://docs.stripe.com/api/payment-link/list
	const activePaymentLinks: PreliveProviderInventory["stripe"]["activePaymentLinks"] =
		[];
	for await (const paymentLink of input.stripe.paymentLinks.list({
		limit: 100,
		active: true,
	})) {
		if (!paymentLink.active) {
			throw new Error(
				`Stripe active Payment Link query returned inactive ${paymentLink.id}`,
			);
		}
		activePaymentLinks.push({
			id: paymentLink.id,
			managed: relayManaged(paymentLink.metadata),
		});
	}
	activePaymentLinks.sort((left, right) => left.id.localeCompare(right.id));

	// A nonterminal bank-account SetupIntent can still run automatic
	// microdeposit verification. Unknown future statuses deliberately block.
	// Official docs: https://docs.stripe.com/api/setup_intents/list
	const setupIntents: PreliveProviderInventory["stripe"]["setupIntents"] = [];
	for await (const setupIntent of input.stripe.setupIntents.list({
		limit: 100,
	})) {
		const customerId = providerId(setupIntent.customer);
		setupIntents.push({
			id: setupIntent.id,
			customerId,
			status: setupIntent.status,
			paymentMethodTypes: [...new Set(setupIntent.payment_method_types)].sort(),
			managed:
				relayManaged(setupIntent.metadata) ||
				(customerId !== null && managedCustomerIds.has(customerId)),
		});
	}
	setupIntents.sort((left, right) => left.id.localeCompare(right.id));

	const topups: PreliveProviderInventory["stripe"]["topups"] = [];
	for await (const topup of input.stripe.topups.list({ limit: 100 })) {
		topups.push({
			id: topup.id,
			status: topup.status,
			amount: topup.amount,
			currency: topup.currency,
			managed: relayManaged(topup.metadata),
		});
	}
	topups.sort((left, right) => left.id.localeCompare(right.id));

	const payouts: PreliveProviderInventory["stripe"]["payouts"] = [];
	for await (const payout of input.stripe.payouts.list({ limit: 100 })) {
		payouts.push({
			id: payout.id,
			status: payout.status,
			amount: payout.amount,
			currency: payout.currency,
			automatic:
				typeof payout.automatic === "boolean" ? payout.automatic : null,
			managed: relayManaged(payout.metadata),
		});
	}
	payouts.sort((left, right) => left.id.localeCompare(right.id));

	// Platform balance funds can settle or pay out independently of application
	// rows. The account payout schedule must be manual before the capture.
	// Official docs:
	// https://docs.stripe.com/api/balance
	// https://docs.stripe.com/api/accounts/object
	const stripeBalance = await input.stripe.balance.retrieve();
	if (stripeBalance.livemode !== true) {
		throw new Error("Stripe platform balance was not read in live mode");
	}
	const balance: PreliveProviderInventory["stripe"]["balance"] = {
		livemode: true,
		available: stripeCurrencyAmounts(
			stripeBalance.available,
			"Stripe available balance",
		),
		pending: stripeCurrencyAmounts(
			stripeBalance.pending,
			"Stripe pending balance",
		),
		connectReserved: stripeCurrencyAmounts(
			stripeBalance.connect_reserved,
			"Stripe Connect-reserved balance",
		),
	};
	const rawBalanceSettings = await input.stripe.balanceSettings.retrieve();
	const payoutSettings = rawBalanceSettings.payments?.payouts;
	const rawAutomaticTransferRules =
		payoutSettings?.automatic_transfer_rules_by_currency ?? {};
	const automaticTransferRuleCurrencies: string[] = [];
	for (const [currency, rules] of Object.entries(rawAutomaticTransferRules)) {
		if (!Array.isArray(rules)) {
			throw new Error(
				"Stripe balance settings returned malformed automatic-transfer rules",
			);
		}
		if (rules.length > 0) automaticTransferRuleCurrencies.push(currency);
	}
	const balanceSettings: PreliveProviderInventory["stripe"]["balanceSettings"] =
		{
			debitNegativeBalances:
				rawBalanceSettings.payments?.debit_negative_balances ?? null,
			payoutScheduleInterval: payoutSettings?.schedule?.interval ?? null,
			payoutStatus: payoutSettings?.status ?? null,
			automaticTransferRuleCurrencies: automaticTransferRuleCurrencies.sort(),
		};

	return {
		terminalReversalPolicy: input.terminalReversalPolicy,
		account: {
			id: account.id,
			country: account.country ?? null,
			defaultCurrency: account.default_currency ?? null,
			livemode: input.livemode,
			payoutScheduleInterval:
				account.settings?.payouts?.schedule?.interval ?? null,
			debitNegativeBalances:
				account.settings?.payouts?.debit_negative_balances ?? null,
		},
		attestations: input.attestations,
		customers,
		subscriptions,
		openCheckoutSessions,
		collectibleInvoices,
		pendingInvoiceItems,
		subscriptionSchedules,
		paymentIntents,
		charges,
		refunds,
		disputes,
		activePaymentLinks,
		customerCashBalances,
		setupIntents,
		topups,
		payouts,
		balance,
		balanceSettings,
	};
}

async function boundedJson(
	response: Response,
	context: string,
	maxBytes = GRAPH_RESPONSE_LIMIT_BYTES,
): Promise<unknown> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) {
		throw new Error(`${context} exceeded the ${maxBytes}-byte limit`);
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error(`${context} returned invalid JSON`);
	}
}

type TelnyxListPage<T> = {
	data?: T[];
	meta?: {
		page_number?: number;
		page_size?: number;
		total_pages?: number;
		total_results?: number;
	};
	errors?: Array<{ code?: string; title?: string; detail?: string }>;
};

async function telnyxGet<T>(input: {
	path: string;
	params?: URLSearchParams;
	apiKey: string;
	fetcher: typeof fetch;
	context: string;
}): Promise<T> {
	const url = new URL(`${TELNYX_API_BASE}${input.path}`);
	if (input.params) url.search = input.params.toString();
	const response = await input.fetcher(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${input.apiKey}`,
		},
		signal: AbortSignal.timeout(30_000),
	});
	const body = (await boundedJson(
		response,
		input.context,
		TELNYX_RESPONSE_LIMIT_BYTES,
	)) as T & TelnyxListPage<never>;
	if (!response.ok || body.errors?.length) {
		const first = body.errors?.[0];
		throw new Error(
			first?.detail ??
				first?.title ??
				`${input.context} failed with HTTP ${response.status}`,
		);
	}
	return body;
}

async function telnyxPaged<T>(input: {
	path: string;
	apiKey: string;
	fetcher: typeof fetch;
	context: string;
	pageStyle: "deep" | "top-level";
	pageSize: number;
	extraParams?: Record<string, string>;
}): Promise<T[]> {
	const rows: T[] = [];
	let expectedTotalPages: number | undefined;
	let expectedTotalResults: number | undefined;
	for (let pageNumber = 1; pageNumber <= TELNYX_PAGE_LIMIT; pageNumber++) {
		const params = new URLSearchParams(input.extraParams);
		if (input.pageStyle === "deep") {
			params.set("page[number]", String(pageNumber));
			params.set("page[size]", String(input.pageSize));
		} else {
			params.set("page_number", String(pageNumber));
			params.set("page_size", String(input.pageSize));
		}
		const body = await telnyxGet<TelnyxListPage<T>>({
			path: input.path,
			params,
			apiKey: input.apiKey,
			fetcher: input.fetcher,
			context: input.context,
		});
		if (!Array.isArray(body.data)) {
			throw new Error(`${input.context} returned no data array`);
		}
		if (body.data.length > input.pageSize) {
			throw new Error(`${input.context} exceeded its requested page size`);
		}
		rows.push(...body.data);
		const totalPages = body.meta?.total_pages;
		const observedPage = body.meta?.page_number;
		const observedPageSize = body.meta?.page_size;
		const totalResults = body.meta?.total_results;
		if (
			!Number.isSafeInteger(observedPage) ||
			observedPage !== pageNumber ||
			(observedPageSize !== undefined &&
				(!Number.isSafeInteger(observedPageSize) ||
					observedPageSize !== input.pageSize)) ||
			!Number.isSafeInteger(totalPages) ||
			(totalPages ?? -1) < 0 ||
			(totalResults !== undefined &&
				(!Number.isSafeInteger(totalResults) || totalResults < 0))
		) {
			throw new Error(`${input.context} returned invalid pagination metadata`);
		}
		if (
			(expectedTotalPages !== undefined && totalPages !== expectedTotalPages) ||
			(expectedTotalResults !== undefined &&
				totalResults !== expectedTotalResults)
		) {
			throw new Error(`${input.context} changed pagination totals mid-capture`);
		}
		expectedTotalPages ??= totalPages;
		expectedTotalResults ??= totalResults;
		if (totalPages === 0) {
			if (
				pageNumber !== 1 ||
				body.data.length !== 0 ||
				(totalResults !== undefined && totalResults !== 0)
			) {
				throw new Error(`${input.context} returned invalid empty pagination`);
			}
			return rows;
		}
		if (pageNumber >= (totalPages as number)) {
			if (
				expectedTotalResults !== undefined &&
				rows.length !== expectedTotalResults
			) {
				throw new Error(
					`${input.context} row count did not match total_results`,
				);
			}
			return rows;
		}
	}
	throw new Error(`${input.context} exceeded ${TELNYX_PAGE_LIMIT} pages`);
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function metaCurrencyAmount(
	value: unknown,
	context: string,
): { amount: string | null; currency: string | null } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context} returned an invalid CurrencyAmount`);
	}
	const amount = (value as { amount?: unknown }).amount;
	const currency = (value as { currency?: unknown }).currency;
	if (
		(typeof amount !== "string" && typeof amount !== "number") ||
		!Number.isFinite(Number(amount)) ||
		typeof currency !== "string" ||
		currency.trim().length === 0
	) {
		throw new Error(`${context} returned an invalid CurrencyAmount`);
	}
	return { amount: String(amount), currency };
}

function uniqueStrings(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	const strings = values.filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	return [...new Set(strings)].sort();
}

function assertUniqueRows<T>(
	rows: T[],
	key: (row: T) => string,
	context: string,
): void {
	const seen = new Set<string>();
	for (const row of rows) {
		const rowKey = key(row);
		if (seen.has(rowKey)) {
			throw new Error(`${context} returned duplicate ${rowKey}`);
		}
		seen.add(rowKey);
	}
}

/**
 * Enumerate every documented Telnyx order family that can asynchronously
 * allocate a recurring-cost phone number. Advanced Orders are the one
 * exception to the pagers: their official list endpoint exposes no pagination
 * parameters, so a response advertising multiple pages is rejected rather
 * than treated as complete.
 *
 * Official docs:
 * https://developers.telnyx.com/api-reference/phone-number-block-orders/list-number-block-orders
 * https://developers.telnyx.com/api-reference/advanced-number-orders/list-advanced-orders
 * https://developers.telnyx.com/api-reference/inexplicit-number-orders/list-inexplicit-number-orders
 * https://developers.telnyx.com/api-reference/porting-orders/list-all-porting-orders
 * https://developers.telnyx.com/api-reference/porting-orders/list-all-porting-phone-numbers
 * https://developers.telnyx.com/docs/numbers/porting/port-out-quickstart
 * https://developers.telnyx.com/api-reference/billing/get-user-balance-details
 */
export async function captureTelnyxFutureMoneyAllocations(input: {
	apiKey: string;
	fetcher?: typeof fetch;
}): Promise<TelnyxFutureMoneyAllocations> {
	const fetcher = input.fetcher ?? fetch;
	const [
		rawBlocks,
		advancedBody,
		rawBulk,
		rawPorts,
		rawPortPhones,
		rawPortOuts,
		balanceBody,
	] = await Promise.all([
		telnyxPaged<Record<string, unknown>>({
			path: "/number_block_orders",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx number-block inventory",
			pageStyle: "deep",
			pageSize: 100,
		}),
		telnyxGet<TelnyxListPage<Record<string, unknown>>>({
			path: "/advanced_orders",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx advanced-order inventory",
		}),
		telnyxPaged<Record<string, unknown>>({
			path: "/inexplicit_number_orders",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx bulk-order inventory",
			pageStyle: "top-level",
			pageSize: 250,
		}),
		telnyxPaged<Record<string, unknown>>({
			path: "/porting_orders",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx porting-order inventory",
			pageStyle: "deep",
			pageSize: 100,
			extraParams: { include_phone_numbers: "false" },
		}),
		telnyxPaged<Record<string, unknown>>({
			path: "/porting_phone_numbers",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx porting phone-number inventory",
			pageStyle: "deep",
			pageSize: 100,
		}),
		telnyxPaged<Record<string, unknown>>({
			path: "/portouts",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx port-out inventory",
			pageStyle: "deep",
			pageSize: 100,
		}),
		telnyxGet<{ data?: Record<string, unknown> }>({
			path: "/balance",
			apiKey: input.apiKey,
			fetcher,
			context: "Telnyx account-balance inventory",
		}),
	]);
	if (!Array.isArray(advancedBody.data)) {
		throw new Error("Telnyx advanced-order inventory returned no data array");
	}
	if ((advancedBody.meta?.total_pages ?? 1) > 1) {
		throw new Error(
			"Telnyx advanced-order inventory advertised unsupported pagination",
		);
	}
	if (
		advancedBody.meta?.total_results !== undefined &&
		(!Number.isSafeInteger(advancedBody.meta.total_results) ||
			advancedBody.meta.total_results !== advancedBody.data.length)
	) {
		throw new Error(
			"Telnyx advanced-order inventory did not match total_results",
		);
	}
	if (!balanceBody.data || typeof balanceBody.data !== "object") {
		throw new Error("Telnyx account-balance inventory returned no data object");
	}
	const balance = {
		balance: nullableString(balanceBody.data.balance),
		pending: nullableString(balanceBody.data.pending),
		creditLimit: nullableString(balanceBody.data.credit_limit),
		availableCredit: nullableString(balanceBody.data.available_credit),
		currency: nullableString(balanceBody.data.currency),
	};

	const numberBlockOrders = rawBlocks.map((row) => {
		const id = nullableString(row.id);
		if (!id)
			throw new Error("Telnyx returned a number-block order without an ID");
		return {
			id,
			status: nullableString(row.status),
			customerReference: nullableString(row.customer_reference),
			startingNumber: nullableString(row.starting_number),
			range: nullableCount(row.range),
			phoneNumbersCount: nullableCount(row.phone_numbers_count),
			updatedAt: nullableString(row.updated_at),
		};
	});
	const advancedOrders = advancedBody.data.map((row) => {
		const id = nullableString(row.id);
		if (!id) throw new Error("Telnyx returned an advanced order without an ID");
		const statuses =
			typeof row.status === "string" ? [row.status] : uniqueStrings(row.status);
		return {
			id,
			statuses: [...new Set(statuses)].sort(),
			customerReference: nullableString(row.customer_reference),
			quantity: nullableCount(row.quantity),
			numberOrderIds: uniqueStrings(row.orders),
		};
	});
	const inexplicitNumberOrders = rawBulk.map((row) => {
		const id = nullableString(row.id);
		if (!id) throw new Error("Telnyx returned a bulk order without an ID");
		const rawGroups = Array.isArray(row.ordering_groups)
			? row.ordering_groups
			: [];
		return {
			id,
			customerReference: nullableString(row.customer_reference),
			updatedAt: nullableString(row.updated_at),
			orderingGroups: rawGroups.map((rawGroup, index) => {
				const group =
					rawGroup && typeof rawGroup === "object"
						? (rawGroup as Record<string, unknown>)
						: {};
				const rawOrders = Array.isArray(group.orders) ? group.orders : [];
				const numberOrderIds = rawOrders.flatMap((rawOrder) => {
					if (!rawOrder || typeof rawOrder !== "object") return [];
					const numberOrderId = nullableString(
						(rawOrder as Record<string, unknown>).number_order_id,
					);
					return numberOrderId ? [numberOrderId] : [];
				});
				return {
					index,
					status: nullableString(group.status),
					countRequested: nullableCount(group.count_requested),
					countAllocated: nullableCount(group.count_allocated),
					numberOrderIds: [...new Set(numberOrderIds)].sort(),
				};
			}),
		};
	});
	const portingOrders = rawPorts.map((row) => {
		const id = nullableString(row.id);
		if (!id) throw new Error("Telnyx returned a porting order without an ID");
		const statusObject =
			row.status && typeof row.status === "object"
				? (row.status as Record<string, unknown>)
				: null;
		return {
			id,
			status: nullableString(statusObject?.value) ?? nullableString(row.status),
			customerReference: nullableString(row.customer_reference),
			phoneNumbersCount: nullableCount(row.porting_phone_numbers_count),
			updatedAt: nullableString(row.updated_at),
		};
	});
	const portingPhoneNumbers = rawPortPhones.map((row) => {
		const portingOrderId = nullableString(row.porting_order_id);
		const phoneNumber = nullableString(row.phone_number);
		if (!portingOrderId || !phoneNumber) {
			throw new Error(
				"Telnyx returned a porting phone number without an order ID or number",
			);
		}
		return {
			portingOrderId,
			phoneNumber,
			portingOrderStatus: nullableString(row.porting_order_status),
			activationStatus: nullableString(row.activation_status),
		};
	});
	const portOuts = rawPortOuts.map((row) => {
		const id = nullableString(row.id);
		if (!id) throw new Error("Telnyx returned a port-out without an ID");
		return {
			id,
			status: nullableString(row.status),
			hostMessaging:
				typeof row.host_messaging === "boolean" ? row.host_messaging : null,
			phoneNumbers: uniqueStrings(row.phone_numbers),
			updatedAt: nullableString(row.updated_at),
		};
	});

	for (const [rows, key, context] of [
		[
			numberBlockOrders,
			(row: { id: string }) => row.id,
			"number-block inventory",
		],
		[
			advancedOrders,
			(row: { id: string }) => row.id,
			"advanced-order inventory",
		],
		[
			inexplicitNumberOrders,
			(row: { id: string }) => row.id,
			"bulk-order inventory",
		],
		[portingOrders, (row: { id: string }) => row.id, "porting-order inventory"],
		[portOuts, (row: { id: string }) => row.id, "port-out inventory"],
	] as const) {
		assertUniqueRows(rows, key, `Telnyx ${context}`);
	}
	assertUniqueRows(
		portingPhoneNumbers,
		(row) => `${row.portingOrderId}:${phoneNumberFingerprint(row.phoneNumber)}`,
		"Telnyx porting phone-number inventory",
	);

	return {
		balance,
		numberBlockOrders: numberBlockOrders.sort((a, b) =>
			a.id.localeCompare(b.id),
		),
		advancedOrders: advancedOrders.sort((a, b) => a.id.localeCompare(b.id)),
		inexplicitNumberOrders: inexplicitNumberOrders.sort((a, b) =>
			a.id.localeCompare(b.id),
		),
		portingOrders: portingOrders.sort((a, b) => a.id.localeCompare(b.id)),
		portingPhoneNumbers: portingPhoneNumbers.sort((a, b) =>
			`${a.portingOrderId}\0${phoneNumberFingerprint(a.phoneNumber)}`.localeCompare(
				`${b.portingOrderId}\0${phoneNumberFingerprint(b.phoneNumber)}`,
			),
		),
		portOuts: portOuts.sort((a, b) => a.id.localeCompare(b.id)),
	};
}

type GraphListPage<T> = {
	data?: T[];
	paging?: {
		cursors?: { after?: string };
		next?: string;
	};
	error?: { message?: string; code?: number };
};

function safeGraphPageUrl(
	rawUrl: string | URL,
	currentUrl: URL,
	allowedOrigin: string,
	allowedPathname: string,
): URL {
	const next = new URL(rawUrl, currentUrl);
	if (
		next.protocol !== "https:" ||
		next.origin !== allowedOrigin ||
		next.pathname !== allowedPathname ||
		next.username ||
		next.password ||
		next.hash
	) {
		throw new Error("Meta Graph inventory returned an unsafe pagination link");
	}
	// Meta has historically embedded access_token in generated next links. The
	// inventory always authenticates in the Authorization header and removes any
	// query copy before handing the URL to fetch.
	next.searchParams.delete("access_token");
	return next;
}

/** Follow Meta's authoritative `paging.next` chain until it is absent. */
// https://developers.facebook.com/docs/graph-api/results/
async function graphList<T>(input: {
	url: URL;
	accessToken: string;
	fetcher: typeof fetch;
}): Promise<T[]> {
	const rows: T[] = [];
	const initialUrl = new URL(input.url);
	let currentUrl = safeGraphPageUrl(
		initialUrl,
		initialUrl,
		initialUrl.origin,
		initialUrl.pathname,
	);
	const seenUrls = new Set<string>();
	const seenProviderIds = new Set<string>();
	for (let page = 0; page < GRAPH_PAGE_LIMIT; page++) {
		const pageKey = currentUrl.href;
		if (seenUrls.has(pageKey)) {
			throw new Error("Meta Graph inventory repeated a pagination link");
		}
		seenUrls.add(pageKey);
		const response = await input.fetcher(currentUrl, {
			headers: { Authorization: `Bearer ${input.accessToken}` },
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await boundedJson(
			response,
			"Meta Graph inventory",
		)) as GraphListPage<T>;
		if (!response.ok || body.error || !Array.isArray(body.data)) {
			throw new Error(
				body.error?.message ??
					`Meta Graph inventory failed with HTTP ${response.status}`,
			);
		}
		for (const row of body.data) {
			const id =
				row && typeof row === "object"
					? (row as { id?: unknown }).id
					: undefined;
			if (typeof id === "string") {
				if (seenProviderIds.has(id)) {
					throw new Error(
						`Meta Graph inventory returned duplicate provider ID ${id}`,
					);
				}
				seenProviderIds.add(id);
			}
			rows.push(row);
		}
		const next = body.paging?.next;
		if (!next) return rows;
		const nextUrl = safeGraphPageUrl(
			next,
			currentUrl,
			initialUrl.origin,
			initialUrl.pathname,
		);
		const nextAfter = nextUrl.searchParams.get("after");
		const cursorAfter = body.paging?.cursors?.after;
		if (
			!nextAfter ||
			nextAfter === currentUrl.searchParams.get("after") ||
			(cursorAfter !== undefined && cursorAfter !== nextAfter)
		) {
			throw new Error(
				"Meta Graph inventory returned inconsistent pagination progress",
			);
		}
		currentUrl = nextUrl;
	}
	throw new Error(`Meta Graph inventory exceeded ${GRAPH_PAGE_LIMIT} pages`);
}

async function graphObject<T>(input: {
	url: URL;
	accessToken: string;
	fetcher: typeof fetch;
}): Promise<T | null> {
	const response = await input.fetcher(input.url, {
		headers: { Authorization: `Bearer ${input.accessToken}` },
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return null;
	const body = (await boundedJson(response, "Meta Graph readback")) as T & {
		error?: { message?: string };
	};
	if (!response.ok || body.error) {
		throw new Error(
			body.error?.message ??
				`Meta Graph readback failed with HTTP ${response.status}`,
		);
	}
	return body;
}

function terminalMetaCampaign(
	status: string | null,
	effectiveStatus: string | null,
): boolean {
	const observed = [status, effectiveStatus].filter(
		(value): value is string => value !== null,
	);
	return (
		observed.length > 0 &&
		observed.every((value) => value === "DELETED" || value === "ARCHIVED")
	);
}

async function captureMetaInventory(input: {
	sources: ProviderInventorySources;
	encryptionKey: string;
	fetcher: typeof fetch;
	systemAuthority: { businessId: string; accessToken: string };
	attestations: {
		whatsappOutstandingInvoicesZero: true;
		whatsappAutomaticPaymentsDisabled: true;
	};
}): Promise<PreliveProviderInventory["meta"]> {
	const sourceRows = {
		socialAccounts: input.sources.socialAccounts
			.map((row) => ({
				id: row.id,
				organizationId: row.organizationId,
				platform: row.platform,
				tokenVersion: row.tokenVersion,
				lifecycleStatus: row.lifecycleStatus,
				accessTokenSha256: row.accessToken ? sha256(row.accessToken) : null,
				metaAdsTokenSha256: getMetaAdsUserAccessToken(row.metadata)
					? sha256(getMetaAdsUserAccessToken(row.metadata) as string)
					: null,
				wabaId:
					typeof (row.metadata as { waba_id?: unknown } | null)?.waba_id ===
					"string"
						? ((row.metadata as { waba_id: string }).waba_id ?? null)
						: null,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		adAccounts: [...input.sources.adAccounts].sort((left, right) =>
			left.id.localeCompare(right.id),
		),
		adCampaigns: [...input.sources.adCampaigns].sort((left, right) =>
			left.id.localeCompare(right.id),
		),
		whatsappPhoneNumbers: [...input.sources.whatsappPhoneNumbers].sort(
			(left, right) => left.id.localeCompare(right.id),
		),
	};
	const sourceRowsSha256 = sha256(JSON.stringify(canonicalize(sourceRows)));
	const socialById = new Map(
		input.sources.socialAccounts.map((row) => [row.id, row]),
	);
	const authorities: PreliveProviderInventory["meta"]["authorities"] = [];
	const adAccountMap = new Map<
		string,
		PreliveProviderInventory["meta"]["adAccounts"][number]
	>();
	const campaignMap = new Map<
		string,
		PreliveProviderInventory["meta"]["campaigns"][number]
	>();
	const phoneMap = new Map<
		string,
		PreliveProviderInventory["meta"]["whatsappPhoneNumbers"][number]
	>();
	const accessByProviderAdAccount = new Map<string, string>();
	const systemAdAccountIds = new Set<string>();
	const authorityGaps: PreliveProviderInventory["meta"]["authorityGaps"] = [];
	const systemWabaIds = new Set<string>();
	const systemCredentialSha256 = sha256(
		`relayapi:meta-inventory-system-authority:v1:${input.systemAuthority.accessToken}`,
	);
	// Account-wide cutover authority. The protected system-user token must be
	// assigned every managed ad account, while the configured business edges
	// enumerate owned/client ad accounts and WhatsApp Business Accounts.
	// Official Graph references:
	// https://developers.facebook.com/docs/marketing-api/reference/business/owned_ad_accounts/
	// https://developers.facebook.com/docs/marketing-api/reference/business/client_ad_accounts/
	// https://developers.facebook.com/docs/graph-api/reference/business/owned_whatsapp_business_accounts/
	const business = await graphObject<{ id?: string }>({
		url: new URL(
			`${GRAPH_BASE.facebook}/${encodeURIComponent(input.systemAuthority.businessId)}?fields=id`,
		),
		accessToken: input.systemAuthority.accessToken,
		fetcher: input.fetcher,
	});
	if (business?.id !== input.systemAuthority.businessId) {
		throw new Error("Meta inventory system authority cannot read its business");
	}
	// Extended Credit is a separate business-level finance surface from ad
	// accounts. Its Graph edge is the only documented account-wide readback for
	// delegated credit lines, so failure to read it must fail the inventory.
	// https://developers.facebook.com/docs/marketing-api/reference/extended-credit/
	const extendedCredits = (
		await graphList<{
			id?: string;
			balance?: unknown;
			credit_available?: unknown;
			credit_type?: string;
		}>({
			url: new URL(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(input.systemAuthority.businessId)}/extendedcredits?fields=id,balance,credit_available,credit_type&limit=100`,
			),
			accessToken: input.systemAuthority.accessToken,
			fetcher: input.fetcher,
		})
	)
		.map((credit) => {
			if (!credit.id) {
				throw new Error("Meta returned an extended credit without an ID");
			}
			return {
				id: credit.id,
				balance: metaCurrencyAmount(
					credit.balance,
					`Meta extended credit ${credit.id} balance`,
				),
				creditAvailable: metaCurrencyAmount(
					credit.credit_available,
					`Meta extended credit ${credit.id} credit_available`,
				),
				creditType: credit.credit_type ?? null,
			};
		})
		.sort((left, right) => left.id.localeCompare(right.id));
	const assignedAdAccounts = await graphList<{
		id?: string;
		account_status?: number | string;
		currency?: string;
		balance?: string | number;
	}>({
		url: new URL(
			`${GRAPH_BASE.facebook}/me/adaccounts?fields=id,account_status,currency,balance&limit=100`,
		),
		accessToken: input.systemAuthority.accessToken,
		fetcher: input.fetcher,
	});
	for (const providerAccount of assignedAdAccounts) {
		if (!providerAccount.id) {
			throw new Error(
				"Meta system authority returned an ad account without an ID",
			);
		}
		accessByProviderAdAccount.set(
			providerAccount.id,
			input.systemAuthority.accessToken,
		);
		systemAdAccountIds.add(providerAccount.id);
		adAccountMap.set(providerAccount.id, {
			id: providerAccount.id,
			accountStatus: providerAccount.account_status ?? null,
			currency: providerAccount.currency ?? null,
			balance:
				providerAccount.balance === undefined
					? null
					: String(providerAccount.balance),
			authoritySocialAccountIds: [],
		});
	}
	for (const edge of ["owned_ad_accounts", "client_ad_accounts"] as const) {
		const discovered = await graphList<{
			id?: string;
			account_status?: number | string;
			currency?: string;
			balance?: string | number;
		}>({
			url: new URL(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(input.systemAuthority.businessId)}/${edge}?fields=id,account_status,currency,balance&limit=100`,
			),
			accessToken: input.systemAuthority.accessToken,
			fetcher: input.fetcher,
		});
		for (const providerAccount of discovered) {
			if (!providerAccount.id) {
				throw new Error(`Meta ${edge} returned an ad account without an ID`);
			}
			accessByProviderAdAccount.set(
				providerAccount.id,
				input.systemAuthority.accessToken,
			);
			systemAdAccountIds.add(providerAccount.id);
			adAccountMap.set(providerAccount.id, {
				id: providerAccount.id,
				accountStatus: providerAccount.account_status ?? null,
				currency: providerAccount.currency ?? null,
				balance:
					providerAccount.balance === undefined
						? null
						: String(providerAccount.balance),
				authoritySocialAccountIds: [],
			});
		}
	}
	for (const edge of [
		"owned_whatsapp_business_accounts",
		"client_whatsapp_business_accounts",
	] as const) {
		const discovered = await graphList<{ id?: string }>({
			url: new URL(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(input.systemAuthority.businessId)}/${edge}?fields=id&limit=100`,
			),
			accessToken: input.systemAuthority.accessToken,
			fetcher: input.fetcher,
		});
		for (const waba of discovered) {
			if (!waba.id)
				throw new Error(`Meta ${edge} returned a WABA without an ID`);
			systemWabaIds.add(waba.id);
		}
	}

	const metaAdAccounts = input.sources.adAccounts.filter(
		(row) => row.platform === "meta",
	);
	for (const localAccount of metaAdAccounts) {
		if (!systemAdAccountIds.has(localAccount.platformAdAccountId)) {
			authorityGaps.push({
				kind: "ads",
				localId: localAccount.id,
				reason: "not_visible_to_system_authority",
			});
		}
		if (!localAccount.socialAccountId) {
			authorityGaps.push({
				kind: "ads",
				localId: localAccount.id,
				reason: "dedicated_ad_connection_requires_inventory_support",
			});
			continue;
		}
		const social = socialById.get(localAccount.socialAccountId);
		if (!social) {
			throw new Error(
				`Meta ad account ${localAccount.id} lost its social authority`,
			);
		}
		const accessToken = await resolveAdsAccessToken(social, {
			ENCRYPTION_KEY: input.encryptionKey,
		} as Env);
		if (!accessToken) {
			throw new Error(
				`Meta ad account ${localAccount.id} has no usable credential`,
			);
		}
		authorities.push({
			kind: "ads",
			socialAccountId: social.id,
			organizationId: social.organizationId,
			providerAuthorityId: localAccount.platformAdAccountId,
			tokenVersion: social.tokenVersion,
			credentialCiphertextSha256: sha256(
				getMetaAdsUserAccessToken(social.metadata) ?? social.accessToken ?? "",
			),
		});
		accessByProviderAdAccount.set(
			localAccount.platformAdAccountId,
			accessToken,
		);
		const discovered = await graphList<{
			id?: string;
			account_status?: number | string;
			currency?: string;
			balance?: string | number;
		}>({
			url: new URL(
				`${GRAPH_BASE.facebook}/me/adaccounts?fields=id,account_status,currency,balance&limit=100`,
			),
			accessToken,
			fetcher: input.fetcher,
		});
		for (const providerAccount of discovered) {
			if (!providerAccount.id) {
				throw new Error("Meta returned an ad account without an ID");
			}
			accessByProviderAdAccount.set(providerAccount.id, accessToken);
			const existing = adAccountMap.get(providerAccount.id);
			adAccountMap.set(providerAccount.id, {
				id: providerAccount.id,
				accountStatus: providerAccount.account_status ?? null,
				currency: providerAccount.currency ?? null,
				balance:
					providerAccount.balance === undefined
						? null
						: String(providerAccount.balance),
				authoritySocialAccountIds: Array.from(
					new Set([...(existing?.authoritySocialAccountIds ?? []), social.id]),
				).sort(),
			});
		}
		if (!adAccountMap.has(localAccount.platformAdAccountId)) {
			adAccountMap.set(localAccount.platformAdAccountId, {
				id: localAccount.platformAdAccountId,
				accountStatus: null,
				currency: null,
				balance: null,
				authoritySocialAccountIds: [social.id],
			});
		}
	}

	for (const [providerAdAccountId, accessToken] of accessByProviderAdAccount) {
		const campaigns = await graphList<{
			id?: string;
			status?: string;
			effective_status?: string;
		}>({
			url: new URL(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(providerAdAccountId)}/campaigns?fields=id,status,effective_status&limit=100`,
			),
			accessToken,
			fetcher: input.fetcher,
		});
		for (const campaign of campaigns) {
			if (!campaign.id)
				throw new Error("Meta returned a campaign without an ID");
			const existing = campaignMap.get(campaign.id);
			const status = campaign.status ?? existing?.status ?? null;
			const effectiveStatus =
				campaign.effective_status ?? existing?.effectiveStatus ?? null;
			campaignMap.set(campaign.id, {
				id: campaign.id,
				status,
				effectiveStatus,
				authorityAdAccountIds: Array.from(
					new Set([
						...(existing?.authorityAdAccountIds ?? []),
						providerAdAccountId,
					]),
				).sort(),
				localCampaignIds: existing?.localCampaignIds ?? [],
				terminal: terminalMetaCampaign(status, effectiveStatus),
			});
		}
	}

	for (const wabaId of systemWabaIds) {
		const phones = await graphList<{
			id?: string;
			code_verification_status?: string;
			quality_rating?: string;
		}>({
			url: new URL(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,code_verification_status,quality_rating&limit=100`,
			),
			accessToken: input.systemAuthority.accessToken,
			fetcher: input.fetcher,
		});
		for (const phone of phones) {
			if (!phone.id) {
				throw new Error("Meta returned a system-authority phone without an ID");
			}
			phoneMap.set(`${wabaId}:${phone.id}`, {
				id: phone.id,
				wabaId,
				codeVerificationStatus: phone.code_verification_status ?? null,
				qualityRating: phone.quality_rating ?? null,
				authoritySocialAccountIds: [],
			});
		}
	}

	const localAdAccountById = new Map(
		metaAdAccounts.map((row) => [row.id, row]),
	);
	for (const localCampaign of input.sources.adCampaigns) {
		if (
			localCampaign.platform !== "meta" ||
			!localCampaign.platformCampaignId
		) {
			continue;
		}
		const localAccount = localAdAccountById.get(localCampaign.adAccountId);
		if (!localAccount) {
			throw new Error(`Meta campaign ${localCampaign.id} lost its ad account`);
		}
		const accessToken = accessByProviderAdAccount.get(
			localAccount.platformAdAccountId,
		);
		if (!accessToken) {
			throw new Error(
				`Meta campaign ${localCampaign.id} has no provider authority`,
			);
		}
		let providerCampaign = campaignMap.get(localCampaign.platformCampaignId);
		if (!providerCampaign) {
			const readback = await graphObject<{
				id?: string;
				status?: string;
				effective_status?: string;
			}>({
				url: new URL(
					`${GRAPH_BASE.facebook}/${encodeURIComponent(localCampaign.platformCampaignId)}?fields=id,status,effective_status`,
				),
				accessToken,
				fetcher: input.fetcher,
			});
			if (!readback) continue;
			if (!readback.id) {
				throw new Error(
					`Meta campaign ${localCampaign.id} returned no provider ID`,
				);
			}
			const status = readback.status ?? null;
			const effectiveStatus = readback.effective_status ?? null;
			providerCampaign = {
				id: readback.id,
				status,
				effectiveStatus,
				authorityAdAccountIds: [localAccount.platformAdAccountId],
				localCampaignIds: [],
				terminal: terminalMetaCampaign(status, effectiveStatus),
			};
			campaignMap.set(readback.id, providerCampaign);
		}
		providerCampaign.localCampaignIds = Array.from(
			new Set([...providerCampaign.localCampaignIds, localCampaign.id]),
		).sort();
	}

	for (const social of input.sources.socialAccounts) {
		if (social.platform !== "whatsapp") continue;
		const wabaId = (social.metadata as { waba_id?: unknown } | null)?.waba_id;
		if (typeof wabaId !== "string" || !wabaId) {
			authorityGaps.push({
				kind: "whatsapp",
				localId: social.id,
				reason: "missing_waba_id",
			});
			continue;
		}
		if (!social.accessToken) {
			authorityGaps.push({
				kind: "whatsapp",
				localId: social.id,
				reason: "missing_access_token",
			});
			continue;
		}
		if (!systemWabaIds.has(wabaId)) {
			authorityGaps.push({
				kind: "whatsapp",
				localId: social.id,
				reason: "not_visible_to_system_authority",
			});
		}
		const accessToken = await decryptAccountToken(
			social.accessToken,
			input.encryptionKey,
			social.id,
			"access_token",
		);
		if (!accessToken)
			throw new Error(`WhatsApp authority ${social.id} decrypted empty`);
		authorities.push({
			kind: "whatsapp",
			socialAccountId: social.id,
			organizationId: social.organizationId,
			providerAuthorityId: wabaId,
			tokenVersion: social.tokenVersion,
			credentialCiphertextSha256: sha256(social.accessToken),
		});
		const phones = await graphList<{
			id?: string;
			code_verification_status?: string;
			quality_rating?: string;
		}>({
			url: new URL(
				`${GRAPH_BASE.facebook}/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,code_verification_status,quality_rating&limit=100`,
			),
			accessToken,
			fetcher: input.fetcher,
		});
		for (const phone of phones) {
			if (!phone.id)
				throw new Error("Meta returned a WhatsApp phone without an ID");
			const key = `${wabaId}:${phone.id}`;
			const existing = phoneMap.get(key);
			phoneMap.set(key, {
				id: phone.id,
				wabaId,
				codeVerificationStatus: phone.code_verification_status ?? null,
				qualityRating: phone.quality_rating ?? null,
				authoritySocialAccountIds: Array.from(
					new Set([...(existing?.authoritySocialAccountIds ?? []), social.id]),
				).sort(),
			});
		}
	}

	authorities.sort((left, right) =>
		`${left.kind}\0${left.socialAccountId}\0${left.providerAuthorityId}`.localeCompare(
			`${right.kind}\0${right.socialAccountId}\0${right.providerAuthorityId}`,
		),
	);
	authorityGaps.sort((left, right) =>
		`${left.kind}\0${left.localId}\0${left.reason}`.localeCompare(
			`${right.kind}\0${right.localId}\0${right.reason}`,
		),
	);
	return {
		sourceRowsSha256,
		attestations: input.attestations,
		systemAuthority: {
			businessId: input.systemAuthority.businessId,
			credentialSha256: systemCredentialSha256,
		},
		authorityGaps,
		authorities,
		extendedCredits,
		adAccounts: [...adAccountMap.values()].sort((left, right) =>
			left.id.localeCompare(right.id),
		),
		campaigns: [...campaignMap.values()].sort((left, right) =>
			left.id.localeCompare(right.id),
		),
		whatsappPhoneNumbers: [...phoneMap.values()].sort((left, right) =>
			`${left.wabaId}\0${left.id}`.localeCompare(
				`${right.wabaId}\0${right.id}`,
			),
		),
	};
}

export async function captureProviderInventory(input: {
	stripe: StripeInventoryClient;
	stripeLivemode: boolean;
	expectedStripeAccountId: string;
	stripeTerminalReversalPolicy:
		| "block_terminal_history"
		| "accept_network_reversal_tail";
	stripeAttestations: {
		bankTransferFundingInstructions: "never_enabled";
		legacyReceiverSources: "never_enabled";
		connect: "never_enabled";
		livePricingTables: "none";
		accountDedicatedToRelayapi: true;
		unsupportedProductsDisabled: true;
	};
	serverPriceIds: Set<string>;
	telnyxNumbers: Awaited<ReturnType<typeof listOwnedPhoneNumbers>>;
	telnyxNumberOrders: Awaited<ReturnType<typeof listNumberOrders>>;
	telnyxFutureMoney: TelnyxFutureMoneyAllocations;
	telnyxCredentialSha256: string;
	expectedTelnyxCredentialSha256: string;
	telnyxAttestations: {
		accountDedicatedToRelayapi: true;
		unsupportedProductsDisabled: true;
		scheduledPayments: "disabled";
		autoRecharge: "disabled";
	};
	metaAttestations: {
		whatsappOutstandingInvoicesZero: true;
		whatsappAutomaticPaymentsDisabled: true;
	};
	metaSources: ProviderInventorySources;
	metaSystemAuthority: { businessId: string; accessToken: string };
	encryptionKey: string;
	graphFetch?: typeof fetch;
}): Promise<PreliveProviderInventory> {
	if (!input.stripeLivemode) {
		throw new Error("Stripe provider inventory requires a live-mode API key");
	}
	if (!input.expectedStripeAccountId.trim()) {
		throw new Error("Expected Stripe account ID is required");
	}
	if (
		input.stripeTerminalReversalPolicy !== "block_terminal_history" &&
		input.stripeTerminalReversalPolicy !== "accept_network_reversal_tail"
	) {
		throw new Error("Stripe terminal-reversal policy is invalid");
	}
	assertSha256(
		input.expectedTelnyxCredentialSha256,
		"Expected Telnyx API-key fingerprint",
	);
	if (input.telnyxCredentialSha256 !== input.expectedTelnyxCredentialSha256) {
		throw new Error("Telnyx API-key fingerprint mismatch");
	}
	if (
		input.telnyxAttestations.accountDedicatedToRelayapi !== true ||
		input.telnyxAttestations.unsupportedProductsDisabled !== true ||
		input.telnyxAttestations.scheduledPayments !== "disabled" ||
		input.telnyxAttestations.autoRecharge !== "disabled"
	) {
		throw new Error("Telnyx provider-scope attestations are incomplete");
	}
	if (
		input.metaAttestations.whatsappOutstandingInvoicesZero !== true ||
		input.metaAttestations.whatsappAutomaticPaymentsDisabled !== true
	) {
		throw new Error("Meta provider-scope attestations are incomplete");
	}
	const [stripe, meta] = await Promise.all([
		captureStripeInventory({
			stripe: input.stripe,
			livemode: input.stripeLivemode,
			expectedAccountId: input.expectedStripeAccountId,
			terminalReversalPolicy: input.stripeTerminalReversalPolicy,
			attestations: input.stripeAttestations,
			serverPriceIds: input.serverPriceIds,
		}),
		captureMetaInventory({
			sources: input.metaSources,
			encryptionKey: input.encryptionKey,
			fetcher: input.graphFetch ?? fetch,
			systemAuthority: input.metaSystemAuthority,
			attestations: input.metaAttestations,
		}),
	]);
	const ownedPhoneIdByFingerprint = new Map(
		input.telnyxNumbers.map((phone) => [
			phoneNumberFingerprint(phone.phoneNumber),
			phone.id,
		]),
	);
	const telnyx: PreliveProviderInventory["telnyx"] = {
		credentialSha256: input.telnyxCredentialSha256,
		attestations: input.telnyxAttestations,
		balance: input.telnyxFutureMoney.balance,
		phoneNumbers: input.telnyxNumbers
			.map((phone) => ({
				id: phone.id,
				phoneNumberSha256: phoneNumberFingerprint(phone.phoneNumber),
				status: phone.status,
				customerReferenceSha256: phone.customerReference
					? sha256(phone.customerReference)
					: null,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		numberOrders: input.telnyxNumberOrders
			.map((order) => ({
				id: order.id,
				status: order.status,
				customerReferenceSha256: order.customerReference
					? sha256(order.customerReference)
					: null,
				phoneNumberSha256: order.phoneNumbers
					.map(phoneNumberFingerprint)
					.sort(),
				updatedAt: order.updatedAt,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		numberBlockOrders: input.telnyxFutureMoney.numberBlockOrders
			.map((order) => ({
				id: order.id,
				status: order.status,
				customerReferenceSha256: order.customerReference
					? sha256(order.customerReference)
					: null,
				startingNumberSha256: order.startingNumber
					? phoneNumberFingerprint(order.startingNumber)
					: null,
				range: order.range,
				phoneNumbersCount: order.phoneNumbersCount,
				updatedAt: order.updatedAt,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		advancedOrders: input.telnyxFutureMoney.advancedOrders
			.map((order) => ({
				id: order.id,
				statuses: [...order.statuses].sort(),
				customerReferenceSha256: order.customerReference
					? sha256(order.customerReference)
					: null,
				quantity: order.quantity,
				numberOrderIds: [...order.numberOrderIds].sort(),
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		inexplicitNumberOrders: input.telnyxFutureMoney.inexplicitNumberOrders
			.map((order) => ({
				id: order.id,
				customerReferenceSha256: order.customerReference
					? sha256(order.customerReference)
					: null,
				updatedAt: order.updatedAt,
				orderingGroups: order.orderingGroups
					.map((group) => ({
						...group,
						numberOrderIds: [...group.numberOrderIds].sort(),
					}))
					.sort((left, right) => left.index - right.index),
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		portingOrders: input.telnyxFutureMoney.portingOrders
			.map((order) => ({
				id: order.id,
				status: order.status,
				customerReferenceSha256: order.customerReference
					? sha256(order.customerReference)
					: null,
				phoneNumbersCount: order.phoneNumbersCount,
				updatedAt: order.updatedAt,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
		portingPhoneNumbers: input.telnyxFutureMoney.portingPhoneNumbers
			.map((phone) => {
				const phoneNumberSha256 = phoneNumberFingerprint(phone.phoneNumber);
				return {
					portingOrderId: phone.portingOrderId,
					phoneNumberSha256,
					portingOrderStatus: phone.portingOrderStatus,
					activationStatus: phone.activationStatus,
					ownedPhoneNumberId:
						ownedPhoneIdByFingerprint.get(phoneNumberSha256) ?? null,
				};
			})
			.sort((left, right) =>
				`${left.portingOrderId}\0${left.phoneNumberSha256}`.localeCompare(
					`${right.portingOrderId}\0${right.phoneNumberSha256}`,
				),
			),
		portOuts: input.telnyxFutureMoney.portOuts
			.map((portOut) => ({
				id: portOut.id,
				status: portOut.status,
				hostMessaging: portOut.hostMessaging,
				phoneNumberSha256: portOut.phoneNumbers
					.map(phoneNumberFingerprint)
					.sort(),
				updatedAt: portOut.updatedAt,
			}))
			.sort((left, right) => left.id.localeCompare(right.id)),
	};
	const blockingResources: ProviderBlocker[] = [];
	if (
		stripe.account.payoutScheduleInterval !== "manual" ||
		stripe.balanceSettings.payoutScheduleInterval !== "manual"
	) {
		blockingResources.push({
			provider: "stripe",
			kind: "automatic_payout_schedule",
			id: stripe.account.id,
			status: `account=${stripe.account.payoutScheduleInterval ?? "unknown"},balance_settings=${stripe.balanceSettings.payoutScheduleInterval ?? "unknown"}`,
			managed: true,
		});
	}
	if (
		stripe.account.debitNegativeBalances !== false ||
		stripe.balanceSettings.debitNegativeBalances !== false
	) {
		blockingResources.push({
			provider: "stripe",
			kind: "automatic_negative_balance_debit",
			id: stripe.account.id,
			status: `account=${String(stripe.account.debitNegativeBalances)},balance_settings=${String(stripe.balanceSettings.debitNegativeBalances)}`,
			managed: true,
		});
	}
	for (const currency of stripe.balanceSettings
		.automaticTransferRuleCurrencies) {
		blockingResources.push({
			provider: "stripe",
			kind: "automatic_balance_transfer_rule",
			id: currency,
			status: "enabled",
			managed: true,
		});
	}
	for (const [kind, amounts] of [
		["available_balance", stripe.balance.available],
		["pending_balance", stripe.balance.pending],
		["connect_reserved_balance", stripe.balance.connectReserved],
	] as const) {
		for (const amount of amounts) {
			if (amount.amount !== 0) {
				blockingResources.push({
					provider: "stripe",
					kind,
					id: amount.currency,
					status: String(amount.amount),
					managed: true,
				});
			}
		}
	}
	for (const cashBalance of stripe.customerCashBalances) {
		for (const amount of cashBalance.available) {
			if (amount.amount !== 0) {
				blockingResources.push({
					provider: "stripe",
					kind: "customer_cash_balance",
					id: `${cashBalance.customerId}:${amount.currency}`,
					status: String(amount.amount),
					managed: cashBalance.managed,
				});
			}
		}
	}
	for (const customer of stripe.customers) {
		if (customer.balance !== 0) {
			blockingResources.push({
				provider: "stripe",
				kind: "customer_invoice_balance",
				id: `${customer.id}:${customer.currency ?? "unknown_currency"}`,
				status: String(customer.balance),
				managed: customer.managed,
			});
		}
		for (const balance of customer.invoiceCreditBalance) {
			if (balance.amount === 0) continue;
			blockingResources.push({
				provider: "stripe",
				kind: "customer_invoice_credit_balance",
				id: `${customer.id}:${balance.currency}`,
				status: String(balance.amount),
				managed: customer.managed,
			});
		}
	}
	for (const subscription of stripe.subscriptions) {
		if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
			blockingResources.push({
				provider: "stripe",
				kind: "subscription",
				id: subscription.id,
				status: subscription.status,
				managed: subscription.managed,
			});
		}
	}
	for (const session of stripe.openCheckoutSessions) {
		blockingResources.push({
			provider: "stripe",
			kind: "checkout_session",
			id: session.id,
			status: session.status,
			managed: session.managed,
		});
	}
	for (const paymentLink of stripe.activePaymentLinks) {
		blockingResources.push({
			provider: "stripe",
			kind: "payment_link",
			id: paymentLink.id,
			status: "active",
			managed: paymentLink.managed,
		});
	}
	for (const invoice of stripe.collectibleInvoices) {
		blockingResources.push({
			provider: "stripe",
			kind: "collectible_invoice",
			id: invoice.id,
			status: invoice.status,
			managed: invoice.managed,
		});
	}
	for (const item of stripe.pendingInvoiceItems) {
		blockingResources.push({
			provider: "stripe",
			kind: "pending_invoice_item",
			id: item.id,
			status: "pending",
			managed: item.managed,
		});
	}
	for (const schedule of stripe.subscriptionSchedules) {
		if (!["canceled", "completed", "released"].includes(schedule.status)) {
			blockingResources.push({
				provider: "stripe",
				kind: "subscription_schedule",
				id: schedule.id,
				status: schedule.status,
				managed: schedule.managed,
			});
		}
	}
	for (const intent of stripe.paymentIntents) {
		if (
			stripe.terminalReversalPolicy === "block_terminal_history" ||
			!["canceled", "succeeded"].includes(intent.status)
		) {
			blockingResources.push({
				provider: "stripe",
				kind: "payment_intent",
				id: intent.id,
				status: intent.status,
				managed: intent.managed,
			});
		}
	}
	for (const charge of stripe.charges) {
		if (
			stripe.terminalReversalPolicy === "block_terminal_history" ||
			!["failed", "succeeded"].includes(charge.status) ||
			(charge.paid && !charge.captured)
		) {
			blockingResources.push({
				provider: "stripe",
				kind: "charge",
				id: charge.id,
				status: `${charge.status};paid=${String(charge.paid)},captured=${String(charge.captured)},refunded=${String(charge.refunded)},disputed=${String(charge.disputed)}`,
				managed: charge.managed,
			});
		}
	}
	for (const refund of stripe.refunds) {
		if (
			stripe.terminalReversalPolicy === "block_terminal_history" ||
			!["canceled", "failed", "succeeded"].includes(refund.status ?? "")
		) {
			blockingResources.push({
				provider: "stripe",
				kind: "refund",
				id: refund.id,
				status: refund.status,
				managed: refund.managed,
			});
		}
	}
	for (const dispute of stripe.disputes) {
		// Stripe documents rare issuer-driven late wins after a loss. The
		// selected policy makes acceptance of that network tail explicit.
		if (
			stripe.terminalReversalPolicy === "block_terminal_history" ||
			!["warning_closed", "won", "lost"].includes(dispute.status)
		) {
			blockingResources.push({
				provider: "stripe",
				kind: "dispute",
				id: dispute.id,
				status: dispute.status,
				managed: dispute.managed,
			});
		}
	}
	for (const setupIntent of stripe.setupIntents) {
		if (!["canceled", "succeeded"].includes(setupIntent.status)) {
			blockingResources.push({
				provider: "stripe",
				kind: "setup_intent",
				id: setupIntent.id,
				status: setupIntent.status,
				managed: setupIntent.managed,
			});
		}
	}
	for (const topup of stripe.topups) {
		if (
			stripe.terminalReversalPolicy === "block_terminal_history" ||
			!["canceled", "failed", "succeeded"].includes(topup.status)
		) {
			blockingResources.push({
				provider: "stripe",
				kind: "topup",
				id: topup.id,
				status: topup.status,
				managed: topup.managed,
			});
		}
	}
	for (const payout of stripe.payouts) {
		if (
			stripe.terminalReversalPolicy === "block_terminal_history" ||
			!["canceled", "failed", "paid"].includes(payout.status)
		) {
			blockingResources.push({
				provider: "stripe",
				kind: "payout",
				id: payout.id,
				status: payout.status,
				managed: payout.managed,
			});
		}
	}
	for (const [kind, amount] of [
		["account_balance", telnyx.balance.balance],
		["pending_balance", telnyx.balance.pending],
	] as const) {
		if (!metaBalanceIsZero(amount)) {
			blockingResources.push({
				provider: "telnyx",
				kind,
				id: telnyx.balance.currency ?? "unknown_currency",
				status: amount,
				managed: true,
			});
		}
	}
	for (const phone of telnyx.phoneNumbers) {
		blockingResources.push({
			provider: "telnyx",
			kind: "owned_phone_number",
			id: phone.id,
			status: phone.status,
			managed: true,
		});
	}
	for (const order of telnyx.numberOrders) {
		if (
			!["success", "cancelled", "deleted", "failure"].includes(order.status)
		) {
			blockingResources.push({
				provider: "telnyx",
				kind: "number_order",
				id: order.id,
				status: order.status,
				managed: true,
			});
		}
	}
	for (const order of telnyx.numberBlockOrders) {
		if (
			!["success", "cancelled", "deleted", "failure"].includes(
				order.status ?? "",
			)
		) {
			blockingResources.push({
				provider: "telnyx",
				kind: "number_block_order",
				id: order.id,
				status: order.status,
				managed: true,
			});
		}
	}
	const standardOrderById = new Map(
		telnyx.numberOrders.map((order) => [order.id, order]),
	);
	const numberOrdersReconciled = (
		numberOrderIds: string[],
		expectedAllocation: number | null,
	): boolean => {
		if (expectedAllocation === 0) return numberOrderIds.length === 0;
		if (numberOrderIds.length === 0) return false;
		const orders = numberOrderIds.map((id) => standardOrderById.get(id));
		return orders.every(
			(order) =>
				order !== undefined &&
				["success", "cancelled", "deleted", "failure"].includes(order.status),
		);
	};
	for (const order of telnyx.advancedOrders) {
		if (order.statuses.length === 1 && order.statuses[0] === "failed") continue;
		if (order.statuses.length === 1 && order.statuses[0] === "ordered") {
			if (numberOrdersReconciled(order.numberOrderIds, order.quantity))
				continue;
			blockingResources.push({
				provider: "telnyx",
				kind: "advanced_order_reconciliation",
				id: order.id,
				status: "ordered_unreconciled",
				managed: true,
			});
			continue;
		}
		blockingResources.push({
			provider: "telnyx",
			kind: "advanced_order",
			id: order.id,
			status: order.statuses.join(",") || null,
			managed: true,
		});
	}
	for (const order of telnyx.inexplicitNumberOrders) {
		if (order.orderingGroups.length === 0) {
			blockingResources.push({
				provider: "telnyx",
				kind: "inexplicit_number_order_reconciliation",
				id: order.id,
				status: "missing_ordering_groups",
				managed: true,
			});
			continue;
		}
		for (const group of order.orderingGroups) {
			const id = `${order.id}:${group.index}`;
			if (group.status === "failed") continue;
			if (["success", "partial_success"].includes(group.status ?? "")) {
				if (
					numberOrdersReconciled(group.numberOrderIds, group.countAllocated)
				) {
					continue;
				}
				blockingResources.push({
					provider: "telnyx",
					kind: "inexplicit_number_order_reconciliation",
					id,
					status: `${group.status}_unreconciled`,
					managed: true,
				});
				continue;
			}
			blockingResources.push({
				provider: "telnyx",
				kind: "inexplicit_number_order",
				id,
				status: group.status,
				managed: true,
			});
		}
	}
	const portingPhonesByOrder = new Map<
		string,
		PreliveProviderInventory["telnyx"]["portingPhoneNumbers"]
	>();
	for (const phone of telnyx.portingPhoneNumbers) {
		const phones = portingPhonesByOrder.get(phone.portingOrderId) ?? [];
		phones.push(phone);
		portingPhonesByOrder.set(phone.portingOrderId, phones);
	}
	const knownPortingOrderIds = new Set(
		telnyx.portingOrders.map((order) => order.id),
	);
	for (const phone of telnyx.portingPhoneNumbers) {
		if (!knownPortingOrderIds.has(phone.portingOrderId)) {
			blockingResources.push({
				provider: "telnyx",
				kind: "porting_phone_number_reconciliation",
				id: `${phone.portingOrderId}:${phone.phoneNumberSha256}`,
				status: "missing_porting_order",
				managed: true,
			});
		}
	}
	for (const order of telnyx.portingOrders) {
		if (["cancelled", "deleted"].includes(order.status ?? "")) continue;
		if (order.status === "ported") {
			const phones = portingPhonesByOrder.get(order.id) ?? [];
			if (
				order.phoneNumbersCount === null ||
				phones.length !== order.phoneNumbersCount ||
				!phones.every((phone) => phone.portingOrderStatus === "ported")
			) {
				blockingResources.push({
					provider: "telnyx",
					kind: "porting_order_reconciliation",
					id: order.id,
					status: "ported_unreconciled",
					managed: true,
				});
				continue;
			}
			// `ported` is a terminal transfer-history state. A number may later be
			// deleted (ending recurring charges) while the porting record remains;
			// current ownership is authoritatively swept from /phone_numbers/slim.
			continue;
		}
		blockingResources.push({
			provider: "telnyx",
			kind: "porting_order",
			id: order.id,
			status: order.status,
			managed: true,
		});
	}
	for (const portOut of telnyx.portOuts) {
		if (["canceled", "rejected"].includes(portOut.status ?? "")) continue;
		if (portOut.status === "ported" && portOut.hostMessaging === false) {
			continue;
		}
		blockingResources.push({
			provider: "telnyx",
			kind:
				portOut.status === "ported" ? "portout_hosted_messaging" : "portout",
			id: portOut.id,
			status:
				portOut.status === "ported"
					? `host_messaging=${String(portOut.hostMessaging)}`
					: portOut.status,
			managed: true,
		});
	}
	for (const account of meta.adAccounts) {
		if (!metaBalanceIsZero(account.balance)) {
			blockingResources.push({
				provider: "meta",
				kind: "ad_account_balance",
				id: account.id,
				status: account.balance,
				managed: true,
			});
		}
		if (!metaAccountStatusIsSettled(account.accountStatus)) {
			blockingResources.push({
				provider: "meta",
				kind: "ad_account_settlement_status",
				id: account.id,
				status:
					account.accountStatus === null ? null : String(account.accountStatus),
				managed: true,
			});
		}
	}
	for (const credit of meta.extendedCredits) {
		if (!metaBalanceIsZero(credit.balance.amount)) {
			blockingResources.push({
				provider: "meta",
				kind: "extended_credit_balance",
				id: `${credit.id}:${credit.balance.currency ?? "unknown_currency"}`,
				status: credit.balance.amount,
				managed: true,
			});
		}
	}
	for (const campaign of meta.campaigns) {
		if (!campaign.terminal) {
			blockingResources.push({
				provider: "meta",
				kind: "ad_campaign",
				id: campaign.id,
				status: campaign.effectiveStatus ?? campaign.status,
				managed: true,
			});
		}
	}
	for (const phone of meta.whatsappPhoneNumbers) {
		blockingResources.push({
			provider: "meta",
			kind: "whatsapp_phone_number",
			id: phone.id,
			status: phone.codeVerificationStatus,
			managed: true,
		});
	}
	for (const gap of meta.authorityGaps) {
		blockingResources.push({
			provider: "meta",
			kind: `${gap.kind}_authority_gap`,
			id: gap.localId,
			status: gap.reason,
			managed: true,
		});
	}
	blockingResources.sort(compareBlockers);
	return {
		schemaVersion: 2,
		targetBaselineGeneration: 2,
		scope: "relayapi_integrated_provider_money_surfaces",
		stripe,
		telnyx,
		meta,
		blockingResources,
	};
}

async function loadMetaSources(
	db: ReturnType<typeof createDb>,
): Promise<ProviderInventorySources> {
	const [social, accounts, campaigns, phones] = await Promise.all([
		db
			.select({
				id: socialAccounts.id,
				organizationId: socialAccounts.organizationId,
				platform: socialAccounts.platform,
				accessToken: socialAccounts.accessToken,
				tokenVersion: socialAccounts.tokenVersion,
				metadata: socialAccounts.metadata,
				lifecycleStatus: socialAccounts.lifecycleStatus,
			})
			.from(socialAccounts),
		db
			.select({
				id: adAccounts.id,
				organizationId: adAccounts.organizationId,
				socialAccountId: adAccounts.socialAccountId,
				platform: adAccounts.platform,
				platformAdAccountId: adAccounts.platformAdAccountId,
				status: adAccounts.status,
			})
			.from(adAccounts),
		db
			.select({
				id: adCampaigns.id,
				organizationId: adCampaigns.organizationId,
				adAccountId: adCampaigns.adAccountId,
				platform: adCampaigns.platform,
				platformCampaignId: adCampaigns.platformCampaignId,
				status: adCampaigns.status,
			})
			.from(adCampaigns),
		db
			.select({
				id: whatsappPhoneNumbers.id,
				organizationId: whatsappPhoneNumbers.organizationId,
				socialAccountId: whatsappPhoneNumbers.socialAccountId,
				providerNumberId: whatsappPhoneNumbers.providerNumberId,
				waPhoneNumberId: whatsappPhoneNumbers.waPhoneNumberId,
				status: whatsappPhoneNumbers.status,
			})
			.from(whatsappPhoneNumbers),
	]);
	return {
		socialAccounts: social,
		adAccounts: accounts,
		adCampaigns: campaigns,
		whatsappPhoneNumbers: phones,
	};
}

async function main(): Promise<void> {
	const command = process.argv[2];
	if (command !== "capture" && command !== "verify") {
		throw new Error(
			"Usage: bun run scripts/prelive-provider-inventory.ts capture|verify",
		);
	}
	const stripeSecretKey = required("STRIPE_SECRET_KEY");
	const telnyxApiKey = required("TELNYX_API_KEY");
	if (!stripeApiKeyIsLive(stripeSecretKey)) {
		throw new Error(
			"STRIPE_SECRET_KEY must be an sk_live_ or rk_live_ production key",
		);
	}
	const expectedStripeAccountId = required(
		"PRELIVE_EXPECTED_STRIPE_ACCOUNT_ID",
	);
	const expectedTelnyxCredentialSha256 = required(
		"PRELIVE_EXPECTED_TELNYX_API_KEY_SHA256",
	);
	assertSha256(
		expectedTelnyxCredentialSha256,
		"PRELIVE_EXPECTED_TELNYX_API_KEY_SHA256",
	);
	const telnyxCredentialSha256 = telnyxApiKeyFingerprint(telnyxApiKey);
	if (telnyxCredentialSha256 !== expectedTelnyxCredentialSha256) {
		throw new Error("Telnyx API-key fingerprint mismatch");
	}
	const stripeAttestations = {
		bankTransferFundingInstructions: requireNeverEnabledAttestation(
			"PRELIVE_STRIPE_BANK_TRANSFER_FUNDING_INSTRUCTIONS_ATTESTATION",
		),
		// Legacy receiver Sources can automatically settle into the platform
		// balance after 60 days and cannot be proven absent via Cash Balance.
		// https://docs.stripe.com/invoicing/customer/balance?dashboard-or-api=api
		legacyReceiverSources: requireNeverEnabledAttestation(
			"PRELIVE_STRIPE_LEGACY_RECEIVER_SOURCES_ATTESTATION",
		),
		connect: requireNeverEnabledAttestation(
			"PRELIVE_STRIPE_CONNECT_ATTESTATION",
		),
		livePricingTables: requireNoLivePricingTables(
			"PRELIVE_STRIPE_LIVE_PRICING_TABLES_ATTESTATION",
		),
		accountDedicatedToRelayapi: requireTrueAttestation(
			"PRELIVE_STRIPE_ACCOUNT_DEDICATED_TO_RELAYAPI",
		),
		unsupportedProductsDisabled: requireTrueAttestation(
			"PRELIVE_STRIPE_UNSUPPORTED_PRODUCTS_DISABLED",
		),
	};
	const stripeTerminalReversalPolicy = requireTerminalReversalPolicy(
		"PRELIVE_PROVIDER_TERMINAL_REVERSAL_POLICY",
	);
	const telnyxAttestations = {
		accountDedicatedToRelayapi: requireTrueAttestation(
			"PRELIVE_TELNYX_ACCOUNT_DEDICATED_TO_RELAYAPI",
		),
		unsupportedProductsDisabled: requireTrueAttestation(
			"PRELIVE_TELNYX_UNSUPPORTED_PRODUCTS_DISABLED",
		),
		scheduledPayments: requireDisabledAttestation(
			"PRELIVE_TELNYX_SCHEDULED_PAYMENTS_ATTESTATION",
		),
		autoRecharge: requireDisabledAttestation(
			"PRELIVE_TELNYX_AUTO_RECHARGE_ATTESTATION",
		),
	};
	const metaAttestations = {
		whatsappOutstandingInvoicesZero: requireTrueAttestation(
			"PRELIVE_META_WHATSAPP_OUTSTANDING_INVOICES_ZERO",
		),
		whatsappAutomaticPaymentsDisabled: requireTrueAttestation(
			"PRELIVE_META_WHATSAPP_AUTOMATIC_PAYMENTS_DISABLED",
		),
	};
	const encryptionKey = required("ENCRYPTION_KEY");
	const metaInventoryBusinessId = required("META_INVENTORY_BUSINESS_ID");
	const metaInventorySystemUserAccessToken = required(
		"META_INVENTORY_SYSTEM_USER_ACCESS_TOKEN",
	);
	const db = createDb(required(CONNECTION_ENV));
	try {
		const stripeClient = await createStripeClient(stripeSecretKey);
		const stripeAccount = await stripeClient.accounts.retrieveCurrent();
		if (stripeAccount.id !== expectedStripeAccountId) {
			throw new Error(
				`Stripe account identity mismatch: expected ${expectedStripeAccountId}, got ${stripeAccount.id}`,
			);
		}
		const serverPriceIds = new Set(
			[process.env.STRIPE_PRO_PRICE_ID, process.env.STRIPE_WA_PHONE_PRICE_ID]
				.map((value) => value?.trim())
				.filter((value): value is string => Boolean(value)),
		);
		if (serverPriceIds.size === 0) {
			throw new Error("At least one server-owned Stripe price ID is required");
		}
		const captureActual = async (): Promise<PreliveProviderInventory> => {
			const [
				telnyxNumbers,
				telnyxNumberOrders,
				telnyxFutureMoney,
				metaSources,
			] = await Promise.all([
				listOwnedPhoneNumbers(telnyxApiKey),
				listNumberOrders(telnyxApiKey),
				captureTelnyxFutureMoneyAllocations({ apiKey: telnyxApiKey }),
				loadMetaSources(db),
			]);
			return captureProviderInventory({
				stripe: stripeClient as unknown as StripeInventoryClient,
				stripeLivemode: true,
				expectedStripeAccountId,
				stripeTerminalReversalPolicy,
				stripeAttestations,
				serverPriceIds,
				telnyxNumbers,
				telnyxNumberOrders,
				telnyxFutureMoney,
				telnyxCredentialSha256,
				expectedTelnyxCredentialSha256,
				telnyxAttestations,
				metaAttestations,
				metaSources,
				metaSystemAuthority: {
					businessId: metaInventoryBusinessId,
					accessToken: metaInventorySystemUserAccessToken,
				},
				encryptionKey,
			});
		};
		const first = await captureActual();
		const actual = await captureActual();
		assertStableProviderInventories(first, actual);
		if (command === "capture") {
			const output = required("PRELIVE_PROVIDER_INVENTORY_OUTPUT");
			writeFileSync(output, canonicalProviderInventory(actual), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			console.log(
				JSON.stringify({
					event: "prelive_provider_inventory_captured",
					sha256: providerInventorySha256(actual),
					blocking_resource_count: actual.blockingResources.length,
					output,
				}),
			);
			return;
		}
		const approvedPath = required("PRELIVE_APPROVED_PROVIDER_INVENTORY");
		const approved = parseProviderInventory(readFileSync(approvedPath, "utf8"));
		const expectedSha256 = required(
			"PRELIVE_APPROVED_PROVIDER_INVENTORY_SHA256",
		);
		if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
			throw new Error("Approved provider inventory SHA-256 is invalid");
		}
		if (providerInventorySha256(approved) !== expectedSha256) {
			throw new Error("Approved provider inventory file digest does not match");
		}
		if (
			canonicalProviderInventory(actual) !==
			canonicalProviderInventory(approved)
		) {
			throw new Error(
				`Live provider inventory changed; expected ${expectedSha256}, got ${providerInventorySha256(actual)}`,
			);
		}
		if (approved.blockingResources.length > 0) {
			throw new Error(
				"Provider inventory still contains money-bearing resources",
			);
		}
		console.log(
			JSON.stringify({
				event: "prelive_provider_inventory_verified",
				sha256: expectedSha256,
			}),
		);
	} finally {
		await db.$client.end({ timeout: 5 });
	}
}

if (import.meta.main) await main();
