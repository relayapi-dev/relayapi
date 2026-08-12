// apps/api/src/__tests__/automation-templates.test.ts
//
// Unit 7 Phase F — smoke tests for every template kind. Each template must
// produce a graph that passes validateGraph() without fatal errors.

import { describe, expect, it } from "bun:test";
import {
	isEntrypointKindSupportedOnChannel,
	validateEntrypointConfig,
} from "../schemas/automation-entrypoints";
import { AutomationCreateSchema } from "../schemas/automations";
import { evaluateFilterGroup } from "../services/automations/filter-eval";
import { applyMergeTags } from "../services/automations/merge-tags";
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
			const a = nodes[i];
			const b = nodes[j];
			if (!a || !b) continue;
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
			const validation = validateGraph(result.graph, "instagram");
			if (!validation.valid) {
				console.error(`template ${kind} validation errors:`, validation.errors);
			}
			expect(validation.valid).toBe(true);
			for (const entrypoint of result.entrypoints) {
				expect(
					isEntrypointKindSupportedOnChannel(entrypoint.kind, "instagram"),
				).toBe(true);
				expect(
					validateEntrypointConfig(entrypoint.kind, entrypoint.config).success,
				).toBe(true);
			}
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
			const validation = validateGraph(result.graph, "instagram");
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
		if (!root) throw new Error("expected root node to be defined");
		expect(typeof root.canvas_x).toBe("number");
		expect(typeof root.canvas_y).toBe("number");
		// LR layout: the root is a source node, so it sits at the left-most x.
		const minX = Math.min(
			...result.graph.nodes.map((n) => n.canvas_x ?? Number.POSITIVE_INFINITY),
		);
		expect(root.canvas_x).toBe(minX);
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
		const validation = validateGraph(built.graph, "instagram");
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
		if (sendDm?.canvas_x === undefined) {
			throw new Error("expected send_dm node with canvas_x");
		}
		if (publicReply?.canvas_x === undefined) {
			throw new Error("expected public_reply node with canvas_x");
		}
		expect(sendDm.canvas_x).toBeGreaterThan(publicReply.canvas_x);
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
		expect(result.graph.edges).toContainEqual({
			from_node: "public_reply",
			from_port: "next",
			to_node: "check_tags",
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

	it("default preset greetings use the persisted contact name field", () => {
		for (const kind of ["welcome_flow", "faq_bot"] as const) {
			const result = buildGraphFromTemplate({
				kind,
				channel: "instagram",
				config: {},
			});
			const firstMessage = result.graph.nodes.find(
				(node) => node.kind === "message",
			);
			const blocks = (
				firstMessage?.config as { blocks?: unknown[] } | undefined
			)?.blocks as Array<{ type?: string; text?: string }> | undefined;
			const text = blocks?.find((block) => block.type === "text")?.text;
			expect(text).toContain("{{contact.name}}");
			expect(
				applyMergeTags(text ?? "", {
					contact: { name: "Alice" },
					state: {},
				}),
			).toContain("Alice");
		}
	});

	it("resolves run context through context and state merge-tag aliases", () => {
		const mergeContext = {
			contact: { name: "Alice" },
			state: { email: "alice@example.com", fields: { tier: "vip" } },
		};
		expect(applyMergeTags("{{context.email}}", mergeContext)).toBe(
			"alice@example.com",
		);
		expect(applyMergeTags("{{state.fields.tier}}", mergeContext)).toBe("vip");
	});

	it("FAQ reply block ids stay unique when labels repeat", () => {
		const result = buildGraphFromTemplate({
			kind: "faq_bot",
			channel: "instagram",
			config: {
				keywords: [
					{ label: "same", keyword: "one", reply: "First" },
					{ label: "same", keyword: "two", reply: "Second" },
				],
			},
		});
		const ids = result.graph.nodes.flatMap((node) => {
			const blocks = (node.config as { blocks?: unknown[] } | undefined)
				?.blocks as Array<{ id?: string }> | undefined;
			return blocks?.flatMap((block) => (block.id ? [block.id] : [])) ?? [];
		});
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("FAQ keyword branches are intentionally case-insensitive", () => {
		const result = buildGraphFromTemplate({
			kind: "faq_bot",
			channel: "instagram",
			config: {
				keywords: [{ label: "hours", keyword: "hours", reply: "We're open." }],
			},
		});
		const condition = result.graph.nodes.find(
			(node) => node.kind === "condition",
		);
		const predicates = condition?.config.predicates as
			| Parameters<typeof evaluateFilterGroup>[0]
			| undefined;
		expect(predicates).toBeDefined();
		expect(
			evaluateFilterGroup(predicates ?? {}, {
				state: { faq_question: "WHAT ARE YOUR HOURS?" },
			}),
		).toBe(true);
	});

	it("comment_to_dm emits a comment_created entrypoint bound to the provided account", () => {
		const result = buildGraphFromTemplate({
			kind: "comment_to_dm",
			channel: "instagram",
			config: FIXTURES.comment_to_dm,
		});
		expect(result.entrypoints).toHaveLength(1);
		const ep = result.entrypoints[0];
		if (!ep) throw new Error("expected an entrypoint");
		expect(ep.kind).toBe("comment_created");
		expect(ep.socialAccountId).toBe("acc_123");
		const epConfig = ep.config as Record<string, unknown>;
		expect(epConfig.post_ids).toEqual(["post_abc"]);
		// After the key-drift fix the emitted entrypoint uses `keywords` (the
		// key the matcher reads); the template input is still `keyword_filter`.
		expect(epConfig.keywords).toEqual(["link"]);
		expect(epConfig.keyword_filter).toBeUndefined();
	});

	it("follow_to_dm starts on the first inbound DM and verifies the follow relationship", () => {
		const result = buildGraphFromTemplate({
			kind: "follow_to_dm",
			channel: "instagram",
			config: {
				...FIXTURES.follow_to_dm,
				daily_cap: 50,
				cooldown_hours: 24,
			},
		});
		expect(result.entrypoints).toHaveLength(1);
		const ep = result.entrypoints[0];
		if (!ep) throw new Error("expected an entrypoint");
		expect(ep.kind).toBe("dm_received");
		expect(ep.config).toEqual({ first_message_only: true });
		expect(ep.allowReentry).toBe(false);
		expect(ep.reentryCooldownMin).toBe(24 * 60);
		expect(ep.dailyCap).toBe(50);
		expect(result.graph.root_node_key).toBe("check_follow");
		expect(
			result.graph.nodes.find((node) => node.key === "check_follow")?.kind,
		).toBe("social_profile_check");
	});

	it("follow_to_dm rejects retired throttling fields at the public request schema", () => {
		for (const field of [
			"max_sends_per_day",
			"cooldown_between_sends_ms",
			"skip_if_already_messaged",
		]) {
			const parsed = AutomationCreateSchema.safeParse({
				name: "Follower welcome",
				channel: "instagram",
				template: {
					kind: "follow_to_dm",
					config: { social_account_id: "acc_123", [field]: true },
				},
			});
			expect(parsed.success).toBe(false);
			if (parsed.success) throw new Error("expected validation to fail");
			expect(
				parsed.error.issues.some(
					(issue) =>
						issue.path.join(".") === "template.config" &&
						issue.message.includes(field),
				),
			).toBe(true);
		}
	});

	it("accepts enforced follow_to_dm admission controls at the public request schema", () => {
		const parsed = AutomationCreateSchema.safeParse({
			name: "Follower welcome",
			channel: "instagram",
			template: {
				kind: "follow_to_dm",
				config: {
					social_account_id: "acc_123",
					daily_cap: 100,
					cooldown_hours: 12,
				},
			},
		});
		expect(parsed.success).toBe(true);
	});

	it("caps preset daily admission limits at the entrypoint maximum", () => {
		for (const kind of [
			"comment_to_dm",
			"story_leads",
			"follower_growth",
			"follow_to_dm",
		] as const) {
			const parsed = AutomationCreateSchema.safeParse({
				name: "Bounded preset",
				channel: "instagram",
				template: {
					kind,
					config: { daily_cap: 1_000_001 },
				},
			});
			expect(parsed.success).toBe(false);
		}
	});
});
