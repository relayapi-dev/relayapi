import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { exchangeCode } from "../config/oauth";
import {
	MastodonOAuthSetupError,
	mastodonOAuthConfigFromState,
	registerMastodonOAuthClient,
} from "../services/mastodon-oauth";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Mastodon dynamic OAuth", () => {
	it("rejects non-origin and local instance URLs before registration", async () => {
		for (const instanceUrl of [
			"http://social.example",
			"https://localhost",
			"https://social.example/path",
			"https://user:secret@social.example",
		]) {
			expect(
				registerMastodonOAuthClient({
					instanceUrl,
					redirectUri: "https://api.relay.example/connect/oauth/callback",
					website: "https://relay.example",
				}),
			).rejects.toBeInstanceOf(MastodonOAuthSetupError);
		}
	});

	it("discovers same-origin endpoints and registers the documented app fields", async () => {
		let registrationBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (
				url.startsWith("https://dns.google/resolve") ||
				url.startsWith("https://cloudflare-dns.com/dns-query")
			) {
				const type = new URL(url).searchParams.get("type");
				return Response.json({
					Status: 0,
					Answer: type === "A" ? [{ type: 1, data: "8.8.8.8" }] : [],
				});
			}
			if (url.endsWith("/.well-known/oauth-authorization-server")) {
				return Response.json({
					authorization_endpoint: "https://social.example/oauth/authorize",
					token_endpoint: "https://social.example/oauth/token",
					app_registration_endpoint: "https://social.example/api/v1/apps",
					scopes_supported: ["read:accounts", "write:statuses", "write:media"],
				});
			}
			if (url === "https://social.example/api/v1/apps") {
				registrationBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				return Response.json({
					client_id: "instance-client",
					client_secret: "instance-secret",
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const state = await registerMastodonOAuthClient({
			instanceUrl: "https://social.example",
			redirectUri: "https://api.relay.example/connect/oauth/callback",
			website: "https://relay.example",
		});

		expect(registrationBody).toEqual({
			client_name: "RelayAPI",
			redirect_uris: ["https://api.relay.example/connect/oauth/callback"],
			scopes: "read:accounts write:statuses write:media",
			website: "https://relay.example",
		});
		expect(state.instance_url).toBe("https://social.example");
		expect(state.profile_url).toBe(
			"https://social.example/api/v1/accounts/verify_credentials",
		);
		const config = mastodonOAuthConfigFromState(state);
		expect(config.getClientId({} as never)).toBe("instance-client");
		expect(config.getClientSecret({} as never)).toBe("instance-secret");
		expect(config.requiresPublicEndpointValidation).toBe(true);
	});

	it("does not follow authorization metadata onto another origin", async () => {
		const requested: string[] = [];
		globalThis.fetch = (async (input) => {
			const url = String(input);
			requested.push(url);
			if (url.includes("/resolve?")) {
				const type = new URL(url).searchParams.get("type");
				return Response.json({
					Status: 0,
					Answer: type === "A" ? [{ type: 1, data: "8.8.8.8" }] : [],
				});
			}
			if (url.endsWith("/.well-known/oauth-authorization-server")) {
				return Response.json({
					authorization_endpoint: "https://attacker.example/authorize",
					token_endpoint: "https://attacker.example/token",
					app_registration_endpoint: "https://attacker.example/register",
				});
			}
			if (url === "https://social.example/api/v1/apps") {
				return Response.json({
					client_id: "safe-client",
					client_secret: "safe-secret",
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const state = await registerMastodonOAuthClient({
			instanceUrl: "https://social.example",
			redirectUri: "https://api.relay.example/connect/oauth/callback",
			website: "https://relay.example",
		});
		expect(state.auth_url).toBe("https://social.example/oauth/authorize");
		expect(
			requested.some((url) => url.startsWith("https://attacker.example")),
		).toBe(false);
	});

	it("revalidates callback endpoints and refuses token/profile redirects", async () => {
		let tokenRequest: RequestInit | undefined;
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			if (
				url.startsWith("https://dns.google/resolve") ||
				url.startsWith("https://cloudflare-dns.com/dns-query")
			) {
				const type = new URL(url).searchParams.get("type");
				return Response.json({
					Status: 0,
					Answer: type === "A" ? [{ type: 1, data: "8.8.8.8" }] : [],
				});
			}
			if (url === "https://social.example/oauth/token") {
				tokenRequest = init;
				return Response.json({ access_token: "instance-token" });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const config = mastodonOAuthConfigFromState({
			instance_url: "https://social.example",
			auth_url: "https://social.example/oauth/authorize",
			token_url: "https://social.example/oauth/token",
			profile_url: "https://social.example/api/v1/accounts/verify_credentials",
			client_id: "instance-client",
			client_secret: "instance-secret",
			scopes: ["read:accounts"],
		});
		await expect(
			exchangeCode(
				config,
				"instance-client",
				"instance-secret",
				"oauth-code",
				"https://api.relay.example/connect/oauth/callback",
			),
		).resolves.toMatchObject({ access_token: "instance-token" });
		expect(tokenRequest?.redirect).toBe("error");

		const callbackSource = readFileSync(
			new URL("../routes/connect.ts", import.meta.url),
			"utf8",
		);
		expect(callbackSource).toContain(
			"oauthConfig.requiresPublicEndpointValidation",
		);
		expect(callbackSource).toContain("await fetchPublicUrl(profileUrl");
	});
});
