import { describe, expect, it } from "bun:test";
import {
	hasEffectivePostPayload,
	injectPostSignature,
	injectSignatureIntoTargetOptions,
	mergePostTargetOptions,
	renderPostTemplate,
	renderPostTemplateOverrides,
	resolvePostTargetOptions,
	resolveTemplateAccountName,
} from "../services/post-content-resolution";

describe("post content resolution", () => {
	it("resolves account_name for a single selected account", () => {
		const name = resolveTemplateAccountName([
			{
				accounts: [
					{ id: "acc_1", username: "relay", display_name: "Relay Team" },
				],
			},
		]);

		expect(name).toBe("Relay Team");
		expect(
			renderPostTemplate(
				"Hello {{account_name}} on {{date}} — {{campaign}}",
				{ campaign: "launch" },
				name,
				new Date("2026-08-08T12:00:00.000Z"),
			),
		).toEqual({
			ok: true,
			content: "Hello Relay Team on 2026-08-08 — launch",
		});
	});

	it("rejects an ambiguous account_name instead of choosing the first account", () => {
		const name = resolveTemplateAccountName([
			{
				accounts: [
					{ id: "acc_1", username: "one", display_name: "One" },
					{ id: "acc_2", username: "two", display_name: "Two" },
				],
			},
		]);

		expect(name).toBeNull();
		expect(
			renderPostTemplate("Hello {{account_name}}", undefined, name),
		).toEqual({
			ok: false,
			code: "TEMPLATE_VARIABLE_UNRESOLVED",
			variable: "account_name",
		});
	});

	it("allows an explicit account_name for an intentionally shared post", () => {
		expect(
			renderPostTemplate(
				"Hello {{account_name}}",
				{ account_name: "All channels" },
				null,
			),
		).toEqual({ ok: true, content: "Hello All channels" });
	});

	it("inserts replacement-token characters literally", () => {
		expect(
			renderPostTemplate(
				"Hello {{account_name}} — {{note}}",
				{ note: "$& and $` and $'" },
				"$& Account",
				new Date("2026-08-08T00:00:00.000Z"),
			),
		).toEqual({
			ok: true,
			content: "Hello $& Account — $& and $` and $'",
		});
	});

	it("renders platform overrides and lets explicit target options win", () => {
		const rendered = renderPostTemplateOverrides(
			{
				twitter: "{{product}} on {{date}}",
				linkedin: "Hello {{account_name}} — {{product}}",
			},
			{ product: "$& launch" },
			"Relay Team",
			new Date("2026-08-08T12:00:00.000Z"),
		);
		expect(rendered).toEqual({
			ok: true,
			overrides: {
				twitter: "$& launch on 2026-08-08",
				linkedin: "Hello Relay Team — $& launch",
			},
		});
		expect(
			mergePostTargetOptions(
				{
					twitter: { content: "template text" },
					linkedin: { content: "LinkedIn template" },
				},
				{
					twitter: { content: "request text", reply_settings: "following" },
				},
			),
		).toEqual({
			twitter: { content: "request text", reply_settings: "following" },
			linkedin: { content: "LinkedIn template" },
		});
		expect(
			resolvePostTargetOptions(
				{
					twitter: { content: "platform template", reply_settings: "all" },
					ws_marketing: { content: "workspace request" },
				},
				"twitter",
				"ws_marketing",
			),
		).toEqual({ content: "workspace request", reply_settings: "all" });
	});

	it("reports the platform whose override cannot resolve account_name", () => {
		expect(
			renderPostTemplateOverrides(
				{ twitter: "Hello {{account_name}}" },
				undefined,
				null,
			),
		).toEqual({
			ok: false,
			code: "TEMPLATE_VARIABLE_UNRESOLVED",
			variable: "account_name",
			platform: "twitter",
		});
	});

	it("injects the default signature into shared and per-target text", () => {
		const signature = { content: "— Relay", position: "append" };
		expect(injectPostSignature("Shared", signature)).toBe(
			"Shared\n\n— Relay",
		);
		expect(
			injectSignatureIntoTargetOptions(
				{
					twitter: { content: "Short", reply_settings: "all" },
					instagram: { media: [{ url: "https://example.com/image.jpg" }] },
				},
				signature,
			),
		).toEqual({
			twitter: {
				content: "Short\n\n— Relay",
				reply_settings: "all",
			},
			instagram: { media: [{ url: "https://example.com/image.jpg" }] },
		});
		expect(
			injectPostSignature("Shared", {
				content: "Relay —",
				position: "prepend",
			}),
		).toBe("Relay —\n\nShared");
	});

	it("requires effective shared, media, or per-target content", () => {
		expect(hasEffectivePostPayload(null, undefined, undefined)).toBe(false);
		expect(hasEffectivePostPayload("   ", [], { twitter: {} })).toBe(false);
		expect(
			hasEffectivePostPayload(null, [], {
				twitter: { content: "target text" },
			}),
		).toBe(true);
		expect(hasEffectivePostPayload(null, [{ url: "media" }], undefined)).toBe(
			true,
		);
	});

	it("accepts per-target payloads a publisher can send without shared content", () => {
		// Each of these is published entirely from target_options by at least one
		// publisher, with no shared content or shared media involved.
		const publishable: Array<Record<string, unknown>> = [
			{ thread: [{ content: "1/" }, { content: "2/" }] },
			{ media: [{ url: "https://example.com/image.jpg" }] },
			{ embeds: [{ title: "Release" }] },
			{ content_html: "<p>Newsletter</p>", subject: "Issue 1" },
			{ template_name: "order_update" },
			{ interactive: { type: "button" } },
			{ location: { latitude: 1, longitude: 2 } },
			{ reaction: { emoji: "👍" } },
			{ contacts: [{ name: "Relay" }] },
			{ url: "https://example.com/post", title: "Link post" },
		];
		for (const options of publishable) {
			expect(hasEffectivePostPayload(null, [], { twitter: options })).toBe(
				true,
			);
		}
	});

	it("does not treat config-only target options as content", () => {
		const configOnly: Array<Record<string, unknown>> = [
			{ reply_to: "123", reply_settings: "following" },
			{ subreddit: "relay", flair_id: "abc", nsfw: false },
			{ privacy_level: "PUBLIC_TO_EVERYONE" },
			{ visibility: "public", spoiler_text: "" },
			{ thread: [] },
			{ media: [] },
			{ content: "   " },
		];
		for (const options of configOnly) {
			expect(hasEffectivePostPayload(null, [], { twitter: options })).toBe(
				false,
			);
		}
	});

	it("skips overrides for platforms the post does not target", () => {
		// An unresolvable variable in an override that will never be applied must
		// not fail the whole create.
		expect(
			renderPostTemplateOverrides(
				{
					twitter: "Hello there",
					pinterest: "Hello {{account_name}}",
				},
				undefined,
				null,
				new Date("2026-08-08T12:00:00.000Z"),
				new Set(["twitter"]),
			),
		).toEqual({ ok: true, overrides: { twitter: "Hello there" } });
	});
});
