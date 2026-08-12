import { afterEach, describe, expect, it } from "bun:test";
import { PLATFORM_LIMITS } from "../config/platform-limits";
import { beehiivPublisher } from "../publishers/beehiiv";
import { convertkitPublisher } from "../publishers/convertkit";
import { listmonkPublisher } from "../publishers/listmonk";
import { mailchimpPublisher } from "../publishers/mailchimp";
import type { MediaAttachment, PublishRequest } from "../publishers/types";
import { whatsappPublisher } from "../publishers/whatsapp";
import { PLATFORMS, type Platform } from "../schemas/common";
import {
	ConvertKitTargetOptions,
	ListmonkTargetOptions,
	PublisherTargetOptions,
} from "../schemas/publisher-options";
import {
	getPlatformMediaFileLimit,
	PLATFORM_ALLOWED_MEDIA_TYPES,
	resolvePlatformMediaForValidation,
	validatePlatformPostInput,
} from "../services/platform-post-validation";
import { hasEffectivePostPayload } from "../services/post-content-resolution";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function request(
	platform: Platform,
	overrides: Partial<PublishRequest> = {},
): PublishRequest {
	return {
		operation_id: "publisher-option-contract",
		content: "Newsletter body",
		media: [],
		target_options: {},
		account: {
			id: `account-${platform}`,
			platform,
			access_token: "token-us1",
			refresh_token: null,
			platform_account_id:
				platform === "listmonk" ? "https://8.8.8.8" : "provider-account",
			username: "relaytest",
		},
		...overrides,
	};
}

describe("publisher option schemas", () => {
	it("uses official numeric Kit and Listmonk identifiers", () => {
		expect(
			ConvertKitTargetOptions.safeParse({
				email_template_id: 42,
				send_at: "2026-08-10T12:00:00Z",
			}).success,
		).toBe(true);
		expect(ConvertKitTargetOptions.safeParse({ send_at: null }).success).toBe(
			false,
		);
		expect(
			ConvertKitTargetOptions.safeParse({ email_template_id: "42" }).success,
		).toBe(false);
		expect(
			ListmonkTargetOptions.safeParse({ list_id: 7, template_id: 3 }).success,
		).toBe(true);
		expect(ListmonkTargetOptions.safeParse({ list_id: "7" }).success).toBe(
			false,
		);
	});

	it("requires options that adapters cannot safely default", () => {
		expect(PublisherTargetOptions.safeParse({ whatsapp: {} }).success).toBe(
			false,
		);
		expect(
			PublisherTargetOptions.safeParse({
				whatsapp: {
					to: "447700900123",
					media: [{ url: "https://cdn.example.test/audio.ogg", type: "audio" }],
				},
			}).success,
		).toBe(true);
		expect(PublisherTargetOptions.safeParse({ snapchat: {} }).success).toBe(
			false,
		);
		expect(
			PublisherTargetOptions.safeParse({
				tiktok: {
					privacy_level: "SELF_ONLY",
					allow_comment: false,
					brand_content_toggle: false,
					brand_organic_toggle: false,
					content_preview_confirmed: true,
					express_consent_given: true,
				},
			}).success,
		).toBe(true);
		expect(
			validatePlatformPostInput(
				"tiktok",
				"video",
				[{ url: "https://cdn.example.test/video.mp4", type: "video" }],
				{},
			).some((error) => error.code === "VIDEO_INTERACTIONS_REQUIRED"),
		).toBe(true);
	});
});

