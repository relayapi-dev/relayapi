import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	fetchRemoteDashboardContext,
	proxyRemoteDashboardRequest,
	resolveRemoteDashboardOrigin,
} from "./remote-dashboard";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("remote dashboard development mode", () => {
	it("defaults local development to the deployed dashboard and stays off in builds", () => {
		expect(resolveRemoteDashboardOrigin(undefined, true)).toBe(
			"https://relayapi.dev",
		);
		expect(resolveRemoteDashboardOrigin("off", true)).toBeNull();
		expect(
			resolveRemoteDashboardOrigin("https://relayapi.dev", false),
		).toBeNull();
	});

	it("rejects insecure or path-bearing upstream values", () => {
		expect(() =>
			resolveRemoteDashboardOrigin("http://relayapi.dev", true),
		).toThrow("must use HTTPS");
		expect(() =>
			resolveRemoteDashboardOrigin("https://relayapi.dev/app", true),
		).toThrow("without a path");
	});

	it("forwards same-origin API requests and rewrites auth redirects locally", async () => {
		let upstreamUrl = "";
		let upstreamInit: RequestInit | undefined;
		globalThis.fetch = Object.assign(
			mock(async (input: string | URL | Request, init?: RequestInit) => {
				upstreamUrl = String(input);
				upstreamInit = init;
				return new Response(null, {
					status: 302,
					headers: {
						Location: "https://relayapi.dev/app",
						"Set-Cookie": "relay_session=abc; Secure; HttpOnly; Path=/",
					},
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);

		const response = await proxyRemoteDashboardRequest(
			new Request("https://dev.relayapi.dev/api/auth/sign-in/email", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: "existing=value",
					Origin: "https://dev.relayapi.dev",
					Referer: "https://dev.relayapi.dev/login",
				},
				body: JSON.stringify({ email: "developer@example.com" }),
			}),
			"https://relayapi.dev",
		);

		expect(upstreamUrl).toBe("https://relayapi.dev/api/auth/sign-in/email");
		const headers = new Headers(upstreamInit?.headers);
		expect(headers.get("origin")).toBe("https://relayapi.dev");
		expect(headers.get("cookie")).toBe("existing=value");
		expect(response.headers.get("location")).toBe(
			"https://dev.relayapi.dev/app",
		);
		expect(response.headers.get("set-cookie")).toContain("relay_session=abc");
	});

	it("loads only the validated remote shell context", async () => {
		globalThis.fetch = Object.assign(
			mock(async () => {
				return Response.json(
					{
						user: { id: "user_1", email: "developer@example.com" },
						session: { id: "session_1", userId: "user_1" },
						organization: { id: "org_1", name: "Development" },
						organizationMembershipRole: "owner",
						hasOrganizations: true,
						hasPendingInvitations: false,
					},
					{
						headers: {
							"Set-Cookie": "relay_session=refreshed; Secure; HttpOnly; Path=/",
						},
					},
				);
			}),
			{ preconnect: originalFetch.preconnect },
		);

		const result = await fetchRemoteDashboardContext(
			new Request("https://dev.relayapi.dev/app", {
				headers: { Cookie: "relay_session=abc" },
			}),
			"https://relayapi.dev",
		);

		expect(result.context?.organization?.id).toBe("org_1");
		expect(result.context?.organizationMembershipRole).toBe("owner");
		expect(result.cookieHeaders.get("set-cookie")).toContain(
			"relay_session=refreshed",
		);
	});

	it("rejects browser requests from another origin before contacting upstream", async () => {
		const upstream = mock(async () => Response.json({ ok: true }));
		globalThis.fetch = Object.assign(upstream, {
			preconnect: originalFetch.preconnect,
		});

		const response = await proxyRemoteDashboardRequest(
			new Request("https://dev.relayapi.dev/api/posts", {
				method: "POST",
				headers: { Origin: "https://attacker.example" },
				body: "{}",
			}),
			"https://relayapi.dev",
		);

		expect(response.status).toBe(403);
		expect(upstream).not.toHaveBeenCalled();
	});
});
