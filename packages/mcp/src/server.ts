import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// The MCP SDK's registerTool<OutputArgs, InputArgs> uses nested conditional
// generics that compound across tools; participating in the full inference
// graph with 14 registrations OOMs tsc. `tool()` below is a typed wrapper
// that casts through `unknown` so each registration is type-checked locally.
type LooseServer = {
	registerTool: (
		name: string,
		config: {
			description?: string;
			inputSchema?: Record<string, unknown>;
		},
		cb: (args: Record<string, unknown>) => unknown,
	) => unknown;
};

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

type ToolHandler<Args> = (args: Args) => Promise<ToolResult>;

function tool<Args>(
	mcp: McpServer,
	name: string,
	description: string,
	inputSchema: Record<string, z.ZodTypeAny>,
	handler: ToolHandler<Args>,
): void {
	const loose = mcp as unknown as LooseServer;
	loose.registerTool(
		name,
		{ description, inputSchema: inputSchema as Record<string, unknown> },
		handler as (args: Record<string, unknown>) => unknown,
	);
}

// The SDK's generic type surface interacts badly with the MCP SDK's tool
// inference — use a loose local shape instead of importing the full Relay type.
type RelayLike = {
	automations: {
		schema: () => Promise<unknown>;
		list: (query: unknown) => Promise<unknown>;
		retrieve: (id: string) => Promise<unknown>;
		create: (body: unknown) => Promise<unknown>;
		update: (id: string, body: unknown) => Promise<unknown>;
		delete: (id: string) => Promise<unknown>;
		publish: (id: string) => Promise<unknown>;
		pause: (id: string) => Promise<unknown>;
		resume: (id: string) => Promise<unknown>;
		archive: (id: string) => Promise<unknown>;
		listEnrollments: (id: string, query: unknown) => Promise<unknown>;
		listRuns: (id: string, enrollmentId: string) => Promise<unknown>;
		simulate: (id: string, body: unknown) => Promise<unknown>;
		templates: {
			commentToDm: (input: unknown) => Promise<unknown>;
			welcomeDm: (input: unknown) => Promise<unknown>;
			keywordReply: (input: unknown) => Promise<unknown>;
			followToDm: (input: unknown) => Promise<unknown>;
			storyReply: (input: unknown) => Promise<unknown>;
			giveaway: (input: unknown) => Promise<unknown>;
		};
	};
};

const AUTOMATION_CHANNELS = [
	"instagram",
	"facebook",
	"whatsapp",
	"telegram",
	"discord",
	"sms",
	"twitter",
	"bluesky",
	"threads",
	"youtube",
	"linkedin",
	"mastodon",
	"reddit",
	"googlebusiness",
	"beehiiv",
	"kit",
	"mailchimp",
	"listmonk",
	"pinterest",
	"multi",
] as const;

const AUTOMATION_STATUSES = ["draft", "active", "paused", "archived"] as const;

const ENROLLMENT_STATUSES = [
	"active",
	"waiting",
	"completed",
	"exited",
	"failed",
] as const;

const TEMPLATE_IDS = [
	"comment-to-dm",
	"welcome-dm",
	"keyword-reply",
	"follow-to-dm",
	"story-reply",
	"giveaway",
] as const;

function asText(data: unknown): ToolResult {
	return {
		content: [
			{ type: "text", text: JSON.stringify(data, null, 2) },
		],
	};
}

function asError(err: unknown): ToolResult {
	const msg = err instanceof Error ? err.message : String(err);
	return {
		isError: true,
		content: [{ type: "text", text: `Error: ${msg}` }],
	};
}

/**
 * Registers every RelayAPI automation tool. Each tool is a thin wrapper over
 * the SDK — the tool description tells the LLM which SDK method it maps to.
 */
