import { describe, expect, it } from "bun:test";
import { simulateAutomation } from "../services/automations/simulator";
import type { AutomationSnapshot } from "../services/automations/types";
import {
	AutomationCreateSpec,
	AutomationSimulateRequest,
	KeywordReplyTemplateInput,
} from "../schemas/automations";
import { isWorkspaceScopeDenied } from "../lib/workspace-scope";
import { applyQuietHours } from "../services/automations/nodes/smart-delay";
import { messageMediaHandler } from "../services/automations/nodes/message-media";
import { validateInput } from "../services/automations/nodes/user-input-validation";
import { resolveTemplatedValue } from "../services/automations/resolve-templated-value";

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

	it("supports split_test labels during simulation", () => {
		const snap = mkSnapshot(
			[
				{ id: "n1", key: "trigger", type: "trigger", config: {} },
				{
					id: "n2",
					key: "experiment",
					type: "split_test",
					config: {
						variants: [
							{ label: "control", weight: 50 },
							{ label: "variant_b", weight: 50 },
						],
					},
				},
				{ id: "n3", key: "control_done", type: "end", config: { reason: "control" } },
				{ id: "n4", key: "variant_done", type: "end", config: { reason: "variant" } },
			],
			[
				{ id: "e1", from_node_key: "trigger", to_node_key: "experiment", label: "next", order: 0, condition_expr: null },
				{ id: "e2", from_node_key: "experiment", to_node_key: "control_done", label: "control", order: 0, condition_expr: null },
				{ id: "e3", from_node_key: "experiment", to_node_key: "variant_done", label: "variant_b", order: 0, condition_expr: null },
			],
		);
		const result = simulateAutomation(snap, {
			branch_choices: { experiment: "variant_b" },
		});
		expect(result.path.map((s) => s.node_key)).toEqual([
			"trigger",
			"experiment",
			"variant_done",
		]);
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

// ---------------------------------------------------------------------------
// AutomationCreateSpec — tightened platform nodes (sample coverage)
// ---------------------------------------------------------------------------

describe("AutomationCreateSpec — tightened platform nodes", () => {
	it("rejects whatsapp_send_interactive without buttons or list", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "whatsapp",
			trigger: { type: "whatsapp_message" },
			nodes: [
				{ type: "whatsapp_send_interactive", key: "send", text: "Hi" },
			],
		});
		expect(result.success).toBe(false);
	});

	it("accepts whatsapp_send_interactive with reply buttons", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "whatsapp",
			trigger: { type: "whatsapp_message" },
			nodes: [
				{
					type: "whatsapp_send_interactive",
					key: "send",
					text: "Pick one",
					buttons: [
						{ id: "a", title: "A" },
						{ id: "b", title: "B" },
					],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("rejects reddit_submit_post without text or url", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "reddit",
			trigger: { type: "reddit_new_post" },
			nodes: [
				{ type: "reddit_submit_post", key: "post", subreddit: "test", title: "hi" },
			],
		});
		expect(result.success).toBe(false);
	});

	it("accepts telegram_send_keyboard with nested button rows", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "telegram",
			trigger: { type: "telegram_message" },
			nodes: [
				{
					type: "telegram_send_keyboard",
					key: "send",
					text: "Choose",
					buttons: [
						[{ text: "A", callback_data: "a" }],
						[{ text: "B", callback_data: "b" }],
					],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("accepts split_test nodes now that the runtime supports them", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "experiment",
			channel: "instagram",
			trigger: { type: "instagram_comment" },
			nodes: [
				{
					type: "split_test",
					key: "experiment",
					variants: [
						{ label: "control", weight: 50 },
						{ label: "variant_b", weight: 50 },
					],
				},
			],
			edges: [],
		});
		expect(result.success).toBe(true);
	});

	it("rejects beehiiv_add_subscriber with an invalid email", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "beehiiv",
			trigger: { type: "beehiiv_subscription_created" },
			nodes: [
				{ type: "beehiiv_add_subscriber", key: "add", email: "not-an-email" },
			],
		});
		expect(result.success).toBe(false);
	});

	it("rejects telegram_send_poll with fewer than 2 options", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "telegram",
			trigger: { type: "telegram_message" },
			nodes: [
				{
					type: "telegram_send_poll",
					key: "poll",
					question: "Q?",
					options: ["only one"],
				},
			],
		});
		expect(result.success).toBe(false);
	});

	it("accepts a valid pinterest_create_pin", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "pinterest",
			trigger: { type: "manual" },
			nodes: [
				{
					type: "pinterest_create_pin",
					key: "pin",
					board_id: "board_123",
					image_url: "https://cdn.example.com/pin.jpg",
					title: "Spring launch",
				},
			],
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Audit 2: workspace-scope gating on single-resource routes
// ---------------------------------------------------------------------------

describe("isWorkspaceScopeDenied", () => {
	// Mock just the `get("workspaceScope")` surface.
	function mockCtx(scope: "all" | string[]) {
		return {
			get: (key: string) => (key === "workspaceScope" ? scope : undefined),
		} as unknown as Parameters<typeof isWorkspaceScopeDenied>[0];
	}

	it("allows access when scope === 'all'", () => {
		expect(isWorkspaceScopeDenied(mockCtx("all"), "ws_123")).toBe(false);
		expect(isWorkspaceScopeDenied(mockCtx("all"), null)).toBe(false);
	});

	it("denies scoped keys accessing resources outside their scope", () => {
		expect(isWorkspaceScopeDenied(mockCtx(["ws_a"]), "ws_b")).toBe(true);
	});

	it("allows scoped keys on resources inside their scope", () => {
		expect(isWorkspaceScopeDenied(mockCtx(["ws_a", "ws_b"]), "ws_b")).toBe(false);
	});

	it("denies scoped keys on org-level resources (null workspaceId)", () => {
		// A null workspaceId is an org-wide resource. A scoped key should not
		// be able to reach it — only 'all' keys can.
		expect(isWorkspaceScopeDenied(mockCtx(["ws_a"]), null)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Audit 2: simulate explicit-version validation
// ---------------------------------------------------------------------------

describe("AutomationSimulateRequest — version handling", () => {
	it("accepts a numeric version", () => {
		const parsed = AutomationSimulateRequest.parse({ version: 3 });
		expect(parsed.version).toBe(3);
	});

	it("treats omitted version as undefined (so the route builds a live snapshot)", () => {
		const parsed = AutomationSimulateRequest.parse({});
		expect(parsed.version).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Audit 3: user_input prompt required + LinkedIn reply shape
// ---------------------------------------------------------------------------

describe("AutomationCreateSpec — Audit 3 gates", () => {
	it("user_input_text rejects missing prompt", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "instagram",
			trigger: { type: "instagram_dm" },
			nodes: [
				{
					type: "user_input_text",
					key: "ask",
					save_to_field: "email",
				},
			],
		});
		expect(result.success).toBe(false);
	});

	it("user_input_text accepts a prompt + save_to_field", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "instagram",
			trigger: { type: "instagram_dm" },
			nodes: [
				{
					type: "user_input_text",
					key: "ask",
					prompt: "What's your email?",
					save_to_field: "email",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("linkedin_reply_to_comment accepts comment_urn + share_urn", () => {
		const result = AutomationCreateSpec.safeParse({
			name: "t",
			channel: "linkedin",
			trigger: { type: "linkedin_comment" },
			nodes: [
				{
					type: "linkedin_reply_to_comment",
					key: "reply",
					text: "Thanks!",
					comment_urn: "urn:li:comment:(urn:li:activity:123,456)",
					share_urn: "urn:li:activity:123",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("KeywordReplyTemplateInput rejects unsupported channel (sms)", () => {
		const result = KeywordReplyTemplateInput.safeParse({
			name: "t",
			account_id: "acc_1",
			channel: "sms",
			keywords: ["HELP"],
			reply_message: "hi",
		});
		expect(result.success).toBe(false);
	});

	it("KeywordReplyTemplateInput accepts supported channel (whatsapp)", () => {
		const result = KeywordReplyTemplateInput.safeParse({
			name: "t",
			account_id: "acc_1",
			channel: "whatsapp",
			keywords: ["HELP"],
			reply_message: "hi",
		});
		expect(result.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// smart_delay — quiet_hours window (Audit 4 #6)
// ---------------------------------------------------------------------------

describe("applyQuietHours", () => {
	it("pushes a delay falling inside a daytime window to the end of the window", () => {
		// 2026-04-17 10:00 UTC — inside a 09:00-12:00 UTC quiet window.
		const inside = new Date("2026-04-17T10:00:00Z");
		const out = applyQuietHours(inside, {
			start: "09:00",
			end: "12:00",
			timezone: "UTC",
		});
		expect(out.toISOString()).toBe("2026-04-17T12:00:00.000Z");
	});

	it("leaves delays outside the window untouched", () => {
		const outside = new Date("2026-04-17T15:00:00Z");
		const out = applyQuietHours(outside, {
			start: "22:00",
			end: "07:00",
			timezone: "UTC",
		});
		expect(out.toISOString()).toBe(outside.toISOString());
	});

	it("handles windows that cross midnight — evening tail pushes to next morning", () => {
		// 23:30 UTC is inside a 22:00-07:00 quiet window that crosses midnight.
		const evening = new Date("2026-04-17T23:30:00Z");
		const out = applyQuietHours(evening, {
			start: "22:00",
			end: "07:00",
			timezone: "UTC",
		});
		expect(out.toISOString()).toBe("2026-04-18T07:00:00.000Z");
	});

	it("handles midnight-crossing windows — morning tail pushes to today's end", () => {
		const morning = new Date("2026-04-17T02:00:00Z");
		const out = applyQuietHours(morning, {
			start: "22:00",
			end: "07:00",
			timezone: "UTC",
		});
		expect(out.toISOString()).toBe("2026-04-17T07:00:00.000Z");
	});

	it("ignores malformed windows without stranding the enrollment", () => {
		const d = new Date("2026-04-17T10:00:00Z");
		const out = applyQuietHours(d, {
			start: "nope",
			end: "also nope",
			timezone: "UTC",
		});
		expect(out.toISOString()).toBe(d.toISOString());
	});
});

// ---------------------------------------------------------------------------
// message_media handler (Audit 4 #8) — must fail loudly, not silently skip
// ---------------------------------------------------------------------------

describe("messageMediaHandler", () => {
	it("fails with a descriptive error for message_media", async () => {
		const result = await messageMediaHandler({
			env: {} as never,
			db: {} as never,
			enrollment: {} as never,
			snapshot: {} as never,
			node: {
				id: "n1",
				key: "send_img",
				type: "message_media",
				config: { url: "https://example.com/a.jpg", media_type: "image" },
			},
		});
		expect(result.kind).toBe("fail");
		if (result.kind === "fail") {
			expect(result.error).toContain("platform-specific");
		}
	});

	it("fails for message_file too", async () => {
		const result = await messageMediaHandler({
			env: {} as never,
			db: {} as never,
			enrollment: {} as never,
			snapshot: {} as never,
			node: {
				id: "n1",
				key: "send_doc",
				type: "message_file",
				config: { url: "https://example.com/a.pdf", filename: "a.pdf" },
			},
		});
		expect(result.kind).toBe("fail");
	});
});

// ---------------------------------------------------------------------------
// user_input validation + retry loop (Audit 5 #1)
// ---------------------------------------------------------------------------

describe("validateInput — email", () => {
	it("accepts and lowercases a valid email", () => {
		const v = validateInput("user_input_email", {}, "Alice@Example.com", 0);
		expect(v.kind).toBe("ok");
		if (v.kind === "ok") expect(v.value).toBe("alice@example.com");
	});

	it("retries on invalid email when attempts remain", () => {
		const v = validateInput(
			"user_input_email",
			{ max_attempts: 3 },
			"not-an-email",
			0,
		);
		expect(v.kind).toBe("retry");
	});

	it("fails when attempts are exhausted", () => {
		const v = validateInput(
			"user_input_email",
			{ max_attempts: 2 },
			"still-not-email",
			1,
		);
		expect(v.kind).toBe("fail");
	});
});

describe("validateInput — number", () => {
	it("parses numbers with commas and enforces min/max", () => {
		expect(validateInput("user_input_number", { min: 0, max: 100 }, "42", 0).kind).toBe("ok");
		// 1,000 parses to 1000 which is > max=100. With default max_attempts=2 and
		// attemptsSoFar=0, verdict is "retry" (user gets one more try). Passing
		// attemptsSoFar=1 exhausts attempts.
		expect(
			validateInput("user_input_number", { min: 0, max: 100 }, "1,000", 1).kind,
		).toBe("fail");
		expect(validateInput("user_input_number", {}, "abc", 1).kind).toBe("fail");
	});
});

describe("validateInput — choice", () => {
	const choices = [
		{ label: "Yes", value: "yes" },
		{ label: "No", value: "no" },
	];

	it("matches canonical value", () => {
		const v = validateInput("user_input_choice", { choices }, "yes", 0);
		expect(v.kind).toBe("ok");
		if (v.kind === "ok") expect(v.value).toBe("yes");
	});

	it("matches label case-insensitively and returns the canonical value", () => {
		const v = validateInput("user_input_choice", { choices }, "YES", 0);
		expect(v.kind).toBe("ok");
		if (v.kind === "ok") expect(v.value).toBe("yes");
	});

	it("retries/fails on unknown input", () => {
		const v = validateInput(
			"user_input_choice",
			{ choices, max_attempts: 1 },
			"maybe",
			0,
		);
		expect(v.kind).toBe("fail");
	});
});

describe("validateInput — date", () => {
	it("accepts YYYY-MM-DD and returns ISO", () => {
		const v = validateInput("user_input_date", {}, "2026-04-17", 0);
		expect(v.kind).toBe("ok");
		if (v.kind === "ok") expect(v.value).toBe("2026-04-17");
	});

	it("rejects impossible dates", () => {
		expect(validateInput("user_input_date", {}, "2026-13-40", 0).kind).toBe(
			"retry",
		);
	});

	it("respects custom format", () => {
		const v = validateInput(
			"user_input_date",
			{ format: "DD/MM/YYYY" },
			"17/04/2026",
			0,
		);
		expect(v.kind).toBe("ok");
	});
});

describe("validateInput — file", () => {
	it("accepts a file matching a wildcard mime type", () => {
		const v = validateInput(
			"user_input_file",
			{ accepted_mime_types: ["image/*"], max_size_mb: 5 },
			{ url: "https://example.com/a.png" },
			0,
			{ mime_type: "image/png", size_bytes: 1024 * 100 },
		);
		expect(v.kind).toBe("ok");
	});

	it("accepts a WhatsApp-style attachment (id + mime_type, no size)", () => {
		// WhatsApp webhooks don't include size_bytes — the validator must still
		// accept the upload and skip the size cap. This is the shape that the
		// inbox-event-processor now forwards to resumeFromInput().
		const v = validateInput(
			"user_input_file",
			{ accepted_mime_types: ["application/pdf"], max_size_mb: 16 },
			{ id: "wa_media_123", mime_type: "application/pdf", filename: "invoice.pdf" },
			0,
			{ mime_type: "application/pdf" },
		);
		expect(v.kind).toBe("ok");
	});

	it("still rejects text when the node expects a file", () => {
		const v = validateInput(
			"user_input_file",
			{ accepted_mime_types: ["image/*"] },
			"hi there",
			1,
		);
		expect(v.kind).toBe("fail");
	});

	it("rejects a file exceeding size cap", () => {
		const v = validateInput(
			"user_input_file",
			{ accepted_mime_types: ["image/*"], max_size_mb: 1 },
			{ url: "https://example.com/big.png" },
			1,
			{ mime_type: "image/png", size_bytes: 5 * 1024 * 1024 },
		);
		expect(v.kind).toBe("fail");
	});

	it("rejects a disallowed mime type", () => {
		const v = validateInput(
			"user_input_file",
			{ accepted_mime_types: ["image/*"], max_size_mb: 5 },
			{ url: "https://example.com/a.mp3" },
			1,
			{ mime_type: "audio/mpeg", size_bytes: 1024 },
		);
		expect(v.kind).toBe("fail");
	});
});

describe("validateInput — phone", () => {
	it("accepts E.164", () => {
		expect(validateInput("user_input_phone", {}, "+14155551234", 0).kind).toBe(
			"ok",
		);
	});
	it("accepts with separators", () => {
		expect(
			validateInput("user_input_phone", {}, "(415) 555-1234", 0).kind,
		).toBe("ok");
	});
	it("rejects too-short numbers", () => {
		expect(validateInput("user_input_phone", {}, "12345", 1).kind).toBe("fail");
	});
});

// ---------------------------------------------------------------------------
// Stubbed node types rejected by AutomationNodeSpec (Audit 5 #2)
// ---------------------------------------------------------------------------

describe("AutomationCreateSpec — stubbed node types are rejected", () => {
	const mkBody = (type: string) => ({
		name: "t",
		channel: "instagram" as const,
		trigger: { type: "instagram_comment" },
		nodes: [
			{ type, key: "stub" },
			{ type: "end", key: "e" },
		],
		edges: [{ from: "trigger", to: "stub" }],
	});

	it("rejects ai_step", () => {
		expect(AutomationCreateSpec.safeParse(mkBody("ai_step")).success).toBe(false);
	});

	it("accepts split_test when configured with variants", () => {
		expect(
			AutomationCreateSpec.safeParse({
				name: "t",
				channel: "instagram" as const,
				trigger: { type: "instagram_comment" },
				nodes: [
					{
						type: "split_test",
						key: "experiment",
						variants: [
							{ label: "a", weight: 50 },
							{ label: "b", weight: 50 },
						],
					},
					{ type: "end", key: "e" },
				],
				edges: [{ from: "trigger", to: "experiment" }],
			}).success,
		).toBe(true);
	});

	it("accepts webhook_out when configured with endpoint and event", () => {
		expect(
			AutomationCreateSpec.safeParse({
				name: "t",
				channel: "instagram" as const,
				trigger: { type: "instagram_comment" },
				nodes: [
					{
						type: "webhook_out",
						key: "notify_partner",
						endpoint_id: "wh_123",
						event: "automation.partner_sync",
						payload: {
							comment_id: "{{state.comment_id}}",
							name: "{{first_name}}",
						},
					},
					{ type: "end", key: "e" },
				],
				edges: [{ from: "trigger", to: "notify_partner" }],
			}).success,
		).toBe(true);
	});

	it("accepts subscription_add when configured with a list id", () => {
		expect(
			AutomationCreateSpec.safeParse({
				name: "t",
				channel: "instagram" as const,
				trigger: { type: "instagram_comment" },
				nodes: [
					{
						type: "subscription_add",
						key: "subscribe",
						list_id: "sublist_123",
					},
					{ type: "end", key: "e" },
				],
				edges: [{ from: "trigger", to: "subscribe" }],
			}).success,
		).toBe(true);
	});

	it("accepts conversation_status with inbox-supported statuses", () => {
		expect(
			AutomationCreateSpec.safeParse({
				name: "t",
				channel: "instagram" as const,
				trigger: { type: "instagram_comment" },
				nodes: [
					{
						type: "conversation_status",
						key: "archive_thread",
						status: "archived",
					},
					{ type: "end", key: "e" },
				],
				edges: [{ from: "trigger", to: "archive_thread" }],
			}).success,
		).toBe(true);
	});

	it("rejects notify_admin", () => {
		expect(AutomationCreateSpec.safeParse(mkBody("notify_admin")).success).toBe(
			false,
		);
	});
});

describe("resolveTemplatedValue", () => {
	it("resolves merge tags recursively in nested objects and arrays", () => {
		expect(
			resolveTemplatedValue(
				{
					message: "Hi {{first_name}}",
					metadata: {
						comment_id: "{{state.comment_id}}",
						tags: ["{{state.variant}}", "static"],
					},
				},
				{
					contact: { first_name: "Zan" },
					state: { comment_id: "c_123", variant: "control" },
				},
			),
		).toEqual({
			message: "Hi Zan",
			metadata: {
				comment_id: "c_123",
				tags: ["control", "static"],
			},
		});
	});
});
