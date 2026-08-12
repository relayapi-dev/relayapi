import { afterEach, describe, expect, it } from "bun:test";
import { blueskyPublisher } from "../publishers/bluesky";
import { facebookPublisher } from "../publishers/facebook";
import { instagramPublisher } from "../publishers/instagram";
import { linkedinPublisher } from "../publishers/linkedin";
import { listmonkPublisher } from "../publishers/listmonk";
import { mailchimpPublisher } from "../publishers/mailchimp";
import { smsPublisher } from "../publishers/sms";
import { threadsPublisher } from "../publishers/threads";
import { twitterPublisher } from "../publishers/twitter";
import {
	mergeProviderEffects,
	type ProviderEffect,
	type PublishEffectRecorder,
	type PublishRequest,
} from "../publishers/types";
import { youtubePublisher } from "../publishers/youtube";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function durableRecorder(initial: ProviderEffect[] = []): {
	effectRecorder: PublishEffectRecorder;
	effects: () => ProviderEffect[];
	recorded: ProviderEffect[];
} {
	let effects = mergeProviderEffects(initial);
	const recorded: ProviderEffect[] = [];
	return {
		effectRecorder: {
			get effects() {
				return effects;
			},
			async record(effect) {
				recorded.push(effect);
				effects = mergeProviderEffects(effects, [effect]);
			},
		},
		effects: () => effects,
		recorded,
	};
}

function request(
	platform: PublishRequest["account"]["platform"],
	overrides: Partial<PublishRequest> = {},
): PublishRequest {
	return {
		operation_id: `durability-${platform}`,
		content: "hello",
		media: [],
		target_options: {},
		account: {
			id: `account-${platform}`,
			platform,
			access_token: "token",
			refresh_token: null,
			platform_account_id: "user-123",
			username: "relaytest",
		},
		...overrides,
	};
}

