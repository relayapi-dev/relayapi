import { createHash, createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	BASELINE_GENERATION,
	MAINTENANCE_SMOKE_HASH_DOMAIN,
} from "../../config/src/index.js";
import { CloudflareClient } from "./cloudflare.js";
import { readConfig, readLock, writeConfig } from "./config.js";
import { RESOURCE_NAMES } from "./constants.js";
import {
	validateBetterAuthSecret,
	validateEncryptionKeyRing,
	validateMigrationDatabaseUrl,
	validateRuntimeDatabaseUrl,
	verifyMigratedDatabaseExtensions,
	verifyRequiredDatabaseExtensions,
	verifySelfHostDatabaseContract,
} from "./doctor.js";
import { run } from "./process.js";
import { reconcileCloudflareResources } from "./reconcile.js";
import { resolveSource } from "./source.js";
import type { CliOptions, SelfHostConfig } from "./types.js";
import { apiWranglerConfig, appWranglerConfig } from "./wrangler-config.js";

const API_SECRET_NAMES = [
	"ENCRYPTION_KEY",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
	"CF_ACCOUNT_ID",
	"OPENAI_API_KEY",
	"OPERATIONS_ALERT_WEBHOOK_URL",
	"OPERATIONS_ALERT_EMAIL",
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

const SELF_HOST_SMOKE_DERIVATION_DOMAIN =
	"relayapi:self-host:database-smoke-token:v1";
const DATABASE_PROBE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

export function deriveSelfHostSmokeCredential(betterAuthSecret: string): {
	token: string;
	digest: string;
} {
	validateBetterAuthSecret(betterAuthSecret);
	const token = createHmac("sha256", betterAuthSecret)
		.update(SELF_HOST_SMOKE_DERIVATION_DOMAIN)
		.digest("base64url");
	const digest = createHash("sha256")
		.update(MAINTENANCE_SMOKE_HASH_DOMAIN)
		.update(token)
		.digest("hex");
	return { token, digest };
}

async function wait(delayMs: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function readBoundedJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		size += result.value.byteLength;
		if (size > 16_384) {
			await reader.cancel();
			throw new Error("database probe returned an oversized response");
		}
		chunks.push(result.value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new Error("database probe returned malformed JSON");
	}
}

function databaseProbeAttestation(
	value: unknown,
): { name: string; user: string } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const root = value as Record<string, unknown>;
	if (root.ok !== true) return null;
	if (
		!root.control ||
		typeof root.control !== "object" ||
		Array.isArray(root.control)
	) {
		return null;
	}
	const control = root.control as Record<string, unknown>;
	if (
		control.status !== "open" ||
		control.application_baseline_generation !== BASELINE_GENERATION ||
		control.configured_baseline_generation !== String(BASELINE_GENERATION)
	) {
		return null;
	}
	if (!root.database || typeof root.database !== "object") return null;
	const database = root.database as Record<string, unknown>;
	return typeof database.name === "string" && typeof database.user === "string"
		? { name: database.name, user: database.user }
		: null;
}