export function registerTools(mcp: McpServer, client: RelayLike): void {
	// --------------------------------------------------------------------- //
	// Schema introspection — primary entry point for agents
	// --------------------------------------------------------------------- //

	tool<Record<string, never>>(
		mcp,
		"relayapi_get_automation_schema",
		"Fetch the self-describing catalog of automation trigger types, node types, templates, and merge tags. Call this first when creating or updating automations so enums are never guessed. Maps to sdk.automations.schema().",
		{},
		async () => {
			try {
				return asText(await client.automations.schema());
			} catch (e) {
				return asError(e);
			}
		},
	);

	// --------------------------------------------------------------------- //
	// Automation CRUD
	// --------------------------------------------------------------------- //

	tool<{
		cursor?: string;
		limit?: number;
		workspace_id?: string;
		status?: (typeof AUTOMATION_STATUSES)[number];
		channel?: (typeof AUTOMATION_CHANNELS)[number];
		trigger_type?: string;
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
			trigger_type: z.string().optional(),
		},
		async (args) => {
			try {
				return asText(await client.automations.list(args));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_get_automation",
		"Retrieve an automation with its full graph (nodes + edges). Maps to sdk.automations.retrieve(id).",
		{ id: z.string() },
		async ({ id }) => {
			try {
				return asText(await client.automations.retrieve(id));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<Record<string, unknown>>(
		mcp,
		"relayapi_create_automation",
		"Create an automation from a single-blob spec (trigger + nodes + edges). Always call relayapi_get_automation_schema first to learn the valid trigger/node types and field shapes. Maps to sdk.automations.create(body).",
		{
			name: z.string(),
			description: z.string().optional(),
			workspace_id: z.string().optional(),
			channel: z.enum(AUTOMATION_CHANNELS),
			status: z.enum(AUTOMATION_STATUSES).optional(),
			trigger: z
				.object({
					type: z.string(),
					account_id: z.string().optional(),
					config: z.record(z.string(), z.unknown()).optional(),
					filters: z.record(z.string(), z.unknown()).optional(),
				})
				.describe(
					"Trigger spec. type must be from the catalog returned by relayapi_get_automation_schema.",
				),
			nodes: z
				.array(z.record(z.string(), z.unknown()))
				.describe(
					"Array of node objects. Each node has flat fields: {type, key, ...type-specific fields}.",
				),
			edges: z
				.array(
					z.object({
						from: z.string(),
						to: z.string(),
						label: z.string().optional(),
						order: z.number().int().optional(),
						condition_expr: z.unknown().optional(),
					}),
				)
				.optional(),
			exit_on_reply: z.boolean().optional(),
			allow_reentry: z.boolean().optional(),
			reentry_cooldown_min: z.number().int().optional(),
		},
		async (args) => {
			try {
				return asText(await client.automations.create(args));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string; body: Record<string, unknown> }>(
		mcp,
		"relayapi_update_automation",
		"Update automation metadata, trigger, or body. Partial — only send fields you want to change. Maps to sdk.automations.update(id, body).",
		{
			id: z.string(),
			body: z.record(z.string(), z.unknown()),
		},
		async ({ id, body }) => {
			try {
				return asText(await client.automations.update(id, body));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_delete_automation",
		"Delete an automation. Maps to sdk.automations.delete(id).",
		{ id: z.string() },
		async ({ id }) => {
			try {
				await client.automations.delete(id);
				return asText({ deleted: true, id });
			} catch (e) {
				return asError(e);
			}
		},
	);

	// --------------------------------------------------------------------- //
	// Lifecycle
	// --------------------------------------------------------------------- //

	tool<{ id: string }>(
		mcp,
		"relayapi_publish_automation",
		"Publish the current graph as a new version snapshot. Maps to sdk.automations.publish(id).",
		{ id: z.string() },
		async ({ id }) => {
			try {
				return asText(await client.automations.publish(id));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_pause_automation",
		"Pause an active automation. Maps to sdk.automations.pause(id).",
		{ id: z.string() },
		async ({ id }) => {
			try {
				return asText(await client.automations.pause(id));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_resume_automation",
		"Resume a paused automation (auto-publishes if no version exists). Maps to sdk.automations.resume(id).",
		{ id: z.string() },
		async ({ id }) => {
			try {
				return asText(await client.automations.resume(id));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string }>(
		mcp,
		"relayapi_archive_automation",
		"Archive an automation. Maps to sdk.automations.archive(id).",
		{ id: z.string() },
		async ({ id }) => {
			try {
				return asText(await client.automations.archive(id));
			} catch (e) {
				return asError(e);
			}
		},
	);

	// --------------------------------------------------------------------- //
	// Observability
	// --------------------------------------------------------------------- //

	tool<{
		id: string;
		cursor?: string;
		limit?: number;
		status?: (typeof ENROLLMENT_STATUSES)[number];
	}>(
		mcp,
		"relayapi_list_automation_enrollments",
		"List enrollments for an automation (contacts currently running through it). Maps to sdk.automations.listEnrollments(id, query).",
		{
			id: z.string(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
			status: z.enum(ENROLLMENT_STATUSES).optional(),
		},
		async ({ id, ...query }) => {
			try {
				return asText(await client.automations.listEnrollments(id, query));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{ id: string; enrollment_id: string }>(
		mcp,
		"relayapi_list_automation_runs",
		"Get the per-node execution log for a specific enrollment. Maps to sdk.automations.listRuns(id, enrollmentId).",
		{
			id: z.string(),
			enrollment_id: z.string(),
		},
		async ({ id, enrollment_id }) => {
			try {
				return asText(await client.automations.listRuns(id, enrollment_id));
			} catch (e) {
				return asError(e);
			}
		},
	);

	tool<{
		id: string;
		version?: number;
		branch_choices?: Record<string, string>;
		max_steps?: number;
	}>(
		mcp,
		"relayapi_simulate_automation",
		"Dry-run the graph without executing handlers or side effects. Returns the predicted node path. Use branch_choices to force a branch on condition / randomizer / intent-router nodes. Maps to sdk.automations.simulate(id, body).",
		{
			id: z.string(),
			version: z.number().int().optional(),
			branch_choices: z.record(z.string(), z.string()).optional(),
			max_steps: z.number().int().min(1).max(200).optional(),
		},
		async ({ id, ...body }) => {
			try {
				return asText(await client.automations.simulate(id, body));
			} catch (e) {
				return asError(e);
			}
		},
	);

	// --------------------------------------------------------------------- //
	// Templates (quick-create)
	// --------------------------------------------------------------------- //

	tool<{
		template_id: (typeof TEMPLATE_IDS)[number];
		input: Record<string, unknown>;
	}>(
		mcp,
		"relayapi_create_automation_from_template",
		"Create an automation from a built-in template. Call relayapi_get_automation_schema first to see the input shape for each template. Maps to sdk.automations.templates.<template>(input).",
		{
			template_id: z.enum(TEMPLATE_IDS),
			input: z
				.record(z.string(), z.unknown())
				.describe(
					"Template-specific input. Shape differs per template — use the schema catalog.",
				),
		},
		async ({ template_id, input }) => {
			try {
				const t = client.automations.templates;
				let result;
				switch (template_id) {
					case "comment-to-dm":
						result = await t.commentToDm(input);
						break;
					case "welcome-dm":
						result = await t.welcomeDm(input);
						break;
					case "keyword-reply":
						result = await t.keywordReply(input);
						break;
					case "follow-to-dm":
						result = await t.followToDm(input);
						break;
					case "story-reply":
						result = await t.storyReply(input);
						break;
					case "giveaway":
						result = await t.giveaway(input);
						break;
				}
				return asText(result);
			} catch (e) {
				return asError(e);
			}
		},
	);
}

export function createServer(client: RelayLike): McpServer {
	const server = new McpServer({
		name: "relayapi",
		version: "0.1.0",
	});
	registerTools(server, client);
	return server;
}
