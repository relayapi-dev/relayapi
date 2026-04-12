import { Command } from "commander";
import { createClient } from "../client.js";
import {
	isTableMode,
	outputJson,
	outputTable,
	withErrorHandler,
} from "../output.js";

export function registerAccountCommands(program: Command): void {
	const accounts = program
		.command("accounts")
		.description("Manage connected accounts")
		.action(function () {
			accounts.help();
		});

	accounts
		.command("list")
		.description("List connected accounts")
		.option("--limit <n>", "Items per page", "20")
		.option("--cursor <cursor>", "Pagination cursor")
		.action(async (opts) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.accounts.list({
					limit: Number(opts.limit),
					cursor: opts.cursor,
				});

				if (isTableMode(program.opts())) {
					outputTable(
						result.data.map((a) => ({
							id: a.id,
							platform: a.platform,
							username: a.username ?? "-",
							display_name: a.display_name ?? "-",
						})),
					);
					if (result.has_more && result.next_cursor) {
						console.log(`\nNext: --cursor ${result.next_cursor}`);
					}
				} else {
					outputJson(result);
				}
			});
		});

	accounts
		.command("get")
		.description("Get account details")
		.argument("<id>", "Account ID")
		.action(async (id: string) => {
			await withErrorHandler(async () => {
				const client = createClient();
				const result = await client.accounts.retrieve(id);
				outputJson(result);
			});
		});

	const health = accounts
		.command("health")
		.description("Check account health")
		.argument("[id]", "Account ID (omit for all)")
		.action(async (id?: string) => {
			await withErrorHandler(async () => {
				const client = createClient();

				if (id) {
					const result = await client.accounts.health.retrieve(id);
					if (isTableMode(program.opts())) {
						outputTable([
							{
								id: result.id,
								platform: result.platform,
								username: result.username ?? "-",
								healthy: result.healthy ? "✓" : "✗",
								token_expires: result.token_expires_at ?? "-",
							},
						]);
					} else {
						outputJson(result);
					}
				} else {
					const result = await client.accounts.health.list();
					if (isTableMode(program.opts())) {
						outputTable(
							result.data.map((a) => ({
								id: a.id,
								platform: a.platform,
								username: a.username ?? "-",
								healthy: a.healthy ? "✓" : "✗",
								token_expires: a.token_expires_at ?? "-",
							})),
						);
					} else {
						outputJson(result);
					}
				}
			});
		});
}
