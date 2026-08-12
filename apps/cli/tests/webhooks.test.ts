import { describe, expect, it, spyOn } from "bun:test";
import { Command } from "commander";
import {
	findWebhookById,
	parsePageSize,
	parseWebhookEvents,
	registerWebhookCommands,
} from "../src/commands/webhooks";

const webhook = {
	id: "wh_example",
	url: "https://example.com/relay-events",
	enabled: true,
	events: ["post.published"],
	created_at: "2026-08-08T10:00:00.000Z",
	updated_at: "2026-08-08T10:00:00.000Z",
};

describe("webhook command input validation", () => {
	it("normalizes, de-duplicates, and validates event names", () => {
		expect(
			parseWebhookEvents(
				" post.published,post.failed,post.published,message.received ",
			),
		).toEqual(["post.published", "post.failed", "message.received"]);
		expect(() => parseWebhookEvents("post.*")).toThrow(
			"Unsupported webhook event: post.*",
		);
		expect(() => parseWebhookEvents("post.published,")).toThrow(
			"Provide at least one webhook event",
		);
	});

	it("accepts only API pagination limits", () => {
		expect(parsePageSize("1")).toBe(1);
		expect(parsePageSize("100")).toBe(100);
		expect(() => parsePageSize("0")).toThrow("integer from 1 to 100");
		expect(() => parsePageSize("2.5")).toThrow("integer from 1 to 100");
		expect(() => parsePageSize("not-a-number")).toThrow(
			"integer from 1 to 100",
		);
	});
});

describe("webhook lookup", () => {
	it("pages the SDK list operation until it finds the requested endpoint", async () => {
		const queries: unknown[] = [];
		const list = async (query: unknown) => {
			queries.push(query);
			return queries.length === 1
				? { data: [], has_more: true, next_cursor: "next-page" }
				: { data: [webhook], has_more: false, next_cursor: null };
		};

		const result = await findWebhookById(
			{ list } as never,
			"wh_example",
			"ws_example",
		);

		expect(result).toEqual(webhook);
		expect(queries).toEqual([
			{ limit: 100, cursor: undefined, workspace_id: "ws_example" },
			{ limit: 100, cursor: "next-page", workspace_id: "ws_example" },
		]);
	});

	it("fails closed on a repeated pagination cursor", async () => {
		const list = async () => ({
			data: [],
			has_more: true,
			next_cursor: "same-cursor",
		});

		await expect(
			findWebhookById({ list } as never, "wh_missing"),
		).rejects.toThrow("invalid repeated cursor");
	});
});

describe("webhook commands", () => {
	it("registers only operations supported by the current SDK/API", () => {
		const program = createProgram({});
		const group = program.commands.find(
			(command) => command.name() === "webhooks",
		);
		expect(group).toBeDefined();
		expect(group?.commands.map((command) => command.name())).toEqual([
			"list",
			"create",
			"get",
			"update",
			"delete",
			"test",
			"logs",
			"rotate-secret",
		]);
		expect(
			group?.commands.find((command) => command.name() === "logs")?.aliases(),
		).toEqual(["deliveries"]);
		expect(
			group?.commands.some((command) => command.name() === "redeliver"),
		).toBe(false);
		expect(group?.commands.some((command) => command.name() === "listen")).toBe(
			false,
		);
	});

	it("maps create, update, get, test, logs, rotation, and deletion to SDK calls", async () => {
		const calls: Array<{ operation: string; args: unknown[] }> = [];
		const client = {
			webhooks: {
				async create(...args: unknown[]) {
					calls.push({ operation: "create", args });
					return { ...webhook, secret: "secret_once" };
				},
				async update(...args: unknown[]) {
					calls.push({ operation: "update", args });
					return { ...webhook, enabled: false };
				},
				async list(...args: unknown[]) {
					calls.push({ operation: "list", args });
					return { data: [webhook], has_more: false, next_cursor: null };
				},
				async delete(...args: unknown[]) {
					calls.push({ operation: "delete", args });
				},
				async listLogs(...args: unknown[]) {
					calls.push({ operation: "listLogs", args });
					return { data: [], has_more: false, next_cursor: null };
				},
				async sendTest(...args: unknown[]) {
					calls.push({ operation: "sendTest", args });
					return { success: true, status_code: 204, response_time_ms: 12 };
				},
				async rotateSecret(...args: unknown[]) {
					calls.push({ operation: "rotateSecret", args });
					return { ...webhook, secret: "replacement_secret" };
				},
			},
		};
		const log = spyOn(console, "log").mockImplementation(() => undefined);

		try {
			await run(client, [
				"webhooks",
				"create",
				"--url",
				"https://example.com/relay-events",
				"--events",
				"post.published,post.failed",
				"--workspace",
				"ws_example",
			]);
			await run(client, ["webhooks", "get", "wh_example"]);
			await run(client, [
				"webhooks",
				"update",
				"wh_example",
				"--disabled",
				"--events",
				"message.received",
			]);
			await run(client, ["webhooks", "test", "wh_example"]);
			await run(client, ["webhooks", "logs", "--limit", "50"]);
			await run(client, ["webhooks", "rotate-secret", "wh_example", "--yes"]);
			await run(client, ["webhooks", "delete", "wh_example", "--yes"]);
		} finally {
			log.mockRestore();
		}

		expect(calls).toEqual([
			{
				operation: "create",
				args: [
					{
						url: "https://example.com/relay-events",
						events: ["post.published", "post.failed"],
						workspace_id: "ws_example",
					},
				],
			},
			{
				operation: "list",
				args: [{ limit: 100, cursor: undefined, workspace_id: undefined }],
			},
			{
				operation: "update",
				args: [
					"wh_example",
					{
						url: undefined,
						events: ["message.received"],
						enabled: false,
					},
				],
			},
			{
				operation: "sendTest",
				args: [{ webhook_id: "wh_example" }],
			},
			{
				operation: "listLogs",
				args: [{ limit: 50, cursor: undefined }],
			},
			{ operation: "rotateSecret", args: ["wh_example"] },
			{ operation: "delete", args: ["wh_example"] },
		]);
	});
});

function createProgram(client: object): Command {
	const program = new Command()
		.name("relay")
		.exitOverride()
		.option("--table", "Output as formatted table");
	registerWebhookCommands(program, {
		createClient: () => client as never,
	});
	return program;
}

async function run(client: object, args: string[]): Promise<void> {
	await createProgram(client).parseAsync(args, { from: "user" });
}
