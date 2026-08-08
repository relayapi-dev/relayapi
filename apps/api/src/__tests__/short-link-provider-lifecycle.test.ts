import { afterEach, describe, expect, it } from "bun:test";
import { MutationEffectTracker } from "../lib/mutation-effect";
import { SingleUnitProviderMutationAggregate } from "../lib/mutation-provider-boundary";
import { bitlyProvider } from "../services/short-link-providers/bitly";
import { dubProvider } from "../services/short-link-providers/dub";
import { shortIoProvider } from "../services/short-link-providers/short-io";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function providerMutationFixture() {
	const tracker = new MutationEffectTracker();
	tracker.markRouteEntered();
	tracker.markCoverageComplete();
	return {
		tracker,
		mutation: new SingleUnitProviderMutationAggregate(tracker),
	};
}

describe("short-link provider durable identities", () => {
	it("sends Dub the durable local intent as externalId and persists both identities", async () => {
		let requestBody: Record<string, unknown> | null = null;
		globalThis.fetch = (async (_url, init) => {
			requestBody = JSON.parse(String(init?.body));
			return Response.json({
				id: "dub_link_1",
				externalId: "sl_intent_1",
				shortLink: "https://dub.sh/abc",
			});
		}) as typeof fetch;

		const created = await dubProvider.shorten(
			"secret",
			null,
			"https://example.com",
			"sl_intent_1",
		);

		expect(requestBody).toMatchObject({ externalId: "sl_intent_1" });
		expect(created).toEqual({
			shortUrl: "https://dub.sh/abc",
			providerRef: {
				provider: "dub",
				externalId: "sl_intent_1",
				linkId: "dub_link_1",
			},
		});
	});

	it("keeps the request-owned Dub externalId when the provider echoes another value", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				id: "dub_link_2",
				externalId: "unexpected-provider-value",
				shortLink: "https://dub.sh/def",
			})) as unknown as typeof fetch;

		const created = await dubProvider.shorten(
			"secret",
			null,
			"https://example.com",
			"sl_intent_authority",
		);
		expect(created.providerRef).toMatchObject({
			provider: "dub",
			externalId: "sl_intent_authority",
			linkId: "dub_link_2",
		});
	});

	it("classifies external creation before provider response parsing", async () => {
		const accepted = providerMutationFixture();
		globalThis.fetch = (async () =>
			new Response("not-json", { status: 201 })) as unknown as typeof fetch;
		await expect(
			dubProvider.shorten(
				"secret",
				null,
				"https://example.com",
				"sl_accepted",
				accepted.mutation,
			),
		).rejects.toBeDefined();
		expect(accepted.tracker.outcome(1)).toEqual({
			kind: "committed",
			units: 1,
		});

		const rejected = providerMutationFixture();
		globalThis.fetch = (async () =>
			new Response("invalid", { status: 422 })) as unknown as typeof fetch;
		await expect(
			dubProvider.shorten(
				"secret",
				null,
				"https://example.com",
				"sl_rejected",
				rejected.mutation,
			),
		).rejects.toThrow("Dub API error (422)");
		rejected.mutation.finalize();
		expect(rejected.tracker.outcome(1)).toEqual({ kind: "not_applied" });

		for (const fetcher of [
			async () => new Response("unavailable", { status: 503 }),
			async () => {
				throw new Error("connection lost");
			},
		]) {
			const ambiguous = providerMutationFixture();
			globalThis.fetch = fetcher as unknown as typeof fetch;
			await expect(
				dubProvider.shorten(
					"secret",
					null,
					"https://example.com",
					"sl_ambiguous",
					ambiguous.mutation,
				),
			).rejects.toBeDefined();
			ambiguous.mutation.finalize();
			expect(ambiguous.tracker.outcome(1)).toEqual({ kind: "unknown" });
		}
	});

	it("reads Dub analytics through the documented retrieve endpoint", async () => {
		const requests: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return Response.json({ clicks: 9 });
		}) as unknown as typeof fetch;

		const counts = await dubProvider.getClickCounts("secret", [
			{
				key: "sl_dub_analytics",
				shortUrl: "https://dub.sh/abc",
				providerRef: {
					provider: "dub",
					externalId: "sl_intent_analytics",
					linkId: "dub_link_analytics",
				},
			},
		]);
		expect(requests).toEqual([
			"https://api.dub.co/links/info?linkId=dub_link_analytics",
		]);
		expect(counts.get("sl_dub_analytics")).toBe(9);
	});

	it("persists Short.io idString/DomainId and reads statistics without expand", async () => {
		const requests: Array<{
			url: string;
			method: string;
			body: string | null;
		}> = [];
		globalThis.fetch = (async (input, init) => {
			const url = String(input);
			requests.push({
				url,
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? init.body : null,
			});
			if (url === "https://api.short.io/links") {
				return Response.json({
					shortURL: "https://go.example/a",
					idString: "lnk_123",
					DomainId: 42,
				});
			}
			if (url === "https://statistics.short.io/statistics/link/lnk_123") {
				return Response.json({ totalClicks: 17 });
			}
			throw new Error(`Unexpected request ${url}`);
		}) as typeof fetch;

		const created = await shortIoProvider.shorten(
			"secret",
			"go.example",
			"https://example.com",
			"sl_intent_2",
		);
		const counts = await shortIoProvider.getClickCounts("secret", [
			{
				key: "sl_2",
				shortUrl: created.shortUrl,
				providerRef: created.providerRef,
			},
		]);

		expect(created.providerRef).toEqual({
			provider: "short_io",
			intentId: "sl_intent_2",
			idString: "lnk_123",
			domainId: 42,
		});
		expect(requests[0]?.body).toBe(
			JSON.stringify({
				originalURL: "https://example.com",
				domain: "go.example",
				allowDuplicates: true,
			}),
		);
		expect(counts.get("sl_2")).toBe(17);
		expect(requests.some(({ url }) => url.includes("/links/expand"))).toBe(
			false,
		);
		expect(requests.at(-1)).toEqual({
			url: "https://statistics.short.io/statistics/link/lnk_123",
			method: "POST",
			body: JSON.stringify({ period: "total", skipTops: true }),
		});
	});

	it("forces a dedicated Short.io object so erasure cannot delete a reused link", async () => {
		let requestBody: Record<string, unknown> | null = null;
		globalThis.fetch = (async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return Response.json({
				shortURL: "https://go.example/dedicated",
				idString: "lnk_dedicated",
				DomainId: 42,
			});
		}) as typeof fetch;

		await shortIoProvider.shorten(
			"secret",
			"go.example",
			"https://example.com/shared-destination",
			"sl_intent_dedicated",
		);

		expect(JSON.stringify(requestBody)).toBe(
			JSON.stringify({
				originalURL: "https://example.com/shared-destination",
				domain: "go.example",
				allowDuplicates: true,
			}),
		);
	});

	it("routes an edited/custom Bitly link to unsupported without claiming deletion", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;

		const outcome = await bitlyProvider.deleteLink("secret", {
			provider: "bitly",
			intentId: "sl_intent_3",
			bitlink: "bit.ly/custom",
			editedOrCustom: true,
		});

		expect(outcome).toEqual({
			kind: "unsupported",
			reason: "bitly_edited_or_custom_link_cannot_be_deleted",
		});
		expect(calls).toBe(0);
		const cleanupSource = await Bun.file(
			new URL("../services/external-subject-cleanup.ts", import.meta.url),
		).text();
		expect(cleanupSource).toContain("short_link_cleanup_unsupported");
		expect(cleanupSource).toContain("moveClaimToManualReview");
	});

	it("forces a dedicated Bitly object so erasure cannot delete a reused link", async () => {
		let requestBody: Record<string, unknown> | null = null;
		globalThis.fetch = (async (_input, init) => {
			requestBody = JSON.parse(String(init?.body));
			return Response.json({
				id: "bit.ly/abc",
				link: "https://bit.ly/abc",
				custom_bitlinks: [],
			});
		}) as typeof fetch;

		await bitlyProvider.shorten(
			"secret",
			null,
			"https://example.com",
			"sl_bitly_1",
		);
		expect(requestBody).toMatchObject({
			long_url: "https://example.com",
			force_new_link: true,
		});
	});

	it("does not mistake an accepted-but-unconfirmed delete for provider deletion", async () => {
		globalThis.fetch = (async () =>
			new Response(null, { status: 202 })) as unknown as typeof fetch;

		expect(
			await dubProvider.deleteLink("secret", {
				provider: "dub",
				externalId: "sl_dub_delete",
			}),
		).toEqual({
			kind: "unknown",
			reason: "dub_delete_ambiguous_202",
		});
		expect(
			await shortIoProvider.deleteLink("secret", {
				provider: "short_io",
				intentId: "sl_short_io_delete",
				idString: "lnk_delete",
				domainId: 42,
			}),
		).toEqual({
			kind: "unknown",
			reason: "short_io_delete_ambiguous_202",
		});
		expect(
			await bitlyProvider.deleteLink("secret", {
				provider: "bitly",
				intentId: "sl_bitly_delete",
				bitlink: "bit.ly/delete",
				editedOrCustom: false,
			}),
		).toEqual({
			kind: "unknown",
			reason: "bitly_delete_ambiguous_202",
		});
	});
});

describe("short-link connection probes", () => {
	it("uses only documented read-only endpoints", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		globalThis.fetch = (async (input, init) => {
			requests.push({
				url: String(input),
				method: init?.method ?? "GET",
			});
			return Response.json({});
		}) as typeof fetch;

		await dubProvider.probeCredential("dub");
		await shortIoProvider.probeCredential("short");
		await bitlyProvider.probeCredential("bitly");

		expect(requests).toEqual([
			{ url: "https://api.dub.co/links/count", method: "GET" },
			{ url: "https://api.short.io/api/domains?limit=1", method: "GET" },
			{ url: "https://api-ssl.bitly.com/v4/user", method: "GET" },
		]);
	});
});
