// apps/api/src/__tests__/automation-action-group.test.ts
//
// Unit tests for the action_group node handler. We monkey-patch the action
// registry with a minimal set of test-only handlers so the test stays purely
// in-memory (no DB required).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { actionRegistry } from "../services/automations/actions";
import { actionGroupHandler } from "../services/automations/nodes/action-group";
import type { RunContext } from "../services/automations/types";

// Back up and restore the real registry so we don't leak test handlers across
// suites. The registry object itself is mutated in-place.
const snapshot: Record<string, unknown> = {};
beforeEach(() => {
	for (const k of Object.keys(actionRegistry)) snapshot[k] = actionRegistry[k];
	// Strip real handlers we don't want to accidentally call.
	for (const k of Object.keys(actionRegistry)) delete actionRegistry[k];
});
afterEach(() => {
	for (const k of Object.keys(actionRegistry)) delete actionRegistry[k];
	for (const [k, v] of Object.entries(snapshot)) {
		actionRegistry[k] = v as never;
	}
});

function makeCtx(): RunContext {
	return {
		runId: "arun_t",
		automationId: "auto_t",
		organizationId: "org_t",
		contactId: "ct_t",
		conversationId: null,
		channel: "telegram",
		graph: { schema_version: 1, root_node_key: null, nodes: [], edges: [] },
		context: {},
		now: new Date(),
		// Not exercised by action-group's routing logic — actions are stubbed.
		db: null as unknown as RunContext["db"],
		env: {},
	};
}

function makeNode(actions: Array<Record<string, unknown>>) {
	return {
		key: "ag",
		kind: "action_group",
		config: { actions } as never,
	};
}

describe("action_group handler", () => {
	it("advances via next when all actions succeed", async () => {
		const calls: string[] = [];
		actionRegistry.fake_ok_a = async () => {
			calls.push("a");
		};
		actionRegistry.fake_ok_b = async () => {
			calls.push("b");
		};

		const result = await actionGroupHandler.handle(
			makeNode([
				{ id: "a1", type: "fake_ok_a", on_error: "abort" },
				{ id: "a2", type: "fake_ok_b", on_error: "abort" },
			]),
			makeCtx(),
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("next");
		expect(calls).toEqual(["a", "b"]);
		expect(result.payload.action_results).toEqual([
			{ id: "a1", ok: true },
			{ id: "a2", ok: true },
		]);
	});

	it("routes via error and stops when an action with on_error=abort throws", async () => {
		const calls: string[] = [];
		actionRegistry.fake_boom = async () => {
			calls.push("boom");
			throw new Error("kaboom");
		};
		actionRegistry.fake_never = async () => {
			calls.push("never");
		};

		const result = await actionGroupHandler.handle(
			makeNode([
				{ id: "a1", type: "fake_boom", on_error: "abort" },
				{ id: "a2", type: "fake_never", on_error: "abort" },
			]),
			makeCtx(),
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		expect(calls).toEqual(["boom"]); // second action NOT called
		expect(result.payload.action_results).toEqual([
			{ id: "a1", ok: false, error: "kaboom" },
		]);
	});

	it("continues past a failed action when on_error=continue and advances via next", async () => {
		const calls: string[] = [];
		actionRegistry.fake_soft_fail = async () => {
			calls.push("fail");
			throw new Error("meh");
		};
		actionRegistry.fake_ok = async () => {
			calls.push("ok");
		};

		const result = await actionGroupHandler.handle(
			makeNode([
				{ id: "a1", type: "fake_soft_fail", on_error: "continue" },
				{ id: "a2", type: "fake_ok", on_error: "abort" },
			]),
			makeCtx(),
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("next");
		expect(calls).toEqual(["fail", "ok"]);
		expect(result.payload.action_results).toEqual([
			{ id: "a1", ok: false, error: "meh" },
			{ id: "a2", ok: true },
		]);
	});

	it("routes via error when an action type is not registered", async () => {
		const result = await actionGroupHandler.handle(
			makeNode([
				{ id: "a1", type: "not_registered", on_error: "abort" },
			]),
			makeCtx(),
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		expect(result.payload.action_results[0].ok).toBe(false);
		expect(result.payload.action_results[0].error).toContain("unknown action");
	});

	it("webhook_out surfaces missing hmac secret through on_error routing", async () => {
		// Import the real webhook handler into the stubbed registry so we can
		// exercise its config-validation path. fetch is never reached because
		// the handler throws synchronously on the missing secret.
		const { webhookHandlers } = await import(
			"../services/automations/actions/webhook"
		);
		actionRegistry.webhook_out = webhookHandlers.webhook_out!;

		const result = await actionGroupHandler.handle(
			makeNode([
				{
					id: "wh1",
					type: "webhook_out",
					url: "https://example.com/hook",
					method: "POST",
					auth: { mode: "hmac" },
					on_error: "abort",
				},
			]),
			makeCtx(),
		);

		expect(result.result).toBe("advance");
		if (result.result === "advance") expect(result.via_port).toBe("error");
		expect(result.payload.action_results[0].ok).toBe(false);
		expect(result.payload.action_results[0].error).toContain(
			"hmac auth requires secret",
		);
	});
});
