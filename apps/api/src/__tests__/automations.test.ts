import { describe, expect, it } from "bun:test";
import { simulateAutomation } from "../services/automations/simulator";
import type { AutomationSnapshot } from "../services/automations/types";
import {
	AutomationCreateSpec,
	AutomationSimulateRequest,
} from "../schemas/automations";

// ---------------------------------------------------------------------------
// simulateAutomation — static graph traversal
// ---------------------------------------------------------------------------

function mkSnapshot(
	nodes: AutomationSnapshot["nodes"],
	edges: AutomationSnapshot["edges"],
): AutomationSnapshot {
	return {
		automation_id: "auto_test",
		version: 1,
		name: "test",
		channel: "instagram",
		trigger: { type: "instagram_comment", config: {}, filters: {} },
		entry_node_key: "trigger",
		nodes,
		edges,
	};
}

describe("simulateAutomation", () => {
	it("follows the next edge from trigger through message_text to end", () => {
		const snap = mkSnapshot(
			[
				{ id: "n1", key: "trigger", type: "trigger", config: {} },
				{ id: "n2", key: "greet", type: "message_text", config: { text: "hi" } },
				{ id: "n3", key: "done", type: "end", config: {} },
			],
			[
				{ id: "e1", from_node_key: "trigger", to_node_key: "greet", label: "next", order: 0, condition_expr: null },
				{ id: "e2", from_node_key: "greet", to_node_key: "done", label: "next", order: 0, condition_expr: null },
			],
		);
		const result = simulateAutomation(snap);
		expect(result.path.map((s) => s.node_key)).toEqual(["trigger", "greet", "done"]);
		expect(result.terminated.kind).toBe("exit");
	});

	it("picks the 'yes' branch on a condition node by default", () => {
		const snap = mkSnapshot(
			[
				{ id: "n1", key: "trigger", type: "trigger", config: {} },
				{ id: "n2", key: "cond", type: "condition", config: {} },
				{ id: "n3", key: "yes", type: "end", config: { reason: "yes" } },
				{ id: "n4", key: "no", type: "end", config: { reason: "no" } },
			],
			[
				{ id: "e1", from_node_key: "trigger", to_node_key: "cond", label: "next", order: 0, condition_expr: null },
				{ id: "e2", from_node_key: "cond", to_node_key: "yes", label: "yes", order: 0, condition_expr: null },
				{ id: "e3", from_node_key: "cond", to_node_key: "no", label: "no", order: 0, condition_expr: null },
			],
		);
		const result = simulateAutomation(snap);
		expect(result.path.map((s) => s.node_key)).toEqual(["trigger", "cond", "yes"]);
	});

	it("honours branch_choices to force the no branch", () => {
		const snap = mkSnapshot(
			[
				{ id: "n1", key: "trigger", type: "trigger", config: {} },
				{ id: "n2", key: "cond", type: "condition", config: {} },
				{ id: "n3", key: "yes", type: "end", config: { reason: "yes" } },
				{ id: "n4", key: "no", type: "end", config: { reason: "no" } },
			],
			[
				{ id: "e1", from_node_key: "trigger", to_node_key: "cond", label: "next", order: 0, condition_expr: null },
				{ id: "e2", from_node_key: "cond", to_node_key: "yes", label: "yes", order: 0, condition_expr: null },
				{ id: "e3", from_node_key: "cond", to_node_key: "no", label: "no", order: 0, condition_expr: null },
			],
		);
		const result = simulateAutomation(snap, { branch_choices: { cond: "no" } });
		expect(result.path.map((s) => s.node_key)).toEqual(["trigger", "cond", "no"]);
	});

	it("detects a cycle when a node is re-entered without a branch_choice", () => {
		const snap = mkSnapshot(
			[
				{ id: "n1", key: "trigger", type: "trigger", config: {} },
				{ id: "n2", key: "loop", type: "goto", config: { target_node_key: "trigger" } },
			],
			[
				{ id: "e1", from_node_key: "trigger", to_node_key: "loop", label: "next", order: 0, condition_expr: null },
			],
		);
		const result = simulateAutomation(snap);
		expect(result.terminated.kind).toBe("cycle");
	});

	it("returns complete when the graph has no outgoing edge from a send node", () => {
		const snap = mkSnapshot(
			[
				{ id: "n1", key: "trigger", type: "trigger", config: {} },
				{ id: "n2", key: "msg", type: "message_text", config: { text: "hi" } },
			],
			[
				{ id: "e1", from_node_key: "trigger", to_node_key: "msg", label: "next", order: 0, condition_expr: null },
			],
		);
		const result = simulateAutomation(snap);
		expect(result.path.map((s) => s.node_key)).toEqual(["trigger", "msg"]);
		expect(result.terminated.kind).toBe("complete");
	});

	it("reports unknown_node when entry_node_key is missing", () => {
		const snap = mkSnapshot([], []);
		const result = simulateAutomation(snap);
		expect(result.terminated.kind).toBe("unknown_node");
	});
});

// ---------------------------------------------------------------------------
// AutomationSimulateRequest — input validation
// ---------------------------------------------------------------------------

describe("AutomationSimulateRequest schema", () => {
	it("defaults max_steps to 50", () => {
		const parsed = AutomationSimulateRequest.parse({});
		expect(parsed.max_steps).toBe(50);
	});

	it("caps max_steps at 200", () => {
		const result = AutomationSimulateRequest.safeParse({ max_steps: 500 });
		expect(result.success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// AutomationCreateSpec — Instagram tightened nodes
// ---------------------------------------------------------------------------

describe("AutomationCreateSpec — Instagram send nodes", () => {
	it("accepts a tightened instagram_send_buttons node with 3 buttons", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "instagram",
			trigger: { type: "instagram_comment" },
			nodes: [
				{
					type: "instagram_send_buttons",
					key: "send",
					text: "Pick one",
					buttons: [
						{ type: "postback", title: "Yes", payload: "yes" },
						{ type: "postback", title: "No", payload: "no" },
						{ type: "web_url", title: "Learn more", url: "https://example.com" },
					],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects instagram_send_buttons with a 4th button", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "instagram",
			trigger: { type: "instagram_comment" },
			nodes: [
				{
					type: "instagram_send_buttons",
					key: "send",
					text: "Pick one",
					buttons: Array.from({ length: 4 }).map((_, i) => ({
						type: "postback" as const,
						title: `Opt ${i}`,
						payload: String(i),
					})),
				},
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects instagram_send_quick_replies missing the text field", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "instagram",
			trigger: { type: "instagram_comment" },
			nodes: [
				{
					type: "instagram_send_quick_replies",
					key: "send",
					quick_replies: [{ title: "Hello" }],
				},
			],
		});
		expect(result.success).toBe(false);
	});
});
