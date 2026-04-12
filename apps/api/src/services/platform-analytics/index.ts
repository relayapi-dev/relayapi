import type { PlatformAnalyticsFetcher } from "./types";
import { facebookAnalytics } from "./facebook";
import { createInstagramAnalytics } from "./instagram";
import { twitterAnalytics } from "./twitter";
import { linkedinAnalytics } from "./linkedin";
import { youtubeAnalytics } from "./youtube";
import { tiktokAnalytics } from "./tiktok";
import { pinterestAnalytics } from "./pinterest";
import { threadsAnalytics } from "./threads";
import { googleBusinessAnalytics } from "./google-business";
import { whatsappAnalytics } from "./whatsapp";

const instagramDirectAnalytics = createInstagramAnalytics("graph.instagram.com");
const instagramFbAnalytics = createInstagramAnalytics("graph.facebook.com");

const fetchers: Record<string, PlatformAnalyticsFetcher> = {
	facebook: facebookAnalytics,
	instagram: instagramDirectAnalytics,
	twitter: twitterAnalytics,
	linkedin: linkedinAnalytics,
	youtube: youtubeAnalytics,
	tiktok: tiktokAnalytics,
	pinterest: pinterestAnalytics,
	threads: threadsAnalytics,
	googlebusiness: googleBusinessAnalytics,
	whatsapp: whatsappAnalytics,
};

export function getPlatformFetcher(
	platform: string,
): PlatformAnalyticsFetcher | null {
	return fetchers[platform] ?? null;
}

export { instagramFbAnalytics };
