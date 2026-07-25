import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "./version.js";

type LooseServer = {
	registerTool: (
		name: string,
		config: {
			description?: string;
			inputSchema?: Record<string, unknown>;
		},
		callback: (args: Record<string, unknown>) => unknown,
	) => unknown;
};

export type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

type ToolHandler<Args> = (args: Args) => Promise<ToolResult>;

function tool<Args>(
	mcp: McpServer,
	name: string,
	description: string,
	inputSchema: Record<string, z.ZodType>,
	handler: ToolHandler<Args>,
): void {
	(mcp as unknown as LooseServer).registerTool(
		name,
		{ description, inputSchema: inputSchema as Record<string, unknown> },
		handler as (args: Record<string, unknown>) => unknown,
	);
}

/** The exact SDK methods used by this MCP server. */
export type RelayLike = {
	automations: {
		catalog: () => Promise<unknown>;
		list: (query: Record<string, unknown>) => Promise<unknown>;
		retrieve: (id: string) => Promise<unknown>;
		create: (body: Record<string, unknown>) => Promise<unknown>;
		update: (id: string, body: Record<string, unknown>) => Promise<unknown>;
		delete: (id: string) => Promise<unknown>;
		activate: (id: string) => Promise<unknown>;
		pause: (id: string) => Promise<unknown>;
		resume: (id: string) => Promise<unknown>;
		archive: (id: string) => Promise<unknown>;
		simulate: (id: string, body: Record<string, unknown>) => Promise<unknown>;
	};
	automationRuns: {
		list: (
			automationId: string,
			query: Record<string, unknown>,
		) => Promise<unknown>;
		listSteps: (
			runId: string,
			query: Record<string, unknown>,
		) => Promise<unknown>;
	};
};

const AUTOMATION_CHANNELS = [
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
] as const;
const AUTOMATION_STATUSES = ["draft", "active", "paused", "archived"] as const;
const RUN_STATUSES = [
	"active",
	"waiting",
	"completed",
	"exited",
	"failed",
] as const;
const TEMPLATE_KINDS = [
	"blank",
	"welcome_flow",
	"faq_bot",
	"lead_capture",
	"comment_to_dm",
	"story_leads",
	"follower_growth",
	"follow_to_dm",
] as const;

function asText(data: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function asError(error: unknown): ToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		isError: true,
		content: [{ type: "text", text: `Error: ${message}` }],
	};
}

async function call(operation: () => Promise<unknown>): Promise<ToolResult> {
	try {
		return asText(await operation());
	} catch (error) {
		return asError(error);
	}
}