export async function probeWorkerDatabase(input: {
	label: "API" | "dashboard";
	hostname: string;
	token: string;
	expectedDatabase: string;
	expectedUser: string;
	fetcher?: typeof fetch;
	/** Test seam; production uses the bounded deployment retry schedule. */
	retryDelaysMs?: readonly number[];
}): Promise<void> {
	const fetcher = input.fetcher ?? fetch;
	const retryDelaysMs = input.retryDelaysMs ?? DATABASE_PROBE_DELAYS_MS;
	let lastFailure = "did not return a successful database probe";
	for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
		try {
			const response = await fetcher(
				`https://${input.hostname}/internal/cutover-smoke?probe=database`,
				{
					headers: {
						"x-relayapi-maintenance-smoke-bypass": input.token,
					},
					redirect: "error",
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (!response.headers.get("cache-control")?.includes("no-store")) {
				await response.body?.cancel();
				lastFailure = "did not return the required no-store response";
			} else if (!response.ok) {
				await response.body?.cancel();
				lastFailure = `returned HTTP ${response.status}`;
			} else {
				const identity = databaseProbeAttestation(
					await readBoundedJson(response),
				);
				if (
					identity?.name === input.expectedDatabase &&
					identity.user === input.expectedUser
				) {
					return;
				}
				lastFailure =
					"returned a non-open, generation-mismatched, or unexpected database attestation";
			}
		} catch (error) {
			lastFailure =
				error instanceof Error && error.name === "TimeoutError"
					? "timed out"
					: "could not be completed";
		}
		const delay = retryDelaysMs[attempt];
		if (delay === undefined) break;
		await wait(delay);
	}
	throw new Error(`${input.label} Worker database probe ${lastFailure}`);
}

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
	if (config.features.ai) requiredEnvironment("OPENAI_API_KEY");
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
	const migrationDatabaseUrl = requiredEnvironment(
		"RELAYAPI_MIGRATION_DATABASE_URL",
	);
	const runtimeDatabaseUrl = requiredEnvironment(
		"RELAYAPI_RUNTIME_DATABASE_URL",
	);
	validateMigrationDatabaseUrl(migrationDatabaseUrl);
	validateRuntimeDatabaseUrl(runtimeDatabaseUrl);
	// Reject malformed local secrets before the first database probe or
	// Cloudflare API call. A merely non-empty ring can still be unusable by the
	// consent and erasure-identity paths at runtime.
	validateEncryptionKeyRing(requiredEnvironment("ENCRYPTION_KEY"));
	const betterAuthSecret = requiredEnvironment("BETTER_AUTH_SECRET");
	const smokeCredential = deriveSelfHostSmokeCredential(betterAuthSecret);
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

	await verifySelfHostDatabaseContract(
		migrationDatabaseUrl,
		runtimeDatabaseUrl,
	);
	const cloudflare = new CloudflareClient(accountId, token);
	await cloudflare.verifyAccess(config.cloudflare.zoneId);
	const reconciliation = await reconcileCloudflareResources({
		config,
		runtimeDatabaseUrl,
		client: cloudflare,
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
	config = reconciliation.config;

	const source = await resolveSource(lock, options.source);
	console.log(`Deploying RelayAPI ${lock.version} from ${source.root}`);
	await run("bun", ["install", "--frozen-lockfile"], { cwd: source.root });
	await verifyRequiredDatabaseExtensions(migrationDatabaseUrl);
	await run("bun", ["run", "--cwd", "packages/db", "migrate"], {
		cwd: source.root,
		env: {
			...process.env,
			CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:
				migrationDatabaseUrl,
		},
	});
	await verifyMigratedDatabaseExtensions(migrationDatabaseUrl);
	await verifySelfHostDatabaseContract(
		migrationDatabaseUrl,
		runtimeDatabaseUrl,
		{
			postMigration: true,
		},
	);
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
		apiWranglerConfig(config, source.root, smokeCredential.digest),
	);
	const appConfigPath = await writeGeneratedConfig(
		options.configPath,
		"app.wrangler.json",
		appWranglerConfig(config, source.root, smokeCredential.digest),
	);
	const apiSecrets = {
		...selectedEnvironment(API_SECRET_NAMES),
		...(config.features.email && !process.env.OPERATIONS_ALERT_EMAIL
			? {
					OPERATIONS_ALERT_EMAIL: requiredEnvironment("RELAYAPI_ADMIN_EMAIL"),
				}
			: {}),
		CF_ACCOUNT_ID: accountId,
	};
	await deployWorker(apiConfigPath, apiSecrets, source.root);
	const expectedRuntime = validateRuntimeDatabaseUrl(runtimeDatabaseUrl);
	await probeWorkerDatabase({
		label: "API",
		hostname: config.cloudflare.apiHostname,
		token: smokeCredential.token,
		expectedDatabase: expectedRuntime.database,
		expectedUser: expectedRuntime.username,
	});
	await deployWorker(
		appConfigPath,
		{
			BETTER_AUTH_SECRET: betterAuthSecret,
			...selectedEnvironment(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
		},
		source.root,
	);
	await probeWorkerDatabase({
		label: "dashboard",
		hostname: config.cloudflare.appHostname,
		token: smokeCredential.token,
		expectedDatabase: expectedRuntime.database,
		expectedUser: expectedRuntime.username,
	});
	console.log(`RelayAPI is live at https://${config.cloudflare.appHostname}`);
	console.log(`API: https://${config.cloudflare.apiHostname}`);
}

export function workerNames(): typeof RESOURCE_NAMES.workers {
	return RESOURCE_NAMES.workers;
}
