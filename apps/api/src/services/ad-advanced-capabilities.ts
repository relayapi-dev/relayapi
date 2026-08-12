import type { ADVANCED_AD_FEATURES } from "../schemas/ads-advanced";
import type { AdPlatform } from "./ad-platforms/types";

export type AdvancedAdFeature = (typeof ADVANCED_AD_FEATURES)[number];
export type AdvancedAdCapabilityState =
	| "supported"
	| "requires_approval"
	| "unsupported";

export interface AdvancedAdCapability {
	state: AdvancedAdCapabilityState;
	reason?: string;
	requiredScopes: string[];
	requiredProgram?: string;
	checkedAt: string | null;
}

type StaticCapability = Omit<AdvancedAdCapability, "checkedAt">;
type PlatformCapabilities = Record<AdvancedAdFeature, StaticCapability>;

const supported = (reason?: string): StaticCapability => ({
	state: "supported",
	requiredScopes: [],
	...(reason ? { reason } : {}),
});

const approval = (
	reason: string,
	options: { scopes?: string[]; program?: string } = {},
): StaticCapability => ({
	state: "requires_approval",
	reason,
	requiredScopes: options.scopes ?? [],
	...(options.program ? { requiredProgram: options.program } : {}),
});

const unsupported = (reason: string): StaticCapability => ({
	state: "unsupported",
	reason,
	requiredScopes: [],
});

/**
 * Relay implementation truth. `requires_approval` means the code path exists,
 * but the provider program/scope must be verified on the exact ad account.
 * `unsupported` can never be promoted by stale account JSON.
 */
export const ADVANCED_AD_PLATFORM_CAPABILITIES: Record<
	AdPlatform,
	PlatformCapabilities
