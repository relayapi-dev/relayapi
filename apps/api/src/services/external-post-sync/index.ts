// ---------------------------------------------------------------------------
// External Post Sync — Adapter Registry
// ---------------------------------------------------------------------------

import type { ExternalPostFetcher } from "./types";
import { facebookPostFetcher } from "./fetchers/facebook";
import { instagramPostFetcher } from "./fetchers/instagram";
import { twitterPostFetcher } from "./fetchers/twitter";
import { linkedinPostFetcher } from "./fetchers/linkedin";
import { youtubePostFetcher } from "./fetchers/youtube";
import { tiktokPostFetcher } from "./fetchers/tiktok";
import { threadsPostFetcher } from "./fetchers/threads";
import { pinterestPostFetcher } from "./fetchers/pinterest";

const fetchers = new Map<string, ExternalPostFetcher>();

fetchers.set("facebook", facebookPostFetcher);
fetchers.set("instagram", instagramPostFetcher);
fetchers.set("twitter", twitterPostFetcher);
fetchers.set("linkedin", linkedinPostFetcher);
fetchers.set("youtube", youtubePostFetcher);
fetchers.set("tiktok", tiktokPostFetcher);
fetchers.set("threads", threadsPostFetcher);
fetchers.set("pinterest", pinterestPostFetcher);

export function getExternalPostFetcher(
	platform: string,
): ExternalPostFetcher | null {
	return fetchers.get(platform) ?? null;
}

export function getSupportedSyncPlatforms(): string[] {
	return Array.from(fetchers.keys());
}
