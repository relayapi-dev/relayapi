import { describe, expect, it } from "bun:test";
import { PLATFORMS, type Platform } from "../schemas/common";
import { CreatePostBody } from "../schemas/posts";

// ===========================================================================
// Schema Validation Tests
// ===========================================================================

describe("CreatePostBody schema", () => {
	it("accepts publish-now request", () => {
		const result = CreatePostBody.safeParse({
			content: "Hello world!",
			targets: ["twitter"],
			scheduled_at: "now",
		});
		expect(result.success).toBe(true);
	});

	it("accepts draft request", () => {
		const result = CreatePostBody.safeParse({
			content: "Draft post",
			targets: ["twitter", "bluesky"],
			scheduled_at: "draft",
		});
		expect(result.success).toBe(true);
	});

	it("accepts scheduled request with ISO timestamp", () => {
		const result = CreatePostBody.safeParse({
			content: "Scheduled post",
			targets: ["twitter"],
			scheduled_at: "2025-06-16T12:00:00Z",
		});
		expect(result.success).toBe(true);
	});

	it("rejects missing scheduled_at", () => {
		const result = CreatePostBody.safeParse({
			content: "Hello",
			targets: ["twitter"],
		});
		expect(result.success).toBe(false);
	});

	it("rejects invalid scheduled_at", () => {
		const result = CreatePostBody.safeParse({
			content: "Hello",
			targets: ["twitter"],
			scheduled_at: "tomorrow",
		});
		expect(result.success).toBe(false);
	});

	it("rejects empty targets", () => {
		const result = CreatePostBody.safeParse({
			content: "Hello",
			targets: [],
			scheduled_at: "now",
		});
		expect(result.success).toBe(false);
	});

	it("accepts media with type", () => {
		const result = CreatePostBody.safeParse({
			content: "With image",
			targets: ["twitter"],
			scheduled_at: "now",
			media: [{ url: "https://cdn.example.com/photo.jpg", type: "image" }],
		});
		expect(result.success).toBe(true);
	});

	it("accepts media without type (auto-infer)", () => {
		const result = CreatePostBody.safeParse({
			content: "With image",
			targets: ["twitter"],
			scheduled_at: "now",
			media: [{ url: "https://cdn.example.com/photo.jpg" }],
		});
		expect(result.success).toBe(true);
	});

	it("rejects media with invalid URL", () => {
		const result = CreatePostBody.safeParse({
			content: "With image",
			targets: ["twitter"],
			scheduled_at: "now",
			media: [{ url: "not-a-url", type: "image" }],
		});
		expect(result.success).toBe(false);
	});

	it("accepts target_options", () => {
		const result = CreatePostBody.safeParse({
			targets: ["twitter"],
			scheduled_at: "now",
			target_options: {
				twitter: { thread: [{ content: "Tweet 1" }, { content: "Tweet 2" }] },
			},
		});
		expect(result.success).toBe(true);
	});

	it("accepts mixed platform names and account IDs", () => {
		const result = CreatePostBody.safeParse({
			content: "Hello",
			targets: ["twitter", "acc_instagram456"],
			scheduled_at: "now",
		});
		expect(result.success).toBe(true);
	});

	it("defaults timezone to UTC", () => {
		const result = CreatePostBody.safeParse({
			content: "Hello",
			targets: ["twitter"],
			scheduled_at: "now",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.timezone).toBe("UTC");
		}
	});
});

// ===========================================================================
// Target Classification Tests
// ===========================================================================

function isPlatformName(value: string): value is Platform {
	return (PLATFORMS as readonly string[]).includes(value);
}

function isAccountId(value: string): boolean {
	return value.startsWith("acc_");
}

function classifyTarget(target: string): "platform" | "account_id" | "invalid" {
	if (isAccountId(target)) return "account_id";
	if (isPlatformName(target)) return "platform";
	return "invalid";
}

