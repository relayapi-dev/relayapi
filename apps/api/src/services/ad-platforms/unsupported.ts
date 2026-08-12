import type {
	AdPlatform,
	AdPlatformAdapter,
	AdPlatformCapabilities,
	AdPlatformOperation,
} from "./types";
import { AdAuthoritativeNotAppliedError } from "./types";

function unsupported(
	platform: AdPlatform,
	operation: AdPlatformOperation,
): never {
	throw new AdAuthoritativeNotAppliedError(
		"UNSUPPORTED_FEATURE",
		`${platform} does not support ${operation.replaceAll("_", " ")} through RelayAPI yet`,
	);
}

/**
 * Complete fail-closed adapter used as the starting point for a provider.
 * Implemented methods override this object; every other method rejects before
 * performing provider I/O. Public services also check the capability manifest
 * before opening a durable paid-object boundary.
 */
export function unsupportedAdAdapter(
	platform: AdPlatform,
	capabilities: AdPlatformCapabilities,
): AdPlatformAdapter {
	return {
		platform,
		capabilities,
		creation: {
			async createCampaign() {
				return unsupported(platform, "campaign_create");
			},
			async createAdSet() {
				return unsupported(platform, "campaign_create");
			},
			async createCreative() {
				return unsupported(platform, "ad_create");
			},
			async createAd() {
				return unsupported(platform, "ad_create");
			},
			async findCreatedObject() {
				return unsupported(platform, "ad_create");
			},
			async activateBoost() {
				return unsupported(platform, "boost");
			},
			async isBoostActivated() {
				return unsupported(platform, "boost");
			},
		},
		async listAdAccounts() {
			return unsupported(platform, "account_discovery");
		},
		async updateAd() {
			return unsupported(platform, "mutation");
		},
		async updateCampaign() {
			return unsupported(platform, "mutation");
		},
		async inspectAdMutation() {
			return unsupported(platform, "mutation");
		},
		async inspectCampaignMutation() {
			return unsupported(platform, "mutation");
		},
		async pauseAd() {
			return unsupported(platform, "mutation");
		},
		async resumeAd() {
			return unsupported(platform, "mutation");
		},
		async cancelAd() {
			return unsupported(platform, "mutation");
		},
		async pauseCampaign() {
			return unsupported(platform, "mutation");
		},
		async resumeCampaign() {
			return unsupported(platform, "mutation");
		},
		async getAdMetrics() {
			return unsupported(platform, "analytics");
		},
		async searchInterests() {
			return unsupported(platform, "targeting_search");
		},
		async listAudiences() {
			return unsupported(platform, "audience_discovery");
		},
		async createCustomAudience() {
			return unsupported(platform, "audience_create");
		},
		async addUsersToAudience() {
			return unsupported(platform, "audience_upload");
		},
		async deleteAudience() {
			return unsupported(platform, "audience_create");
		},
		async syncExternalAds() {
			return unsupported(platform, "external_sync");
		},
	};
}

export function requireAdCapability(
	adapter: Pick<AdPlatformAdapter, "platform" | "capabilities">,
	operation: AdPlatformOperation,
): void {
	const capability = adapter.capabilities.operations[operation];
	if (capability.state === "supported") return;
	throw new AdAuthoritativeNotAppliedError(
		capability.state === "requires_approval"
			? "ADS_ACCESS_REVIEW_REQUIRED"
			: "UNSUPPORTED_FEATURE",
		capability.reason ??
			`${adapter.platform} does not support ${operation.replaceAll("_", " ")} through RelayAPI`,
	);
}
