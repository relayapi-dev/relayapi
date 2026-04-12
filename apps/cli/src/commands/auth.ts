import { Command } from "commander";
import * as prompts from "@clack/prompts";
import pc from "picocolors";
import {
	loadConfig,
	saveConfig,
	resolveApiKey,
	maskKey,
} from "../config.js";
import { createClient } from "../client.js";
import { outputJson, outputSuccess, withErrorHandler } from "../output.js";

export function registerAuthCommands(program: Command): void {
	const auth = program
		.command("auth")
		.description("Manage authentication")
		.action(function () {
			auth.help();
		});

	auth.command("set-key")
		.description("Save an API key")
		.argument("[key]", "API key (rlay_live_* or rlay_test_*)")
		.action(async (key?: string) => {
			let apiKey = key;

			if (!apiKey) {
				const result = await prompts.password({
					message: "Enter your API key",
				});
				if (prompts.isCancel(result)) {
					process.exit(0);
				}
				apiKey = result;
			}

			if (!apiKey.startsWith("rlay_")) {
				console.error(
					pc.red(
						'Invalid API key format. Keys must start with "rlay_live_" or "rlay_test_".',
					),
				);
				process.exit(1);
			}

			const config = loadConfig();
			config.api_key = apiKey;
			saveConfig(config);
			outputSuccess(`API key saved (${maskKey(apiKey)})`);
		});

	auth.command("status")
		.description("Show authentication status and usage")
		.action(async () => {
			const apiKey = resolveApiKey();
			if (!apiKey) {
				console.error(
					pc.red("Not authenticated.") +
						` Run ${pc.bold("relay auth set-key")} to get started.`,
				);
				process.exit(1);
			}

			console.log(`${pc.dim("API Key:")} ${maskKey(apiKey)}`);

			await withErrorHandler(async () => {
				const client = createClient();
				const usage = await client.usage.retrieve();

				console.log(`${pc.dim("Plan:")} ${usage.plan.name}`);
				console.log(
					`${pc.dim("API Calls:")} ${usage.usage.api_calls_used} / ${usage.plan.api_calls_limit}`,
				);
				console.log(
					`${pc.dim("Remaining:")} ${usage.usage.api_calls_remaining}`,
				);
				console.log(
					`${pc.dim("Cycle:")} ${usage.usage.cycle_start} → ${usage.usage.cycle_end}`,
				);
				console.log(
					`${pc.dim("Rate Limit:")} ${usage.rate_limit.current_minute} / ${usage.rate_limit.limit_per_minute} per min`,
				);
			});
		});

	auth.command("logout")
		.description("Remove saved credentials")
		.action(async () => {
			const apiKey = resolveApiKey();
			if (!apiKey) {
				console.log(pc.dim("No credentials saved."));
				return;
			}

			const confirmed = await prompts.confirm({
				message: "Remove saved API key?",
			});

			if (prompts.isCancel(confirmed) || !confirmed) {
				process.exit(0);
			}

			const config = loadConfig();
			delete config.api_key;
			saveConfig(config);
			outputSuccess("Credentials removed.");
		});
}
