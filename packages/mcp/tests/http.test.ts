import { describe, expect, it } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	bearerTokenIsAllowed,
	createHttpRequestHandler,
	hostHeaderIsAllowed,
	jsonContentTypeIsAllowed,
	loadHttpConfig,
	originHeaderIsAllowed,
} from "../src/http";

function requestStub(headers: Record<string, string>): IncomingMessage {
	return {
		method: "POST",
		url: "/mcp",
		headers,
	} as unknown as IncomingMessage;
}

function responseStub(): {
	response: ServerResponse;
	result: { status?: number; body?: string };
} {
	const result: { status?: number; body?: string } = {};
	const response = {
		headersSent: false,
		writableEnded: false,
		writeHead(status: number) {
			result.status = status;
			this.headersSent = true;
			return this;
		},
		end(body?: string) {
			result.body = body;
			this.writableEnded = true;
			return this;
		},
	} as unknown as ServerResponse;
	return { response, result };
}

describe("MCP HTTP configuration", () => {
	it("uses a loopback-only default", () => {
		expect(loadHttpConfig({})).toEqual({
			host: "127.0.0.1",
			port: 3000,
			path: "/mcp",
			allowedHosts: ["127.0.0.1", "localhost", "[::1]"],
			authToken: undefined,
		});
	});

	it("requires an allowlist and bearer token for non-loopback binding", () => {
		expect(() => loadHttpConfig({ RELAYAPI_MCP_HOST: "0.0.0.0" })).toThrow(
			"RELAYAPI_MCP_AUTH_TOKEN is required",
		);
		expect(() =>
			loadHttpConfig({
				RELAYAPI_MCP_HOST: "0.0.0.0",
				RELAYAPI_MCP_AUTH_TOKEN: "x".repeat(32),
			}),
		).toThrow("RELAYAPI_MCP_ALLOWED_HOSTS is required");

		expect(
			loadHttpConfig({
				RELAYAPI_MCP_HOST: "0.0.0.0",
				RELAYAPI_MCP_ALLOWED_HOSTS: "mcp.example.com, localhost",
				RELAYAPI_MCP_AUTH_TOKEN: "x".repeat(32),
			}),
		).toEqual({
			host: "0.0.0.0",
			port: 3000,
			path: "/mcp",
			allowedHosts: ["mcp.example.com", "localhost"],
			authToken: "x".repeat(32),
		});
	});

	it("rejects invalid ports, paths, hosts, and weak tokens", () => {
		expect(() => loadHttpConfig({ RELAYAPI_MCP_PORT: "0" })).toThrow(
			"1 to 65535",
		);
		expect(() => loadHttpConfig({ RELAYAPI_MCP_PATH: "mcp" })).toThrow(
			"absolute URL path",
		);
		expect(() =>
			loadHttpConfig({
				RELAYAPI_MCP_ALLOWED_HOSTS: "localhost:3000",
			}),
		).toThrow("without ports");
		expect(() =>
			loadHttpConfig({ RELAYAPI_MCP_AUTH_TOKEN: "too-short" }),
		).toThrow("at least 32 characters");
	});
});

describe("MCP HTTP request protection", () => {
	it("validates Host headers without depending on the port", () => {
		const allowed = ["localhost", "127.0.0.1", "[::1]"];
		expect(hostHeaderIsAllowed("localhost:3000", allowed)).toBe(true);
		expect(hostHeaderIsAllowed("[::1]:3000", allowed)).toBe(true);
		expect(hostHeaderIsAllowed("attacker.example", allowed)).toBe(false);
		expect(hostHeaderIsAllowed(undefined, allowed)).toBe(false);
	});

	it("requires an exact bearer token when configured", () => {
		const token = "correct-token-that-is-at-least-32-chars";
		expect(bearerTokenIsAllowed(undefined, undefined)).toBe(true);
		expect(bearerTokenIsAllowed(`Bearer ${token}`, token)).toBe(true);
		expect(bearerTokenIsAllowed(`bearer ${token}`, token)).toBe(true);
		expect(bearerTokenIsAllowed("Bearer wrong", token)).toBe(false);
		expect(bearerTokenIsAllowed(undefined, token)).toBe(false);
		expect(bearerTokenIsAllowed(`Bearer${"\t".repeat(100_000)}`, token)).toBe(
			false,
		);
	});

	it("accepts only JSON and trusted browser origins", () => {
		const allowed = ["localhost", "127.0.0.1"];
		expect(originHeaderIsAllowed(undefined, allowed)).toBe(true);
		expect(originHeaderIsAllowed("http://localhost:5173", allowed)).toBe(true);
		expect(originHeaderIsAllowed("https://attacker.example", allowed)).toBe(
			false,
		);
		expect(originHeaderIsAllowed("null", allowed)).toBe(false);
		expect(jsonContentTypeIsAllowed("application/json")).toBe(true);
		expect(jsonContentTypeIsAllowed("application/json; charset=utf-8")).toBe(
			true,
		);
		expect(jsonContentTypeIsAllowed("text/plain")).toBe(false);
	});

	it("rejects cross-origin and CORS-simple posts in the full handler", async () => {
		const handler = createHttpRequestHandler({} as never, loadHttpConfig({}));
		const crossOrigin = responseStub();
		await handler(
			requestStub({
				host: "127.0.0.1:3000",
				origin: "https://attacker.example",
				"content-type": "text/plain",
			}),
			crossOrigin.response,
		);
		expect(crossOrigin.result.status).toBe(403);
		expect(crossOrigin.result.body).toContain("Untrusted Origin");

		const simplePost = responseStub();
		await handler(
			requestStub({
				host: "127.0.0.1:3000",
				origin: "http://localhost:5173",
				"content-type": "text/plain",
			}),
			simplePost.response,
		);
		expect(simplePost.result.status).toBe(415);
		expect(simplePost.result.body).toContain("application/json");
	});
});
