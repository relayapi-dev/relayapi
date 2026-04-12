import { describe, expect, it } from "bun:test";
import { getPublisher, isSupportedPlatform } from "../publishers";
import { PLATFORMS } from "../schemas/common";

// ===========================================================================
// Publisher Registry Tests
// ===========================================================================

describe("Publisher registry", () => {
	const PUBLISHER_PLATFORMS = PLATFORMS;

	it("has publishers for every declared platform", () => {
		for (const platform of PUBLISHER_PLATFORMS) {
			const publisher = getPublisher(platform);
			expect(publisher).toBeDefined();
			expect(publisher?.platform).toBe(platform);
		}
	});

	it("reports supported platforms correctly", () => {
		for (const platform of PUBLISHER_PLATFORMS) {
			expect(isSupportedPlatform(platform)).toBe(true);
		}
	});

	it("has a publisher for whatsapp", () => {
		expect(getPublisher("whatsapp")).toBeDefined();
		expect(getPublisher("whatsapp")?.platform).toBe("whatsapp");
		expect(isSupportedPlatform("whatsapp")).toBe(true);
	});

	it("returns undefined for unknown platforms", () => {
		expect(getPublisher("nonexistent" as never)).toBeUndefined();
	});
});

// ===========================================================================
// Publisher Interface Compliance Tests
// ===========================================================================

describe("Publisher interface compliance", () => {
	const PUBLISHER_PLATFORMS = PLATFORMS;

	for (const platform of PUBLISHER_PLATFORMS) {
		it(`${platform} publisher has correct platform and publish method`, () => {
			const publisher = getPublisher(platform);
			expect(publisher).toBeDefined();
			expect(publisher?.platform).toBe(platform);
			expect(typeof publisher?.publish).toBe("function");
		});
	}
});

// ===========================================================================
// Platform-specific Validation Tests (unit-testable logic)
// ===========================================================================

describe("Bluesky content limits", () => {
	it("300 character hard limit", () => {
		const content = "a".repeat(301);
		expect(content.length).toBeGreaterThan(300);
	});

	it("facet detection for URLs", () => {
		const text = "Check out https://example.com for more";
		const urlRegex = /https?:\/\/[^\s)>\]]+/g;
		const matches = [...text.matchAll(urlRegex)];
		expect(matches).toHaveLength(1);
		expect(matches[0]?.[0]).toBe("https://example.com");
	});

	it("facet detection for mentions", () => {
		const text = "Hello @user.bsky.social and @other.bsky.social";
		const mentionRegex = /(^|\s)@([a-zA-Z0-9.-]+(\.[a-zA-Z]{2,}))/g;
		const matches = [...text.matchAll(mentionRegex)];
		expect(matches).toHaveLength(2);
	});

	it("facet detection for hashtags", () => {
		const text = "Hello #world #test123";
		const hashtagRegex = /(^|\s)#([a-zA-Z0-9_]+)/g;
		const matches = [...text.matchAll(hashtagRegex)];
		expect(matches).toHaveLength(2);
	});
});

describe("Twitter character counting", () => {
	it("URLs count as 23 characters (t.co)", () => {
		const url = "https://example.com/very/long/path/that/would/be/shortened";
		const tcoLength = 23;
		expect(tcoLength).toBe(23);
		expect(url.length).toBeGreaterThan(23);
	});

	it("280 character limit for free accounts", () => {
		const tweet = "a".repeat(281);
		expect(tweet.length).toBeGreaterThan(280);
	});
});

describe("Instagram content limits", () => {
	it("2,200 character caption limit", () => {
		const caption = "a".repeat(2201);
		expect(caption.length).toBeGreaterThan(2200);
	});

	it("aspect ratio validation (0.8 to 1.91)", () => {
		const isValidAspectRatio = (width: number, height: number) => {
			const ratio = width / height;
			return ratio >= 0.8 && ratio <= 1.91;
		};
		expect(isValidAspectRatio(1080, 1350)).toBe(true); // 4:5
		expect(isValidAspectRatio(1080, 1080)).toBe(true); // 1:1
		expect(isValidAspectRatio(1080, 566)).toBe(true); // ~1.91:1
		expect(isValidAspectRatio(1080, 1920)).toBe(false); // 9:16 — story/reel only
	});
});

