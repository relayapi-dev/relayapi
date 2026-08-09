import { describe, expect, it } from "bun:test";
import { fetchTwilioMediaSize } from "../services/twilio-media-metadata";

const MEDIA_URL =
	"https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1";

describe("fetchTwilioMediaSize", () => {
	it("HEADs the media URL with account basic auth and reads Content-Length", async () => {
		let requestedUrl = "";
		let requestedInit: RequestInit | undefined;

		const size = await fetchTwilioMediaSize(
			MEDIA_URL,
			"AC123",
			"secret-token",
			async (url, init) => {
				requestedUrl = String(url);
				requestedInit = init;
				return new Response(null, {
					status: 200,
					headers: { "content-length": "204800" },
				});
			},
		);

		expect(requestedUrl).toBe(MEDIA_URL);
		expect(requestedInit?.method).toBe("HEAD");
		expect(new Headers(requestedInit?.headers).get("authorization")).toBe(
			`Basic ${btoa("AC123:secret-token")}`,
		);
		expect(size).toBe(204_800);
	});

	it("keeps an unknown size unknown rather than guessing one", async () => {
		// No Content-Length, and a compressed response whose length describes the
		// encoded body rather than the media. Both must fail so the caller's
		// fail-closed size validation stays honest.
		const cases: Array<Record<string, string>> = [
			{},
			{ "content-length": "not-a-number" },
			{ "content-length": "204800", "content-encoding": "gzip" },
		];
		for (const headers of cases) {
			expect(
				fetchTwilioMediaSize(
					MEDIA_URL,
					"AC123",
					"secret-token",
					async () => new Response(null, { status: 200, headers }),
				),
			).rejects.toThrow("no usable Content-Length");
		}
	});

	it("refuses to send account credentials to a non-Twilio origin", async () => {
		// The media URL arrives in an unauthenticated webhook body, so a spoofed
		// payload must not be able to redirect the account's basic-auth header.
		for (const url of [
			"https://attacker.example/steal",
			"https://api.twilio.com.attacker.example/steal",
			"http://api.twilio.com/insecure",
		]) {
			expect(
				fetchTwilioMediaSize(url, "AC123", "secret-token", async () => {
					throw new Error("fetcher must not be reached");
				}),
			).rejects.toThrow(/not a Twilio origin|must be HTTPS/);
		}
	});

	it("surfaces a provider error without reflecting the response body", async () => {
		expect(
			fetchTwilioMediaSize(
				MEDIA_URL,
				"AC123",
				"secret-token",
				async () => new Response("provider secret", { status: 401 }),
			),
		).rejects.toThrow("HTTP 401");
	});

	it("requires both halves of the credential pair", async () => {
		expect(
			fetchTwilioMediaSize(MEDIA_URL, "  ", "secret-token", async () => {
				throw new Error("fetcher must not be reached");
			}),
		).rejects.toThrow("Twilio account SID is required");
		expect(
			fetchTwilioMediaSize(MEDIA_URL, "AC123", "  ", async () => {
				throw new Error("fetcher must not be reached");
			}),
		).rejects.toThrow("Twilio auth token is required");
	});
});
