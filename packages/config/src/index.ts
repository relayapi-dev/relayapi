/**
 * @relayapi/config — Shared pricing, plan tiers, and system configuration.
 *
 * Used by: apps/api (enforcement), apps/app (dashboard display), apps/docs (pricing page).
 * Per-organization overrides are stored in the
 * `organization_subscriptions` table.
 */

const ORGANIZATION_CREDENTIAL_ADMIN_ROLES = new Set(["owner", "admin"]);

/** Internal dashboard-to-API proof locator; the value is an auth.session ID. */
export const DASHBOARD_SESSION_AUTHORITY_HEADER =
	"x-relayapi-dashboard-session-id";

export type OrganizationCredentialPermission =
	| "read"
	| "write"
	| "manage_api_keys"
	| "view_billing"
	| "manage_billing"
	| "manage_spend";

export function canManageOrganizationCredentials(
	role: string | null | undefined,
): boolean {
	return (role ?? "")
		.split(",")
		.some((candidate) =>
			ORGANIZATION_CREDENTIAL_ADMIN_ROLES.has(candidate.trim()),
		);
}

/** Exact dashboard-key authority derived from the live Better Auth role. */
export function getDashboardCredentialPermissions(
	role: string | null | undefined,
): OrganizationCredentialPermission[] {
	const permissions: OrganizationCredentialPermission[] = ["read", "write"];
	if (canManageOrganizationCredentials(role)) {
		permissions.push("manage_api_keys");
	}
	const roles = new Set(
		(role ?? "").split(",").map((candidate) => candidate.trim()),
	);
	if (roles.has("owner")) {
		permissions.push("view_billing", "manage_billing", "manage_spend");
	} else if (roles.has("admin")) {
		permissions.push("manage_spend");
	}
	return permissions;
}

export function hasCurrentDashboardCredentialPermissions(
	storedPermissions: string | null | undefined,
	role: string | null | undefined,
): boolean {
	return (
		storedPermissions === getDashboardCredentialPermissions(role).join(",")
	);
}

/**
 * Runtime/database compatibility generation shared by hosted and self-hosted
 * Worker builds. The pre-live migration reset established the complete current
 * schema as the sealed initial generation.
 */
export const BASELINE_GENERATION = 1;

/**
 * Cutover smoke credentials must remain valid while Worker generations
 * overlap. Keep the hash domain independent from the database generation; the
 * stored secret is still a one-way SHA-256 digest.
 */
export const MAINTENANCE_SMOKE_HASH_DOMAIN =
	"relayapi:maintenance-smoke:cutover:v1:";

/**
 * The cutover wait is deliberately source-owned rather than copied into a
 * workflow literal. It covers the reviewed one-hour asynchronous execution
 * envelope plus five minutes of clock/cache convergence.
 */
export const PRELIVE_CUTOVER_HOLD_SECONDS = 65 * 60;

/**
 * Workers KV allows a 30-second minimum read cache. Both hosted Workers use
 * this exact value for the generation-aware maintenance record.
 */
export const RUNTIME_CONTROL_CACHE_TTL_SECONDS = 30;

/**
 * Leave Queue consumers paused while a maintenance-off write propagates. This
 * covers KV's documented 60-second global visibility window, the 30-second
 * read cache, and a further 30-second safety margin.
 */
export const PRELIVE_CONTROL_CONVERGENCE_SECONDS = 2 * 60;

/**
 * R2 deletion notifications are asynchronous. Give them a bounded delivery
 * window before starting the final reviewed Queue purge.
 */
export const PRELIVE_R2_EVENT_SETTLE_SECONDS = 60;

/**
 * Reserved Workers KV key for the shared API/dashboard maintenance gate.
 * Cutover tooling preserves and updates this key while clearing application KV.
 */
export const MAINTENANCE_CONTROL_KEY = "control:maintenance:v1";

