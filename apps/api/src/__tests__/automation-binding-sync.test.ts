import { describe, expect, it } from "bun:test";
import {
	getBindingConfigChannelError,
	isBindingTypeSupportedOnChannel,
} from "../schemas/automation-bindings";
import {
	buildMetaBindingPayload,
	buildMetaBindingRequest,
	metaBindingField,
} from "../services/automations/binding-sync";

describe("Meta automation binding synchronization contracts", () => {
	it("builds the Get Started messenger_profile payload", () => {
		expect(
			buildMetaBindingPayload("get_started", "facebook", {
				payload: "GET_STARTED",
			}),
		).toEqual({ get_started: { payload: "GET_STARTED" } });
		expect(metaBindingField("get_started")).toBe("get_started");
	});

	it("builds Facebook and Instagram persistent menus", () => {
		const config = {
			items: [
				{ label: "Help", action: "postback", payload: "HELP" },
				{ label: "Website", action: "url", url: "https://relayapi.dev" },
			],
			composer_input_disabled: true,
		};
		const facebook = buildMetaBindingPayload("main_menu", "facebook", config);
		expect(facebook).toEqual({
			persistent_menu: [
				{
					locale: "default",
					composer_input_disabled: true,
					call_to_actions: [
						{ type: "postback", title: "Help", payload: "HELP" },
						{
							type: "web_url",
							title: "Website",
							url: "https://relayapi.dev",
							webview_height_ratio: "full",
						},
					],
				},
			],
		});
		expect(buildMetaBindingPayload("main_menu", "instagram", config)).toEqual({
			platform: "instagram",
			persistent_menu: [
				{
					locale: "default",
					call_to_actions: [
						{ type: "postback", title: "Help", payload: "HELP" },
						{
							type: "web_url",
							title: "Website",
							url: "https://relayapi.dev",
						},
					],
				},
			],
		});
		expect(metaBindingField("main_menu")).toBe("persistent_menu");
	});

	it("rejects Instagram menu fields that Meta does not support", () => {
		expect(
			getBindingConfigChannelError("main_menu", "instagram", {
				items: [{ label: "Help", action: "postback", payload: "HELP" }],
				composer_input_disabled: true,
			}),
		).toContain("do not support");
		expect(
			getBindingConfigChannelError("main_menu", "facebook", {
				items: [{ label: "Help", action: "postback", payload: "HELP" }],
				composer_input_disabled: true,
			}),
		).toBeNull();
	});

	it("builds Instagram ice breakers and provider DELETE field names", () => {
		expect(
			buildMetaBindingPayload("ice_breaker", "instagram", {
				questions: [{ question: "How can I order?", payload: "ORDER" }],
			}),
		).toEqual({
			platform: "instagram",
			ice_breakers: [{ question: "How can I order?", payload: "ORDER" }],
		});
		expect(metaBindingField("ice_breaker")).toBe("ice_breakers");
	});

	it("uses each provider's documented messenger_profile DELETE shape", () => {
		const instagram = buildMetaBindingRequest(
			"ice_breaker",
			"instagram",
			"https://graph.instagram.com/v1/me/messenger_profile",
			{},
			false,
		);
		expect(instagram.method).toBe("DELETE");
		expect(new URL(instagram.endpoint).searchParams.get("fields")).toBe(
			"['ice_breakers']",
		);
		expect(instagram.body).toBeUndefined();

		const facebook = buildMetaBindingRequest(
			"main_menu",
			"facebook",
			"https://graph.facebook.com/v1/me/messenger_profile",
			{},
			false,
		);
		expect(facebook).toEqual({
			endpoint: "https://graph.facebook.com/v1/me/messenger_profile",
			method: "DELETE",
			body: { fields: ["persistent_menu"] },
		});
	});

	it("enforces each provider surface's supported channels", () => {
		expect(isBindingTypeSupportedOnChannel("get_started", "facebook")).toBe(
			true,
		);
		expect(isBindingTypeSupportedOnChannel("get_started", "instagram")).toBe(
			false,
		);
		expect(isBindingTypeSupportedOnChannel("main_menu", "instagram")).toBe(
			true,
		);
		expect(isBindingTypeSupportedOnChannel("ice_breaker", "instagram")).toBe(
			true,
		);
		expect(isBindingTypeSupportedOnChannel("ice_breaker", "whatsapp")).toBe(
			false,
		);
	});
});