describe("publisher effect durability", () => {
	it("resumes YouTube from its confirmed uploaded video ID", async () => {
		const journal = durableRecorder([
			{
				name: "video_upload",
				status: "succeeded",
				provider_id: "youtube-video-1",
			},
		]);
		globalThis.fetch = (async () => {
			throw new Error("a confirmed YouTube upload must not be repeated");
		}) as unknown as typeof fetch;

		const result = await youtubePublisher.publish(
			request("youtube", {
				effect_recorder: journal.effectRecorder,
				media: [{ url: "https://cdn.example.test/video.mp4", type: "video" }],
			}),
		);

		expect(result.success).toBe(true);
		expect(result.platform_post_id).toBe("youtube-video-1");
		expect(result.provider_outcome?.effects).toEqual(journal.effects());
		expect(journal.recorded).toEqual([]);
	});

	it("resumes an SMS fan-out without resending confirmed recipients", async () => {
		const journal = durableRecorder([
			{
				name: "recipient_1",
				status: "succeeded",
				provider_id: "SMfirst",
			},
		]);
		const recipients: string[] = [];
		globalThis.fetch = (async (_input, init) => {
			const body = new URLSearchParams(String(init?.body));
			recipients.push(body.get("To") ?? "");
			return Response.json({ sid: "SMsecond", status: "queued" });
		}) as typeof fetch;

		const result = await smsPublisher.publish({
			...request("sms", {
				effect_recorder: journal.effectRecorder,
				target_options: {
					phone_numbers: ["+15550000001", "+15550000002"],
				},
			}),
			account: {
				...request("sms").account,
				platform_account_id: "AC_test_account_sid",
				metadata: { from_number: "+15559999999" },
			},
		});

		expect(result.success).toBe(true);
		expect(recipients).toEqual(["+15550000002"]);
		expect(journal.recorded).toEqual([
			{
				name: "recipient_2",
				status: "succeeded",
				provider_id: "SMsecond",
			},
		]);
		expect(result.provider_outcome?.effects).toEqual(journal.effects());
	});

	it("resumes an X thread from its last confirmed item", async () => {
		const journal = durableRecorder([
			{
				name: "thread_item_1",
				status: "succeeded",
				provider_id: "tweet-root",
			},
		]);
		const bodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			return Response.json({ data: { id: "tweet-second" } });
		}) as typeof fetch;

		const result = await twitterPublisher.publish(
			request("twitter", {
				effect_recorder: journal.effectRecorder,
				target_options: {
					thread: [{ content: "first" }, { content: "second" }],
				},
			}),
		);

		expect(result.success).toBe(true);
		expect(result.platform_post_id).toBe("tweet-root");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			text: "second",
			reply: { in_reply_to_tweet_id: "tweet-root" },
		});
		expect(journal.recorded).toEqual([
			{
				name: "thread_item_2",
				status: "succeeded",
				provider_id: "tweet-second",
			},
		]);
		expect(result.provider_outcome?.effects).toEqual(journal.effects());
	});

	it("resumes a Threads sequence without recreating its root", async () => {
		const journal = durableRecorder([
			{
				name: "thread_item_1",
				status: "succeeded",
				provider_id: "threads-root",
			},
		]);
		const mutations: Array<{ path: string; body: URLSearchParams }> = [];
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			if (init?.method === "POST") {
				mutations.push({
					path: url.pathname,
					body: new URLSearchParams(String(init.body)),
				});
			}
			if (url.pathname.endsWith("/user-123/threads")) {
				return Response.json({ id: "container-second" });
			}
			if (url.pathname.endsWith("/container-second")) {
				return Response.json({ status: "FINISHED" });
			}
			if (url.pathname.endsWith("/user-123/threads_publish")) {
				return Response.json({ id: "threads-second" });
			}
			if (url.pathname.endsWith("/threads-second")) {
				return Response.json({
					id: "threads-second",
					permalink: "https://www.threads.net/@relaytest/post/second",
				});
			}
			throw new Error(`Unexpected Threads request: ${url}`);
		}) as typeof fetch;

		const result = await threadsPublisher.publish(
			request("threads", {
				effect_recorder: journal.effectRecorder,
				target_options: {
					thread: [{ content: "first" }, { content: "second" }],
				},
			}),
		);

		expect(result.success).toBe(true);
		expect(result.platform_post_id).toBe("threads-root");
		expect(mutations).toHaveLength(2);
		expect(mutations[0]?.body.get("reply_to_id")).toBe("threads-root");
		expect(journal.recorded).toEqual([
			{
				name: "thread_item_2",
				status: "succeeded",
				provider_id: "threads-second",
			},
		]);
		expect(result.provider_outcome?.effects).toEqual(journal.effects());
	});

	it("recovers the Bluesky strong reference before adding a reply", async () => {
		const did = "did:plc:abcdefghijklmnopqrstuvwxyz";
		const rootUri = `at://${did}/app.bsky.feed.post/root`;
		const secondUri = `at://${did}/app.bsky.feed.post/second`;
		const journal = durableRecorder([
			{
				name: "thread_item_1",
				status: "succeeded",
				provider_id: rootUri,
			},
		]);
		const createdRecords: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/com.atproto.server.createSession")) {
				return Response.json({
					did,
					handle: "relay.test",
					accessJwt: "jwt",
					refreshJwt: "refresh",
				});
			}
			if (url.pathname.endsWith("/com.atproto.repo.getRecord")) {
				return Response.json({ uri: rootUri, cid: "cid-root" });
			}
			if (url.pathname.endsWith("/com.atproto.repo.createRecord")) {
				const body = JSON.parse(String(init?.body)) as {
					record: Record<string, unknown>;
				};
				createdRecords.push(body.record);
				return Response.json({ uri: secondUri, cid: "cid-second" });
			}
			throw new Error(`Unexpected Bluesky request: ${url}`);
		}) as typeof fetch;

		const result = await blueskyPublisher.publish({
			...request("bluesky", {
				effect_recorder: journal.effectRecorder,
				target_options: {
					thread: [{ content: "first" }, { content: "second" }],
				},
			}),
			account: {
				...request("bluesky").account,
				platform_account_id: did,
				metadata: { pds_url: "https://8.8.8.8" },
			},
		});

		expect(result.success).toBe(true);
		expect(result.platform_post_id).toBe(rootUri);
		expect(createdRecords).toHaveLength(1);
		expect(createdRecords[0]?.reply).toEqual({
			root: { uri: rootUri, cid: "cid-root" },
			parent: { uri: rootUri, cid: "cid-root" },
		});
		expect(journal.recorded).toEqual([
			{
				name: "thread_item_2",
				status: "succeeded",
				provider_id: secondUri,
			},
		]);
	});

	it("resumes Instagram from a confirmed media container and then becomes replay-safe", async () => {
		const journal = durableRecorder([
			{
				name: "media_container",
				status: "succeeded",
				provider_id: "container-1",
			},
		]);
		const mutations: string[] = [];
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			if (init?.method === "POST") mutations.push(url.pathname);
			if (url.pathname.endsWith("/container-1")) {
				return Response.json({ status_code: "FINISHED" });
			}
			if (url.pathname.endsWith("/user-123/media_publish")) {
				return Response.json({ id: "instagram-post" });
			}
			if (url.pathname.endsWith("/instagram-post")) {
				return Response.json({
					permalink: "https://www.instagram.com/p/instagram-post/",
				});
			}
			throw new Error(`Unexpected Instagram request: ${url}`);
		}) as typeof fetch;

		const publishRequest = request("instagram", {
			effect_recorder: journal.effectRecorder,
			media: [{ url: "https://cdn.example.test/image.jpg", type: "image" }],
		});
		const first = await instagramPublisher.publish(publishRequest);
		const second = await instagramPublisher.publish(publishRequest);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(mutations).toEqual([expect.stringContaining("/media_publish")]);
		expect(journal.recorded).toEqual([
			{
				name: "post_published",
				status: "succeeded",
				provider_id: "instagram-post",
			},
		]);
	});

	it("resumes a Facebook multi-image post without restaging confirmed photos", async () => {
		const journal = durableRecorder([
			{
				name: "staged_photo_1",
				status: "succeeded",
				provider_id: "photo-first",
			},
		]);
		const mutations: Array<{ path: string; body: string }> = [];
		globalThis.fetch = (async (input, init) => {
			const url = new URL(String(input));
			mutations.push({ path: url.pathname, body: String(init?.body) });
			if (url.pathname.endsWith("/user-123/photos")) {
				return Response.json({ id: "photo-second" });
			}
			if (url.pathname.endsWith("/user-123/feed")) {
				return Response.json({ id: "user-123_post-1" });
			}
			throw new Error(`Unexpected Facebook request: ${url}`);
		}) as typeof fetch;

		const publishRequest = request("facebook", {
			effect_recorder: journal.effectRecorder,
			media: [
				{ url: "https://cdn.example.test/first.jpg", type: "image" },
				{ url: "https://cdn.example.test/second.jpg", type: "image" },
			],
		});
		const first = await facebookPublisher.publish(publishRequest);
		const second = await facebookPublisher.publish(publishRequest);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(mutations).toHaveLength(2);
		expect(JSON.parse(mutations[0]?.body ?? "{}")).toMatchObject({
			url: "https://cdn.example.test/second.jpg",
			published: false,
		});
		const feedBody = new URLSearchParams(mutations[1]?.body);
		expect(feedBody.get("attached_media[0]")).toContain("photo-first");
		expect(feedBody.get("attached_media[1]")).toContain("photo-second");
		expect(journal.recorded.map((effect) => effect.name)).toEqual([
			"staged_photo_2",
			"post_published",
		]);
	});

	it("resumes LinkedIn from a confirmed asset and journals the post and comment", async () => {
		const imageUrn = "urn:li:image:asset-1";
		const postUrn = "urn:li:share:123456789";
		const journal = durableRecorder([
			{
				name: "media_asset_1",
				status: "succeeded",
				provider_id: imageUrn,
			},
		]);
		const calls: Array<{
			url: string;
			method: string | undefined;
			body: Record<string, unknown>;
		}> = [];
		globalThis.fetch = (async (input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			calls.push({ url: String(input), method: init?.method, body });
			if (String(input).endsWith("/rest/posts")) {
				return new Response(null, {
					status: 201,
					headers: { "x-restli-id": postUrn },
				});
			}
			if (String(input).includes("/comments")) {
				return Response.json(
					{ id: "urn:li:comment:(urn:li:activity:123,456)" },
					{ status: 201 },
				);
			}
			throw new Error(`Unexpected LinkedIn request: ${input}`);
		}) as typeof fetch;

		const publishRequest = request("linkedin", {
			effect_recorder: journal.effectRecorder,
			media: [{ url: "https://cdn.example.test/image.jpg", type: "image" }],
			target_options: { first_comment: "First!" },
		});
		const first = await linkedinPublisher.publish(publishRequest);
		const second = await linkedinPublisher.publish(publishRequest);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(first.platform_post_id).toBe(postUrn);
		expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
		expect(calls[0]?.url).toEndWith("/rest/posts");
		expect(calls[0]?.body.content).toEqual({ media: { id: imageUrn } });
		expect(calls[1]?.url).toContain(
			`/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
		);
		expect(journal.recorded.map((effect) => effect.name)).toEqual([
			"post_published",
			"first_comment",
		]);
		expect(second.provider_outcome?.effects).toEqual(journal.effects());
	});

	it("reconciles a journaled LinkedIn post without requiring extra read scopes", async () => {
		const postUrn = "urn:li:ugcPost:987654321";
		const effects: ProviderEffect[] = [
			{
				name: "post_published",
				status: "succeeded",
				provider_id: postUrn,
			},
		];
		globalThis.fetch = (async () => {
			throw new Error("durable confirmation must not require provider I/O");
		}) as unknown as typeof fetch;

		const result = await linkedinPublisher.reconcile?.({
			account: request("linkedin").account,
			provider_operation_id: null,
			platform_post_id: null,
			provider_state: null,
			effects,
		});

		expect(result?.success).toBe(true);
		expect(result?.platform_post_id).toBe(postUrn);
		expect(result?.provider_outcome?.disposition).toBe("published");
		expect(result?.provider_outcome?.effects).toEqual(effects);
	});

	it("uses a read-only LinkedIn Posts lookup for a legacy unjournaled post ID", async () => {
		const postUrn = "urn:li:ugcPost:987654321";
		const calls: Array<{ url: string; method: string | undefined }> = [];
		globalThis.fetch = (async (input, init) => {
			calls.push({ url: String(input), method: init?.method });
			return Response.json({
				id: postUrn,
				author: "user-123",
				lifecycleState: "PUBLISHED",
			});
		}) as typeof fetch;

		const result = await linkedinPublisher.reconcile?.({
			account: request("linkedin").account,
			provider_operation_id: null,
			platform_post_id: postUrn,
			provider_state: null,
			effects: [],
		});

		expect(result?.success).toBe(true);
		expect(result?.provider_outcome?.disposition).toBe("published");
		expect(calls).toEqual([
			{
				url: `https://api.linkedin.com/rest/posts/${encodeURIComponent(postUrn)}?viewContext=AUTHOR`,
				method: "GET",
			},
		]);
	});

	it("does not restart a Facebook upload whose one-time upload URL was lost", async () => {
		const journal = durableRecorder([
			{
				name: "video_upload_started",
				status: "succeeded",
				provider_id: "video-1",
			},
		]);
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("unexpected fetch");
		}) as unknown as typeof fetch;

		const result = await facebookPublisher.publish(
			request("facebook", {
				effect_recorder: journal.effectRecorder,
				media: [{ url: "https://cdn.example.test/video.mp4", type: "video" }],
				target_options: { content_type: "reel" },
			}),
		);

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("PUBLISH_OUTCOME_UNKNOWN");
		expect(fetchCalls).toBe(0);
	});

	it("resumes Mailchimp at send and skips all mutations after acceptance", async () => {
		const journal = durableRecorder([
			{
				name: "campaign_created",
				status: "succeeded",
				provider_id: "campaign-1",
			},
			{
				name: "content_set",
				status: "succeeded",
				provider_id: "campaign-1",
			},
		]);
		const requests: string[] = [];
		globalThis.fetch = (async (input) => {
			requests.push(String(input));
			return new Response(null, { status: 204 });
		}) as typeof fetch;

		const publishRequest = {
			...request("mailchimp", {
				effect_recorder: journal.effectRecorder,
				target_options: {
					from_email: "sender@example.test",
					list_id: "list-1",
				},
			}),
			account: {
				...request("mailchimp").account,
				access_token: `${"0123456789abcdef"}-us21`,
			},
		};
		const first = await mailchimpPublisher.publish(publishRequest);
		const second = await mailchimpPublisher.publish(publishRequest);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toEndWith("/3.0/campaigns/campaign-1/actions/send");
		expect(journal.recorded).toEqual([
			{
				name: "send_or_schedule",
				status: "succeeded",
				provider_id: "campaign-1",
			},
		]);
	});

	it("resumes Listmonk at the status transition and never recreates the campaign", async () => {
		const journal = durableRecorder([
			{
				name: "campaign_created",
				status: "succeeded",
				provider_id: "7",
			},
		]);
		const requests: Array<{ url: string; method: string | undefined }> = [];
		globalThis.fetch = (async (input, init) => {
			requests.push({ url: String(input), method: init?.method });
			return Response.json({});
		}) as typeof fetch;

		const publishRequest = {
			...request("listmonk", {
				effect_recorder: journal.effectRecorder,
				target_options: { list_id: 1 },
			}),
			account: {
				...request("listmonk").account,
				access_token: "base64-credentials",
				platform_account_id: "https://8.8.8.8",
			},
		};
		const first = await listmonkPublisher.publish(publishRequest);
		const second = await listmonkPublisher.publish(publishRequest);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(requests).toEqual([
			{ url: "https://8.8.8.8/api/campaigns/7/status", method: "PUT" },
		]);
		expect(journal.recorded).toEqual([
			{
				name: "start_or_schedule",
				status: "succeeded",
				provider_id: "7",
			},
		]);
	});
});
