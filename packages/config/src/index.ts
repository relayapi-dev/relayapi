/**
 * @relayapi/config — Shared pricing, plan tiers, and system configuration.
 *
 * Used by: apps/api (enforcement), apps/app (dashboard display), apps/docs (pricing page).
 * Per-user overrides are stored in the `organization_subscriptions` table.
 */

export interface PlanTier {
	/** Display name */
	name: string;
	/** Monthly base price in cents */
	monthlyPriceCents: number;
	/** API calls included per month */
	apiCallsIncluded: number;
	/** Price per 1,000 additional calls in cents (0 = hard limit, no overage) */
	pricePerThousandCallsCents: number;
	/** Requests per minute rate limit */
	rateLimitMax: number;
	/** Rate limit window in seconds */
	rateLimitWindow: number;
	/** Features included in this plan */
	features: {
		analytics: boolean;
		inbox: boolean;
		prioritySupport: boolean;
	};
	/** Display features for pricing page */
	displayFeatures: string[];
}

export const PLANS: Record<"free" | "pro", PlanTier> = {
	free: {
		name: "Free",
		monthlyPriceCents: 0,
		apiCallsIncluded: 200,
		pricePerThousandCallsCents: 0, // hard limit — no overage allowed
		rateLimitMax: 100,
		rateLimitWindow: 60,
		features: {
			analytics: false,
			inbox: false,
			prioritySupport: false,
		},
		displayFeatures: [
			"200 API calls/month",
			"All 21 platforms",
			"Unlimited profiles",
			"Media uploads",
			"Webhook notifications",
			"100 req/min rate limit",
		],
	},
	pro: {
		name: "Pro",
		monthlyPriceCents: 500,
		apiCallsIncluded: 10_000,
		pricePerThousandCallsCents: 100,
		rateLimitMax: 1_000,
		rateLimitWindow: 60,
		features: {
			analytics: true,
			inbox: true,
			prioritySupport: false,
		},
		displayFeatures: [
			"10,000 API calls included",
			"$1 per 1,000 extra calls",
			"All 21 platforms",
			"Unlimited profiles",
			"Comments API included",
			"Analytics API included",
			"1,000 req/min rate limit",
		],
	},
};

/** System-wide limits */
export const LIMITS = {
	/** Maximum FREE organizations a single user can own (paid orgs are unlimited) */
	maxFreeOrgsPerUser: 2,
	/** Maximum members per organization */
	maxMembersPerOrg: 50,
	/** Maximum posts in a single bulk create request */
	maxBulkPosts: 50,
	/** Bulk create counts each post as a separate API call */
	bulkPostsCountIndividually: true,
} as const;

