import * as prompts from "@clack/prompts";
import { type Command, Option } from "commander";
import { createClient } from "../client.js";
import {
	isTableMode,
	outputJson,
	outputSuccess,
	outputTable,
	truncate,
	withErrorHandler,
} from "../output.js";

type RelayClient = ReturnType<typeof createClient>;
type WebhookOperations = RelayClient["webhooks"];
type WebhookCreateInput = Parameters<WebhookOperations["create"]>[0];
type WebhookUpdateInput = Parameters<WebhookOperations["update"]>[1];
type WebhookListInput = NonNullable<Parameters<WebhookOperations["list"]>[0]>;
type WebhookListResult = Awaited<ReturnType<WebhookOperations["list"]>>;
type WebhookSummary = WebhookListResult["data"][number];
type WebhookEvent = WebhookCreateInput["events"][number];

export const WEBHOOK_EVENTS = [
	"post.published",
	"post.partial",
	"post.failed",
	"post.scheduled",
	"post.recycled",
	"thread.published",
	"account.connected",
	"account.disconnected",
	"comment.received",
	"message.received",
	"message.sent",
	"auto_post.created",
	"auto_post.error",
	"streak.started",
	"streak.milestone",
	"streak.warning",
	"streak.broken",
	"cross_post_action.executed",
	"cross_post_action.failed",
] as const satisfies readonly WebhookEvent[];

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

interface WebhookCommandDependencies {
	createClient?: () => RelayClient;
}

export function registerWebhookCommands(
	program: Command,
	dependencies: WebhookCommandDependencies = {},
): void {
	const getClient = dependencies.createClient ?? createClient;
	const webhooks = program
		.command("webhooks")
		.description("Manage customer webhook endpoints and delivery logs")
		.action(() => {
			webhooks.help();
		});

	webhooks
		.command("list")
		.description("List webhook endpoints")
		.option("--limit <n>", "Items per page (1-100)", "20")
		.option("--cursor <cursor>", "Pagination cursor")
		.option("--workspace <id>", "Filter by workspace ID")
		.action(async (opts) => {
			await withErrorHandler(async () => {
				const result = await getClient().webhooks.list({
					limit: parsePageSize(opts.limit),
					cursor: opts.cursor,
					workspace_id: opts.workspace,
				});

				if (isTableMode(program.opts())) {
					outputTable(
						result.data.map((webhook) => ({
							id: webhook.id,
							enabled: webhook.enabled ? "yes" : "no",
							url: truncate(webhook.url, 48),
							events: webhook.events.join(", "),
							updated_at: webhook.updated_at,
						})),
					);
					printNextCursor(result);
				} else {
					outputJson(result);
				}
			});
		});

	webhooks
		.command("create")
		.description("Create a webhook endpoint (the signing secret is shown once)")
		.requiredOption("--url <url>", "Webhook endpoint URL")
		.requiredOption(
			"--events <events>",
			"Subscribed event names (comma-separated)",
		)
		.option("--workspace <id>", "Scope the webhook to a workspace")
		.action(async (opts) => {
			await withErrorHandler(async () => {
				const body: WebhookCreateInput = {
					url: opts.url,
					events: parseWebhookEvents(opts.events),
					workspace_id: opts.workspace,
				};
				const result = await getClient().webhooks.create(body);
				outputJson(result);
				outputSuccess(
					`Webhook ${result.id} created; save the signing secret now`,
				);
			});
		});

	webhooks
		.command("get")
		.description(
			"Find a webhook endpoint by ID in the authorized endpoint list",
		)
		.argument("<id>", "Webhook ID")
		.option("--workspace <id>", "Restrict the lookup to a workspace")
		.action(async (id: string, opts) => {
			await withErrorHandler(async () => {
				const result = await findWebhookById(
					getClient().webhooks,
					id,
					opts.workspace,
				);
				if (!result) {
					throw new Error(`Webhook ${id} was not found`);
				}
				outputJson(result);
			});
		});

	webhooks
		.command("update")
		.description("Update a webhook endpoint")
		.argument("<id>", "Webhook ID")
		.option("--url <url>", "Updated endpoint URL")
		.option("--events <events>", "Updated event names (comma-separated)")
		.addOption(
			new Option("--enabled", "Enable the webhook").conflicts("disabled"),
		)
		.addOption(
			new Option("--disabled", "Disable the webhook").conflicts("enabled"),
		)
		.action(async (id: string, opts) => {
			await withErrorHandler(async () => {
				const body: WebhookUpdateInput = {
					url: opts.url,
					events:
						opts.events === undefined
							? undefined
							: parseWebhookEvents(opts.events),
					enabled: opts.enabled ? true : opts.disabled ? false : undefined,
				};
				if (Object.values(body).every((value) => value === undefined)) {
					throw new Error(
						"Provide at least one of --url, --events, --enabled, or --disabled",
					);
				}
				const result = await getClient().webhooks.update(id, body);
				outputJson(result);
				outputSuccess(`Webhook ${result.id} updated`);
			});
		});

	webhooks
		.command("delete")
		.description("Delete a webhook endpoint")
		.argument("<id>", "Webhook ID")
		.option("-y, --yes", "Skip confirmation")
		.action(async (id: string, opts) => {
			if (!opts.yes) {
				const confirmed = await prompts.confirm({
					message: `Delete webhook ${id}?`,
				});
				if (prompts.isCancel(confirmed) || !confirmed) {
					return;
				}
			}

			await withErrorHandler(async () => {
				await getClient().webhooks.delete(id);
				outputSuccess(`Deleted ${id}`);
			});
		});

	webhooks
		.command("test")
		.description("Send a test delivery to a webhook endpoint")
		.argument("<id>", "Webhook ID")
		.action(async (id: string) => {
			await withErrorHandler(async () => {
				const result = await getClient().webhooks.sendTest({
					webhook_id: id,
				});
				outputJson(result);
				if (!result.success) {
					throw new Error(
						`Test delivery failed${result.status_code === null ? "" : ` with HTTP ${result.status_code}`}`,
					);
				}
				outputSuccess(
					`Test delivery succeeded${result.status_code === null ? "" : ` with HTTP ${result.status_code}`}`,
				);
			});
		});

	webhooks
		.command("logs")
		.alias("deliveries")
		.description("List delivery and test attempt logs from the last 7 days")
		.option("--limit <n>", "Items per page (1-100)", "20")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(async (opts) => {
			await withErrorHandler(async () => {
				const result = await getClient().webhooks.listLogs({
					limit: parsePageSize(opts.limit),
					cursor: opts.cursor,
				});

				if (isTableMode(program.opts())) {
					outputTable(
						result.data.map((log) => ({
							id: log.id,
							webhook_id: log.webhook_id,
							delivery_id: log.delivery_id ?? "-",
							event: log.event,
							attempt: log.attempt_ordinal,
							outcome: log.outcome,
							status: log.status_code ?? "-",
							created_at: log.created_at,
						})),
					);
					printNextCursor(result);
				} else {
					outputJson(result);
				}
			});
		});

	webhooks
		.command("rotate-secret")
		.description(
			"Replace a webhook signing secret (the new secret is shown once)",
		)
		.argument("<id>", "Webhook ID")
		.option("-y, --yes", "Skip confirmation")
		.action(async (id: string, opts) => {
			if (!opts.yes) {
				const confirmed = await prompts.confirm({
					message: `Rotate the signing secret for webhook ${id}? The current secret will stop working.`,
				});
				if (prompts.isCancel(confirmed) || !confirmed) {
					return;
				}
			}

			await withErrorHandler(async () => {
				const result = await getClient().webhooks.rotateSecret(id);
				outputJson(result);
				outputSuccess(
					`Webhook ${result.id} signing secret rotated; save the new secret now`,
				);
			});
		});
}

