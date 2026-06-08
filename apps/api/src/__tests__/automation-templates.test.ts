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
import { estimateNodeSize } from "../services/automations/templates/_layout";
import { validateGraph } from "../services/automations/validator";

type FixtureConfig = Record<string, unknown>;

type PositionedNode = {
	key: string;
	kind: string;
	config: Record<string, unknown>;
	canvas_x?: number;
	canvas_y?: number;
};

// True if any two node bounding boxes (using the layout's own size estimate)
// overlap. The dagre layout must guarantee this is always false.
function anyNodesOverlap(nodes: PositionedNode[]): boolean {
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const a = nodes[i]!;
			const b = nodes[j]!;
			const sa = estimateNodeSize(a);
			const sb = estimateNodeSize(b);
			const ax = a.canvas_x ?? 0;
			const ay = a.canvas_y ?? 0;
			const bx = b.canvas_x ?? 0;
			const by = b.canvas_y ?? 0;
			if (
				ax < bx + sb.width &&
				bx < ax + sa.width &&
				ay < by + sb.height &&
				by < ay + sa.height
			) {
				return true;
			}
		}
	}
	return false;
}

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

	// Every non-blank template must assign canvas_x / canvas_y so nodes
	// render at distinct positions on the dashboard canvas (previously they
	// all stacked at (0, 0) because builders didn't set positions).
	for (const kind of Object.keys(FIXTURES) as TemplateKind[]) {
		if (kind === "blank") continue;
		it(`assigns non-overlapping canvas positions to every node for ${kind}`, () => {
			const result = buildGraphFromTemplate({
				kind,
				channel: "instagram",
				config: FIXTURES[kind],
			});
			expect(result.graph.nodes.length).toBeGreaterThan(0);
			for (const node of result.graph.nodes) {
				expect(typeof node.canvas_x).toBe("number");
				expect(typeof node.canvas_y).toBe("number");
			}
			expect(anyNodesOverlap(result.graph.nodes as PositionedNode[])).toBe(
				false,
			);
		});

		it(`produces non-empty ports on every node after validation for ${kind}`, () => {
			const result = buildGraphFromTemplate({
				kind,
				channel: "instagram",
				config: FIXTURES[kind],
			});
			const validation = validateGraph(result.graph);
			expect(validation.canonicalGraph.nodes.length).toBeGreaterThan(0);
			for (const node of validation.canonicalGraph.nodes) {
				expect(Array.isArray(node.ports)).toBe(true);
				expect(node.ports.length).toBeGreaterThan(0);
			}
		});
	}

	it("places the root node at the left edge of the layout for a non-blank template", () => {
		const result = buildGraphFromTemplate({
			kind: "welcome_flow",
			channel: "instagram",
			config: {},
		});
		const root = result.graph.nodes.find(
			(n) => n.key === result.graph.root_node_key,
		);
		expect(root).toBeDefined();
		expect(typeof root!.canvas_x).toBe("number");
		expect(typeof root!.canvas_y).toBe("number");
		// LR layout: the root is a source node, so it sits at the left-most x.
		const minX = Math.min(
			...result.graph.nodes.map((n) => n.canvas_x ?? Number.POSITIVE_INFINITY),
		);
		expect(root!.canvas_x).toBe(minX);
	});

	// Simulates what POST /v1/automations does end-to-end: build from template,
	// run validateGraph, persist the canonical graph. Guards against the
	// regression where the canvas rendered empty because persisted nodes had
	// `ports: []` and no canvas_x / canvas_y.
	it("persistable graph for comment_to_dm has ports AND non-overlapping canvas positions on every node", () => {
		const built = buildGraphFromTemplate({
			kind: "comment_to_dm",
			channel: "instagram",
			config: FIXTURES.comment_to_dm,
		});
		const validation = validateGraph(built.graph);
		// This is what the route INSERTs into automations.graph.
		const persisted = validation.canonicalGraph;
		expect(persisted.nodes.length).toBeGreaterThan(0);
		for (const node of persisted.nodes) {
			expect(node.ports.length).toBeGreaterThan(0);
			expect(typeof node.canvas_x).toBe("number");
			expect(typeof node.canvas_y).toBe("number");
		}
		// public_reply → root, send_dm → downstream. LR layout places the
		// downstream node to the right, and the two cards must not overlap.
		const publicReply = persisted.nodes.find((n) => n.key === "public_reply");
		const sendDm = persisted.nodes.find((n) => n.key === "send_dm");
		expect(sendDm!.canvas_x!).toBeGreaterThan(publicReply!.canvas_x!);
		expect(anyNodesOverlap(persisted.nodes as PositionedNode[])).toBe(false);
	});

	it("comment_to_dm adds a visible public reply node and omits a redundant end node", () => {
		const result = buildGraphFromTemplate({
			kind: "comment_to_dm",
			channel: "instagram",
			config: FIXTURES.comment_to_dm,
		});
		expect(result.graph.root_node_key).toBe("public_reply");
		expect(result.graph.nodes.some((n) => n.kind === "end")).toBe(false);
		const replyNode = result.graph.nodes.find((n) => n.key === "public_reply");
		expect(replyNode?.kind).toBe("action_group");
		expect(
			(replyNode?.config as { actions?: unknown[] } | undefined)?.actions,
		).toEqual([
			{
				id: "act_public_reply",
				type: "reply_to_comment",
				text: "DM sent!",
				on_error: "continue",
			},
		]);
		expect(result.graph.edges).toContainEqual({
			from_node: "public_reply",
			from_port: "next",
			to_node: "send_dm",
			to_port: "in",
		});
	});

	it("follower_growth adds a visible public reply node when configured", () => {
		const result = buildGraphFromTemplate({
			kind: "follower_growth",
			channel: "instagram",
			config: FIXTURES.follower_growth,
		});
		expect(result.graph.root_node_key).toBe("public_reply");
		expect(result.graph.nodes.some((n) => n.kind === "end")).toBe(false);
		expect(result.graph.edges).toContainEqual({
			from_node: "public_reply",
			from_port: "next",
			to_node: "rules",
			to_port: "in",
		});
	});

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
