import { describe, expect, it, beforeAll } from "bun:test";
import { PLATFORMS, type Platform } from "../schemas/common";
import { CreatePostBody, UpdatePostBody } from "../schemas/posts";
import { CreateApiKeyBody } from "../schemas/api-keys";
import {
	ValidatePostBody,
	PostLengthBody,
	ValidateMediaBody,
	HashtagCheckBody,
	SubredditCheckQuery,
} from "../schemas/tools";
import { PLATFORM_LIMITS, countChars } from "../config/platform-limits";
import { PRICING } from "../types";
import type { Env } from "../types";
import { createMockEnv as createSharedMockEnv } from "./__mocks__/env";

// ===========================================================================
// Helpers
// ===========================================================================

const ITERATIONS = 1000;
const WARM_UP = 50;

interface BenchResult {
	name: string;
	iterations: number;
	totalMs: number;
	avgMs: number;
	p50Ms: number;
	p95Ms: number;
	p99Ms: number;
	opsPerSec: number;
}

function benchmark(name: string, fn: () => void, iterations = ITERATIONS): BenchResult {
	// Warm-up
	for (let i = 0; i < WARM_UP; i++) fn();

	const times: number[] = [];
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		fn();
		times.push(performance.now() - t0);
	}
	const totalMs = performance.now() - start;

	times.sort((a, b) => a - b);
	const p50 = times[Math.floor(iterations * 0.5)]!;
	const p95 = times[Math.floor(iterations * 0.95)]!;
	const p99 = times[Math.floor(iterations * 0.99)]!;

	return {
		name,
		iterations,
		totalMs,
		avgMs: totalMs / iterations,
		p50Ms: p50,
		p95Ms: p95,
		p99Ms: p99,
		opsPerSec: Math.round((iterations / totalMs) * 1000),
	};
}

async function benchmarkAsync(
	name: string,
	fn: () => Promise<void>,
	iterations = ITERATIONS,
): Promise<BenchResult> {
	// Warm-up
	for (let i = 0; i < WARM_UP; i++) await fn();

	const times: number[] = [];
	const start = performance.now();
	for (let i = 0; i < iterations; i++) {
		const t0 = performance.now();
		await fn();
		times.push(performance.now() - t0);
	}
	const totalMs = performance.now() - start;

	times.sort((a, b) => a - b);
	const p50 = times[Math.floor(iterations * 0.5)]!;
	const p95 = times[Math.floor(iterations * 0.95)]!;
	const p99 = times[Math.floor(iterations * 0.99)]!;

	return {
		name,
		iterations,
		totalMs,
		avgMs: totalMs / iterations,
		p50Ms: p50,
		p95Ms: p95,
		p99Ms: p99,
		opsPerSec: Math.round((iterations / totalMs) * 1000),
	};
}

function printResult(r: BenchResult) {
	console.log(
		`  ${r.name}: ${r.avgMs.toFixed(3)}ms avg | P50=${r.p50Ms.toFixed(3)}ms P95=${r.p95Ms.toFixed(3)}ms P99=${r.p99Ms.toFixed(3)}ms | ${r.opsPerSec} ops/s`,
	);
}

// ===========================================================================
// Mock Cloudflare Bindings
// ===========================================================================

class MockKV {
	private store = new Map<string, string>();

	async get(key: string, opts?: unknown): Promise<unknown> {
		const raw = this.store.get(key);
		if (!raw) return null;
		if (opts === "json") return JSON.parse(raw);
		return raw;
	}

	async put(key: string, value: string, _opts?: unknown): Promise<void> {
		this.store.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	async list(_opts?: unknown): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
		return {
			keys: Array.from(this.store.keys()).map((name) => ({ name })),
			list_complete: true,
		};
	}

	async getWithMetadata(key: string, _opts?: unknown): Promise<{ value: string | null; metadata: unknown }> {
		return { value: this.store.get(key) ?? null, metadata: null };
	}
}

class MockR2Bucket {
	async put(_key: string, _body: unknown, _opts?: unknown) {
		return {};
	}
	async get(_key: string) {
		return null;
	}
	async delete(_key: string) {}
	async createMultipartUpload(_key: string, _opts?: unknown) {
		return { uploadId: "mock-upload-id" };
	}
}

// ===========================================================================
// Setup mock app
// ===========================================================================

let app: Awaited<ReturnType<typeof createApp>>;

async function createApp() {
	const { default: appModule } = await import("../index");
	return appModule;
}

function createMockEnv(): Env {
	return createSharedMockEnv().env;
}

