import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { run, runCaptured } from "./process.js";
import { reconcileCloudflareResources } from "./reconcile.js";
import { withResolvedSource } from "./source.js";
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
const WORKER_VERSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

interface WorkerVersionSnapshot {
	id: string;
	secretNames: string[];
	configurationDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, canonicalJson(value[key])]),
	);
}

function parseJson(value: string, label: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`${label} returned malformed JSON`);
	}
}

function uploadedVersionId(output: string): string {
	const entries = output
		.split(/\r?\n/u)
		.filter((line) => line.trim().length > 0)
		.map((line) => parseJson(line, "Wrangler version upload"));
	const matches = entries.filter(
		(entry) =>
			isRecord(entry) &&
			entry.type === "version-upload" &&
			entry.version === 1 &&
			typeof entry.version_id === "string" &&
			WORKER_VERSION_ID_PATTERN.test(entry.version_id),
	) as Array<Record<string, unknown> & { version_id: string }>;
	const match = matches[0];
	if (matches.length !== 1 || !match) {
		throw new Error(
			"Wrangler did not report exactly one staged Worker version ID; live traffic was not changed",
		);
	}
	return match.version_id;
}

function workerVersionSnapshot(
	output: string,
	expectedVersionId: string,
): WorkerVersionSnapshot {
	const version = parseJson(output, "Wrangler version inspection");
	if (
		!isRecord(version) ||
		version.id !== expectedVersionId ||
		!isRecord(version.resources) ||
		!Array.isArray(version.resources.bindings) ||
		!isRecord(version.resources.script) ||
		typeof version.resources.script.etag !== "string" ||
		version.resources.script.etag.length === 0
	) {
		throw new Error(
			"Wrangler returned an incomplete or mismatched Worker version inspection",
		);
	}
	const bindings = version.resources.bindings;
	const secretNames: string[] = [];
	const nonSecretBindings: unknown[] = [];
	for (const binding of bindings) {
		if (!isRecord(binding) || typeof binding.type !== "string") {
			throw new Error(
				"Wrangler returned a malformed Worker binding inspection",
			);
		}
		if (binding.type !== "secret_text") {
			nonSecretBindings.push(binding);
			continue;
		}
		if (typeof binding.name !== "string" || binding.name.length === 0) {
			throw new Error("Wrangler returned an unnamed Worker secret binding");
		}
		secretNames.push(binding.name);
	}
	secretNames.sort();
	if (new Set(secretNames).size !== secretNames.length) {
		throw new Error("Wrangler returned duplicate Worker secret bindings");
	}
	nonSecretBindings.sort((left, right) =>
		JSON.stringify(canonicalJson(left)).localeCompare(
			JSON.stringify(canonicalJson(right)),
		),
	);
	const configurationDigest = createHash("sha256")
		.update(
			JSON.stringify(
				canonicalJson({
					bindings: nonSecretBindings,
					script: version.resources.script,
					script_runtime: version.resources.script_runtime,
				}),
			),
		)
		.digest("hex");
	return { id: expectedVersionId, secretNames, configurationDigest };
}

function versionIdForTag(output: string, expectedTag: string): string {
	const versions = parseJson(output, "Wrangler version list");
	if (!Array.isArray(versions)) {
		throw new Error("Wrangler version list did not return an array");
	}
	const matches = versions.filter(
		(version) =>
			isRecord(version) &&
			typeof version.id === "string" &&
			WORKER_VERSION_ID_PATTERN.test(version.id) &&
			isRecord(version.annotations) &&
			version.annotations["workers/tag"] === expectedTag,
	) as Array<Record<string, unknown> & { id: string }>;
	const match = matches[0];
	if (matches.length !== 1 || !match) {
		throw new Error(
			"Wrangler could not uniquely resolve the reconciled Worker candidate; live traffic was not changed",
		);
	}
	return match.id;
}

function assertExactSecretNames(
	label: "API" | "dashboard",
	actual: readonly string[],
	desired: readonly string[],
): void {
	const actualSet = new Set(actual);
	const desiredSet = new Set(desired);
	const unexpected = actual.filter((name) => !desiredSet.has(name));
	const missing = desired.filter((name) => !actualSet.has(name));
	if (unexpected.length === 0 && missing.length === 0) return;
	const details = [
		...(unexpected.length > 0
			? [`unexpected names: ${unexpected.join(", ")}`]
			: []),
		...(missing.length > 0 ? [`missing names: ${missing.join(", ")}`] : []),
	].join("; ");
	throw new Error(
		`${label} Worker secret reconciliation did not converge (${details}); live traffic was not changed`,
	);
}

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

