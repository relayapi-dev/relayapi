// Pure-helper tests for the per-account bindings tabs (Plan 3 — Unit C3).
//
// The UI-level logic (rendering, fetching) is covered by integration
// smoke-tests; here we focus on the pure helpers that drive channel filtering
// and validation of the stubbed-binding config payloads.

import { describe, expect, it } from "bun:test";
import {
	BINDING_TABS,
	bindingTabsForChannel,
	bindingTypeToTabKey,
	findBindingTab,
	validateConversationStarters,
	validateIceBreakers,
	validateMainMenuItems,
	type MainMenuItem,
} from "./types";

describe("bindingTabsForChannel", () => {
	it("returns all 5 tabs but only Default Reply + Welcome Message for TikTok", () => {
		const tabs = bindingTabsForChannel("tiktok");
		expect(tabs.map((t) => t.bindingType)).toEqual([
			"default_reply",
			"welcome_message",
		]);
	});

	it("returns Default Reply + Welcome Message for Telegram", () => {
		const tabs = bindingTabsForChannel("telegram");
		expect(tabs.map((t) => t.bindingType)).toEqual([
			"default_reply",
			"welcome_message",
		]);
	});

	it("returns Default Reply + Welcome Message + Main Menu for Instagram", () => {
		const tabs = bindingTabsForChannel("instagram");
		expect(tabs.map((t) => t.bindingType)).toEqual([
			"default_reply",
			"welcome_message",
			"main_menu",
		]);
	});

	it("returns all FB-eligible tabs in canonical order for Facebook", () => {
		const tabs = bindingTabsForChannel("facebook");
		expect(tabs.map((t) => t.bindingType)).toEqual([
			"default_reply",
			"welcome_message",
			"main_menu",
			"conversation_starter",
		]);
	});

	it("returns Default Reply + Welcome Message + Ice Breaker for WhatsApp", () => {
		const tabs = bindingTabsForChannel("whatsapp");
		expect(tabs.map((t) => t.bindingType)).toEqual([
			"default_reply",
			"welcome_message",
			"ice_breaker",
		]);
	});

	it("excludes Main Menu from WhatsApp / Telegram / TikTok", () => {
		for (const channel of ["whatsapp", "telegram", "tiktok"] as const) {
			const tabs = bindingTabsForChannel(channel);
			expect(tabs.some((t) => t.bindingType === "main_menu")).toBe(false);
		}
	});

	it("flags Main Menu + Conversation Starter + Ice Breaker as stubbed", () => {
		const stubbed = BINDING_TABS.filter((t) => t.stubbed)
			.map((t) => t.bindingType)
			.sort();
		expect(stubbed).toEqual(
			(["conversation_starter", "ice_breaker", "main_menu"] as const)
				.slice()
				.sort(),
		);
	});

	it("flags Default Reply + Welcome Message as non-stubbed", () => {
		const live = BINDING_TABS.filter((t) => !t.stubbed)
			.map((t) => t.bindingType)
			.sort();
		expect(live).toEqual(
			(["default_reply", "welcome_message"] as const).slice().sort(),
		);
	});
});

describe("findBindingTab / bindingTypeToTabKey", () => {
	it("maps the 'default-reply' slug to the default_reply tab", () => {
		const tab = findBindingTab("default-reply");
		expect(tab?.bindingType).toBe("default_reply");
	});

	it("returns null for unknown slugs", () => {
		expect(findBindingTab("nope")).toBeNull();
		expect(findBindingTab(null)).toBeNull();
		expect(findBindingTab(undefined)).toBeNull();
	});

	it("converts binding_type snake_case to hyphen slug", () => {
		expect(bindingTypeToTabKey("default_reply")).toBe("default-reply");
		expect(bindingTypeToTabKey("welcome_message")).toBe("welcome-message");
		expect(bindingTypeToTabKey("main_menu")).toBe("main-menu");
		expect(bindingTypeToTabKey("conversation_starter")).toBe(
			"conversation-starter",
		);
		expect(bindingTypeToTabKey("ice_breaker")).toBe("ice-breaker");
	});
});

