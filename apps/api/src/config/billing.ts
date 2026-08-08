/**
 * Server-owned Stripe contract. The webhook endpoint must be configured with
 * the same API version as the SDK so event objects and request responses share
 * one shape.
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia" as const;

export const STRIPE_SUBSCRIPTION_ROLE_KEY = "relayapi_role" as const;
export const STRIPE_MANAGED_BY_KEY = "relayapi_managed_by" as const;
export const STRIPE_MANAGED_BY_VALUE = "relayapi" as const;

export const STRIPE_SUBSCRIPTION_ROLES = {
	base: "base",
	phoneAddon: "phone_addon",
} as const;

export type StripeSubscriptionRole =
	(typeof STRIPE_SUBSCRIPTION_ROLES)[keyof typeof STRIPE_SUBSCRIPTION_ROLES];

/** Bump whenever any economic, allowance, discount, or tax term changes. */
export const BILLING_RATE_CARD_VERSION = "hosted-usd-v1" as const;

export const BASE_PRICE_TAX_BEHAVIOR = "unspecified" as const;
export const BASE_PRICE_TAX_CODE: string | null = null;
export const OVERAGE_DISCOUNTABLE = false;

/**
 * Keep this manifest in source control and mirror it exactly on the Stripe
 * webhook endpoint during rollout.
 */
export const STRIPE_FINANCIAL_EVENT_MANIFEST = [
	"checkout.session.async_payment_failed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.completed",
	"credit_note.created",
	"credit_note.updated",
	"customer.subscription.created",
	"customer.subscription.deleted",
	"customer.subscription.updated",
	"invoice.created",
	"invoice.finalization_failed",
	"invoice.finalized",
	"invoice.marked_uncollectible",
	"invoice.paid",
	"invoice.payment_failed",
	"invoice.voided",
	"charge.dispute.created",
	"charge.dispute.closed",
	"refund.created",
	"refund.failed",
	"refund.updated",
] as const;

export const STRIPE_SUBSCRIPTION_CYCLE_FINALIZATION_GRACE_SECONDS = 2 * 60 * 60;

/** Durable marker for provider proof that arrives after a local terminal choice. */
export const LATE_BILLING_EFFECT_ALERT_PREFIX =
	"late_provider_effect_requires_compensation:v1:" as const;
export const LATE_BILLING_EFFECT_REASON_CODE =
	"late_provider_effect_requires_compensating_invoice_or_credit" as const;
export const LATE_BILLING_EFFECT_COMPENSATED_PREFIX =
	"late_provider_effect_compensated:v1:" as const;
export const LATE_BILLING_EFFECT_WAIVED_PREFIX =
	"late_provider_effect_writeoff_accepted:v1:" as const;
