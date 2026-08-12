import { describe, expect, it } from "bun:test";
import {
	type AutomationTemplateFormState,
	buildAutomationTemplateConfig,
	type TemplateSlug,
} from "./template-picker-dialog";

const baseForm: AutomationTemplateFormState = {
	name: "Preset",
	channel: "instagram",
	social_account_id: "acc_123",
	dm_text: "Hello",
};

function serializedConfig(
	kind: TemplateSlug,
	overrides: Partial<AutomationTemplateFormState> = {},
) {
	return JSON.parse(
		JSON.stringify(
			buildAutomationTemplateConfig(kind, { ...baseForm, ...overrides }),
		),
	) as Record<string, unknown>;
}

describe("buildAutomationTemplateConfig", () => {
	it("builds default-only configs for scaffold presets", () => {
		for (const kind of [
			"blank",
			"welcome_flow",
			"faq_bot",
			"lead_capture",
		] as const) {
			expect(serializedConfig(kind)).toEqual({});
		}
	});

	it("builds the strict comment-to-DM config", () => {
		expect(
			serializedConfig("comment_to_dm", {
				post_ids: ["post_1"],
				keyword_filter: " LINK, info ",
				public_reply: " Sent! ",
				once_per_user: true,
				fallback_message: " Message us ",
			}),
		).toEqual({
			post_ids: ["post_1"],
			keyword_filter: ["LINK", "info"],
			public_reply: "Sent!",
			dm_message: {
				blocks: [{ id: "txt", type: "text", text: "Hello" }],
			},
			once_per_user: true,
			fallback_message: "Message us",
			social_account_id: "acc_123",
		});
	});

	it("builds the strict story-leads config", () => {
		expect(
			serializedConfig("story_leads", {
				keyword_filter: "guide",
				capture_field: "phone",
				success_tag: " story_lead ",
			}),
		).toEqual({
			story_ids: null,
			keyword_filter: ["guide"],
			dm_message: {
				blocks: [{ id: "txt", type: "text", text: "Hello" }],
			},
			capture_field: "phone",
			success_tag: "story_lead",
			social_account_id: "acc_123",
		});
	});

	it("builds the typed follower-growth requirements without retired keys", () => {
		const config = serializedConfig("follower_growth", {
			post_ids: ["post_contest"],
			trigger_keyword: " enter ",
			public_reply: " Entered! ",
			must_tag_friends: 2,
			must_share_story: true,
			winner_tag: " qualified ",
		});
		expect(config).toEqual({
			post_ids: ["post_contest"],
			trigger_keyword: "enter",
			public_reply: "Entered!",
			dm_message: {
				blocks: [{ id: "txt", type: "text", text: "Hello" }],
			},
			entry_requirements: {
				must_tag_friends: 2,
				must_share_story: true,
			},
			winner_tag: "qualified",
			social_account_id: "acc_123",
		});
		expect(config).not.toHaveProperty("contest_post_id");
	});

	it("builds the follow-to-DM config", () => {
		expect(serializedConfig("follow_to_dm")).toEqual({
			dm_message: {
				blocks: [{ id: "txt", type: "text", text: "Hello" }],
			},
			social_account_id: "acc_123",
		});
	});
});