describe("publisher runtime option semantics", () => {
	it("rejects explicit Kit provider drafts before provider I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("provider I/O must not occur");
		}) as unknown as typeof fetch;

		const result = await convertkitPublisher.publish(
			request("convertkit", { target_options: { send_at: null } }),
		);
		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("PROVIDER_DRAFT_UNSUPPORTED");
		expect(result.error?.message).toContain('scheduled_at: "draft"');
		expect(fetchCalls).toBe(0);
		expect(
			validatePlatformPostInput("convertkit", "body", [], {
				send_at: null,
			}).some((error) => error.code === "PROVIDER_DRAFT_UNSUPPORTED"),
		).toBe(true);
	});

	it("terminalizes an unexpected Kit provider draft during reconciliation", async () => {
		globalThis.fetch = (async () =>
			Response.json({
				broadcast: { id: 42, stats: { status: "draft" } },
			})) as unknown as typeof fetch;

		const result = await convertkitPublisher.reconcile?.({
			account: request("convertkit").account,
			provider_operation_id: "42",
			platform_post_id: "42",
			provider_state: "scheduled",
			effects: [],
		});
		expect(result?.success).toBe(false);
		expect(result?.provider_outcome).toMatchObject({
			disposition: "failed",
			provider_state: "draft",
		});
		expect(result?.error?.code).toBe("PROVIDER_DRAFT_REQUIRES_MANUAL_ACTION");
	});

	it("fails WhatsApp audio captions before provider I/O", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("provider I/O must not occur");
		}) as unknown as typeof fetch;
		const result = await whatsappPublisher.publish(
			request("whatsapp", {
				content: "This caption would be dropped",
				media: [{ url: "https://cdn.example.test/audio.ogg", type: "audio" }],
				target_options: { to: "447700900123" },
			}),
		);
		expect(result.error?.code).toBe("AUDIO_CAPTION_UNSUPPORTED");
		expect(fetchCalls).toBe(0);
	});

	it("renders explicitly typed Beehiiv GIFs into the newsletter HTML", async () => {
		let payload: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_input, init) => {
			payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return Response.json({ data: { id: "post-gif" } });
		}) as typeof fetch;
		const result = await beehiivPublisher.publish(
			request("beehiiv", {
				media: [{ url: "https://cdn.example.test/animation.gif", type: "gif" }],
			}),
		);
		expect(result.success).toBe(true);
		expect(String(payload?.body_content)).toContain(
			"https://cdn.example.test/animation.gif",
		);
	});

	it("rejects invalid compatibility-alias IDs and unsupported newsletter media before fetch", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("provider I/O must not occur");
		}) as unknown as typeof fetch;

		const invalidKit = await convertkitPublisher.publish(
			request("convertkit", {
				target_options: { email_template_id: "42" },
			}),
		);
		expect(invalidKit.error?.code).toBe("INVALID_EMAIL_TEMPLATE_ID");

		const invalidListmonk = await listmonkPublisher.publish(
			request("listmonk", { target_options: { list_id: "7" } }),
		);
		expect(invalidListmonk.error?.code).toBe("INVALID_LISTMONK_ID");

		const media: MediaAttachment[] = [
			{ url: "https://cdn.example.test/image.jpg", type: "image" },
		];
		for (const publisher of [
			convertkitPublisher,
			mailchimpPublisher,
			listmonkPublisher,
		]) {
			const result = await publisher.publish(
				request(publisher.platform, { media }),
			);
			expect(result.error?.code, publisher.platform).toBe(
				"UNSUPPORTED_MEDIA_TYPE",
			);
		}
		expect(fetchCalls).toBe(0);
	});
});