> = {
	meta: {
		lead_forms: approval(
			"Meta lead-form management requires approved Marketing API access",
		),
		lead_inbox: unsupported(
			"No verified Meta lead webhook or retrieval ingestion path is enabled in this build",
		),
		lead_promotion: supported(
			"Promoting an encrypted Relay lead to Contacts is local-only",
		),
		conversions: unsupported(
			"No verified Meta conversion-delivery worker is enabled in this build",
		),
		messaging_experiences: approval(
			"Click-to-Messenger, Instagram Direct, and WhatsApp ads require eligible assets and account roles",
		),
		report_jobs: unsupported(
			"No verified Meta durable-report adapter is enabled in this build",
		),
		forecasts: unsupported(
			"No verified Meta forecast module is enabled in this build",
		),
		keyword_ideas: unsupported(
			"Meta does not expose a generic keyword-planner contract",
		),
		creative_assets: approval(
			"Meta creative-library writes require Marketing API access",
		),
		catalogs: approval(
			"Meta Commerce catalogs require Business and catalog authority",
		),
		product_sets: approval(
			"Meta product sets require authority over the parent catalog",
		),
	},
	google: {
		lead_forms: approval(
			"Google lead-form assets are account-policy restricted",
		),
		lead_inbox: unsupported(
			"No verified Google lead-form webhook ingestion path is enabled in this build",
		),
		lead_promotion: supported(
			"Promoting an encrypted Relay lead to Contacts is local-only",
		),
		conversions: unsupported(
			"No verified Google conversion-delivery worker is enabled in this build",
		),
		messaging_experiences: approval(
			"Business message assets depend on provider and account eligibility",
		),
		report_jobs: unsupported(
			"No verified Google durable-report adapter is enabled in this build",
		),
		forecasts: unsupported(
			"No verified Google ReachPlan or forecast module is enabled in this build",
		),
		keyword_ideas: unsupported(
			"No verified Google KeywordPlanIdea module is enabled in this build",
		),
		creative_assets: approval(
			"Google asset writes require approved Ads API access",
		),
		catalogs: approval(
			"Relay links Merchant Center catalogs; it does not replicate item feeds",
		),
		product_sets: approval(
			"Product groups require an eligible linked Merchant Center account",
		),
	},
	tiktok: {
		lead_forms: approval(
			"TikTok lead generation APIs are advertiser and app permission gated",
		),
		lead_inbox: unsupported(
			"No verified TikTok lead webhook or retrieval ingestion path is enabled in this build",
		),
		lead_promotion: supported(
			"Promoting an encrypted Relay lead to Contacts is local-only",
		),
		conversions: unsupported(
			"No verified TikTok conversion-delivery worker is enabled in this build",
		),
		messaging_experiences: approval(
			"TikTok messaging ads are market and account dependent",
		),
		report_jobs: supported(
			"TikTok Marketing API v1.3 asynchronous report tasks are implemented",
		),
		forecasts: unsupported(
			"No verified TikTok forecast module is enabled in this build",
		),
		keyword_ideas: unsupported(
			"No verified TikTok keyword-planning module is enabled in this build",
		),
		creative_assets: approval(
			"TikTok asset libraries require Marketing API permissions",
		),
		catalogs: approval("TikTok catalog access is separately permission gated"),
		product_sets: approval(
			"TikTok product sets require authority over the parent catalog",
		),
	},
	linkedin: {
		lead_forms: approval(
			"LinkedIn ad-form reads require Advertising API access",
			{
				scopes: ["r_ads"],
				program: "LinkedIn Advertising API",
			},
		),
		lead_inbox: unsupported(
			"No verified LinkedIn Lead Sync ingestion path is enabled in this build",
		),
		lead_promotion: supported(
			"Promoting an encrypted Relay lead to Contacts is local-only",
		),
		conversions: unsupported(
			"No verified LinkedIn conversion-delivery worker is enabled in this build",
		),
		messaging_experiences: approval(
			"Conversation Ads require Advertising API access and eligible creatives",
		),
		report_jobs: approval("LinkedIn reporting requires r_ads_reporting", {
			scopes: ["r_ads_reporting"],
			program: "LinkedIn Advertising API",
		}),
		forecasts: unsupported(
			"No verified LinkedIn media-planning module is enabled in this build",
		),
		keyword_ideas: unsupported(
			"LinkedIn does not expose a generic keyword-planner contract",
		),
		creative_assets: approval(
			"LinkedIn creative libraries require Advertising API access",
		),
		catalogs: unsupported(
			"Relay has no official LinkedIn generic catalog contract",
		),
		product_sets: unsupported(
			"Relay has no official LinkedIn generic product-set contract",
		),
	},
	pinterest: {
		lead_forms: approval(
			"Pinterest lead ads require production access and eligible accounts",
		),
		lead_inbox: unsupported(
			"No verified Pinterest lead-delivery ingestion path is enabled in this build",
		),
		lead_promotion: supported(
			"Promoting an encrypted Relay lead to Contacts is local-only",
		),
		conversions: unsupported(
			"No verified Pinterest conversion-delivery worker is enabled in this build",
		),
		messaging_experiences: unsupported(
			"Pinterest has no official click-to-message ad contract",
		),
		report_jobs: unsupported(
			"No verified Pinterest durable-report adapter is enabled in this build",
		),
		forecasts: unsupported(
			"No verified Pinterest delivery-estimate module is enabled in this build",
		),
		keyword_ideas: unsupported(
			"No verified Pinterest keyword-planning module is enabled in this build",
		),
		creative_assets: approval(
			"Pinterest asset-backed ad creation requires Ads API access",
		),
		catalogs: approval("Pinterest catalogs require production access"),
		product_sets: approval(
			"Pinterest product groups require authority over the parent catalog",
		),
	},
	twitter: {
		lead_forms: unsupported(
			"X Ads API has no current generic lead-form resource",
		),
		lead_inbox: unsupported(
			"X Ads API has no current lead-response inbox contract",
		),
		lead_promotion: supported(
			"Promoting an encrypted Relay lead to Contacts is local-only",
		),
		conversions: unsupported(
			"No verified X conversion-delivery worker is enabled in this build",
		),
		messaging_experiences: approval(
			"X conversation cards require Ads API entitlement",
		),
		report_jobs: supported(
			"X Ads API v12 asynchronous analytics jobs are implemented",
		),
		forecasts: unsupported("Relay has no official X forecast contract"),
		keyword_ideas: unsupported(
			"No verified X keyword-planning module is enabled in this build",
		),
		creative_assets: approval(
			"X media/creative libraries require Ads API entitlement",
		),
		catalogs: approval(
			"X product catalogs require Ads API entitlement and account eligibility",
		),
		product_sets: approval(
			"X product sets require authority over the parent catalog",
		),
	},
};

