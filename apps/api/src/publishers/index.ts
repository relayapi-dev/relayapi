import type { Platform } from "../schemas/common";
import { beehiivPublisher } from "./beehiiv";
import { blueskyPublisher } from "./bluesky";
import { convertkitPublisher } from "./convertkit";
import { discordPublisher } from "./discord";
import { facebookPublisher } from "./facebook";
import { googleBusinessPublisher } from "./google-business";
import { instagramPublisher } from "./instagram";
import { linkedinPublisher } from "./linkedin";
import { listmonkPublisher } from "./listmonk";
import { mailchimpPublisher } from "./mailchimp";
import { mastodonPublisher } from "./mastodon";
import { pinterestPublisher } from "./pinterest";
import { redditPublisher } from "./reddit";
import { smsPublisher } from "./sms";
import { snapchatPublisher } from "./snapchat";
import { telegramPublisher } from "./telegram";
import { threadsPublisher } from "./threads";
import { tiktokPublisher } from "./tiktok";
import { twitterPublisher } from "./twitter";
import type { Publisher } from "./types";
import { whatsappPublisher } from "./whatsapp";
import { youtubePublisher } from "./youtube";

const publishers = new Map<Platform, Publisher>();

publishers.set("bluesky", blueskyPublisher);
publishers.set("discord", discordPublisher);
publishers.set("facebook", facebookPublisher);
publishers.set("googlebusiness", googleBusinessPublisher);
publishers.set("instagram", instagramPublisher);
publishers.set("linkedin", linkedinPublisher);
publishers.set("mastodon", mastodonPublisher);
publishers.set("pinterest", pinterestPublisher);
publishers.set("reddit", redditPublisher);
publishers.set("sms", smsPublisher);
publishers.set("snapchat", snapchatPublisher);
publishers.set("telegram", telegramPublisher);
publishers.set("threads", threadsPublisher);
publishers.set("tiktok", tiktokPublisher);
publishers.set("twitter", twitterPublisher);
publishers.set("whatsapp", whatsappPublisher);
publishers.set("youtube", youtubePublisher);
publishers.set("beehiiv", beehiivPublisher);
publishers.set("convertkit", convertkitPublisher);
publishers.set("mailchimp", mailchimpPublisher);
publishers.set("listmonk", listmonkPublisher);

export function getPublisher(platform: Platform): Publisher | undefined {
	return publishers.get(platform);
}

export function isSupportedPlatform(platform: Platform): boolean {
	return publishers.has(platform);
}

export { classifyPublishError } from "./types";
export type { Publisher, PublishRequest, PublishResult, PublishErrorCode, EngagementAccount, EngagementActionResult } from "./types";