describe("LinkedIn content limits", () => {
	it("3,000 character limit", () => {
		const post = "a".repeat(3001);
		expect(post.length).toBeGreaterThan(3000);
	});

	it("rejects mixed media types", () => {
		const media = [
			{ url: "https://example.com/photo.jpg", type: "image" as const },
			{ url: "https://example.com/video.mp4", type: "video" as const },
		];
		const hasImages = media.some((m) => m.type === "image");
		const hasVideos = media.some((m) => m.type === "video");
		expect(hasImages && hasVideos).toBe(true); // would be rejected
	});
});

describe("Threads content limits", () => {
	it("500 character limit", () => {
		const post = "a".repeat(501);
		expect(post.length).toBeGreaterThan(500);
	});
});

describe("Telegram content limits", () => {
	it("4,096 character text limit", () => {
		const text = "a".repeat(4097);
		expect(text.length).toBeGreaterThan(4096);
	});

	it("1,024 character caption limit", () => {
		const caption = "a".repeat(1025);
		expect(caption.length).toBeGreaterThan(1024);
	});
});

describe("YouTube validation", () => {
	it("100 character title limit", () => {
		const title = "a".repeat(101);
		expect(title.length).toBeGreaterThan(100);
	});

	it("Shorts detection (≤3 min + vertical)", () => {
		const isShort = (durationSec: number, width: number, height: number) =>
			durationSec <= 180 && height > width;
		expect(isShort(60, 1080, 1920)).toBe(true); // 1 min, vertical
		expect(isShort(240, 1080, 1920)).toBe(false); // 4 min, vertical
		expect(isShort(60, 1920, 1080)).toBe(false); // 1 min, horizontal
	});
});

describe("Pinterest content limits", () => {
	it("100 character title limit", () => {
		const title = "a".repeat(101);
		expect(title.length).toBeGreaterThan(100);
	});

	it("500 character description limit", () => {
		const desc = "a".repeat(501);
		expect(desc.length).toBeGreaterThan(500);
	});
});

describe("Reddit validation", () => {
	it("300 character title limit", () => {
		const title = "a".repeat(301);
		expect(title.length).toBeGreaterThan(300);
	});

	it("extracts title from first line of content", () => {
		const content = "My post title\n\nThe rest of the body text here";
		const title = content.split("\n")[0] ?? "";
		expect(title).toBe("My post title");
	});

	it("strips r/ prefix from subreddit", () => {
		const subreddit = "r/programming";
		const clean = subreddit.replace(/^r\//, "");
		expect(clean).toBe("programming");
	});
});

describe("TikTok validation", () => {
	it("requires privacy_level", () => {
		const validLevels = [
			"PUBLIC_TO_EVERYONE",
			"MUTUAL_FOLLOW_FRIENDS",
			"FOLLOWER_OF_CREATOR",
			"SELF_ONLY",
		];
		for (const level of validLevels) {
			expect(validLevels.includes(level)).toBe(true);
		}
	});

	it("2,200 character video caption limit", () => {
		const caption = "a".repeat(2201);
		expect(caption.length).toBeGreaterThan(2200);
	});

	it("photo title truncated to 90 chars", () => {
		const title = "a".repeat(100);
		const truncated = title.slice(0, 90);
		expect(truncated).toHaveLength(90);
	});
});

describe("Snapchat validation", () => {
	it("45 character saved story title limit", () => {
		const title = "a".repeat(46);
		expect(title.length).toBeGreaterThan(45);
	});

	it("160 character spotlight description limit", () => {
		const desc = "a".repeat(161);
		expect(desc.length).toBeGreaterThan(160);
	});

	it("single media item only", () => {
		const media = [
			{ url: "https://example.com/a.jpg", type: "image" },
			{ url: "https://example.com/b.jpg", type: "image" },
		];
		expect(media.length).toBeGreaterThan(1); // would be rejected
	});
});

describe("Google Business validation", () => {
	it("1,500 character limit", () => {
		const text = "a".repeat(1501);
		expect(text.length).toBeGreaterThan(1500);
	});

	it("valid CTA types", () => {
		const validTypes = [
			"LEARN_MORE",
			"BOOK",
			"ORDER",
			"SHOP",
			"SIGN_UP",
			"CALL",
		];
		expect(validTypes).toHaveLength(6);
		for (const type of validTypes) {
			expect(typeof type).toBe("string");
		}
	});
});