export async function deployWorker(input: {
	configPath: string;
	secrets: Record<string, string>;
	sourceRoot: string;
	version: string;
	label: "API" | "dashboard";
	runner?: typeof run;
	captureRunner?: typeof runCaptured;
}): Promise<void> {
	const runner = input.runner ?? run;
	const captureRunner = input.captureRunner ?? runCaptured;
	let rolloutDirectory: string | undefined;
	try {
		rolloutDirectory = await mkdtemp(
			join(tmpdir(), "relayapi-worker-rollout-"),
		);
		const outputPath = join(rolloutDirectory, "wrangler-output.jsonl");
		const wranglerEnvironment = {
			...process.env,
			WRANGLER_OUTPUT_FILE_PATH: outputPath,
		};
		const rolloutId = randomUUID().replaceAll("-", "").slice(0, 12);
		const labelTag = input.label === "API" ? "api" : "app";
		const tagPrefix = `relayapi-${input.version}-${labelTag}-${rolloutId}`;
		const uploadTag = `${tagPrefix}-upload`;
		const args = [
			"wrangler",
			"versions",
			"upload",
			"--config",
			input.configPath,
			"--keep-vars",
			"--strict",
			"--tag",
			uploadTag,
			"--message",
			`RelayAPI self-host ${input.version} ${input.label} candidate`,
		];
		if (Object.keys(input.secrets).length > 0) {
			const secretsPath = join(rolloutDirectory, "secrets.json");
			await writeFile(secretsPath, `${JSON.stringify(input.secrets)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			args.push("--secrets-file", secretsPath);
		}
		await runner("bunx", args, {
			cwd: input.sourceRoot,
			env: wranglerEnvironment,
		});
		const uploadedId = uploadedVersionId(await readFile(outputPath, "utf8"));
		const uploadedSnapshot = workerVersionSnapshot(
			await captureRunner(
				"bunx",
				[
					"wrangler",
					"versions",
					"view",
					uploadedId,
					"--config",
					input.configPath,
					"--json",
				],
				{ cwd: input.sourceRoot, env: wranglerEnvironment },
			),
			uploadedId,
		);
		const desiredNames = Object.keys(input.secrets).sort();
		const desiredSet = new Set(desiredNames);
		const staleNames = uploadedSnapshot.secretNames.filter(
			(name) => !desiredSet.has(name),
		);
		let finalCandidateId = uploadedId;
		if (staleNames.length > 0) {
			for (const [index, name] of staleNames.entries()) {
				const finalDeletion = index === staleNames.length - 1;
				const deletionTag = finalDeletion
					? `${tagPrefix}-reconciled`
					: `${tagPrefix}-delete-${index + 1}`;
				try {
					await runner(
						"bunx",
						[
							"wrangler",
							"versions",
							"secret",
							"delete",
							name,
							"--config",
							input.configPath,
							"--tag",
							deletionTag,
							"--message",
							`RelayAPI self-host ${input.version} ${input.label} secret reconciliation`,
						],
						{
							cwd: input.sourceRoot,
							env: wranglerEnvironment,
							stdin: "y\n",
						},
					);
				} catch (error) {
					throw new Error(
						`${input.label} Worker could not stage removal of obsolete secret binding ${name}; live traffic was not changed`,
						{ cause: error },
					);
				}
			}
			const versions = await captureRunner(
				"bunx",
				[
					"wrangler",
					"versions",
					"list",
					"--config",
					input.configPath,
					"--json",
				],
				{ cwd: input.sourceRoot, env: wranglerEnvironment },
			);
			finalCandidateId = versionIdForTag(versions, `${tagPrefix}-reconciled`);
		}
		const finalSnapshot =
			finalCandidateId === uploadedId
				? uploadedSnapshot
				: workerVersionSnapshot(
						await captureRunner(
							"bunx",
							[
								"wrangler",
								"versions",
								"view",
								finalCandidateId,
								"--config",
								input.configPath,
								"--json",
							],
							{ cwd: input.sourceRoot, env: wranglerEnvironment },
						),
						finalCandidateId,
					);
		assertExactSecretNames(
			input.label,
			finalSnapshot.secretNames,
			desiredNames,
		);
		if (
			finalSnapshot.configurationDigest !== uploadedSnapshot.configurationDigest
		) {
			throw new Error(
				`${input.label} Worker code or non-secret bindings changed during secret reconciliation; live traffic was not changed`,
			);
		}
		await runner(
			"bunx",
			[
				"wrangler",
				"versions",
				"deploy",
				`${finalCandidateId}@100%`,
				"--config",
				input.configPath,
				"--message",
				`RelayAPI self-host ${input.version} ${input.label}`,
				"--yes",
			],
			{ cwd: input.sourceRoot, env: wranglerEnvironment },
		);
		await runner(
			"bunx",
			["wrangler", "triggers", "deploy", "--config", input.configPath],
			{ cwd: input.sourceRoot, env: wranglerEnvironment },
		);
	} finally {
		if (rolloutDirectory) {
			await rm(rolloutDirectory, { recursive: true, force: true });
		}
	}
}

export function rolloutRecoveryError(input: {
	stage: string;
	cause: unknown;
	version: string;
	operatorConfigPath: string;
	rollbackWorkerNames: string[];
	explicitSource?: string;
}): Error {
	const forwardCommand = [
		`bunx @relayapi/self-host@${input.version} deploy`,
		`--config ${JSON.stringify(resolve(input.operatorConfigPath))}`,
		...(input.explicitSource
			? [
					`--source ${JSON.stringify(resolve(input.explicitSource))}`,
					"--allow-unsealed-source",
				]
			: []),
	].join(" ");
	const rollbackCommands = input.rollbackWorkerNames.flatMap((workerName) => [
		`bunx wrangler deployments list --name ${JSON.stringify(workerName)}`,
		`bunx wrangler rollback PREVIOUS_VERSION_ID --name ${JSON.stringify(workerName)} --message ${JSON.stringify(`Rollback failed RelayAPI ${input.version} rollout`)}`,
	]);
	const causeMessage =
		input.cause instanceof Error ? input.cause.message : String(input.cause);
	return new Error(
		[
			`RelayAPI rollout failed during ${input.stage}: ${causeMessage}`,
			`Forward repair: rerun ${forwardCommand}. The deploy is idempotent and will reconcile the same sealed release.`,
			...(rollbackCommands.length === 0
				? []
				: [
						"Database migrations are forward-only, so rollback was not attempted automatically. Only if the release notes explicitly confirm schema compatibility, roll back each possibly activated Worker with:",
						...rollbackCommands,
					]),
		].join("\n"),
		{ cause: input.cause },
	);
}

export async function deploy(options: CliOptions): Promise<void> {
	if (options.source && !options.allowUnsealedSource) {
		throw new Error(
			"deploy --source bypasses the sealed release archive and requires --allow-unsealed-source",
		);
	}
	if (!options.source && options.allowUnsealedSource) {
		throw new Error(
			"--allow-unsealed-source is valid only with deploy --source",
		);
	}
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

	await withResolvedSource(lock, options.source, async (source) => {
		if (options.source) {
			console.warn(
				`Using acknowledged --source override ${source.root}; the sealed release archive is not being used`,
			);
		}

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
			persist: (appliedConfig) =>
				writeConfig(appliedConfig, options.configPath),
		});
		if (!reconciliation.applied) {
			console.log(JSON.stringify(reconciliation.plan, null, 2));
			return;
		}
		console.log(
			`Hyperdrive CA certificate intent: ${reconciliation.plan.hyperdrive.caCertificateAction} ${reconciliation.plan.hyperdrive.caCertificateId}`,
		);
		config = reconciliation.config;

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
		const expectedRuntime = validateRuntimeDatabaseUrl(runtimeDatabaseUrl);
		let rolloutStage = "API Worker verified exact-secret deployment";
		const rollbackWorkerNames: string[] = [];
		try {
			rollbackWorkerNames.push(RESOURCE_NAMES.workers.api);
			await deployWorker({
				configPath: apiConfigPath,
				secrets: apiSecrets,
				sourceRoot: source.root,
				version: lock.version,
				label: "API",
			});
			rolloutStage = "API Worker database probe";
			await probeWorkerDatabase({
				label: "API",
				hostname: config.cloudflare.apiHostname,
				token: smokeCredential.token,
				expectedDatabase: expectedRuntime.database,
				expectedUser: expectedRuntime.username,
			});
			rolloutStage = "dashboard Worker verified exact-secret deployment";
			rollbackWorkerNames.push(RESOURCE_NAMES.workers.app);
			await deployWorker({
				configPath: appConfigPath,
				secrets: {
					BETTER_AUTH_SECRET: betterAuthSecret,
					...selectedEnvironment(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]),
				},
				sourceRoot: source.root,
				version: lock.version,
				label: "dashboard",
			});
			rolloutStage = "dashboard Worker database probe";
			await probeWorkerDatabase({
				label: "dashboard",
				hostname: config.cloudflare.appHostname,
				token: smokeCredential.token,
				expectedDatabase: expectedRuntime.database,
				expectedUser: expectedRuntime.username,
			});
		} catch (error) {
			throw rolloutRecoveryError({
				stage: rolloutStage,
				cause: error,
				version: lock.version,
				operatorConfigPath: options.configPath,
				rollbackWorkerNames,
				...(options.source ? { explicitSource: options.source } : {}),
			});
		}
		console.log(`RelayAPI is live at https://${config.cloudflare.appHostname}`);
		console.log(`API: https://${config.cloudflare.apiHostname}`);
	});
}

export function workerNames(): typeof RESOURCE_NAMES.workers {
	return RESOURCE_NAMES.workers;
}