export interface PlanTier {
	/** Display name */
	name: string;
	/** Monthly base price in cents */
	monthlyPriceCents: number;
	/** API calls included per month */
	apiCallsIncluded: number;
	/** Cost-bearing download/transcript tool invocations allowed per UTC day */
	dailyToolLimit: number;
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
		dailyToolLimit: 2,
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
		dailyToolLimit: 10,
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
	freeDailyToolLimit: PLANS.free.dailyToolLimit,
	monthlyPriceCents: PLANS.pro.monthlyPriceCents,
	proCallsIncluded: PLANS.pro.apiCallsIncluded,
	proDailyToolLimit: PLANS.pro.dailyToolLimit,
	pricePerThousandCallsCents: PLANS.pro.pricePerThousandCallsCents,
	freeRateLimitMax: PLANS.free.rateLimitMax,
	freeRateLimitWindow: PLANS.free.rateLimitWindow,
	proRateLimitMax: PLANS.pro.rateLimitMax,
	proRateLimitWindow: PLANS.pro.rateLimitWindow,
} as const;

/**
 * Resolve the effective hosted tools allowance. A nullable database value is
 * an explicit "use the plan default" marker; zero remains a valid override
 * that disables cost-bearing tools for one organization.
 */
export function dailyToolLimitForPlan(
	plan: "free" | "pro",
	override: number | null | undefined,
): number {
	return override ?? PLANS[plan].dailyToolLimit;
}

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
	source?: "stripe" | "complimentary" | null;
	stripeSubscriptionId?: string | null;
	trialEndsAt?: Date | string | null;
	delinquentAt?: Date | string | null;
	graceEndsAt?: Date | string | null;
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
	/** Enforcement mode for the period; unlimited is always explicit. */
	quotaMode: "hard" | "metered" | "unlimited";
	/** Why the decision was made, useful for logs/tests without duplicating policy. */
	reason:
		| "active"
		| "complimentary"
		| "past_due_grace"
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
		periodStart &&
		periodEnd &&
		periodStart <= now &&
		now < periodEnd &&
		periodEnd > periodStart
			? { start: periodStart, end: periodEnd }
			: null;

	if (input.source === "complimentary" && input.status === "active") {
		return {
			entitlement: "pro",
			usagePeriod: validPeriod,
			billable: false,
			quotaMode: "hard",
			reason: "complimentary",
		};
	}

	if (
		input.source === "stripe" &&
		input.status === "active" &&
		Boolean(input.stripeSubscriptionId)
	) {
		return {
			entitlement: "pro",
			usagePeriod: validPeriod,
			billable: true,
			quotaMode: "metered",
			reason: "active",
		};
	}

	if (
		input.source === "stripe" &&
		input.status === "past_due" &&
		Boolean(input.stripeSubscriptionId)
	) {
		const delinquentAt = asValidDate(input.delinquentAt);
		const graceEndsAt = asValidDate(input.graceEndsAt);
		const inGrace = Boolean(
			delinquentAt && graceEndsAt && delinquentAt <= now && now < graceEndsAt,
		);
		return {
			entitlement: inGrace ? "pro" : "free",
			usagePeriod: inGrace ? validPeriod : null,
			billable: false,
			quotaMode: "hard",
			reason: inGrace ? "past_due_grace" : "inactive",
		};
	}

	if (input.source === "stripe" && input.status === "trialing") {
		const trialEndsAt = asValidDate(input.trialEndsAt);
		const authoritativeTrial = Boolean(
			input.stripeSubscriptionId && trialEndsAt && trialEndsAt > now,
		);
		return {
			entitlement: authoritativeTrial ? "pro" : "free",
			usagePeriod: authoritativeTrial ? validPeriod : null,
			// Trials have entitlement but are not billed for overage.
			billable: false,
			quotaMode: "hard",
			reason: authoritativeTrial
				? "authoritative_trial"
				: "expired_or_unproven_trial",
		};
	}

	return {
		entitlement: "free",
		usagePeriod: null,
		billable: false,
		quotaMode: "hard",
		reason: "inactive",
	};
}
