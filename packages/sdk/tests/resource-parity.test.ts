import { describe, expect, it } from "bun:test";
import Relay from "../src";

const API_KEY = ["rlay", "test", "resource-parity"].join("_");

describe("hand-written resource parity", () => {
	it("maps the inbox AI and feed methods to their API routes", async () => {
		const requests: Array<{ method: string; url: string }> = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input, init) => {
				requests.push({ method: init?.method ?? "GET", url: String(input) });
				return Response.json({});
			},
		});

		await client.inbox.classify({ messages: [{ text: "hello" }] });
		await client.inbox.suggestReply({ conversation_id: "conv_1" });
		await client.inbox.summarize({ conversation_id: "conv_1" });
		await client.inbox.priorities({ limit: 10 });
		await client.inbox.search({ q: "refund" });
		await client.inbox.stats({ platform: "instagram" });

		expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
			"POST /v1/inbox/classify",
			"POST /v1/inbox/suggest-reply",
			"POST /v1/inbox/summarize",
			"GET /v1/inbox/priorities",
			"GET /v1/inbox/search",
			"GET /v1/inbox/stats",
		]);
	});

	it("maps every downloader, transcript, resolver, and job poll route", async () => {
		const paths: string[] = [];
		const client = new Relay({
			apiKey: API_KEY,
			baseURL: "https://api.example.test",
			maxRetries: 0,
			fetch: async (input) => {
				paths.push(new URL(String(input)).pathname);
				return Response.json({});
			},
		});
		const body = { url: "https://example.test/content" };

		await client.tools.resolveLinkedInMention({
			account_id: "acc_1",
			type: "organization",
			vanity_name: "relay",
		});
		await client.tools.downloadYoutube(body);
		await client.tools.downloadTiktok(body);
		await client.tools.downloadInstagram(body);
		await client.tools.downloadTwitter(body);
		await client.tools.downloadFacebook(body);
		await client.tools.downloadLinkedin(body);
		await client.tools.downloadBluesky(body);
		await client.tools.getYoutubeTranscript({ url: "video-id" });
		await client.tools.getJobStatus("tj_1");

		expect(paths).toEqual([
			"/v1/tools/linkedin/resolve-mention",
			"/v1/tools/youtube/download",
			"/v1/tools/tiktok/download",
			"/v1/tools/instagram/download",
			"/v1/tools/twitter/download",
			"/v1/tools/facebook/download",
			"/v1/tools/linkedin/download",
			"/v1/tools/bluesky/download",
			"/v1/tools/youtube/transcript",
			"/v1/tools/jobs/tj_1",
		]);
	});

	it("does not expose API routes that do not exist", () => {
		const client = new Relay({ apiKey: API_KEY });
		expect("groups" in client.whatsapp).toBe(false);
	});
});
