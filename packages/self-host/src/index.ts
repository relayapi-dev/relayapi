#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { CloudflareClient } from "./cloudflare.js";
import { initialLock, readConfig, writeConfig, writeLock } from "./config.js";
import { CLI_VERSION, CONFIG_FILENAME, RESOURCE_NAMES } from "./constants.js";
import { deploy } from "./deploy.js";
import { doctor } from "./doctor.js";
import {
	configureGithubRepository,
	generatedSecrets,
	writeScaffold,
} from "./scaffold.js";
import type { CliOptions, SelfHostConfig } from "./types.js";
import { upgrade } from "./upgrade.js";

const HELP = `RelayAPI self-host deployment CLI

Usage:
  relayapi-self-host init [--domain example.com] [--zone-id id] [--admin-email you@example.com] [--github owner/repo]
  relayapi-self-host doctor
  relayapi-self-host plan
  relayapi-self-host configure
  relayapi-self-host deploy [--source /path/to/relayapi]
  relayapi-self-host upgrade

Global options:
  --config <path>       Operator config (default: ${CONFIG_FILENAME})
  --env-file <path>     Load secrets from a local ignored env file
  --non-interactive     Never prompt
  --dry-run             Show resource changes without applying them
  --email               Enable transactional email during init
  --ai                  Enable Workers AI during init
  --downloader          Enable the optional downloader during init
  --deploy              Deploy immediately after init
  --version             Print the CLI version
  --help                Show this help

Secrets are read from environment variables and are never written to the
operator config. Run "doctor" for the required list.`;

interface ParsedArgs {
	command: string;
	values: Map<string, string>;
	flags: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
	const command = args.find((arg) => !arg.startsWith("-")) ?? "help";
	const commandIndex = args.indexOf(command);
	const rest = args.filter((_, index) => index !== commandIndex);
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (!arg?.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
		const [name, inline] = arg.split("=", 2);
		if (!name) throw new Error(`Invalid argument ${arg}`);
		if (inline !== undefined) {
			values.set(name, inline);
			continue;
		}
		const next = rest[index + 1];
		if (next && !next.startsWith("--")) {
			values.set(name, next);
			index += 1;
		} else {
			flags.add(name);
		}
	}
	return { command, values, flags };
}

function value(args: ParsedArgs, name: string): string | undefined {
	return args.values.get(`--${name}`);
}

async function loadEnvironment(path: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(resolve(path), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
		if (!match) throw new Error(`Invalid env line in ${path}`);
		const name = match[1];
		let environmentValue = match[2] ?? "";
		if (
			(environmentValue.startsWith('"') && environmentValue.endsWith('"')) ||
			(environmentValue.startsWith("'") && environmentValue.endsWith("'"))
		) {
			environmentValue = environmentValue.slice(1, -1);
		}
		if (name && process.env[name] === undefined)
			process.env[name] = environmentValue;
	}
}

