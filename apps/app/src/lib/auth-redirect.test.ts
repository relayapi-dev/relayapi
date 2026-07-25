import { describe, expect, it } from "bun:test";
import { normalizeAuthRedirect } from "./auth-redirect";

describe("normalizeAuthRedirect", () => {
	it("preserves safe same-origin paths", () => {
		expect(normalizeAuthRedirect("/app/posts?status=draft#top")).toBe(
			"/app/posts?status=draft#top",
		);
		expect(normalizeAuthRedirect("/invite/inv_123")).toBe("/invite/inv_123");
	});

	it("rejects schemes, protocol-relative URLs, and backslashes", () => {
		for (const value of [
			"javascript:alert(1)",
			"https://attacker.example",
			"//attacker.example/path",
			"/\\attacker.example/path",
			"/%5cattacker.example/path",
			"/%252f%252fattacker.example/path",
		]) {
			expect(normalizeAuthRedirect(value)).toBe("/app");
		}
	});

	it("rejects malformed encodings and control characters", () => {
		expect(normalizeAuthRedirect("/%E0%A4%A")).toBe("/app");
		expect(normalizeAuthRedirect("/app%0d%0aLocation:%20//evil.test")).toBe(
			"/app",
		);
	});

	it("revalidates the path after URL dot-segment normalization", () => {
		for (const value of [
			"/safe/..//attacker.example",
			"/safe/%2e%2e//attacker.example",
			"/%2e%2e//attacker.example",
		]) {
			expect(normalizeAuthRedirect(value)).toBe("/app");
		}
	});

	it("uses the caller's safe fallback", () => {
		expect(normalizeAuthRedirect(null, "/login")).toBe("/login");
	});
});
