import { describe, expect, test } from "bun:test";
import {
	matchesTikTokVerifiedUrlPrefix,
	parseTikTokVerifiedUrlPrefix,
} from "../lib/tiktok-verified-url";

describe("TikTok verified URL prefixes", () => {
	test("requires an HTTPS domain and trailing path boundary", () => {
		expect(parseTikTokVerifiedUrlPrefix("https://media.example/tiktok/")).toBe(
			"https://media.example/tiktok/",
		);
		for (const invalid of [
			"http://media.example/tiktok/",
			"https://127.0.0.1/tiktok/",
			"https://[::1]/tiktok/",
			"https://media.example/tiktok",
			"https://media.example:8443/tiktok/",
			"https://user:pass@media.example/tiktok/",
			"https://media.example/tiktok/?variant=1",
		]) {
			expect(() => parseTikTokVerifiedUrlPrefix(invalid)).toThrow();
		}
	});

	test("matches only the verified origin and slash-delimited path", () => {
		const prefixes = ["https://media.example/tiktok/"];
		expect(
			matchesTikTokVerifiedUrlPrefix(
				"https://media.example/tiktok/video.mp4?token=short-lived",
				prefixes,
			),
		).toBe(true);
		expect(
			matchesTikTokVerifiedUrlPrefix(
				"https://media.example/tiktok-evil/video.mp4",
				prefixes,
			),
		).toBe(false);
		expect(
			matchesTikTokVerifiedUrlPrefix(
				"https://attacker.example/tiktok/video.mp4",
				prefixes,
			),
		).toBe(false);
	});

	test("fails closed for invalid legacy metadata", () => {
		expect(
			matchesTikTokVerifiedUrlPrefix("https://media.example/video.mp4", [
				"https://media.example",
			]),
		).toBe(false);
	});
});
