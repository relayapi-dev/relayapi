import { afterEach, describe, expect, it } from "bun:test";
import { buildAuthUrl, exchangeCode, OAUTH_CONFIGS } from "../config/oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("official OAuth configuration contracts", () => {
	it("requests the least-privilege scopes required by implemented social actions", () => {
		expect(OAUTH_CONFIGS.twitter?.scopes).toEqual(
			expect.arrayContaining(["like.write", "tweet.moderate.write"]),
		);
		expect(OAUTH_CONFIGS.facebook?.scopes).toContain("pages_manage_engagement");
		expect(OAUTH_CONFIGS.reddit?.scopes).toEqual(
			expect.arrayContaining(["edit", "vote"]),
		);
	});

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
		expect(authUrl.searchParams.get("scope")?.split(" ")).toContain(
			"video.upload",
		);
		expect(config.scopes).toContain("video.upload");

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
		expect(config).toBeDefined();
		if (!config) throw new Error("Threads OAuth config is missing");
		expect(config?.authUrl).toBe("https://threads.net/oauth/authorize");
		expect(config?.tokenUrl).toBe(
			"https://graph.threads.net/oauth/access_token",
		);
		expect(
			config?.profileUrl.startsWith("https://graph.threads.net/v1.0/"),
		).toBe(true);

		const authUrl = new URL(
			buildAuthUrl(
				config,
				"threads-app-id",
				"https://relay.example/callback",
				"state-token",
			),
		);
		expect(authUrl.searchParams.get("scope")?.split(" ")).toContain(
			"threads_location_tagging",
		);
		expect(config.scopes).toContain("threads_location_tagging");
	});

	it("uses Snapchat Creator OAuth and the token-owned Public Profile endpoint", () => {
		const config = OAUTH_CONFIGS.snapchat;
		expect(config?.scopes).toEqual(["snapchat-profile-api"]);
		expect(config?.profileUrl).toBe(
			"https://businessapi.snapchat.com/v1/public_profiles/my_profile",
		);
	});

	it("requests Pinterest continuous refresh tokens during code exchange", async () => {
		const config = OAUTH_CONFIGS.pinterest;
		expect(config).toBeDefined();
		if (!config) throw new Error("Pinterest OAuth config is missing");

		let tokenBody: URLSearchParams | undefined;
		globalThis.fetch = (async (_input, init) => {
			tokenBody = new URLSearchParams(String(init?.body));
			return Response.json({ access_token: "token" });
		}) as typeof fetch;

		await exchangeCode(
			config,
			"client-id",
			"client-secret",
			"authorization-code",
			"https://relay.example/callback",
		);
		expect(tokenBody?.get("continuous_refresh")).toBe("true");
	});
});