describe("validateMainMenuItems", () => {
	const makeItem = (overrides: Partial<MainMenuItem> = {}): MainMenuItem => ({
		label: "Buy",
		action: "postback",
		payload: "BUY",
		...overrides,
	});

	it("accepts a valid single-item menu", () => {
		expect(validateMainMenuItems([makeItem()])).toBeNull();
	});

	it("rejects more than 3 top-level items", () => {
		const err = validateMainMenuItems([
			makeItem({ label: "a", payload: "A" }),
			makeItem({ label: "b", payload: "B" }),
			makeItem({ label: "c", payload: "C" }),
			makeItem({ label: "d", payload: "D" }),
		]);
		expect(err).toMatch(/at most 3 top-level/);
	});

	it("rejects labels longer than 30 chars", () => {
		const err = validateMainMenuItems([
			makeItem({ label: "x".repeat(31) }),
		]);
		expect(err).toMatch(/30 characters or fewer/);
	});

	it("rejects nesting deeper than 3 levels", () => {
		const deep: MainMenuItem = makeItem({
			label: "L1",
			payload: "L1",
			sub_items: [
				makeItem({
					label: "L2",
					payload: "L2",
					sub_items: [
						makeItem({
							label: "L3",
							payload: "L3",
							sub_items: [makeItem({ label: "L4", payload: "L4" })],
						}),
					],
				}),
			],
		});
		const err = validateMainMenuItems([deep]);
		expect(err).toMatch(/more than 3 levels/);
	});

	it("accepts exactly 3 levels of nesting", () => {
		const ok: MainMenuItem = makeItem({
			label: "L1",
			payload: "L1",
			sub_items: [
				makeItem({
					label: "L2",
					payload: "L2",
					sub_items: [makeItem({ label: "L3", payload: "L3" })],
				}),
			],
		});
		expect(validateMainMenuItems([ok])).toBeNull();
	});

	it("rejects empty payloads even with a label", () => {
		const err = validateMainMenuItems([makeItem({ payload: "" })]);
		expect(err).toMatch(/payload/);
	});
});

describe("validateConversationStarters", () => {
	it("accepts up to 4 starters", () => {
		expect(
			validateConversationStarters([
				{ label: "a", payload: "A" },
				{ label: "b", payload: "B" },
				{ label: "c", payload: "C" },
				{ label: "d", payload: "D" },
			]),
		).toBeNull();
	});

	it("rejects more than 4 starters", () => {
		const err = validateConversationStarters([
			{ label: "a", payload: "A" },
			{ label: "b", payload: "B" },
			{ label: "c", payload: "C" },
			{ label: "d", payload: "D" },
			{ label: "e", payload: "E" },
		]);
		expect(err).toMatch(/at most 4/);
	});

	it("rejects labels > 30 chars", () => {
		const err = validateConversationStarters([
			{ label: "x".repeat(31), payload: "P" },
		]);
		expect(err).toMatch(/30 characters/);
	});
});

describe("validateIceBreakers", () => {
	it("accepts up to 4 questions", () => {
		expect(
			validateIceBreakers([
				{ question: "q1", payload: "A" },
				{ question: "q2", payload: "B" },
				{ question: "q3", payload: "C" },
				{ question: "q4", payload: "D" },
			]),
		).toBeNull();
	});

	it("rejects more than 4 questions", () => {
		const err = validateIceBreakers([
			{ question: "q1", payload: "A" },
			{ question: "q2", payload: "B" },
			{ question: "q3", payload: "C" },
			{ question: "q4", payload: "D" },
			{ question: "q5", payload: "E" },
		]);
		expect(err).toMatch(/at most 4/);
	});

	it("rejects questions > 80 chars", () => {
		const err = validateIceBreakers([
			{ question: "x".repeat(81), payload: "P" },
		]);
		expect(err).toMatch(/80 characters/);
	});
});