export function parseWebhookEvents(value: string): WebhookEvent[] {
	const events = [...new Set(value.split(",").map((event) => event.trim()))];
	if (events.length === 0 || events.some((event) => event.length === 0)) {
		throw new Error("Provide at least one webhook event");
	}

	const unsupported = events.filter((event) => !WEBHOOK_EVENT_SET.has(event));
	if (unsupported.length > 0) {
		throw new Error(
			`Unsupported webhook event${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}. Supported events: ${WEBHOOK_EVENTS.join(", ")}`,
		);
	}

	return events as WebhookEvent[];
}

export function parsePageSize(value: string): number {
	const limit = Number(value);
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("--limit must be an integer from 1 to 100");
	}
	return limit;
}

export async function findWebhookById(
	webhooks: Pick<WebhookOperations, "list">,
	id: string,
	workspaceId?: string,
): Promise<WebhookSummary | undefined> {
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	let hasMore = true;

	while (hasMore) {
		const query: WebhookListInput = {
			limit: 100,
			cursor,
			workspace_id: workspaceId,
		};
		const page = await webhooks.list(query);
		const match = page.data.find((webhook) => webhook.id === id);
		if (match) return match;
		hasMore = page.has_more;
		if (!hasMore) continue;

		const nextCursor = page.next_cursor;
		if (!nextCursor || seenCursors.has(nextCursor)) {
			throw new Error("Webhook pagination returned an invalid repeated cursor");
		}
		seenCursors.add(nextCursor);
		cursor = nextCursor;
	}

	return undefined;
}

function printNextCursor(result: {
	has_more: boolean;
	next_cursor: string | null;
}): void {
	if (result.has_more && result.next_cursor) {
		console.log(`\nNext: --cursor ${result.next_cursor}`);
	}
}
