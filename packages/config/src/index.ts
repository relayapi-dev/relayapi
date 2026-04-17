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
	/** Maximum organizations a single user can create */
	maxOrgsPerUser: 2,
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

/** Flat PRICING object for backward compatibility */
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
