import { describe, expect, it } from "bun:test";
import { applyAppSecurityHeaders } from "./security-headers";

describe("application security headers", () => {
	it("adds production transport, framing, and content protections", () => {
		const response = applyAppSecurityHeaders(
			new Response("ok", { headers: { "X-Powered-By": "framework" } }),
			true,
		);
		expect(response.headers.get("strict-transport-security")).toContain(
			"includeSubDomains",
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect(response.headers.get("content-security-policy")).toContain(
			"https://3496f40fcd55a91da50ded8abea2cf7a.r2.cloudflarestorage.com",
		);
		expect(response.headers.get("content-security-policy")).not.toContain(
			"https://*.r2.cloudflarestorage.com",
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.has("x-powered-by")).toBe(false);
	});

	it("does not force HTTPS or a production CSP during local development", () => {
		const response = applyAppSecurityHeaders(new Response("ok"), false);
		expect(response.headers.has("strict-transport-security")).toBe(false);
		expect(response.headers.has("content-security-policy")).toBe(false);
		expect(response.headers.get("referrer-policy")).toBe(
			"strict-origin-when-cross-origin",
		);
	});
});
