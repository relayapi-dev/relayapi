import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchPublicUrl } from "../lib/fetch-public-url";
import {
	classifyPublicUrlWithDns,
	isBlockedUrl,
	isBlockedUrlWithDns,
	isRelayR2PresignedUrl,
} from "../lib/ssrf-guard";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("SSRF address classification", () => {
	it("rejects every non-global IPv4 class", () => {
		const blocked = [
			"0.0.0.0",
			"10.0.0.1",
			"100.64.0.1",
			"100.127.255.255",
			"127.0.0.1",
			"169.254.169.254",
			"172.31.255.255",
			"192.0.0.8",
			"192.0.0.170",
			"192.0.2.1",
			"192.88.99.2",
			"192.168.0.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"239.255.255.255",
			"240.0.0.1",
			"255.255.255.255",
		];

		for (const address of blocked) {
			expect(isBlockedUrl(`http://${address}/`), address).toBe(true);
		}
	});

	it("keeps globally reachable IPv4 boundary values available", () => {
		for (const address of [
			"8.8.8.8",
			"93.184.216.34",
			"100.128.0.1",
			"192.0.0.9",
			"192.0.0.10",
			"223.255.255.254",
		]) {
			expect(isBlockedUrl(`https://${address}/`), address).toBe(false);
		}
	});

	it("rejects non-global and transition IPv6 space", () => {
		const blocked = [
			"::",
			"::1",
			"::ffff:7f00:1",
			"64:ff9b::7f00:1",
			"64:ff9b:1::1",
			"100::1",
			"100:0:0:1::1",
			"2001::1",
			"2001:2::1",
			"2001:db8::1",
			"2002::1",
			"3fff::1",
			"5f00::1",
			"fc00::1",
			"fdff::1",
			"fe80::1",
			"fec0::1",
			"ff02::1",
		];

		for (const address of blocked) {
			expect(isBlockedUrl(`https://[${address}]/`), address).toBe(true);
		}
	});

	it("allows globally reachable IPv6 addresses", () => {
		for (const address of [
			"2606:4700:4700::1111",
			"2a00:1450:4009:80b::200e",
			"64:ff9b::5db8:d822",
			"2001:1::1",
			"2001:3::1",
			"2001:4:112::1",
			"2001:20::1",
			"2001:30::1",
		]) {
			expect(isBlockedUrl(`https://[${address}]/`), address).toBe(false);
		}
	});

	it("rejects alternate numeric encodings and local names after URL normalization", () => {
		for (const url of [
			"http://2130706433/",
			"http://0177.0.0.1/",
			"http://0x7f000001/",
			"http://localhost/",
			"http://api.localhost/",
			"http://metadata.google.internal/computeMetadata/v1/",
		]) {
			expect(isBlockedUrl(url), url).toBe(true);
		}
	});
});

function publicDnsResponse(input: RequestInfo | URL): Response {
	const requestUrl = new URL(String(input));
	return requestUrl.searchParams.get("type") === "AAAA"
		? Response.json({
				Status: 0,
				Answer: [{ type: 28, data: "2606:4700:4700::1111" }],
			})
		: Response.json({
				Status: 0,
				Answer: [{ type: 1, data: "93.184.216.34" }],
			});
}

describe("SSRF DNS validation", () => {
	const relayPresign =
		"https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/relayapi-media/org_1/media.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=credential&X-Amz-Date=20260713T000000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=signature";

	it("recognizes only the exact HTTPS Relay R2 presign shape", () => {
		expect(isRelayR2PresignedUrl(relayPresign)).toBe(true);
		expect(isRelayR2PresignedUrl(relayPresign.replace("https:", "http:"))).toBe(
			false,
		);
		expect(
			isRelayR2PresignedUrl(
				relayPresign.replace("/relayapi-media/", "/foreign-bucket/"),
			),
		).toBe(false);
		expect(
			isRelayR2PresignedUrl(
				relayPresign.replace(
					".r2.cloudflarestorage.com",
					".r2.cloudflarestorage.com.attacker.example",
				),
			),
		).toBe(false);
	});

	it("skips DoH only for a fixed-service Relay R2 presign", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return new Response("media", {
				headers: { "content-length": "5" },
			});
		}) as unknown as typeof fetch;

		const response = await fetchPublicUrl(relayPresign);
		expect(await response.text()).toBe("media");
		expect(fetchCalls).toBe(1);
	});

	it("rejects any non-global address in a hostname's current DNS answers", async () => {
		globalThis.fetch = mock(async (input) => {
			const requestUrl = new URL(String(input));
			return requestUrl.searchParams.get("type") === "AAAA"
				? Response.json({ Status: 0, Answer: [] })
				: Response.json({
						Status: 0,
						Answer: [
							{ type: 1, data: "93.184.216.34" },
							{ type: 1, data: "100.64.0.1" },
						],
					});
		}) as unknown as typeof fetch;

		expect(await isBlockedUrlWithDns("https://mixed.example/")).toBe(true);
	});

	it("rejects non-global IPv6 DNS answers", async () => {
		globalThis.fetch = mock(async (input) => {
			const requestUrl = new URL(String(input));
			return requestUrl.searchParams.get("type") === "AAAA"
				? Response.json({
						Status: 0,
						Answer: [{ type: 28, data: "2001:db8::1" }],
					})
				: Response.json({ Status: 0, Answer: [] });
		}) as unknown as typeof fetch;

		expect(await isBlockedUrlWithDns("https://ipv6-private.example/")).toBe(
			true,
		);
	});

	it("fails closed when DNS has no addresses or both resolvers fail", async () => {
		globalThis.fetch = mock(async () =>
			Response.json({ Status: 0, Answer: [] }),
		) as unknown as typeof fetch;
		expect(await isBlockedUrlWithDns("https://empty.example/")).toBe(true);
		expect(await classifyPublicUrlWithDns("https://empty.example/")).toBe(
			"indeterminate",
		);

		globalThis.fetch = mock(async () => {
			throw new Error("resolver unavailable");
		}) as unknown as typeof fetch;
		expect(await isBlockedUrlWithDns("https://dns-failure.example/")).toBe(
			true,
		);
		expect(await classifyPublicUrlWithDns("https://dns-failure.example/")).toBe(
			"indeterminate",
		);
	});

	it("does not reuse an allowed DNS result across requests", async () => {
		let dnsCalls = 0;
		globalThis.fetch = mock(async (input) => {
			dnsCalls++;
			return publicDnsResponse(input);
		}) as unknown as typeof fetch;

		expect(await isBlockedUrlWithDns("https://fresh-dns.example/")).toBe(false);
		expect(await isBlockedUrlWithDns("https://fresh-dns.example/")).toBe(false);
		expect(dnsCalls).toBe(4);
	});

	it("prevents fetch from following an unchecked redirect", async () => {
		let outboundRedirect: RequestRedirect | undefined;
		globalThis.fetch = mock(async (input, init) => {
			const requestUrl = new URL(String(input));
			if (
				requestUrl.hostname === "dns.google" ||
				requestUrl.hostname === "cloudflare-dns.com"
			) {
				return publicDnsResponse(input);
			}
			outboundRedirect = init?.redirect;
			return new Response("ok");
		}) as unknown as typeof fetch;

		const response = await fetchPublicUrl("https://redirecting.example/", {
			redirect: "follow",
		});

		expect(response.status).toBe(200);
		expect(outboundRedirect).toBe("error");
	});
});