interface StoredCapability {
	state?: unknown;
	reason?: unknown;
	required_scopes?: unknown;
	required_program?: unknown;
	checked_at?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function storedCapability(value: unknown): StoredCapability | null {
	if (typeof value === "boolean") {
		return { state: value ? "supported" : "unsupported" };
	}
	return objectValue(value);
}

function validState(value: unknown): AdvancedAdCapabilityState | undefined {
	return value === "supported" ||
		value === "requires_approval" ||
		value === "unsupported"
		? value
		: undefined;
}

/**
 * Merge a potentially old account probe with the current complete registry.
 * A probe may downgrade support, or satisfy a coded approval gate. It cannot
 * elevate a feature Relay has not implemented.
 */
export function effectiveAdvancedAdCapabilities(
	platform: AdPlatform,
	stored: unknown,
	grantedScopes: readonly string[] = [],
): Record<AdvancedAdFeature, AdvancedAdCapability> {
	const staticCapabilities = ADVANCED_AD_PLATFORM_CAPABILITIES[platform];
	const storedObject = objectValue(stored) ?? {};
	const nested = objectValue(storedObject.advanced) ?? storedObject;
	const granted = new Set(grantedScopes);
	const result = {} as Record<AdvancedAdFeature, AdvancedAdCapability>;

	for (const [feature, baseline] of Object.entries(staticCapabilities) as Array<
		[AdvancedAdFeature, StaticCapability]
	>) {
		const account = storedCapability(nested[feature]);
		const accountState = validState(account?.state);
		let state = baseline.state;
		const requiredScopesGranted = baseline.requiredScopes.every((scope) =>
			granted.has(scope),
		);

		if (baseline.state !== "unsupported" && accountState) {
			state = accountState;
		} else if (
			baseline.state === "requires_approval" &&
			baseline.requiredScopes.length > 0 &&
			requiredScopesGranted
		) {
			// Restricted provider scopes are issued only after the corresponding
			// product approval. Their presence on this exact connection is stronger
			// evidence than an absent/stale account probe.
			state = "supported";
		}
		if (state === "supported" && !requiredScopesGranted) {
			state = "requires_approval";
		}

		result[feature] = {
			state,
			reason:
				typeof account?.reason === "string" ? account.reason : baseline.reason,
			requiredScopes: baseline.requiredScopes,
			requiredProgram: baseline.requiredProgram,
			checkedAt:
				typeof account?.checked_at === "string" ? account.checked_at : null,
		};
	}
	return result;
}

export function serializeAdvancedAdCapabilities(
	capabilities: Record<AdvancedAdFeature, AdvancedAdCapability>,
) {
	return Object.fromEntries(
		Object.entries(capabilities).map(([feature, capability]) => [
			feature,
			{
				state: capability.state,
				...(capability.reason ? { reason: capability.reason } : {}),
				required_scopes: capability.requiredScopes,
				...(capability.requiredProgram
					? { required_program: capability.requiredProgram }
					: {}),
				checked_at: capability.checkedAt,
			},
		]),
	);
}

export class AdvancedAdCapabilityError extends Error {
	readonly code: "ADS_APPROVAL_REQUIRED" | "UNSUPPORTED_FEATURE";

	constructor(
		readonly feature: AdvancedAdFeature,
		readonly capability: AdvancedAdCapability,
	) {
		super(capability.reason ?? `Advanced ad feature ${feature} is unavailable`);
		this.name = "AdvancedAdCapabilityError";
		this.code =
			capability.state === "requires_approval"
				? "ADS_APPROVAL_REQUIRED"
				: "UNSUPPORTED_FEATURE";
	}
}

export function requireAdvancedAdCapability(
	capabilities: Record<AdvancedAdFeature, AdvancedAdCapability>,
	feature: AdvancedAdFeature,
): void {
	const capability = capabilities[feature];
	if (capability.state !== "supported") {
		throw new AdvancedAdCapabilityError(feature, capability);
	}
}
