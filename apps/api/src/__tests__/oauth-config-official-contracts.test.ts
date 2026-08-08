import { afterEach, describe, expect, it } from "bun:test";
import { buildAuthUrl, exchangeCode, OAUTH_CONFIGS } from "../config/oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("official OAuth configuration contracts", () => {
	it("uses TikTok's documented client_key field in both OAuth steps", async () => {
		const config = OAUTH_CONFIGS.tiktok;
		expect(config).toBeDefined();
		if (!config) throw new Error("TikTok OAuth config is missing");

		const authUrl = new URL(
			buildAuthUrl(
				config,
				"client-key",
				"https://relay.example/callback",
				"state-token",
			),
		);
		expect(
			authUrl.href.startsWith("https://www.tiktok.com/v2/auth/authorize/"),
		).toBe(true);
		expect(authUrl.searchParams.get("client_key")).toBe("client-key");
		expect(authUrl.searchParams.has("client_id")).toBe(false);

		let tokenBody: URLSearchParams | undefined;
		globalThis.fetch = (async (_input, init) => {
			tokenBody = new URLSearchParams(String(init?.body));
			return Response.json({ access_token: "token" });
		}) as typeof fetch;

		await exchangeCode(
			config,
			"client-key",
			"client-secret",
			"authorization-code",
			"https://relay.example/callback",
		);
		expect(tokenBody?.get("client_key")).toBe("client-key");
		expect(tokenBody?.has("client_id")).toBe(false);
	});

	it("uses the current Threads short-lived OAuth and Graph hosts", () => {
		const config = OAUTH_CONFIGS.threads;
		expect(config?.authUrl).toBe("https://threads.net/oauth/authorize");
		expect(config?.tokenUrl).toBe(
			"https://graph.threads.net/oauth/access_token",
		);
		expect(
			config?.profileUrl.startsWith("https://graph.threads.net/v1.0/"),
		).toBe(true);
	});
});
