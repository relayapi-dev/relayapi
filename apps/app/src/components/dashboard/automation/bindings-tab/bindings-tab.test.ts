import { describe, expect, it } from "bun:test";
import { normalizeProviderBindingConfig } from "./provider-binding-tab";
import {
	bindingTabsForChannel,
	bindingTypeToTabKey,
	findBindingTab,
} from "./types";

describe("bindingTabsForChannel", () => {
	it("exposes runtime and provider-synced surfaces only on supported channels", () => {
		const expected = {
			instagram: [
				"default_reply",
				"welcome_message",
				"main_menu",
				"ice_breaker",
			],
			facebook: [
				"default_reply",
				"welcome_message",
				"get_started",
				"main_menu",
			],
			whatsapp: ["default_reply", "welcome_message"],
			telegram: ["default_reply", "welcome_message"],
		} as const;
		for (const channel of Object.keys(expected) as Array<
			keyof typeof expected
		>) {
			expect(
				bindingTabsForChannel(channel).map((tab) => tab.bindingType),
			).toEqual([...expected[channel]]);
		}
	});
});

describe("findBindingTab / bindingTypeToTabKey", () => {
	it("maps supported binding slugs", () => {
		expect(findBindingTab("default-reply")?.bindingType).toBe("default_reply");
		expect(findBindingTab("welcome-message")?.bindingType).toBe(
			"welcome_message",
		);
		expect(bindingTypeToTabKey("default_reply")).toBe("default-reply");
		expect(bindingTypeToTabKey("welcome_message")).toBe("welcome-message");
		expect(findBindingTab("get-started")?.bindingType).toBe("get_started");
		expect(findBindingTab("main-menu")?.bindingType).toBe("main_menu");
		expect(findBindingTab("ice-breakers")?.bindingType).toBe("ice_breaker");
		expect(bindingTypeToTabKey("ice_breaker")).toBe("ice-breakers");
	});

	it("does not resolve removed or misspelled platform-sync surfaces", () => {
		for (const slug of ["conversation-starter", "ice-breaker"]) {
			expect(findBindingTab(slug)).toBeNull();
		}
	});
});

describe("normalizeProviderBindingConfig", () => {
	it("clears the unsupported legacy Instagram composer flag", () => {
		expect(
			normalizeProviderBindingConfig(
				"main_menu",
				{ items: [], composer_input_disabled: true },
				"instagram",
			),
		).toEqual({ items: [], composer_input_disabled: false });
		expect(
			normalizeProviderBindingConfig(
				"main_menu",
				{ items: [], composer_input_disabled: true },
				"facebook",
			),
		).toEqual({ items: [], composer_input_disabled: true });
	});
});