describe("Target classification", () => {
	it("identifies every declared platform name", () => {
		expect(PLATFORMS.length).toBeGreaterThan(0);
		expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
		for (const p of PLATFORMS) {
			expect(classifyTarget(p)).toBe("platform");
		}
	});

	it("identifies account IDs", () => {
		expect(classifyTarget("acc_abc123")).toBe("account_id");
		expect(classifyTarget("acc_twitter_brand")).toBe("account_id");
	});

	it("rejects invalid targets", () => {
		expect(classifyTarget("Twitter")).toBe("invalid");
		expect(classifyTarget("TWITTER")).toBe("invalid");
		expect(classifyTarget("twiter")).toBe("invalid");
		expect(classifyTarget("google_business")).toBe("invalid");
		expect(classifyTarget("gmb")).toBe("invalid");
		expect(classifyTarget("")).toBe("invalid");
	});

	it("deduplicates targets", () => {
		const targets = ["twitter", "twitter", "bluesky", "twitter"];
		const unique = [...new Set(targets)];
		expect(unique).toEqual(["twitter", "bluesky"]);
	});
});

// ===========================================================================
// Auth Logic Tests
// ===========================================================================

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

describe("API key hashing", () => {
	it("produces consistent SHA-256 hashes", async () => {
		const key = "rlay_live_test1234567890abcdef";
		const hash1 = await hashKey(key);
		const hash2 = await hashKey(key);
		expect(hash1).toBe(hash2);
		expect(hash1).toHaveLength(64);
	});

	it("produces different hashes for different keys", async () => {
		const hash1 = await hashKey("rlay_live_key1");
		const hash2 = await hashKey("rlay_live_key2");
		expect(hash1).not.toBe(hash2);
	});
});

describe("API key format validation", () => {
	const PREFIXES = ["rlay_live_", "rlay_test_"];
	const isValid = (token: string) => PREFIXES.some((p) => token.startsWith(p));

	it("accepts valid prefixes", () => {
		expect(isValid("rlay_live_abc123")).toBe(true);
		expect(isValid("rlay_test_abc123")).toBe(true);
	});

	it("rejects invalid prefixes", () => {
		expect(isValid("sk_abc123")).toBe(false);
		expect(isValid("rlay_abc123")).toBe(false);
		expect(isValid("Bearer abc")).toBe(false);
	});
});

describe("KV expiry detection", () => {
	it("detects expired keys", () => {
		const isExpired = (expiresAt: string | null) =>
			expiresAt !== null && new Date(expiresAt) < new Date();

		expect(isExpired("2020-01-01T00:00:00Z")).toBe(true);
		expect(isExpired("2030-01-01T00:00:00Z")).toBe(false);
		expect(isExpired(null)).toBe(false);
	});
});

// ===========================================================================
// Performance Tests
// ===========================================================================

describe("SHA-256 hashing performance", () => {
	it("hashes 1000 keys under 100ms", async () => {
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			await hashKey(`rlay_live_testkey${i}`);
		}
		const elapsed = performance.now() - start;
		console.log(
			`  1000 SHA-256 hashes in ${elapsed.toFixed(1)}ms (${(elapsed / 1000).toFixed(3)}ms avg)`,
		);
		expect(elapsed).toBeLessThan(100);
	});
});

describe("Schema validation performance", () => {
	it("validates 1000 post bodies under 100ms", () => {
		const body = {
			content: "Hello world!",
			targets: ["twitter", "bluesky"],
			scheduled_at: "now",
			media: [{ url: "https://cdn.example.com/photo.jpg", type: "image" }],
			target_options: {
				twitter: { thread: [{ content: "Tweet 1" }] },
			},
		};

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			CreatePostBody.safeParse(body);
		}
		const elapsed = performance.now() - start;
		console.log(
			`  1000 schema validations in ${elapsed.toFixed(1)}ms (${(elapsed / 1000).toFixed(3)}ms avg)`,
		);
		expect(elapsed).toBeLessThan(100);
	});
});