// Pre-computed hash for "rlay_live_perftestkey000000000000000000000000000000"
const TEST_API_KEY = "rlay_live_perftestkey000000000000000000000000000000";
let TEST_API_KEY_HASH: string;

async function hashKey(key: string): Promise<string> {
	const encoded = new TextEncoder().encode(key);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hashBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

beforeAll(async () => {
	TEST_API_KEY_HASH = await hashKey(TEST_API_KEY);
});

function getAuthHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${TEST_API_KEY}`,
		"Content-Type": "application/json",
	};
}

async function makeRequest(
	env: Env,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; time: number }> {
	const { default: appModule } = await import("../index");
	const init: RequestInit = {
		method,
		headers: getAuthHeaders(),
	};
	if (body) {
		init.body = JSON.stringify(body);
	}
	const start = performance.now();
	const res = await appModule.fetch(
		new Request(`http://localhost${path}`, init),
		env,
		{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
	);
	const time = performance.now() - start;
	return { status: res.status, time };
}

// ===========================================================================
// 1. Schema Validation Performance
// ===========================================================================

describe("Schema validation performance", () => {
	const postBody = {
		content: "Hello world! This is a test post with some content.",
		targets: ["twitter", "bluesky", "instagram"],
		scheduled_at: "now",
		media: [{ url: "https://cdn.example.com/photo.jpg", type: "image" }],
		target_options: {
			twitter: { thread: [{ content: "Tweet 1" }] },
		},
	};

	it("CreatePostBody validation", () => {
		const r = benchmark("CreatePostBody.safeParse", () => {
			CreatePostBody.safeParse(postBody);
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});

	it("CreatePostBody with all fields", () => {
		const fullBody = {
			content: "A".repeat(500),
			targets: ["twitter", "instagram", "facebook", "linkedin", "bluesky"],
			scheduled_at: "2026-06-01T12:00:00Z",
			timezone: "America/New_York",
			media: [
				{ url: "https://cdn.example.com/1.jpg", type: "image" },
				{ url: "https://cdn.example.com/2.jpg", type: "image" },
				{ url: "https://cdn.example.com/3.mp4", type: "video" },
			],
			target_options: {
				twitter: { reply_to: "123" },
				reddit: { subreddit: "test", flair_id: "abc" },
			},
		};
		const r = benchmark("CreatePostBody (full)", () => {
			CreatePostBody.safeParse(fullBody);
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.2);
	});

	it("UpdatePostBody validation", () => {
		const r = benchmark("UpdatePostBody.safeParse", () => {
			UpdatePostBody.safeParse({ content: "Updated content" });
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});

	it("ValidatePostBody validation", () => {
		const r = benchmark("ValidatePostBody.safeParse", () => {
			ValidatePostBody.safeParse(postBody);
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});

	it("PostLengthBody validation", () => {
		const r = benchmark("PostLengthBody.safeParse", () => {
			PostLengthBody.safeParse({ content: "Hello world!" });
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("ValidateMediaBody validation", () => {
		const r = benchmark("ValidateMediaBody.safeParse", () => {
			ValidateMediaBody.safeParse({ url: "https://cdn.example.com/image.jpg" });
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("HashtagCheckBody validation", () => {
		const r = benchmark("HashtagCheckBody.safeParse", () => {
			HashtagCheckBody.safeParse({
				hashtags: ["travel", "photography", "nature", "art", "design"],
			});
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("CreateApiKeyBody validation", () => {
		const r = benchmark("CreateApiKeyBody.safeParse", () => {
			CreateApiKeyBody.safeParse({ name: "My API Key", expires_in_days: 365 });
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("SubredditCheckQuery validation", () => {
		const r = benchmark("SubredditCheckQuery.safeParse", () => {
			SubredditCheckQuery.safeParse({ name: "technology" });
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("invalid schema rejection speed", () => {
		const r = benchmark("CreatePostBody rejection", () => {
			CreatePostBody.safeParse({ content: "missing required fields" });
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});
});

// ===========================================================================
// 2. Platform Limits & Character Counting Performance
// ===========================================================================

describe("Platform limits performance", () => {
	it("countChars for short text across all platforms", () => {
		const content = "Hello world! Check out this post.";
		const r = benchmark("countChars (short, all platforms)", () => {
			for (const platform of PLATFORMS) {
				countChars(content, platform);
			}
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});

	it("countChars for long text with URLs (Twitter URL shortening)", () => {
		const content =
			"Check out https://example.com/very/long/url/path?param=value and https://another-url.com/post/123 for more info. This is a tweet with multiple URLs.";
		const r = benchmark("countChars (with URLs)", () => {
			countChars(content, "twitter");
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("countChars for very long text (5000 chars)", () => {
		const content = "A".repeat(5000);
		const r = benchmark("countChars (5000 chars)", () => {
			for (const platform of PLATFORMS) {
				countChars(content, platform);
			}
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.2);
	});

	it("PLATFORM_LIMITS lookup speed", () => {
		const r = benchmark("PLATFORM_LIMITS lookup (all)", () => {
			for (const platform of PLATFORMS) {
				const limits = PLATFORM_LIMITS[platform];
				// Access nested properties to prevent optimization
				const _ = limits.chars.maxChars + limits.media.maxImages;
			}
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.01);
	});

	it("PRICING config lookup speed", () => {
		const r = benchmark("PRICING lookup", () => {
			const _ =
				PRICING.proRateLimitMax +
				PRICING.proCallsIncluded +
				PRICING.pricePerThousandCallsCents +
				PRICING.monthlyPriceCents;
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.01);
	});

	it("full validation simulation (content + media for all platforms)", () => {
		const content = "This is a test post with some content that is medium length";
		const r = benchmark("full platform validation", () => {
			for (const platform of PLATFORMS) {
				const limits = PLATFORM_LIMITS[platform];
				const chars = countChars(content, platform);
				const withinLimit = chars <= limits.chars.maxChars;
				const nearLimit = chars > limits.chars.maxChars * 0.9;
				// Simulate media check
				const imageSize = 2 * 1024 * 1024;
				const withinMediaLimit = imageSize <= limits.media.maxImageSize;
			}
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.2);
	});
});

// ===========================================================================
// 3. Cryptographic Operations Performance
// ===========================================================================

describe("Cryptographic operations performance", () => {
	it("SHA-256 API key hashing", async () => {
		const r = await benchmarkAsync("SHA-256 hash", async () => {
			await hashKey("rlay_live_testkey1234567890abcdef1234567890abcdef");
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});

	it("HMAC-SHA256 webhook signing", async () => {
		const r = await benchmarkAsync("HMAC-SHA256 sign", async () => {
			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey(
				"raw",
				encoder.encode("whsec_test_secret_key_for_benchmarking"),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"],
			);
			const payload = JSON.stringify({
				event: "post.published",
				data: { post_id: "post_123", status: "published" },
				timestamp: new Date().toISOString(),
			});
			await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.2);
	});

	it("random key generation", () => {
		const r = benchmark("API key generation", () => {
			const bytes = new Uint8Array(29);
			crypto.getRandomValues(bytes);
			const hex = Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const key = `rlay_live_${hex}`;
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("webhook secret generation", () => {
		const r = benchmark("webhook secret generation", () => {
			const bytes = new Uint8Array(32);
			crypto.getRandomValues(bytes);
			const hex = Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const secret = `whsec_${hex}`;
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});

	it("OAuth state token generation", () => {
		const r = benchmark("OAuth state token", () => {
			const bytes = new Uint8Array(32);
			crypto.getRandomValues(bytes);
			Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});
});

// ===========================================================================
// 4. ID Generation Performance
// ===========================================================================

describe("ID generation performance", () => {
	it("nanoid-style ID generation", () => {
		const r = benchmark("generateId", () => {
			const bytes = new Uint8Array(16);
			crypto.getRandomValues(bytes);
			const hex = Array.from(bytes)
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			const id = `post_${hex}`;
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.05);
	});
});

// ===========================================================================
// 5. HTTP Endpoint Performance (Hono test client)
// ===========================================================================

describe("HTTP endpoint performance", () => {
	let env: Env;

	beforeAll(async () => {
		env = createMockEnv();
		// Seed the mock KV with a valid API key
		TEST_API_KEY_HASH = await hashKey(TEST_API_KEY);
		const kvData = {
			org_id: "org_perftest",
			key_id: "key_perftest",
			permissions: [],
			expires_at: null,
			rate_limit_max: 100000,
			rate_limit_window: 60,
			};
		await (env.KV as unknown as MockKV).put(
			`apikey:${TEST_API_KEY_HASH}`,
			JSON.stringify(kvData),
		);

		// Seed account groups for KV tests
		await (env.KV as unknown as MockKV).put(
			"groups:org_perftest",
			JSON.stringify([
				{
					id: "ws_test1",
					name: "Test Group",
					account_ids: ["acc_1", "acc_2"],
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				},
			]),
		);
	});

	it("GET /health (no auth)", async () => {
		const times: number[] = [];
		const iterations = 500;

		for (let i = 0; i < iterations; i++) {
			const { default: appModule } = await import("../index");
			const start = performance.now();
			const res = await appModule.fetch(
				new Request("http://localhost/health"),
				env,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);
			times.push(performance.now() - start);
			expect(res.status).toBe(200);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  GET /health: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms | ${Math.round((iterations / (avg * iterations)) * 1000000)} ops/s`,
		);
		expect(avg).toBeLessThan(5);
	});

	it("Auth middleware (valid key)", async () => {
		const times: number[] = [];
		const iterations = 200;

		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			// This will fail at DB level but auth + rate limit will succeed
			await makeRequest(env, "GET", "/v1/usage");
			times.push(performance.now() - start);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  Auth middleware: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("Auth middleware (invalid key → 401)", async () => {
		const times: number[] = [];
		const iterations = 200;

		for (let i = 0; i < iterations; i++) {
			const { default: appModule } = await import("../index");
			const start = performance.now();
			const res = await appModule.fetch(
				new Request("http://localhost/v1/usage", {
					headers: { Authorization: "Bearer rlay_live_invalidkey000000000000000000000" },
				}),
				env,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);
			times.push(performance.now() - start);
			expect(res.status).toBe(401);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  Auth reject (401): ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("GET /v1/workspaces (KV-based, no DB)", async () => {
		const times: number[] = [];
		const iterations = 200;

		for (let i = 0; i < iterations; i++) {
			const { status, time } = await makeRequest(env, "GET", "/v1/workspaces");
			times.push(time);
			expect(status).toBe(200);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  GET /v1/workspaces: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("POST /v1/workspaces (KV write)", async () => {
		const times: number[] = [];
		const iterations = 100;

		for (let i = 0; i < iterations; i++) {
			const { status, time } = await makeRequest(
				env,
				"POST",
				"/v1/workspaces",
				{ name: `Perf Group ${i}`, account_ids: ["acc_1"] },
			);
			times.push(time);
			expect(status).toBe(201);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  POST /v1/workspaces: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("GET /v1/connections/logs (DB-backed, measures auth overhead)", async () => {
		const times: number[] = [];
		const iterations = 200;

		for (let i = 0; i < iterations; i++) {
			const { status, time } = await makeRequest(env, "GET", "/v1/connections/logs");
			times.push(time);
			// Will get 500 (DB not available in test) — we measure auth + routing overhead
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  GET /v1/connections/logs: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("GET /v1/queue/slots (KV-based, no DB)", async () => {
		const times: number[] = [];
		const iterations = 200;

		for (let i = 0; i < iterations; i++) {
			const { status, time } = await makeRequest(env, "GET", "/v1/queue/slots");
			times.push(time);
			expect(status).toBe(200);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  GET /v1/queue/slots: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("POST /v1/connect/telegram (KV-based, code generation)", async () => {
		const times: number[] = [];
		const iterations = 100;

		for (let i = 0; i < iterations; i++) {
			const { status, time } = await makeRequest(
				env,
				"POST",
				"/v1/connect/telegram",
			);
			times.push(time);
			expect(status).toBe(200);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  POST /v1/connect/telegram: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("GET /v1/connect/pending-data (KV read, not found)", async () => {
		const times: number[] = [];
		const iterations = 200;

		for (let i = 0; i < iterations; i++) {
			const { status, time } = await makeRequest(
				env,
				"GET",
				"/v1/connect/pending-data?token=nonexistent",
			);
			times.push(time);
			expect(status).toBe(404);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  GET /v1/connect/pending-data (404): ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(10);
	});

	it("GET /openapi.json (spec generation)", async () => {
		const times: number[] = [];
		const iterations = 50;

		for (let i = 0; i < iterations; i++) {
			const { default: appModule } = await import("../index");
			const start = performance.now();
			const res = await appModule.fetch(
				new Request("http://localhost/openapi.json"),
				env,
				{ waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
			);
			times.push(performance.now() - start);
			expect(res.status).toBe(200);
		}

		times.sort((a, b) => a - b);
		const avg = times.reduce((a, b) => a + b, 0) / iterations;
		console.log(
			`  GET /openapi.json: ${avg.toFixed(3)}ms avg | P50=${times[Math.floor(iterations * 0.5)]!.toFixed(3)}ms P95=${times[Math.floor(iterations * 0.95)]!.toFixed(3)}ms P99=${times[Math.floor(iterations * 0.99)]!.toFixed(3)}ms`,
		);
		expect(avg).toBeLessThan(50);
	});
});

// ===========================================================================
// 6. Rate Limiting Performance
// ===========================================================================

describe("Rate limiting performance", () => {
	it("KV counter increment pattern", async () => {
		const kv = new MockKV() as unknown as KVNamespace;
		const r = await benchmarkAsync(
			"rate limit counter increment",
			async () => {
				const key = "ratelimit:key1:12345";
				const current = await kv.get(key, "text");
				const count = current ? parseInt(current as string, 10) : 0;
				await kv.put(key, String(count + 1));
			},
			500,
		);
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});
});

// ===========================================================================
// 7. Target Resolution Simulation Performance
// ===========================================================================

describe("Target resolution performance", () => {
	it("platform name classification", () => {
		const targets = [
			"twitter",
			"instagram",
			"facebook",
			"acc_abc123",
			"linkedin",
			"acc_def456",
			"bluesky",
			"invalid_target",
		];

		const r = benchmark("target classification (8 targets)", () => {
			for (const target of targets) {
				if (target.startsWith("acc_")) {
					// account ID
				} else if (
					(PLATFORMS as readonly string[]).includes(target)
				) {
					// platform
				} else {
					// invalid
				}
			}
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.01);
	});
});

// ===========================================================================
// 8. JSON Serialization Performance
// ===========================================================================

describe("JSON serialization performance", () => {
	it("post response serialization", () => {
		const response = {
			id: "post_abc123def456",
			status: "published",
			content: "Hello world! ".repeat(20),
			scheduled_at: null,
			targets: {
				twitter: {
					status: "published",
					platform: "twitter",
					accounts: [
						{
							id: "acc_123",
							username: "testuser",
							url: "https://twitter.com/testuser/status/123",
						},
					],
				},
				instagram: {
					status: "published",
					platform: "instagram",
					accounts: [
						{
							id: "acc_456",
							username: "instauser",
							url: "https://instagram.com/p/abc",
						},
					],
				},
			},
			media: [
				{ url: "https://cdn.example.com/image.jpg", type: "image" },
			],
			created_at: "2026-03-15T10:00:00Z",
			updated_at: "2026-03-15T10:01:00Z",
		};

		const r = benchmark("JSON.stringify (post response)", () => {
			JSON.stringify(response);
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.01);
	});

	it("analytics response serialization (large)", () => {
		const data = Array.from({ length: 100 }, (_, i) => ({
			post_id: `post_${i}`,
			platform: "twitter",
			impressions: Math.floor(Math.random() * 10000),
			reach: Math.floor(Math.random() * 8000),
			likes: Math.floor(Math.random() * 500),
			comments: Math.floor(Math.random() * 100),
			shares: Math.floor(Math.random() * 50),
			saves: Math.floor(Math.random() * 20),
			clicks: Math.floor(Math.random() * 300),
			views: null,
			published_at: "2026-03-10T14:30:00Z",
		}));
		const response = {
			data,
			overview: {
				total_posts: 100,
				total_impressions: 500000,
				total_likes: 25000,
				total_comments: 5000,
				total_shares: 2500,
				total_clicks: 15000,
				total_views: 0,
			},
		};

		const r = benchmark("JSON.stringify (100-item analytics)", () => {
			JSON.stringify(response);
		});
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.1);
	});

	it("webhook payload serialization + HMAC signing", async () => {
		const r = await benchmarkAsync(
			"webhook payload + HMAC",
			async () => {
				const payload = JSON.stringify({
					id: "whd_abc123",
					event: "post.published",
					data: {
						post_id: "post_123",
						status: "published",
						targets: { twitter: { status: "published" } },
					},
					timestamp: new Date().toISOString(),
				});

				const encoder = new TextEncoder();
				const key = await crypto.subtle.importKey(
					"raw",
					encoder.encode("test_secret"),
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["sign"],
				);
				await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
			},
			500,
		);
		printResult(r);
		expect(r.avgMs).toBeLessThan(0.5);
	});
});

// ===========================================================================
// Summary
// ===========================================================================

describe("Performance summary", () => {
	it("prints threshold reference", () => {
		console.log("\n  ═══════════════════════════════════════════════════");
		console.log("  Performance Thresholds (per operation):");
		console.log("  ─────────────────────────────────────────────────");
		console.log("  Schema validation:  < 0.1ms");
		console.log("  Character counting: < 0.05ms");
		console.log("  SHA-256 hash:       < 0.1ms");
		console.log("  HMAC-SHA256 sign:   < 0.2ms");
		console.log("  Key generation:     < 0.05ms");
		console.log("  KV read/write:      < 0.1ms (in-memory mock)");
		console.log("  Health endpoint:    < 5ms");
		console.log("  Auth middleware:     < 10ms");
		console.log("  KV endpoints:       < 10ms");
		console.log("  OpenAPI spec:       < 50ms");
		console.log("  JSON serialize:     < 0.1ms");
		console.log("  ═══════════════════════════════════════════════════\n");
		expect(true).toBe(true);
	});
});
