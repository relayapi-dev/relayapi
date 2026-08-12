import { platformLabels } from "./platform-maps";

/** Canonical publishing-platform order used by dashboard validation tools. */
export const TOOL_PLATFORM_IDS = [
	"twitter",
	"instagram",
	"facebook",
	"linkedin",
	"tiktok",
	"youtube",
	"pinterest",
	"reddit",
	"bluesky",
	"threads",
	"telegram",
	"snapchat",
	"googlebusiness",
	"whatsapp",
	"mastodon",
	"discord",
	"sms",
	"beehiiv",
	"convertkit",
	"mailchimp",
	"listmonk",
	"slack",
] as const;

export type ToolPlatform = (typeof TOOL_PLATFORM_IDS)[number];

export const TOOL_PLATFORMS = TOOL_PLATFORM_IDS.map((id) => ({
	id,
	label: platformLabels[id] ?? id,
}));

export const TOOL_PLATFORM_LABELS = platformLabels;

/** Keep these values byte-for-byte aligned with apps/api/src/config/platform-limits.ts. */
type PlatformCharLimit = { maxChars: number; urlShortening?: number };

export const PLATFORM_CHAR_LIMITS: Record<ToolPlatform, PlatformCharLimit> &
	Partial<Record<string, PlatformCharLimit>> = {
	twitter: { maxChars: 280, urlShortening: 23 },
	instagram: { maxChars: 2200 },
	facebook: { maxChars: 63206 },
	linkedin: { maxChars: 3000 },
	tiktok: { maxChars: 2200 },
	youtube: { maxChars: 5000 },
	pinterest: { maxChars: 800 },
	reddit: { maxChars: 40000 },
	bluesky: { maxChars: 300 },
	threads: { maxChars: 500 },
	telegram: { maxChars: 4096 },
	snapchat: { maxChars: 250 },
	googlebusiness: { maxChars: 1500 },
	whatsapp: { maxChars: 4096 },
	mastodon: { maxChars: 500 },
	discord: { maxChars: 2000 },
	sms: { maxChars: 1600 },
	beehiiv: { maxChars: 100_000 },
	convertkit: { maxChars: 100_000 },
	mailchimp: { maxChars: 100_000 },
	listmonk: { maxChars: 100_000 },
	slack: { maxChars: 40_000 },
};

const URL_REGEX = /https?:\/\/[^\s]+/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII boundary, matching the API counter
const NON_ASCII_REGEX = /[^\x00-\x7F]/;
const TWITTER_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function countTwitterChars(content: string): number {
	const hasUrl = content.includes("http://") || content.includes("https://");
	if (!hasUrl && !NON_ASCII_REGEX.test(content)) return content.length;

	const normalized = content.normalize("NFC");
	let urlAdjustment = 0;
	const text = hasUrl
		? normalized.replace(URL_REGEX, () => {
				urlAdjustment += 23;
				return "";
			})
		: normalized;

	let count = 0;
	for (const { segment } of TWITTER_SEGMENTER.segment(text)) {
		count += (segment.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
	}
	return count + urlAdjustment;
}

export function countCharsForPlatform(
	content: string,
	platform: string,
): number {
	if (platform === "twitter") return countTwitterChars(content);
	return content.length;
}
