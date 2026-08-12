import { googleAdAdapter } from "./google";
import { linkedinAdAdapter } from "./linkedin";
import { metaAdAdapter } from "./meta";
import { pinterestAdAdapter } from "./pinterest";
import { tiktokAdAdapter } from "./tiktok";
import { twitterAdAdapter } from "./twitter";
import type { AdPlatform, AdPlatformAdapter } from "./types";

const adapters = new Map<AdPlatform, AdPlatformAdapter>();

// Register platform adapters
adapters.set("meta", metaAdAdapter);
adapters.set("google", googleAdAdapter);
adapters.set("tiktok", tiktokAdAdapter);
adapters.set("linkedin", linkedinAdAdapter);
adapters.set("pinterest", pinterestAdAdapter);
adapters.set("twitter", twitterAdAdapter);

export function getAdPlatformAdapter(
	platform: AdPlatform,
): AdPlatformAdapter | undefined {
	return adapters.get(platform);
}

export function getSupportedAdPlatforms(): AdPlatform[] {
	return Array.from(adapters.keys());
}

export function getAdPlatformAdapters(): readonly AdPlatformAdapter[] {
	return [...adapters.values()];
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
