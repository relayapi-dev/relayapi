#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { CloudflareClient } from "./cloudflare.js";
import {
	initialLock,
	readConfig,
	validateConfig,
	validateHyperdriveCaCertificateId,
	writeConfig,
	writeLock,
} from "./config.js";
import {
	CLI_VERSION,
	CONFIG_FILENAME,
	DEFAULT_SOURCE_REPOSITORY,
	RESOURCE_NAMES,
} from "./constants.js";
import { deploy } from "./deploy.js";
import { doctor, validateRuntimeDatabaseUrl } from "./doctor.js";
import { reconcileCloudflareResources } from "./reconcile.js";
import {
	configureGithubRepository,
	generatedSecrets,
	prepareInitDirectory,
	writeScaffold,
} from "./scaffold.js";
import { resolveReleaseArchiveSha256 } from "./source.js";
import type { CliOptions, SelfHostConfig } from "./types.js";
import { upgrade } from "./upgrade.js";

const HELP = `RelayAPI self-host deployment CLI

Usage:
  relayapi-self-host init [--domain example.com] [--zone-id id] [--admin-email you@example.com] [--github owner/repo]
  relayapi-self-host doctor [--hyperdrive-ca-certificate-id UUID]
  relayapi-self-host plan [--hyperdrive-ca-certificate-id UUID]
  relayapi-self-host configure [--hyperdrive-ca-certificate-id UUID]
  relayapi-self-host deploy [--source /path/to/relayapi --allow-unsealed-source] [--hyperdrive-ca-certificate-id UUID]
  relayapi-self-host upgrade

Global options:
  --config <path>       Operator config (default: ${CONFIG_FILENAME})
  --env-file <path>     Load secrets from a local ignored env file
  --non-interactive     Never prompt
  --dry-run             Show resource changes without applying them
  --force               During init, back up and replace managed files
  --allow-unsealed-source
                        Acknowledge that deploy --source bypasses the sealed archive
  --email               Enable transactional email during init
  --ai                  Enable Workers AI during init
  --downloader          Enable the optional downloader during init
  --media-processing    Enable paid Containers/Workflows media compression
  --r2-jurisdiction     R2 jurisdiction: default or eu (default: default)
  --hyperdrive-ca-certificate-id
                        Create with, or explicitly rotate the exact pinned
                        Hyperdrive to, this uploaded Cloudflare CA UUID
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

async function init(args: ParsedArgs, options: CliOptions): Promise<void> {
	const githubRepository = value(args, "github");
	const preparation = await prepareInitDirectory(options.configPath, {
		force: options.force,
		github: githubRepository !== undefined,
	});
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
	const adminEmail = await promptValue(
		"Initial administrator email",
		value(args, "admin-email") ?? process.env.RELAYAPI_ADMIN_EMAIL,
		options.nonInteractive,
	);
	if (!/^\S+@\S+\.\S+$/.test(adminEmail)) {
		throw new Error("Initial administrator email is invalid");
	}
	const requestedR2Jurisdiction = value(args, "r2-jurisdiction") ?? "default";
	if (
		requestedR2Jurisdiction !== "default" &&
		requestedR2Jurisdiction !== "eu"
	) {
		throw new Error('--r2-jurisdiction must be "default" or "eu"');
	}
	const hyperdriveCaCertificateId = validateHyperdriveCaCertificateId(
		await promptValue(
			"Hyperdrive CA certificate ID",
			options.hyperdriveCaCertificateId,
			options.nonInteractive,
		),
		"Hyperdrive CA certificate ID",
	);
	const config: SelfHostConfig = validateConfig({
		schemaVersion: 1,
		instance: "relayapi",
		cloudflare: {
			accountId,
			zoneId,
			rootDomain,
			apiHostname: value(args, "api-hostname") ?? `api.${rootDomain}`,
			appHostname: value(args, "app-hostname") ?? `app.${rootDomain}`,
			publicHostname: value(args, "public-hostname") ?? `go.${rootDomain}`,
			mediaHostname: value(args, "media-hostname") ?? `media.${rootDomain}`,
			thumbnailHostname:
				value(args, "thumbnail-hostname") ?? `thumbs.${rootDomain}`,
			r2Jurisdiction: requestedR2Jurisdiction,
			hyperdriveCaCertificateId,
		},
		features: {
			email: args.flags.has("--email"),
			ai: args.flags.has("--ai"),
			downloader: args.flags.has("--downloader"),
			mediaProcessing: args.flags.has("--media-processing"),
		},
		...(githubRepository ? { github: { repository: githubRepository } } : {}),
	});
	const version = value(args, "relayapi-version") ?? CLI_VERSION;
	const sourceArchiveSha256 = await resolveReleaseArchiveSha256(
		DEFAULT_SOURCE_REPOSITORY,
		version,
	);
	await mkdir(dirname(resolve(options.configPath)), { recursive: true });
	await writeConfig(config, options.configPath, {
		overwrite: preparation.overwrite,
	});
	await writeLock(
		initialLock(version, sourceArchiveSha256),
		options.configPath,
		{ overwrite: preparation.overwrite },
	);
	await writeScaffold(options.configPath, {
		overwrite: preparation.overwrite,
		mergeGitignore: preparation.mergeGitignore,
	});

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
		{ mode: 0o600, flag: preparation.overwrite ? "w" : "wx" },
	);
	await chmod(localSecretsPath, 0o600);

	console.log(`Created ${options.configPath} and guarded GitHub workflows`);
	console.log(
		`Generated local secrets in ${localSecretsPath} (gitignored, mode 0600)`,
	);
	if (preparation.backupDirectory) {
		console.log(
			`Backed up replaced init files to ${preparation.backupDirectory}`,
		);
	}
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
	const databaseUrl = process.env.RELAYAPI_RUNTIME_DATABASE_URL?.trim();
	if (!accountId || !token || !databaseUrl) {
		throw new Error(
			"CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and RELAYAPI_RUNTIME_DATABASE_URL are required",
		);
	}
	validateRuntimeDatabaseUrl(databaseUrl);
	if (accountId !== config.cloudflare.accountId) {
		throw new Error("Cloudflare account ID does not match the config");
	}
	const client = new CloudflareClient(accountId, token);
	await client.verifyAccess(config.cloudflare.zoneId);
	console.log(
		JSON.stringify(
			await client.plan(
				config,
				databaseUrl,
				options.hyperdriveCaCertificateId
					? {
							requestedCaCertificateId: options.hyperdriveCaCertificateId,
						}
					: {},
			),
			null,
			2,
		),
	);
}

async function configure(options: CliOptions): Promise<void> {
	const config = await readConfig(options.configPath);
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	const databaseUrl = process.env.RELAYAPI_RUNTIME_DATABASE_URL?.trim();
	if (!accountId || !token || !databaseUrl) {
		throw new Error(
			"CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and RELAYAPI_RUNTIME_DATABASE_URL are required",
		);
	}
	validateRuntimeDatabaseUrl(databaseUrl);
	if (accountId !== config.cloudflare.accountId) {
		throw new Error("Cloudflare account ID does not match the config");
	}
	const client = new CloudflareClient(accountId, token);
	await client.verifyAccess(config.cloudflare.zoneId);
	const reconciliation = await reconcileCloudflareResources({
		config,
		runtimeDatabaseUrl: databaseUrl,
		client,
		dryRun: options.dryRun,
		...(options.hyperdriveCaCertificateId
			? {
					requestedCaCertificateId: options.hyperdriveCaCertificateId,
				}
			: {}),
		persist: (appliedConfig) => writeConfig(appliedConfig, options.configPath),
	});
	if (!reconciliation.applied) {
		console.log(JSON.stringify(reconciliation.plan, null, 2));
		return;
	}
	console.log(
		`Hyperdrive CA certificate intent: ${reconciliation.plan.hyperdrive.caCertificateAction} ${reconciliation.plan.hyperdrive.caCertificateId}`,
	);
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
	if (args.flags.has("--hyperdrive-ca-certificate-id")) {
		throw new Error("--hyperdrive-ca-certificate-id requires a UUID value");
	}
	const requestedHyperdriveCaCertificateId = value(
		args,
		"hyperdrive-ca-certificate-id",
	);
	await loadEnvironment(
		value(args, "env-file") ??
			resolve(dirname(resolve(configPath)), ".relayapi", "secrets.env"),
	);
	const options: CliOptions = {
		configPath,
		nonInteractive: args.flags.has("--non-interactive"),
		dryRun: args.flags.has("--dry-run"),
		force: args.flags.has("--force"),
		...(value(args, "source") ? { source: value(args, "source") } : {}),
		...(args.flags.has("--allow-unsealed-source")
			? { allowUnsealedSource: true }
			: {}),
		...(requestedHyperdriveCaCertificateId
			? {
					hyperdriveCaCertificateId: validateHyperdriveCaCertificateId(
						requestedHyperdriveCaCertificateId,
						"--hyperdrive-ca-certificate-id",
					),
				}
			: {}),
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