describe("central platform post validation", () => {
	it("runs effective-media preflight before any publisher task can cross the provider boundary", async () => {
		const source = await Bun.file(
			new URL("../services/publisher-runner.ts", import.meta.url),
		).text();
		const effectiveMedia = source.indexOf(
			"const targetMedia = resolvePlatformMediaForValidation",
		);
		const preflight = source.indexOf(
			"const preflightError = validatePlatformPostInput",
			effectiveMedia,
		);
		const taskQueued = source.indexOf("publishTasks.push", preflight);
		const providerCall = source.indexOf("publisher.publish", taskQueued);
		expect(effectiveMedia).toBeGreaterThanOrEqual(0);
		expect(preflight).toBeGreaterThan(effectiveMedia);
		expect(taskQueued).toBeGreaterThan(preflight);
		expect(providerCall).toBeGreaterThan(taskQueued);
	});

	it("allows audio only for WhatsApp for shared and target-override media", () => {
		const audio: MediaAttachment[] = [
			{ url: "https://cdn.example.test/audio.ogg", type: "audio" },
		];
		expect(resolvePlatformMediaForValidation(audio, {})).toEqual(audio);
		expect(resolvePlatformMediaForValidation([], { media: audio })).toEqual(
			audio,
		);
		expect(PLATFORM_ALLOWED_MEDIA_TYPES.whatsapp).toContain("audio");
		for (const platform of PLATFORMS) {
			if (platform === "whatsapp") continue;
			expect(PLATFORM_ALLOWED_MEDIA_TYPES[platform], platform).not.toContain(
				"audio",
			);
			for (const effectiveMedia of [audio, [...audio]]) {
				expect(
					validatePlatformPostInput(
						platform,
						"content",
						effectiveMedia,
						{},
					).some((error) => error.code === "UNSUPPORTED_MEDIA_TYPE"),
					platform,
				).toBe(true);
			}
			expect(
				validatePlatformPostInput(platform, "", [], {
					thread: [{ content: "thread item", media: audio }],
				}).some((error) => error.code === "UNSUPPORTED_MEDIA_TYPE"),
				`${platform} nested thread media`,
			).toBe(true);
		}
		expect(
			validatePlatformPostInput("whatsapp", "", audio, {
				to: "447700900123",
			}),
		).toEqual([]);
		expect(
			validatePlatformPostInput("whatsapp", "caption", audio, {
				to: "447700900123",
			}).some((error) => error.code === "AUDIO_CAPTION_UNSUPPORTED"),
		).toBe(true);
	});

	it("enforces mixed, total, mode-specific, and newsletter limits", () => {
		expect(
			validatePlatformPostInput(
				"facebook",
				"",
				[
					{ url: "https://cdn.example.test/image.jpg", type: "image" },
					{ url: "https://cdn.example.test/video.mp4", type: "video" },
				],
				{},
			).some((error) => error.code === "INVALID_MEDIA_MIX"),
		).toBe(true);
		expect(
			validatePlatformPostInput(
				"snapchat",
				"x".repeat(46),
				[{ url: "https://cdn.example.test/image.jpg", type: "image" }],
				{ content_type: "saved_story" },
			).some((error) => error.code === "CONTENT_TOO_LONG"),
		).toBe(true);
		for (const platform of ["convertkit", "mailchimp", "listmonk"] as const) {
			expect(PLATFORM_LIMITS[platform].media.maxImages).toBe(0);
			expect(
				validatePlatformPostInput(
					platform,
					"body",
					[{ url: "https://cdn.example.test/image.jpg", type: "image" }],
					{},
				).some((error) => error.code === "UNSUPPORTED_MEDIA_TYPE"),
			).toBe(true);
		}
	});

	it("classifies document and audio MIME limits without treating them as images", () => {
		expect(getPlatformMediaFileLimit("linkedin", "application/pdf")).toEqual({
			maxSize: 100 * 1024 * 1024,
			mimeTypeSupported: true,
		});
		expect(getPlatformMediaFileLimit("twitter", "application/pdf")).toEqual({
			maxSize: 0,
			mimeTypeSupported: false,
		});
		expect(getPlatformMediaFileLimit("whatsapp", "audio/ogg")).toEqual({
			maxSize: 16 * 1024 * 1024,
			mimeTypeSupported: true,
		});
	});

	it("recognizes HTML-only newsletter posts as effective payloads", () => {
		expect(
			hasEffectivePostPayload(null, [], {
				convertkit: { content_html: "<p>Hello</p>" },
			}),
		).toBe(true);
	});
});
