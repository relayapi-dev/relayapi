import { describe, expect, it } from "bun:test";
import app from "../app";

describe("API transport security", () => {
	it("redirects the production host from HTTP without changing path or query", async () => {
		const response = await app.request(
			new Request("http://api.relayapi.dev/health?probe=transport"),
		);
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe(
			"https://api.relayapi.dev/health?probe=transport",
		);
	});

	it("pins redirects to the canonical HTTPS origin", async () => {
		const response = await app.request(
			new Request("http://api.relayapi.dev:8080/health?probe=transport"),
		);
		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe(
			"https://api.relayapi.dev/health?probe=transport",
		);
	});
});
