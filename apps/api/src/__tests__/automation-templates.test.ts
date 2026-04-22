// apps/api/src/__tests__/automation-templates.test.ts
//
// Unit 7 Phase F — smoke tests for every template kind. Each template must
// produce a graph that passes validateGraph() without fatal errors.

import { describe, expect, it } from "bun:test";
import {
	buildGraphFromTemplate,
	listTemplateKinds,
	type TemplateKind,
} from "../services/automations/templates";
import { validateGraph } from "../services/automations/validator";

type FixtureConfig = Record<string, unknown>;

const FIXTURES: Record<TemplateKind, FixtureConfig> = {
	blank: {},
	welcome_flow: {},
	faq_bot: {
		keywords: [
			{ label: "hours", keyword: "hours", reply: "We're open 9-6." },
			{ label: "price", keyword: "price", reply: "See our pricing page." },
		],
	},
	lead_capture: { tag: "lead", capture_field: "email" },
	comment_to_dm: {
		post_ids: ["post_abc"],
		keyword_filter: ["link"],
		dm_message: {
			blocks: [{ id: "b1", type: "text", text: "Here's your link!" }],
		},
		public_reply: "DM sent!",
		once_per_user: true,
		social_account_id: "acc_123",
	},
	story_leads: {
		story_ids: null,
		capture_field: "email",
		success_tag: "story_lead",
		social_account_id: "acc_123",
	},
	follower_growth: {
		post_ids: ["post_abc"],
		trigger_keyword: "enter",
		public_reply: "Entered!",
		dm_message: {
			blocks: [{ id: "b1", type: "text", text: "Contest rules..." }],
		},
		entry_requirements: { must_tag_friends: 2 },
		winner_tag: "contest_winner",
		social_account_id: "acc_123",
	},
	follow_to_dm: {
		social_account_id: "acc_123",
		dm_message: {
			blocks: [{ id: "b1", type: "text", text: "Thanks for following!" }],
		},
		max_sends_per_day: 50,
		cooldown_between_sends_ms: 2000,
		skip_if_already_messaged: true,
	},
};

describe("buildGraphFromTemplate", () => {
	it("returns the full list of template kinds", () => {
		const kinds = listTemplateKinds().sort();
		const expected = [
			"blank",
			"comment_to_dm",
			"faq_bot",
			"follow_to_dm",
			"follower_growth",
			"lead_capture",
			"story_leads",
			"welcome_flow",
		].sort() as TemplateKind[];
		expect(kinds).toEqual(expected);
	});

	it("throws for unknown template kinds", () => {
		expect(() =>
			buildGraphFromTemplate({
				kind: "nonexistent" as TemplateKind,
				channel: "instagram",
				config: {},
			}),
		).toThrow();
	});

	for (const kind of Object.keys(FIXTURES) as TemplateKind[]) {
		it(`builds a validator-safe graph for ${kind}`, () => {
			const result = buildGraphFromTemplate({
				kind,
				channel: "instagram",
				config: FIXTURES[kind],
			});
			expect(typeof result.name).toBe("string");
			expect(Array.isArray(result.entrypoints)).toBe(true);
			const validation = validateGraph(result.graph);
			if (!validation.valid) {
				console.error(`template ${kind} validation errors:`, validation.errors);
			}
			expect(validation.valid).toBe(true);
		});
	}

	it("blank template produces an empty graph and no entrypoints", () => {
		const result = buildGraphFromTemplate({
			kind: "blank",
			channel: "instagram",
			config: {},
		});
		expect(result.graph.nodes).toHaveLength(0);
		expect(result.graph.edges).toHaveLength(0);
		expect(result.graph.root_node_key).toBeNull();
		expect(result.entrypoints).toHaveLength(0);
	});

	it("comment_to_dm emits a comment_created entrypoint bound to the provided account", () => {
		const result = buildGraphFromTemplate({
			kind: "comment_to_dm",
			channel: "instagram",
			config: FIXTURES.comment_to_dm,
		});
		expect(result.entrypoints).toHaveLength(1);
		const ep = result.entrypoints[0]!;
		expect(ep.kind).toBe("comment_created");
		expect(ep.socialAccountId).toBe("acc_123");
		expect((ep.config as any).post_ids).toEqual(["post_abc"]);
		// After the key-drift fix the emitted entrypoint uses `keywords` (the
		// key the matcher reads); the template input is still `keyword_filter`.
		expect((ep.config as any).keywords).toEqual(["link"]);
		expect((ep.config as any).keyword_filter).toBeUndefined();
	});

	it("follow_to_dm emits a follow entrypoint", () => {
		const result = buildGraphFromTemplate({
			kind: "follow_to_dm",
			channel: "instagram",
			config: FIXTURES.follow_to_dm,
		});
		expect(result.entrypoints).toHaveLength(1);
		expect(result.entrypoints[0]!.kind).toBe("follow");
	});

	it("follow_to_dm does NOT persist rate-limit fields on the entrypoint config", () => {
		// The template input accepts max_sends_per_day / cooldown_between_sends_ms
		// / skip_if_already_messaged, but the follow-entrypoint matcher doesn't
		// read them yet (deferred to v1.1). They must not appear on the emitted
		// entrypoint.config or operators will think they're enforced.
		const result = buildGraphFromTemplate({
			kind: "follow_to_dm",
			channel: "instagram",
			config: FIXTURES.follow_to_dm,
		});
		const ep = result.entrypoints[0]!;
		const cfg = (ep.config ?? {}) as Record<string, unknown>;
		expect(cfg.max_sends_per_day).toBeUndefined();
		expect(cfg.cooldown_between_sends_ms).toBeUndefined();
		expect(cfg.skip_if_already_messaged).toBeUndefined();
		// Only the social account scope should be carried through.
		expect(ep.socialAccountId).toBe("acc_123");
	});
});