async function promptValue(
	question: string,
	provided: string | undefined,
	nonInteractive: boolean,
): Promise<string> {
	if (provided?.trim()) return provided.trim();
	if (nonInteractive) throw new Error(`${question} is required`);
	const readline = createInterface({ input, output });
	try {
		const answer = await readline.question(`${question}: `);
		if (!answer.trim()) throw new Error(`${question} is required`);
		return answer.trim();
	} finally {
		readline.close();
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function init(args: ParsedArgs, options: CliOptions): Promise<void> {
	if (await fileExists(resolve(options.configPath))) {
		throw new Error(
			`${options.configPath} already exists; use configure or deploy instead`,
		);
	}
	const accountId = await promptValue(
		"Cloudflare account ID",
		value(args, "account-id") ?? process.env.CLOUDFLARE_ACCOUNT_ID,
		options.nonInteractive,
	);
	const zoneId = await promptValue(
		"Cloudflare zone ID",
		value(args, "zone-id"),
		options.nonInteractive,
	);
	const rootDomain = (
		await promptValue(
			"Root domain",
			value(args, "domain"),
			options.nonInteractive,
		)
	).toLowerCase();
	const githubRepository = value(args, "github");
	const adminEmail = await promptValue(
		"Initial administrator email",
		value(args, "admin-email") ?? process.env.RELAYAPI_ADMIN_EMAIL,
		options.nonInteractive,
	);
	if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
		throw new Error("Initial administrator email is invalid");
	}
	const config: SelfHostConfig = {
		schemaVersion: 1,
		instance: "relayapi",
		cloudflare: {
			accountId,
			zoneId,
			rootDomain,
			apiHostname: value(args, "api-hostname") ?? `api.${rootDomain}`,
			appHostname: value(args, "app-hostname") ?? `app.${rootDomain}`,
			mediaHostname: value(args, "media-hostname") ?? `media.${rootDomain}`,
			thumbnailHostname:
				value(args, "thumbnail-hostname") ?? `thumbs.${rootDomain}`,
		},
		features: {
			email: args.flags.has("--email"),
			ai: args.flags.has("--ai"),
			downloader: args.flags.has("--downloader"),
		},
		...(githubRepository ? { github: { repository: githubRepository } } : {}),
	};
	await mkdir(dirname(resolve(options.configPath)), { recursive: true });
	await writeConfig(config, options.configPath);
	await writeLock(
		initialLock(value(args, "relayapi-version") ?? CLI_VERSION),
		options.configPath,
	);
	await writeScaffold(options.configPath);

	const generated = generatedSecrets();
	process.env.CLOUDFLARE_ACCOUNT_ID ??= accountId;
	process.env.ENCRYPTION_KEY ??= generated.encryptionKey;
	process.env.BETTER_AUTH_SECRET ??= generated.betterAuthSecret;
	process.env.RELAYAPI_ADMIN_EMAIL ??= adminEmail.toLowerCase();
	process.env.RELAYAPI_ADMIN_PASSWORD ??= generated.adminPassword;
	const localSecretsPath = resolve(
		dirname(resolve(options.configPath)),
		".relayapi",
		"secrets.env",
	);
	await writeFile(
		localSecretsPath,
		`ENCRYPTION_KEY=${process.env.ENCRYPTION_KEY}\nBETTER_AUTH_SECRET=${process.env.BETTER_AUTH_SECRET}\nRELAYAPI_ADMIN_EMAIL=${process.env.RELAYAPI_ADMIN_EMAIL}\nRELAYAPI_ADMIN_PASSWORD=${process.env.RELAYAPI_ADMIN_PASSWORD}\n`,
		{ mode: 0o600, flag: "wx" },
	);

	console.log(`Created ${options.configPath} and guarded GitHub workflows`);
	console.log(
		`Generated local secrets in ${localSecretsPath} (gitignored, mode 0600)`,
	);
	if (githubRepository) {
		await configureGithubRepository(config, options.configPath);
		console.log(`Created private deployment repository ${githubRepository}`);
	}
	if (args.flags.has("--deploy")) {
		await deploy(options);
	} else {
		console.log(
			"Next: export the remaining values from .env.example, then run doctor and deploy.",
		);
	}
}

async function plan(options: CliOptions): Promise<void> {
	const config = await readConfig(options.configPath);
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!accountId || !token) {
		throw new Error(
			"CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required",
		);
	}
	if (accountId !== config.cloudflare.accountId) {
		throw new Error("Cloudflare account ID does not match the config");
	}
	const client = new CloudflareClient(accountId, token);
	await client.verifyAccess(config.cloudflare.zoneId);
	console.log(JSON.stringify(await client.plan(), null, 2));
}

async function configure(options: CliOptions): Promise<void> {
	let config = await readConfig(options.configPath);
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	const databaseUrl = process.env.RELAYAPI_RUNTIME_DATABASE_URL?.trim();
	if (!accountId || !token || !databaseUrl) {
		throw new Error(
			"CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and RELAYAPI_RUNTIME_DATABASE_URL are required",
		);
	}
	if (accountId !== config.cloudflare.accountId) {
		throw new Error("Cloudflare account ID does not match the config");
	}
	const client = new CloudflareClient(accountId, token);
	await client.verifyAccess(config.cloudflare.zoneId);
	if (options.dryRun) {
		console.log(JSON.stringify(await client.plan(), null, 2));
		return;
	}
	config = { ...config, resources: await client.apply(config, databaseUrl) };
	await writeConfig(config, options.configPath);
	console.log(
		`Configured ${RESOURCE_NAMES.workers.api} and ${RESOURCE_NAMES.workers.app} resources`,
	);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.flags.has("--version") || args.command === "version") {
		console.log(CLI_VERSION);
		return;
	}
	if (args.flags.has("--help") || args.command === "help") {
		console.log(HELP);
		return;
	}
	const configPath = value(args, "config") ?? CONFIG_FILENAME;
	await loadEnvironment(
		value(args, "env-file") ??
			resolve(dirname(resolve(configPath)), ".relayapi", "secrets.env"),
	);
	const options: CliOptions = {
		configPath,
		nonInteractive: args.flags.has("--non-interactive"),
		dryRun: args.flags.has("--dry-run"),
		...(value(args, "source") ? { source: value(args, "source") } : {}),
	};
	switch (args.command) {
		case "init":
			await init(args, options);
			break;
		case "doctor":
			await doctor(options);
			break;
		case "plan":
			await plan(options);
			break;
		case "configure":
			await configure(options);
			break;
		case "deploy":
			await deploy(options);
			break;
		case "upgrade":
			await upgrade(options);
			break;
		default:
			throw new Error(`Unknown command ${args.command}\n\n${HELP}`);
	}
}

main().catch((error) => {
	console.error(
		`Error: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
