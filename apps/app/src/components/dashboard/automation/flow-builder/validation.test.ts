// validation.test.ts — Plan 2 Unit B2, Task L3.

import { describe, expect, it } from "bun:test";
import type { AutomationGraph, AutomationNode } from "./graph-types";
import { validateGraph, validateLegacyGraph } from "./validation";
import type { AutomationSchema } from "./types";

function node(
	key: string,
	kind: string,
	config: Record<string, unknown> = {},
): AutomationNode {
	return { key, kind, canvas_x: 0, canvas_y: 0, config, ports: [] };
}

function graph(
	nodes: AutomationNode[],
	edges: AutomationGraph["edges"] = [],
	root: string | null = nodes[0]?.key ?? null,
): AutomationGraph {
	return { schema_version: 1, root_node_key: root, nodes, edges };
}

describe("validateGraph (new graph-store API)", () => {
	it("accepts a minimal valid graph", () => {
		const g = graph(
			[
				node("a", "message"),
				node("b", "end"),
			],
			[{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
			"a",
		);
		const result = validateGraph(g);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("flags missing root_node_key when nodes exist", () => {
		const g = graph([node("a", "message")], [], null);
		const result = validateGraph(g);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.code === "missing_root")).toBe(true);
	});

	it("flags a root node with a non-entry kind (input)", () => {
		const g = graph(
			[node("a", "input"), node("b", "end")],
			[
				{
					from_node: "a",
					from_port: "captured",
					to_node: "b",
					to_port: "in",
				},
			],
			"a",
		);
		const result = validateGraph(g);
		expect(result.errors.some((e) => e.code === "invalid_root_kind")).toBe(true);
	});

	it("flags an orphan node (non-root with no incoming edges)", () => {
		const g = graph(
			[node("a", "message"), node("b", "message")],
			[],
			"a",
		);
		const result = validateGraph(g);
		expect(result.errors.some((e) => e.code === "orphan_node")).toBe(true);
	});

	it("flags an edge to an unknown node", () => {
		const g = graph(
			[node("a", "message")],
			[{ from_node: "a", from_port: "next", to_node: "ghost", to_port: "in" }],
			"a",
		);
		const result = validateGraph(g);
		expect(result.errors.some((e) => e.code === "edge_missing_to_node")).toBe(
			true,
		);
	});

	it("flags an edge referencing a non-existent port", () => {
		const g = graph(
			[node("a", "message"), node("b", "end")],
			[
				{
					from_node: "a",
					from_port: "does_not_exist",
					to_node: "b",
					to_port: "in",
				},
			],
			"a",
		);
		const result = validateGraph(g);
		expect(result.errors.some((e) => e.code === "edge_missing_from_port")).toBe(
			true,
		);
	});

	it("flags a cycle with no pause point", () => {
		const g = graph(
			[node("a", "action_group"), node("b", "action_group")],
			[
				{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" },
				{ from_node: "b", from_port: "next", to_node: "a", to_port: "in" },
			],
			"a",
		);
		const result = validateGraph(g);
		expect(result.errors.some((e) => e.code === "cycle_without_pause")).toBe(
			true,
		);
	});

	it("allows a cycle that passes through a delay (pause point)", () => {
		const g = graph(
			[
				node("a", "action_group"),
				node("d", "delay", { seconds: 30 }),
			],
			[
				{ from_node: "a", from_port: "next", to_node: "d", to_port: "in" },
				{ from_node: "d", from_port: "next", to_node: "a", to_port: "in" },
			],
			"a",
		);
		const result = validateGraph(g);
		// cycle_without_pause must NOT fire (the delay pauses the loop)
		expect(result.errors.some((e) => e.code === "cycle_without_pause")).toBe(
			false,
		);
	});

	it("warns but does not error when an output port has no outgoing edge", () => {
		const g = graph(
			[node("a", "condition"), node("b", "end")],
			[
				{ from_node: "a", from_port: "true", to_node: "b", to_port: "in" },
				// false port intentionally left dangling
			],
			"a",
		);
		const result = validateGraph(g);
		expect(result.warnings.some((w) => w.code === "port_no_outgoing_edge")).toBe(
			true,
		);
		// No dangling-port *error* should be raised; this is warning-only.
		expect(result.errors.some((e) => e.code === "port_no_outgoing_edge")).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// Legacy validator — kept alive only while the detail page is on the old
// `AutomationDetail` shape.
// ---------------------------------------------------------------------------

const legacySchema: AutomationSchema = {
	triggers: [
		{
			type: "instagram_comment",
			channel: "instagram",
			config_schema: {
				type: "object",
				properties: {},
				required: [],
			},
			output_labels: ["next"],
		},
	],
	nodes: [
		{
			type: "message_text",
			category: "content",
			fields_schema: {
				type: "object",
				properties: {
					text: { type: "string" },
					recipient_mode: {
						type: "string",
						enum: ["enrolled_contact", "custom_identifier"],
						default: "enrolled_contact",
					},
				},
				required: ["text", "recipient_mode"],
			},
			output_labels: ["next"],
		},
	],
	templates: [],
	merge_tags: [],
};

describe("validateLegacyGraph (deprecated)", () => {
	it("does not fail defaulted required node fields", () => {
		const issues = validateLegacyGraph(
			{
				triggers: [
					{
						id: "tr_1",
						type: "instagram_comment",
						account_id: "acc_123",
						config: {},
						filters: {},
						label: "Trigger #1",
						order_index: 0,
					},
				],
				nodes: [
					{
						key: "send_dm",
						type: "message_text",
						text: "hello",
					},
				],
				edges: [{ from: "trigger", to: "send_dm" }],
			},
			legacySchema,
		);

		expect(
			issues.some((issue) =>
				issue.message.includes('missing required field "recipient_mode"'),
			),
		).toBe(false);
	});

	it("still fails required fields that do not have defaults", () => {
		const issues = validateLegacyGraph(
			{
				triggers: [
					{
						id: "tr_1",
						type: "instagram_comment",
						account_id: "acc_123",
						config: {},
						filters: {},
						label: "Trigger #1",
						order_index: 0,
					},
				],
				nodes: [
					{
						key: "send_dm",
						type: "message_text",
					},
				],
				edges: [{ from: "trigger", to: "send_dm" }],
			},
			legacySchema,
		);

		expect(
			issues.some((issue) =>
				issue.message.includes('missing required field "text"'),
			),
		).toBe(true);
	});
});
