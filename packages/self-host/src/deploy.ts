import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CloudflareClient, parsePostgresUrl } from "./cloudflare.js";
import { readConfig, readLock, writeConfig } from "./config.js";
import { RESOURCE_NAMES } from "./constants.js";
import { run } from "./process.js";
import { resolveSource } from "./source.js";
import type { CliOptions, SelfHostConfig } from "./types.js";
import { apiWranglerConfig, appWranglerConfig } from "./wrangler-config.js";

const API_SECRET_NAMES = [
	"ENCRYPTION_KEY",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"CF_ACCOUNT_ID",
	"RESEND_API_KEY",
	"DOWNLOADER_SERVICE_URL",
	"DOWNLOADER_SERVICE_KEY",
	"TWITTER_CLIENT_ID",
	"TWITTER_CLIENT_SECRET",
	"FACEBOOK_APP_ID",
	"FACEBOOK_APP_SECRET",
	"INSTAGRAM_APP_ID",
	"INSTAGRAM_APP_SECRET",
	"INSTAGRAM_LOGIN_APP_ID",
	"INSTAGRAM_LOGIN_APP_SECRET",
	"LINKEDIN_CLIENT_ID",
	"LINKEDIN_CLIENT_SECRET",
	"TIKTOK_CLIENT_KEY",
	"TIKTOK_CLIENT_SECRET",
	"YOUTUBE_CLIENT_ID",
	"YOUTUBE_CLIENT_SECRET",
	"PINTEREST_APP_ID",
	"PINTEREST_APP_SECRET",
	"REDDIT_CLIENT_ID",
	"REDDIT_CLIENT_SECRET",
	"THREADS_APP_ID",
	"THREADS_APP_SECRET",
	"SNAPCHAT_CLIENT_ID",
	"SNAPCHAT_CLIENT_SECRET",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"WHATSAPP_APP_ID",
	"WHATSAPP_APP_SECRET",
	"WHATSAPP_CONFIG_ID",
	"MASTODON_CLIENT_ID",
	"MASTODON_CLIENT_SECRET",
	"TELEGRAM_BOT_TOKEN",
	"TELEGRAM_WEBHOOK_SECRET",
	"FACEBOOK_WEBHOOK_VERIFY_TOKEN",
	"YOUTUBE_HUB_SECRET",
] as const;

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required environment variable ${name}`);
	return value;
}

function selectedEnvironment(names: readonly string[]): Record<string, string> {
	return Object.fromEntries(
		names.flatMap((name) => {
			const value = process.env[name];
			return value ? [[name, value]] : [];
		}),
	);
}

function assertFeatureSecrets(config: SelfHostConfig): void {
	if (config.features.email) requiredEnvironment("RESEND_API_KEY");
	if (config.features.downloader) {
		requiredEnvironment("DOWNLOADER_SERVICE_URL");
		requiredEnvironment("DOWNLOADER_SERVICE_KEY");
	}
}

async function writeGeneratedConfig(
	configPath: string,
	name: string,
	value: Record<string, unknown>,
): Promise<string> {
	const generated = resolve(
		dirname(resolve(configPath)),
		".relayapi",
		"generated",
	);
	await mkdir(generated, { recursive: true, mode: 0o700 });
	const path = join(generated, name);
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	return path;
}

async function deployWorker(
	configPath: string,
	secrets: Record<string, string>,
	sourceRoot: string,
): Promise<void> {
	await run(
		"bunx",
		["wrangler", "deploy", "--config", configPath, "--keep-vars", "--strict"],
		{ cwd: sourceRoot },
	);
	if (Object.keys(secrets).length > 0) {
		await run("bunx", ["wrangler", "secret", "bulk", "--config", configPath], {
			cwd: sourceRoot,
			stdin: `${JSON.stringify(secrets)}\n`,
		});
	}
}

export async function deploy(options: CliOptions): Promise<void> {
	let config = await readConfig(options.configPath);
	const lock = await readLock(options.configPath);
	const token = requiredEnvironment("CLOUDFLARE_API_TOKEN");
	const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
	if (accountId !== config.cloudflare.accountId) {
		throw new Error(
			"CLOUDFLARE_ACCOUNT_ID does not match relayapi.selfhost.json",
		);
	}
	const migrationDatabaseUrl = requiredEnvironment("RELAYAPI_DATABASE_URL");
	const runtimeDatabaseUrl = requiredEnvironment(
		"RELAYAPI_RUNTIME_DATABASE_URL",
	);
	parsePostgresUrl(migrationDatabaseUrl);
	parsePostgresUrl(runtimeDatabaseUrl);
	requiredEnvironment("ENCRYPTION_KEY");
	requiredEnvironment("BETTER_AUTH_SECRET");
	requiredEnvironment("RELAYAPI_ADMIN_EMAIL");
	const adminPassword = requiredEnvironment("RELAYAPI_ADMIN_PASSWORD");
	if (adminPassword.length < 12) {
		throw new Error(
			"RELAYAPI_ADMIN_PASSWORD must contain at least 12 characters",
		);
	}
	requiredEnvironment("R2_ACCESS_KEY_ID");
	requiredEnvironment("R2_SECRET_ACCESS_KEY");
	assertFeatureSecrets(config);

	const cloudflare = new CloudflareClient(accountId, token);
	await cloudflare.verifyAccess(config.cloudflare.zoneId);
	if (options.dryRun) {
		console.log(JSON.stringify(await cloudflare.plan(), null, 2));
		return;
	}
	config = {
		...config,
		resources: await cloudflare.apply(config, runtimeDatabaseUrl),
	};
	await writeConfig(config, options.configPath);

	const source = await resolveSource(lock, options.source);
	console.log(`Deploying RelayAPI ${lock.version} from ${source.root}`);
	await run("bun", ["install", "--frozen-lockfile"], { cwd: source.root });
	await run("bun", ["run", "--cwd", "packages/db", "migrate"], {
		cwd: source.root,
		env: { ...process.env, DATABASE_URL: migrationDatabaseUrl },
	});
	await run("bun", ["run", "scripts/bootstrap-self-host.ts"], {
		cwd: source.root,
		env: {
			...process.env,
			DATABASE_URL: migrationDatabaseUrl,
			DEPLOYMENT_MODE: "self_hosted",
			SELF_HOSTED_FEATURE_AI: config.features.ai ? "1" : "0",
		},
	});
	await run("bun", ["run", "--cwd", "apps/app", "build"], {
		cwd: source.root,
		env: {
			...process.env,
			NODE_ENV: "production",
			API_BASE_URL: `https://${config.cloudflare.apiHostname}`,
			APP_BASE_URL: `https://${config.cloudflare.appHostname}`,
			PUBLIC_DEPLOYMENT_MODE: "self_hosted",
			PUBLIC_SELF_HOSTED_FEATURE_AI: config.features.ai ? "1" : "0",
		},
	});

	const apiConfigPath = await writeGeneratedConfig(
		options.configPath,
		"api.wrangler.json",
		apiWranglerConfig(config, source.root),
	);
	const appConfigPath = await writeGeneratedConfig(
		options.configPath,
		"app.wrangler.json",
		appWranglerConfig(config, source.root),
	);
	await deployWorker(
		apiConfigPath,
		{
			...selectedEnvironment(API_SECRET_NAMES),
			CF_ACCOUNT_ID: accountId,
		},
		source.root,
	);
	await deployWorker(
		appConfigPath,
		{
			BETTER_AUTH_SECRET: requiredEnvironment("BETTER_AUTH_SECRET"),
			...selectedEnvironment([
				"GOOGLE_CLIENT_ID",
				"GOOGLE_CLIENT_SECRET",
				"RESEND_API_KEY",
			]),
		},
		source.root,
	);
	console.log(`RelayAPI is live at https://${config.cloudflare.appHostname}`);
	console.log(`API: https://${config.cloudflare.apiHostname}`);
}

export function workerNames(): typeof RESOURCE_NAMES.workers {
	return RESOURCE_NAMES.workers;
}
