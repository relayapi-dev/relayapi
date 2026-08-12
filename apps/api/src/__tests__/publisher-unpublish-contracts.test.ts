import { afterEach, describe, expect, it } from "bun:test";
import { deleteBlueskyPost } from "../publishers/bluesky";
import type { PublishRequest } from "../publishers/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function blueskyAccount(): PublishRequest["account"] {
	return {
		id: "acc_bluesky",
		platform: "bluesky",
		access_token: "app-password",
		refresh_token: null,
		platform_account_id: "did:plc:relaytest",
		username: "relay.test",
		metadata: { pds_url: "https://8.8.8.8" },
	};
}

describe("official unpublish contracts", () => {
	it("deletes a Bluesky record only from the connected DID and PDS", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/com.atproto.server.createSession")) {
				return Response.json({
					did: "did:plc:relaytest",
					accessJwt: "access-jwt",
					refreshJwt: "refresh-jwt",
					handle: "relay.test",
				});
			}
			return Response.json({});
		}) as unknown as typeof fetch;

		const response = await deleteBlueskyPost(
			blueskyAccount(),
			"at://did:plc:relaytest/app.bsky.feed.post/3kexample",
		);

		expect(response.ok).toBe(true);
		expect(calls.map((call) => call.url)).toEqual([
			"https://8.8.8.8/xrpc/com.atproto.server.createSession",
			"https://8.8.8.8/xrpc/com.atproto.repo.deleteRecord",
		]);
		expect(calls[1]?.init?.method).toBe("POST");
		expect(calls[1]?.init?.redirect).toBe("error");
		expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
			repo: "did:plc:relaytest",
			collection: "app.bsky.feed.post",
			rkey: "3kexample",
		});
	});

	it("rejects a Bluesky URI for another repository before network I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		expect(
			deleteBlueskyPost(
				blueskyAccount(),
				"at://did:plc:another/app.bsky.feed.post/3kexample",
			),
		).rejects.toMatchObject({ code: "CONTENT_ERROR" });
		expect(fetchCalls).toBe(0);
	});
});
