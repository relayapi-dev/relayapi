import type { Platform } from "../schemas/common";

export interface PlatformCharLimit {
	maxChars: number;
	/** If true, URLs are counted as a fixed length (e.g. Twitter t.co = 23 chars) */
	urlShortening?: number;
}

export interface PlatformMediaLimit {
	maxImages: number;
	maxVideos: number;
	maxImageSize: number; // bytes
	maxGifSize?: number; // bytes — if different from maxImageSize
	maxVideoSize: number; // bytes
	allowedImageTypes: string[];
	allowedVideoTypes: string[];
}

export interface PlatformLimits {
	chars: PlatformCharLimit;
	media: PlatformMediaLimit;
}

export const PLATFORM_LIMITS: Record<Platform, PlatformLimits> = {
	twitter: {
		chars: { maxChars: 280, urlShortening: 23 },
		media: {
			maxImages: 4,
			maxVideos: 1,
			maxImageSize: 5 * 1024 * 1024,
			maxGifSize: 15 * 1024 * 1024, // GIFs can be up to 15MB on Twitter
			maxVideoSize: 512 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
			allowedVideoTypes: ["video/mp4", "video/quicktime"],
		},
	},
	instagram: {
		chars: { maxChars: 2200 },
		media: {
			maxImages: 10,
			maxVideos: 1,
			maxImageSize: 8 * 1024 * 1024,
			maxVideoSize: 100 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4", "video/quicktime"],
		},
	},
	facebook: {
		chars: { maxChars: 63206 },
		media: {
			maxImages: 10,
			maxVideos: 1,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 1024 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/bmp"],
			allowedVideoTypes: ["video/mp4", "video/quicktime", "video/avi"],
		},
	},
	linkedin: {
		chars: { maxChars: 3000 },
		media: {
			maxImages: 20,
			maxVideos: 1,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 500 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	tiktok: {
		chars: { maxChars: 2200 },
		media: {
			maxImages: 35,
			maxVideos: 1,
			maxImageSize: 20 * 1024 * 1024,
			maxVideoSize: 4 * 1024 * 1024 * 1024,
			allowedImageTypes: [],
			allowedVideoTypes: ["video/mp4", "video/webm"],
		},
	},
	youtube: {
		chars: { maxChars: 5000 },
		media: {
			maxImages: 0,
			maxVideos: 1,
			maxImageSize: 2 * 1024 * 1024,
			maxVideoSize: 256 * 1024 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: [
				"video/mp4",
				"video/quicktime",
				"video/x-msvideo",
				"video/webm",
			],
		},
	},
	pinterest: {
		chars: { maxChars: 500 },
		media: {
			maxImages: 1,
			maxVideos: 1,
			maxImageSize: 20 * 1024 * 1024,
			maxVideoSize: 2 * 1024 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4", "video/quicktime"],
		},
	},
	reddit: {
		chars: { maxChars: 40000 },
		media: {
			maxImages: 20,
			maxVideos: 1,
			maxImageSize: 20 * 1024 * 1024,
			maxVideoSize: 1024 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	bluesky: {
		chars: { maxChars: 300 },
		media: {
			maxImages: 4,
			maxVideos: 1,
			maxImageSize: 1 * 1024 * 1024,
			maxVideoSize: 100 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	threads: {
		chars: { maxChars: 500 },
		media: {
			maxImages: 20,
			maxVideos: 1,
			maxImageSize: 8 * 1024 * 1024,
			maxVideoSize: 100 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4", "video/quicktime"],
		},
	},
	telegram: {
		chars: { maxChars: 4096 },
		media: {
			maxImages: 10,
			maxVideos: 1,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 50 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	snapchat: {
		chars: { maxChars: 250 },
		media: {
			maxImages: 1,
			maxVideos: 1,
			maxImageSize: 5 * 1024 * 1024,
			maxVideoSize: 32 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	googlebusiness: {
		chars: { maxChars: 1500 },
		media: {
			maxImages: 10,
			maxVideos: 1,
			maxImageSize: 5 * 1024 * 1024,
			maxVideoSize: 75 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	whatsapp: {
		chars: { maxChars: 4096 },
		media: {
			maxImages: 1,
			maxVideos: 1,
			maxImageSize: 5 * 1024 * 1024,
			maxVideoSize: 16 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png"],
			allowedVideoTypes: ["video/mp4", "video/3gpp"],
		},
	},
	mastodon: {
		chars: { maxChars: 500 },
		media: {
			maxImages: 4,
			maxVideos: 1,
			maxImageSize: 16 * 1024 * 1024,
			maxVideoSize: 99 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
			allowedVideoTypes: ["video/mp4", "video/webm", "video/quicktime"],
		},
	},
	sms: {
		chars: { maxChars: 1600 }, // Twilio auto-segments longer messages
		media: {
			maxImages: 10, // MMS supports up to 10 MediaUrl
			maxVideos: 1,
			maxImageSize: 5 * 1024 * 1024,
			maxVideoSize: 5 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: ["video/mp4"],
		},
	},
	discord: {
		chars: { maxChars: 2000 },
		media: {
			maxImages: 10,
			maxVideos: 1,
			maxImageSize: 25 * 1024 * 1024,
			maxVideoSize: 25 * 1024 * 1024,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
			allowedVideoTypes: ["video/mp4", "video/webm", "video/quicktime"],
		},
	},
	beehiiv: {
		chars: { maxChars: 100_000 }, // HTML email body, effectively unlimited
		media: {
			maxImages: 50,
			maxVideos: 0,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 0,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
			allowedVideoTypes: [],
		},
	},
	convertkit: {
		chars: { maxChars: 100_000 },
		media: {
			maxImages: 50,
			maxVideos: 0,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 0,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: [],
		},
	},
	mailchimp: {
		chars: { maxChars: 100_000 },
		media: {
			maxImages: 50,
			maxVideos: 0,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 0,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: [],
		},
	},
	listmonk: {
		chars: { maxChars: 100_000 },
		media: {
			maxImages: 50,
			maxVideos: 0,
			maxImageSize: 10 * 1024 * 1024,
			maxVideoSize: 0,
			allowedImageTypes: ["image/jpeg", "image/png", "image/gif"],
			allowedVideoTypes: [],
		},
	},
};

const URL_REGEX = /https?:\/\/[^\s]+/g;
const NON_ASCII_REGEX = /[^\x00-\x7F]/;
const TWITTER_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

/**
 * Count characters for Twitter using weighted rules from twitter-text v3:
 * - NFC normalization before counting
 * - Each grapheme cluster with code point >= 0x1100 (CJK, emoji, etc.) counts as 2
 * - All other grapheme clusters count as 1
 * - URLs are collapsed to 23 characters (t.co shortening)
 */
function countTwitterChars(content: string): number {
	const hasUrl =
		content.includes("http://") || content.includes("https://");
	if (!hasUrl && !NON_ASCII_REGEX.test(content)) {
		return content.length;
	}

	const normalized = content.normalize("NFC");

	// Extract and remove URLs, count them as 23 chars each
	let urlAdjustment = 0;
	const text = hasUrl
		? normalized.replace(URL_REGEX, () => {
				urlAdjustment += 23;
				return "";
		})
		: normalized;

	// Count remaining characters using grapheme segmentation
	let count = 0;
	for (const { segment } of TWITTER_SEGMENTER.segment(text)) {
		const codePoint = segment.codePointAt(0) ?? 0;
		// twitter-text v3: code points >= 0x1100 are weighted as 2
		count += codePoint >= 0x1100 ? 2 : 1;
	}

	return count + urlAdjustment;
}

/**
 * Count characters with platform-specific rules.
 * Twitter uses weighted counting (NFC, emoji=2, CJK=2, URLs=23).
 * All other platforms use simple string length with optional URL shortening.
 */
export function countChars(
	content: string,
	platform: Platform,
): number {
	if (platform === "twitter") {
		return countTwitterChars(content);
	}

	const limits = PLATFORM_LIMITS[platform];
	if (!limits.chars.urlShortening) return content.length;

	// Replace URLs with fixed-length placeholders for counting
	let count = content.length;
	for (const match of content.matchAll(URL_REGEX)) {
		count -= match[0].length;
		count += limits.chars.urlShortening;
	}
	return count;
}
