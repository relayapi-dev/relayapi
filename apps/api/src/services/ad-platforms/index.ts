import type { AdPlatform, AdPlatformAdapter } from "./types";
import { metaAdAdapter } from "./meta";

const adapters = new Map<AdPlatform, AdPlatformAdapter>();

// Register platform adapters
adapters.set("meta", metaAdAdapter);
// Future: adapters.set("google", googleAdAdapter);
// Future: adapters.set("tiktok", tiktokAdAdapter);
// Future: adapters.set("linkedin", linkedinAdAdapter);
// Future: adapters.set("pinterest", pinterestAdAdapter);
// Future: adapters.set("twitter", twitterAdAdapter);

export function getAdPlatformAdapter(
	platform: AdPlatform,
): AdPlatformAdapter | undefined {
	return adapters.get(platform);
}

export function getSupportedAdPlatforms(): AdPlatform[] {
	return Array.from(adapters.keys());
}

/**
 * Map a social account platform (e.g. "facebook", "instagram") to
 * the ad platform key used by the adapter registry.
 * Returns undefined if the social platform has no ads support.
 */
export function socialPlatformToAdPlatform(
	socialPlatform: string,
): AdPlatform | undefined {
	switch (socialPlatform) {
		case "facebook":
		case "instagram":
			return "meta";
		case "twitter":
			return "twitter";
		case "tiktok":
			return "tiktok";
		case "linkedin":
			return "linkedin";
		case "pinterest":
			return "pinterest";
		default:
			return undefined;
	}
}

export type { AdPlatform, AdPlatformAdapter } from "./types";
