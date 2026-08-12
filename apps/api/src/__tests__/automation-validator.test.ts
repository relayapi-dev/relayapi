// apps/api/src/__tests__/automation-validator.test.ts
import { describe, expect, test } from "bun:test";
import type { Graph } from "../schemas/automation-graph";
import { validateGraph } from "../services/automations/validator";

const mkGraph = (overrides: Record<string, unknown> = {}) => ({
	schema_version: 1 as const,
	root_node_key: "a",
	nodes: [
		{ key: "a", kind: "message", config: { blocks: [] }, ports: [] },
		{ key: "b", kind: "end", config: {}, ports: [] },
	],
	edges: [{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" }],
	...overrides,
});

const graphWithNode = (
	kind: string,
	config: Record<string, unknown>,
): Graph => ({
	schema_version: 1,
	root_node_key: "start",
	nodes: [
		{
			key: "start",
			kind: "message",
			config: { blocks: [] },
			ports: [],
		},
		{ key: "subject", kind, config, ports: [] },
	],
	edges: [
		{
			from_node: "start",
			from_port: "next",
			to_node: "subject",
			to_port: "in",
		},
	],
});

describe("validateGraph", () => {
	test("valid simple graph passes", () => {
		const r = validateGraph(mkGraph());
		expect(r.valid).toBe(true);
		expect(r.errors).toEqual([]);
	});

	test("rejects unknown message delivery and invalid wait settings", () => {
		for (const config of [
			{ blocks: [], delivery: "carrier_pigeon" },
			{ blocks: [], wait_for_reply: "yes" },
			{ blocks: [], no_response_timeout_min: 0 },
			{ blocks: [], no_response_timeout_min: 15 },
			{ blocks: [], typing_indicator_seconds: 6 },
		]) {
			const result = validateGraph(
				mkGraph({
					nodes: [
						{ key: "a", kind: "message", config, ports: [] },
						{ key: "b", kind: "end", config: {}, ports: [] },
					],
				}),
			);
			expect(
				result.errors.some(
					(error) => error.code === "invalid_message_settings",
				),
			).toBe(true);
		}
	});

	test("accepts plain and implicit-interactive message reply timeouts", () => {
		const plain = validateGraph(
			mkGraph({
				nodes: [
					{
						key: "a",
						kind: "message",
						config: {
							blocks: [{ id: "text", type: "text", text: "Reply" }],
							wait_for_reply: true,
							no_response_timeout_min: 15,
						},
						ports: [],
					},
					{ key: "b", kind: "end", config: {}, ports: [] },
				],
			}),
		);
		expect(plain.valid).toBe(true);

		const interactive = validateGraph(
			mkGraph({
				nodes: [
					{
						key: "a",
						kind: "message",
						config: {
							blocks: [
								{
									id: "text",
									type: "text",
									text: "Choose",
									buttons: [{ id: "yes", type: "branch", label: "Yes" }],
								},
							],
							no_response_timeout_min: 15,
						},
						ports: [],
					},
					{ key: "b", kind: "end", config: {}, ports: [] },
				],
			}),
		);
		expect(interactive.valid).toBe(true);
		expect(
			interactive.canonicalGraph.nodes[0]?.ports.some(
				(port) => port.key === "no_response",
			),
		).toBe(true);
	});

	test("rejects ambiguous or unsafe input configurations", () => {
		for (const config of [
			{ field: "email", input_type: "carrier_pigeon" },
			{ field: "email", max_retries: 0 },
			{ field: "email", timeout_min: -1 },
			{ field: "age", input_type: "number", validation: { min: 10, max: 5 } },
			{
				field: "size",
				input_type: "choice",
				choices: [
					{ value: "small", label: "Small" },
					{ value: "large", label: "Large", match: ["small"] },
				],
			},
		]) {
			const result = validateGraph(graphWithNode("input", config));
			expect(
				result.errors.some((error) => error.code === "invalid_input_config"),
			).toBe(true);
		}

		const validChoice = validateGraph(
			graphWithNode("input", {
				field: "size",
				input_type: "choice",
				max_retries: 2,
				choices: [
					{ value: "small", label: "Small", match: ["s"] },
					{ value: "large", label: "Large", match: ["l"] },
				],
			}),
		);
		expect(validChoice.valid).toBe(true);
	});

	test("validates condition values and delay units before activation", () => {
		for (const predicates of [
			{ all: [{ field: "state.total", op: "gte" }] },
			{ all: [{ field: "state.total", op: "gte", value: "not-a-number" }] },
			{ all: [{ field: "tags", op: "in", value: [] }] },
			{ all: [{ field: "tags", op: "unknown", value: "vip" }] },
		]) {
			const result = validateGraph(graphWithNode("condition", { predicates }));
			expect(
				result.errors.some(
					(error) => error.code === "invalid_condition_config",
				),
			).toBe(true);
		}

		const delay = validateGraph(
			graphWithNode("delay", { minutes: 2, seconds: -1 }),
		);
		expect(
			delay.errors.some((error) => error.code === "invalid_delay_config"),
		).toBe(true);
	});

	test("validates HTTP, subflow, profile-check, randomizer, and end settings", () => {
		const invalidCases: Array<[string, Record<string, unknown>, string]> = [
			[
				"http_request",
				{ url: "ftp://example.com", method: "TRACE" },
				"invalid_http_request_config",
			],
			[
				"start_automation",
				{ target_automation_id: "", pass_context: "yes" },
				"invalid_start_automation_config",
			],
			[
				"social_profile_check",
				{ field: "follower_count" },
				"invalid_social_profile_check_config",
			],
			[
				"randomizer",
				{ variants: [{ key: "only", weight: 1 }] },
				"invalid_randomizer_config",
			],
			["end", { reason: 42 }, "invalid_end_config"],
		];
		for (const [kind, config, code] of invalidCases) {
			const result = validateGraph(graphWithNode(kind, config), "instagram");
			expect(result.errors.some((error) => error.code === code)).toBe(true);
		}

		const request = validateGraph(
			graphWithNode("http_request", {
				url: "https://api.example.com/{{state.path}}",
				method: "POST",
				timeout_ms: 15_000,
				response_key: "last_response",
			}),
		);
		expect(request.valid).toBe(true);
	});

	test("rejects duplicate message identifiers and missing action targets", () => {
		const result = validateGraph(
			mkGraph({
				nodes: [
					{
						key: "a",
						kind: "message",
						config: {
							blocks: [
								{ id: "duplicate", type: "text", text: "First" },
								{
									id: "duplicate",
									type: "text",
									text: "Second",
									buttons: [{ id: "open", type: "url", label: "Open" }],
								},
							],
						},
						ports: [],
					},
					{ key: "b", kind: "end", config: {}, ports: [] },
				],
			}),
		);
		expect(
			result.errors.some((error) => error.code === "invalid_message_content"),
		).toBe(true);
	});

	test("missing root errors", () => {
		const r = validateGraph(mkGraph({ root_node_key: "missing" }));
		expect(r.errors.some((e) => e.code === "missing_root")).toBe(true);
	});

	test("input as root is invalid", () => {
		const r = validateGraph({
			schema_version: 1,
			root_node_key: "a",
			nodes: [{ key: "a", kind: "input", config: {}, ports: [] }],
			edges: [],
		});
		expect(r.errors.some((e) => e.code === "invalid_root_kind")).toBe(true);
	});

	test("orphan node is a warning, not an error", () => {
		// An unreachable node never executes (the runner only follows edges out
		// from the root), so it must not block save/activation. It surfaces as a
		// warning instead.
		const r = validateGraph(
			mkGraph({
				nodes: [
					{ key: "a", kind: "message", config: { blocks: [] }, ports: [] },
					{ key: "b", kind: "end", config: {}, ports: [] },
					{ key: "c", kind: "end", config: {}, ports: [] },
				],
			}),
		);
		expect(r.errors.some((e) => e.code === "orphan_node")).toBe(false);
		expect(
			r.warnings.some((w) => w.code === "orphan_node" && w.node_key === "c"),
		).toBe(true);
		expect(r.valid).toBe(true);
	});

	test("edge to unknown node", () => {
		const r = validateGraph(
			mkGraph({
				edges: [
					{ from_node: "a", from_port: "next", to_node: "zzz", to_port: "in" },
				],
			}),
		);
		expect(r.errors.some((e) => e.code === "edge_missing_to_node")).toBe(true);
	});

	test("edge to non-existent port", () => {
		const r = validateGraph(
			mkGraph({
				edges: [
					{
						from_node: "a",
						from_port: "wrong_port",
						to_node: "b",
						to_port: "in",
					},
				],
			}),
		);
		expect(r.errors.some((e) => e.code === "edge_missing_from_port")).toBe(
			true,
		);
	});

	test("cycle without pause is error", () => {
		const r = validateGraph({
			schema_version: 1,
			root_node_key: "a",
			nodes: [
				{ key: "a", kind: "message", config: { blocks: [] }, ports: [] },
				{ key: "b", kind: "message", config: { blocks: [] }, ports: [] },
			],
			edges: [
				{ from_node: "a", from_port: "next", to_node: "b", to_port: "in" },
				{ from_node: "b", from_port: "next", to_node: "a", to_port: "in" },
			],
		});
		expect(r.errors.some((e) => e.code === "cycle_without_pause")).toBe(true);
	});

	test("cycle with delay is OK", () => {
		const r = validateGraph({
			schema_version: 1,
			root_node_key: "a",
			nodes: [
				{ key: "a", kind: "message", config: { blocks: [] }, ports: [] },
				{ key: "d", kind: "delay", config: { seconds: 60 }, ports: [] },
			],
			edges: [
				{ from_node: "a", from_port: "next", to_node: "d", to_port: "in" },
				{ from_node: "d", from_port: "next", to_node: "a", to_port: "in" },
			],
		});
		const cycleErrors = r.errors.filter(
			(e) => e.code === "cycle_without_pause",
		);
		expect(cycleErrors).toEqual([]);
	});

	test("orphan port produces warning not error", () => {
		const r = validateGraph(
			mkGraph({
				nodes: [
					{ key: "a", kind: "condition", config: {}, ports: [] },
					{ key: "b", kind: "end", config: {}, ports: [] },
				],
				edges: [
					{ from_node: "a", from_port: "true", to_node: "b", to_port: "in" },
				],
			}),
		);
		expect(
			r.warnings.some(
				(w) => w.code === "port_no_outgoing_edge" && w.port_key === "false",
			),
		).toBe(true);
		// ... but no error about this
	});

	test("change_main_menu validates for Facebook and rejects other channels", () => {
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "ag",
			nodes: [
				{
					key: "ag",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "menu",
								type: "change_main_menu",
								menu_payload: {
									items: [
										{
											label: "Help",
											action: "postback",
											payload: "HELP",
										},
									],
								},
								on_error: "abort",
							},
						],
					},
					ports: [],
				},
				{ key: "done", kind: "end", config: {}, ports: [] },
			],
			edges: [
				{ from_node: "ag", from_port: "next", to_node: "done", to_port: "in" },
			],
		};
		const facebook = validateGraph(graph, "facebook");
		expect(facebook.valid).toBe(true);
		expect(
			facebook.errors.some((error) => error.code === "action_unavailable"),
		).toBe(false);

		const instagram = validateGraph(graph, "instagram");
		expect(instagram.valid).toBe(false);
		expect(
			instagram.errors.some(
				(error) =>
					error.code === "unsupported_action_channel" &&
					error.node_key === "ag",
			),
		).toBe(true);
	});

	test("wait_event rejects event kinds unavailable on the automation channel", () => {
		const graph: Graph = {
			schema_version: 1,
			root_node_key: "start",
			nodes: [
				{
					key: "start",
					kind: "message",
					config: { blocks: [] },
					ports: [],
				},
				{
					key: "wait",
					kind: "wait_event",
					config: { event_kinds: ["share_to_dm"] },
					ports: [],
				},
				{ key: "done", kind: "end", config: {}, ports: [] },
			],
			edges: [
				{
					from_node: "start",
					from_port: "next",
					to_node: "wait",
					to_port: "in",
				},
				{
					from_node: "wait",
					from_port: "received",
					to_node: "done",
					to_port: "in",
				},
			],
		};
		expect(validateGraph(graph, "instagram").valid).toBe(true);
		const facebook = validateGraph(graph, "facebook");
		expect(facebook.valid).toBe(false);
		expect(
			facebook.errors.some(
				(error) => error.code === "unsupported_wait_event_channel",
			),
		).toBe(true);
	});

	test("action_group without `change_main_menu` passes the stubbed-action check", () => {
		const r = validateGraph({
			schema_version: 1,
			root_node_key: "ag",
			nodes: [
				{
					key: "ag",
					kind: "action_group",
					config: { actions: [{ type: "tag_add", params: { tag: "vip" } }] },
					ports: [],
				},
				{ key: "done", kind: "end", config: {}, ports: [] },
			],
			edges: [
				{ from_node: "ag", from_port: "next", to_node: "done", to_port: "in" },
			],
		});
		expect(r.errors.some((e) => e.code === "action_unavailable")).toBe(false);
	});

	test("action_group with durable conversion logging can activate", () => {
		const r = validateGraph({
			schema_version: 1,
			root_node_key: "ag",
			nodes: [
				{
					key: "ag",
					kind: "action_group",
					config: {
						actions: [
							{
								id: "conversion",
								type: "log_conversion_event",
								event_name: "purchase",
								on_error: "abort",
							},
						],
					},
					ports: [],
				},
				{ key: "done", kind: "end", config: {}, ports: [] },
			],
			edges: [
				{ from_node: "ag", from_port: "next", to_node: "done", to_port: "in" },
			],
		});
		expect(r.valid).toBe(true);
		expect(
			r.errors.some(
				(e) => e.code === "action_unavailable" && e.node_key === "ag",
			),
		).toBe(false);
	});
});