/** Register tools that map one-to-one to methods present in @relayapi/sdk. */
export function registerTools(mcp: McpServer, client: RelayLike): void {
	tool<Record<string, never>>(
		mcp,
		"relayapi_get_automation_schema",
		"Fetch the automation catalog of node, entrypoint, binding, action, channel, and template definitions. Call this before creating an automation. Maps to sdk.automations.catalog().",
		{},
		async () => call(() => client.automations.catalog()),
	);

	tool<{
		cursor?: string;
		limit?: number;
		workspace_id?: string;
		status?: (typeof AUTOMATION_STATUSES)[number];
		channel?: (typeof AUTOMATION_CHANNELS)[number];
		created_from_template?: string;
		q?: string;
	}>(
		mcp,
		"relayapi_list_automations",
		"List automations for the authenticated organization. Maps to sdk.automations.list(query).",
		{
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			workspace_id: z.string().optional(),
			status: z.enum(AUTOMATION_STATUSES).optional(),
			channel: z.enum(AUTOMATION_CHANNELS).optional(),
			created_from_template: z.string().optional(),
			q: z.string().optional(),
		},
		async (args) => call(() => client.automations.list(args)),
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_get_automation",
		"Retrieve an automation and its full graph. Maps to sdk.automations.retrieve(id).",
		{ id: z.string() },
		async ({ id }) => call(() => client.automations.retrieve(id)),
	);

	tool<{
		name: string;
		description?: string;
		channel: (typeof AUTOMATION_CHANNELS)[number];
		workspace_id?: string;
	}>(
		mcp,
		"relayapi_create_automation",
		"Create a blank automation. Add its graph through the RelayAPI dashboard or SDK updateGraph method. Maps to sdk.automations.create(body).",
		{
			name: z.string().min(1).max(200),
			description: z.string().max(1000).optional(),
			channel: z.enum(AUTOMATION_CHANNELS),
			workspace_id: z.string().optional(),
		},
		async (args) => call(() => client.automations.create(args)),
	);

	tool<{ id: string; name?: string; description?: string }>(
		mcp,
		"relayapi_update_automation",
		"Update automation name or description. Maps to sdk.automations.update(id, body).",
		{
			id: z.string(),
			name: z.string().min(1).max(200).optional(),
			description: z.string().max(1000).optional(),
		},
		async ({ id, ...body }) => call(() => client.automations.update(id, body)),
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_delete_automation",
		"Permanently delete an automation. Maps to sdk.automations.delete(id).",
		{ id: z.string() },
		async ({ id }) =>
			call(async () => {
				await client.automations.delete(id);
				return { deleted: true, id };
			}),
	);

	for (const lifecycle of ["activate", "pause", "resume", "archive"] as const) {
		tool<{ id: string }>(
			mcp,
			`relayapi_${lifecycle}_automation`,
			`${lifecycle[0]?.toUpperCase()}${lifecycle.slice(1)} an automation. Maps to sdk.automations.${lifecycle}(id).`,
			{ id: z.string() },
			async ({ id }) => call(() => client.automations[lifecycle](id)),
		);
	}

	tool<{
		id: string;
		cursor?: string;
		limit?: number;
		status?: (typeof RUN_STATUSES)[number];
		contact_id?: string;
		started_after?: string;
		started_before?: string;
	}>(
		mcp,
		"relayapi_list_automation_runs",
		"List automation runs, newest first. Maps to sdk.automationRuns.list(automationId, query).",
		{
			id: z.string(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			status: z.enum(RUN_STATUSES).optional(),
			contact_id: z.string().optional(),
			started_after: z.string().optional(),
			started_before: z.string().optional(),
		},
		async ({ id, ...query }) =>
			call(() => client.automationRuns.list(id, query)),
	);

	tool<{ run_id: string; cursor?: string; limit?: number }>(
		mcp,
		"relayapi_list_automation_run_steps",
		"List the append-only node execution log for one run. Maps to sdk.automationRuns.listSteps(runId, query).",
		{
			run_id: z.string(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		},
		async ({ run_id, ...query }) =>
			call(() => client.automationRuns.listSteps(run_id, query)),
	);

	tool<{
		id: string;
		start_node_key?: string;
		test_context?: Record<string, unknown>;
		branch_choices?: Record<string, string>;
		execute_side_effects?: boolean;
	}>(
		mcp,
		"relayapi_simulate_automation",
		"Simulate an automation graph. Side effects are disabled unless explicitly requested. Maps to sdk.automations.simulate(id, body).",
		{
			id: z.string(),
			start_node_key: z.string().optional(),
			test_context: z.record(z.string(), z.unknown()).optional(),
			branch_choices: z.record(z.string(), z.string()).optional(),
			execute_side_effects: z.boolean().optional(),
		},
		async ({ id, ...body }) =>
			call(() => client.automations.simulate(id, body)),
	);

	tool<{
		name: string;
		description?: string;
		channel: (typeof AUTOMATION_CHANNELS)[number];
		workspace_id?: string;
		template_kind: (typeof TEMPLATE_KINDS)[number];
		config?: Record<string, unknown>;
	}>(
		mcp,
		"relayapi_create_automation_from_template",
		"Create an automation from a built-in server template. Use relayapi_get_automation_schema first for template configuration. Maps to sdk.automations.create({ template }).",
		{
			name: z.string().min(1).max(200),
			description: z.string().max(1000).optional(),
			channel: z.enum(AUTOMATION_CHANNELS),
			workspace_id: z.string().optional(),
			template_kind: z.enum(TEMPLATE_KINDS),
			config: z.record(z.string(), z.unknown()).optional(),
		},
		async ({ template_kind, config, ...body }) =>
			call(() =>
				client.automations.create({
					...body,
					template: { kind: template_kind, config: config ?? {} },
				}),
			),
	);
}

export function createServer(client: RelayLike): McpServer {
	const server = new McpServer({ name: "relayapi", version: VERSION });
	registerTools(server, client);
	return server;
}
