import { describe, expect, it } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type RelayLike, registerTools, type ToolResult } from "../src/server";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function harness() {
	const handlers = new Map<string, Handler>();
	const server = {
		registerTool(name: string, _config: unknown, handler: Handler) {
			handlers.set(name, handler);
		},
	};
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const result = (method: string, ...args: unknown[]) => {
		calls.push({ method, args });
		return Promise.resolve({ method, args });
	};
	const client: RelayLike = {
		automations: {
			catalog: () => result("catalog"),
			list: (query) => result("list", query),
			retrieve: (id) => result("retrieve", id),
			create: (body) => result("create", body),
			update: (id, body) => result("update", id, body),
			delete: (id) => result("delete", id),
			activate: (id) => result("activate", id),
			pause: (id) => result("pause", id),
			resume: (id) => result("resume", id),
			archive: (id) => result("archive", id),
			simulate: (id, body) => result("simulate", id, body),
		},
		automationRuns: {
			list: (id, query) => result("runs.list", id, query),
			listSteps: (id, query) => result("runs.listSteps", id, query),
		},
	};
	registerTools(server as unknown as McpServer, client);
	return { handlers, calls };
}

describe("MCP automation tools", () => {
	it("registers only tools backed by real SDK methods", () => {
		const { handlers } = harness();
		expect([...handlers.keys()].sort()).toEqual(
			[
				"relayapi_activate_automation",
				"relayapi_archive_automation",
				"relayapi_create_automation",
				"relayapi_create_automation_from_template",
				"relayapi_delete_automation",
				"relayapi_get_automation",
				"relayapi_get_automation_schema",
				"relayapi_list_automation_run_steps",
				"relayapi_list_automation_runs",
				"relayapi_list_automations",
				"relayapi_pause_automation",
				"relayapi_resume_automation",
				"relayapi_simulate_automation",
				"relayapi_update_automation",
			].sort(),
		);
		expect(handlers.has("relayapi_publish_automation")).toBe(false);
		expect(handlers.has("relayapi_list_automation_enrollments")).toBe(false);
	});

	it("maps catalog, lifecycle, runs, and templates to the SDK", async () => {
		const { handlers, calls } = harness();
		await handlers.get("relayapi_get_automation_schema")?.({});
		await handlers.get("relayapi_activate_automation")?.({ id: "auto_1" });
		await handlers.get("relayapi_list_automation_runs")?.({
			id: "auto_1",
			status: "waiting",
			limit: 5,
		});
		await handlers.get("relayapi_list_automation_run_steps")?.({
			run_id: "run_1",
			limit: 10,
		});
		await handlers.get("relayapi_create_automation_from_template")?.({
			name: "Welcome",
			channel: "instagram",
			template_kind: "welcome_flow",
			config: { account_id: "acc_1" },
		});

		expect(calls).toEqual([
			{ method: "catalog", args: [] },
			{ method: "activate", args: ["auto_1"] },
			{
				method: "runs.list",
				args: ["auto_1", { status: "waiting", limit: 5 }],
			},
			{ method: "runs.listSteps", args: ["run_1", { limit: 10 }] },
			{
				method: "create",
				args: [
					{
						name: "Welcome",
						channel: "instagram",
						template: {
							kind: "welcome_flow",
							config: { account_id: "acc_1" },
						},
					},
				],
			},
		]);
	});
});