/** Blocked URL patterns for outbound webhook/SSRF protection */
export const BLOCKED_URL_PATTERNS = [
	/^https?:\/\/localhost/i,
	/^https?:\/\/127\./,
	/^https?:\/\/0\./,
	/^https?:\/\/10\./,
	/^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
	/^https?:\/\/192\.168\./,
	/^https?:\/\/169\.254\./,
	/^https?:\/\/\[::1\]/,
	/^https?:\/\/\[fc/i,
	/^https?:\/\/\[fd/i,
	/^https?:\/\/\[fe80:/i,
	/^https?:\/\/metadata\.google/i,
	/^https?:\/\/100\.100\.100\.200/,
] as const;

export function isBlockedUrl(url: string): boolean {
	return BLOCKED_URL_PATTERNS.some((pattern) => pattern.test(url));
}

/** Helper to get plan config by name */
export function getPlan(name: "free" | "pro"): PlanTier {
	return PLANS[name];
}

/** Stripe price IDs — set real values via env in production */
export const STRIPE = {
	proPriceId: "price_pro_monthly", // $5/mo flat subscription; overage added as invoice items
} as const;

/** Flat pricing constants shared by applications. */
export const PRICING = {
	freeCallsIncluded: PLANS.free.apiCallsIncluded,
	monthlyPriceCents: PLANS.pro.monthlyPriceCents,
	proCallsIncluded: PLANS.pro.apiCallsIncluded,
	pricePerThousandCallsCents: PLANS.pro.pricePerThousandCallsCents,
	freeRateLimitMax: PLANS.free.rateLimitMax,
	freeRateLimitWindow: PLANS.free.rateLimitWindow,
	proRateLimitMax: PLANS.pro.rateLimitMax,
	proRateLimitWindow: PLANS.pro.rateLimitWindow,
} as const;

/**
 * Shared API-key cache policy. KV is only a derivative authorization cache;
 * every writer uses this short backstop so DB revocations and entitlement
 * changes cannot remain effective at the edge for longer than ten minutes.
 */
export const API_KEY_CACHE_TTL_SECONDS = 600;
export const API_KEY_NEGATIVE_CACHE_TTL_SECONDS = 300;

export function apiKeyCacheTtl(
	expiresAt: Date | string | null | undefined,
	now = new Date(),
): number {
	if (!expiresAt) return API_KEY_CACHE_TTL_SECONDS;
	const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
	const secondsUntilExpiry = Math.floor(
		(expiry.getTime() - now.getTime()) / 1000,
	);
	// Cloudflare KV requires a minimum TTL of 60 seconds. API auth still checks
	// expires_at on every hit, so this never extends the key's authorization.
	return Math.max(60, Math.min(API_KEY_CACHE_TTL_SECONDS, secondsUntilExpiry));
}

export type BillingSubscriptionStatus =
	| "trialing"
	| "active"
	| "past_due"
	| "cancelled"
	| null
	| undefined;

export interface BillingPolicyInput {
	status: BillingSubscriptionStatus;
	stripeSubscriptionId?: string | null;
	trialEndsAt?: Date | string | null;
	currentPeriodStart?: Date | string | null;
	currentPeriodEnd?: Date | string | null;
}

export interface BillingPolicyDecision {
	/** Product access. Kept separate from whether usage may be invoiced. */
	entitlement: "free" | "pro";
	/** The usage window to attribute API calls to, when Stripe is authoritative. */
	usagePeriod: { start: Date; end: Date } | null;
	/** Whether metered overage may be sent to Stripe. */
	billable: boolean;
	/** Why the decision was made, useful for logs/tests without duplicating policy. */
	reason:
		| "active"
		| "authoritative_trial"
		| "expired_or_unproven_trial"
		| "inactive";
}

function asValidDate(value: Date | string | null | undefined): Date | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Single source of truth for entitlement, usage periods, and billability.
 * A local `trialing` value alone is deliberately insufficient: a Pro trial
 * must be backed by a Stripe subscription and a future Stripe trial end.
 */
export function getBillingPolicy(
	input: BillingPolicyInput,
	now = new Date(),
): BillingPolicyDecision {
	const periodStart = asValidDate(input.currentPeriodStart);
	const periodEnd = asValidDate(input.currentPeriodEnd);
	const validPeriod =
		periodStart && periodEnd && periodEnd > periodStart
			? { start: periodStart, end: periodEnd }
			: null;

	if (input.status === "active") {
		return {
			entitlement: "pro",
			usagePeriod: validPeriod,
			billable: Boolean(input.stripeSubscriptionId),
			reason: "active",
		};
	}

	if (input.status === "trialing") {
		const trialEndsAt = asValidDate(input.trialEndsAt);
		const authoritativeTrial = Boolean(
			input.stripeSubscriptionId && trialEndsAt && trialEndsAt > now,
		);
		return {
			entitlement: authoritativeTrial ? "pro" : "free",
			usagePeriod: authoritativeTrial ? validPeriod : null,
			// Trials have entitlement but are not billed for overage.
			billable: false,
			reason: authoritativeTrial
				? "authoritative_trial"
				: "expired_or_unproven_trial",
		};
	}

	return {
		entitlement: "free",
		usagePeriod: null,
		billable: false,
		reason: "inactive",
	};
}
