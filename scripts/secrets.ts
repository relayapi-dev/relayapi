import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parse as parseDotenv } from "@dotenvx/dotenvx";

type SecretValues = Record<string, string>;
type SecretGroupName = "development" | "production";
type CloudflareTargetName = "api" | "app";

export type SecretFileSpec = {
	id: string;
	plain: string;
	vault: string;
	example: string;
	required: string[];
	optional: string[];
	completeGroups: string[][];
	exampleLiteralKeys?: string[];
	cloudflareTarget?: CloudflareTargetName;
	optionalVault?: boolean;
};

export type SecretGroupSpec = {
	name: SecretGroupName;
	alias: string;
	publicKeyName: string;
	privateKeyName: string;
	files: SecretFileSpec[];
};

type ProductionResources = {
	accountId: string;
	workerName: string;
	requiredSecrets: string[];
	secretGroups: string[][];
};

const ROOT = resolve(import.meta.dir, "..");
const ENV_KEYS_FILE = join(ROOT, ".env.keys");
const DOTENVX = join(
	ROOT,
	"node_modules",
	".bin",
	process.platform === "win32" ? "dotenvx.cmd" : "dotenvx",
);
const WRANGLER = join(
	ROOT,
	"node_modules",
	".bin",
	process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);

const productionResources = JSON.parse(
	readFileSync(join(ROOT, "apps/api/production-resources.json"), "utf8"),
) as ProductionResources;

const developmentApiGroups = [
	["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"],
	["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"],
	["THREADS_APP_ID", "THREADS_APP_SECRET"],
	["WHATSAPP_APP_ID", "WHATSAPP_APP_SECRET"],
	["TELNYX_API_KEY", "STRIPE_WA_PHONE_PRICE_ID"],
];

export const secretGroups: Record<SecretGroupName, SecretGroupSpec> = {
	development: {
		name: "development",
		alias: ".env.development",
		publicKeyName: "DOTENV_PUBLIC_KEY_DEVELOPMENT",
		privateKeyName: "DOTENV_PRIVATE_KEY_DEVELOPMENT",
		files: [
			{
				id: "api-development",
				plain: "apps/api/.dev.vars",
				vault: "apps/api/.dev.vars.vault",
				example: "apps/api/.dev.vars.example",
				required: [
					"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
					"ENCRYPTION_KEY",
				],
				optional: [
					"BETTER_AUTH_SECRET",
					"RELAYAPI_DB_SSH_TARGET",
					"STRIPE_SECRET_KEY",
					"STRIPE_PRO_PRICE_ID",
					"STRIPE_WEBHOOK_SECRET",
					"STRIPE_PORTAL_CONFIGURATION_ID",
				],
				completeGroups: developmentApiGroups,
				exampleLiteralKeys: ["RELAYAPI_DB_SSH_TARGET"],
			},
			{
				id: "app-development",
				plain: "apps/app/.dev.vars",
				vault: "apps/app/.dev.vars.vault",
				example: "apps/app/.dev.vars.example",
				required: [],
				optional: [
					"REMOTE_DASHBOARD_ORIGIN",
					"API_BASE_URL",
					"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
					"BETTER_AUTH_SECRET",
				],
				completeGroups: [],
				exampleLiteralKeys: ["REMOTE_DASHBOARD_ORIGIN", "API_BASE_URL"],
			},
			{
				id: "database-development",
				plain: "packages/db/.env",
				vault: "packages/db/.env.vault",
				example: "packages/db/.env.example",
				required: ["CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE"],
				optional: [],
				completeGroups: [],
			},
		],
	},
	production: {
		name: "production",
		alias: ".env.production",
		publicKeyName: "DOTENV_PUBLIC_KEY_PRODUCTION",
		privateKeyName: "DOTENV_PRIVATE_KEY_PRODUCTION",
		files: [
			{
				id: "api-production",
				plain: "apps/api/.production.secrets",
				vault: "apps/api/.production.secrets.vault",
				example: "apps/api/.production.secrets.example",
				required: productionResources.requiredSecrets,
				optional: [
					"API_BASE_URL",
					"OPERATIONS_ALERT_EMAIL",
					"OPERATIONS_ALERT_WEBHOOK_URL",
				],
				completeGroups: productionResources.secretGroups,
				cloudflareTarget: "api",
				optionalVault: true,
			},
			{
				id: "app-production",
				plain: "apps/app/.production.secrets",
				vault: "apps/app/.production.secrets.vault",
				example: "apps/app/.production.secrets.example",
				required: ["BETTER_AUTH_SECRET", "MAINTENANCE_SMOKE_BYPASS_SHA256"],
				optional: ["BETTER_AUTH_URL"],
				completeGroups: [["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
				exampleLiteralKeys: ["BETTER_AUTH_URL"],
				cloudflareTarget: "app",
				optionalVault: true,
			},
		],
	},
};

function absolute(path: string): string {
	return join(ROOT, path);
}

function parseValues(source: string): SecretValues {
	return parseDotenv(source, { processEnv: {} });
}

function parseRawAssignments(source: string): SecretValues {
	const values: SecretValues = {};
	for (const line of source.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match?.[1]) throw new Error("vault contains a malformed assignment");
		if (match[1] in values) {
			throw new Error(`vault contains duplicate assignment ${match[1]}`);
		}
		let value = (match[2] ?? "").trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value;
	}
	return values;
}

function withoutDotenvKeys(values: SecretValues): SecretValues {
	return Object.fromEntries(
		Object.entries(values).filter(
			([key]) =>
				!key.startsWith("DOTENV_PUBLIC_KEY") &&
				!key.startsWith("DOTENV_PRIVATE_KEY"),
		),
	);
}

export function allowedSecretKeys(spec: SecretFileSpec): Set<string> {
	return new Set([
		...spec.required,
		...spec.optional,
		...spec.completeGroups.flat(),
	]);
}

export function isPlaceholder(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return (
		normalized.length === 0 ||
		/^(?:change|replace)[-_ ]?me(?:[-_ ].*)?$/.test(normalized) ||
		/^your[-_ ]/.test(normalized) ||
		/<[^>]+>/.test(normalized) ||
		normalized.includes(".invalid")
	);
}

export function validateEncryptionKeyRing(value: string): void {
	const ids = new Set<string>();
	const entries = value.split(",");
	if (entries.length === 0) {
		throw new Error(
			"ENCRYPTION_KEY must contain at least one key-id=64-hex entry",
		);
	}
	for (const rawEntry of entries) {
		const entry = rawEntry.trim();
		const separator = entry.indexOf("=");
		if (separator <= 0 || entry.indexOf("=", separator + 1) !== -1) {
			throw new Error("ENCRYPTION_KEY must use key-id=64-hex entries");
		}
		const id = entry.slice(0, separator);
		const hex = entry.slice(separator + 1);
		if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
			throw new Error(`ENCRYPTION_KEY contains an invalid key id: ${id}`);
		}
		if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
			throw new Error(
				`ENCRYPTION_KEY ${id} must contain exactly 64 hexadecimal characters`,
			);
		}
		if (ids.has(id)) {
			throw new Error(`ENCRYPTION_KEY contains duplicate key id: ${id}`);
		}
		ids.add(id);
	}
	const activeId = entries[0]?.trim().split("=", 1)[0];
	if (activeId === "identity") {
		throw new Error(
			"ENCRYPTION_KEY identity entry is retained consent material and cannot be active",
		);
	}
	if (!ids.has("identity")) {
		throw new Error(
			"ENCRYPTION_KEY must retain an identity=64-hex entry for consent authority",
		);
	}
}

export function evaluateCompleteSecretGroups(
	groups: readonly (readonly string[])[],
	configuredKeys: ReadonlySet<string>,
): {
	states: Array<{
		group: readonly string[];
		present: string[];
		triggered: boolean;
	}>;
	orphanedKeys: string[];
} {
	const groupKeyCounts = new Map<string, number>();
	for (const group of groups) {
		for (const key of group) {
			groupKeyCounts.set(key, (groupKeyCounts.get(key) ?? 0) + 1);
		}
	}

	const states = groups.map((group) => {
		const present = group.filter((key) => configuredKeys.has(key));
		const uniqueKeys = group.filter((key) => groupKeyCounts.get(key) === 1);
		const triggerKeys = uniqueKeys.length > 0 ? uniqueKeys : group;
		return {
			group,
			present,
			triggered: triggerKeys.some((key) => configuredKeys.has(key)),
		};
	});
	const coveredGroupKeys = new Set(
		states
			.filter(({ triggered }) => triggered)
			.flatMap(({ group }) => [...group]),
	);
	const orphanedKeys = [...groupKeyCounts.keys()].filter(
		(key) => configuredKeys.has(key) && !coveredGroupKeys.has(key),
	);

	return { states, orphanedKeys };
}

export function validateTargetValues(
	spec: SecretFileSpec,
	input: SecretValues,
): SecretValues {
	const values = withoutDotenvKeys(input);
	const allowed = allowedSecretKeys(spec);
	const unknown = Object.keys(values).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		throw new Error(
			`${spec.id} contains keys outside its target allowlist: ${unknown.join(", ")}`,
		);
	}

	const missing = spec.required.filter(
		(key) => !(key in values) || isPlaceholder(values[key] ?? ""),
	);
	if (missing.length > 0) {
		throw new Error(
			`${spec.id} is missing real values for: ${missing.join(", ")}`,
		);
	}

	const encryptionKey = values.ENCRYPTION_KEY;
	if (encryptionKey && !isPlaceholder(encryptionKey)) {
		validateEncryptionKeyRing(encryptionKey);
	}

	const configuredGroupKeys = new Set(
		Object.entries(values)
			.filter(([, value]) => value.trim().length > 0)
			.map(([key]) => key),
	);
	const { states: groupStates, orphanedKeys } = evaluateCompleteSecretGroups(
		spec.completeGroups,
		configuredGroupKeys,
	);
	for (const { group, present, triggered } of groupStates) {
		if (triggered && present.length !== group.length) {
			throw new Error(
				`${spec.id} must provide all or none of: ${group.join(", ")}`,
			);
		}
	}
	if (orphanedKeys.length > 0) {
		throw new Error(
			`${spec.id} has grouped values without a complete provider group: ${orphanedKeys.join(", ")}`,
		);
	}

	for (const [key, value] of Object.entries(values)) {
		if (value.trim().length > 0 && isPlaceholder(value)) {
			throw new Error(`${spec.id} contains a placeholder for ${key}`);
		}
	}

	return values;
}

export function selectCloudflareSecrets(
	spec: SecretFileSpec,
	input: SecretValues,
): SecretValues {
	const validated = validateTargetValues(spec, input);
	return Object.fromEntries(
		Object.entries(validated).filter(([, value]) => value.trim().length > 0),
	);
}

export function validateExampleValues(
	spec: SecretFileSpec,
	input: SecretValues,
): void {
	const values = withoutDotenvKeys(input);
	const allowed = allowedSecretKeys(spec);
	const unknown = Object.keys(values).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		throw new Error(
			`${spec.example} contains keys outside its target allowlist: ${unknown.join(", ")}`,
		);
	}
	const missing = spec.required.filter((key) => !(key in values));
	if (missing.length > 0) {
		throw new Error(
			`${spec.example} does not document required keys: ${missing.join(", ")}`,
		);
	}
	for (const group of spec.completeGroups) {
		const documented = group.filter((key) => key in values);
		if (documented.length > 0 && documented.length !== group.length) {
			throw new Error(
				`${spec.example} must document all or none of: ${group.join(", ")}`,
			);
		}
	}
	if (
		Object.entries(input).some(
			([key, value]) =>
				key.startsWith("DOTENV_PRIVATE_KEY") || value.startsWith("encrypted:"),
		)
	) {
		throw new Error(
			`${spec.example} must contain placeholders, never key material`,
		);
	}
	const exampleLiteralKeys = new Set(spec.exampleLiteralKeys ?? []);
	const unsafeExampleKeys = Object.entries(values)
		.filter(
			([key, value]) =>
				value.trim().length > 0 &&
				!exampleLiteralKeys.has(key) &&
				!isPlaceholder(value),
		)
		.map(([key]) => key);
	if (unsafeExampleKeys.length > 0) {
		throw new Error(
			`${spec.example} must use placeholders for secret values: ${unsafeExampleKeys.join(", ")}`,
		);
	}
}

export function validateVaultStructure(
	group: SecretGroupSpec,
	source: string,
): SecretValues {
	const values = parseRawAssignments(source);
	const publicKeys = Object.keys(values).filter((key) =>
		key.startsWith("DOTENV_PUBLIC_KEY"),
	);
	const privateKeys = Object.keys(values).filter((key) =>
		key.startsWith("DOTENV_PRIVATE_KEY"),
	);
	if (publicKeys.length !== 1 || publicKeys[0] !== group.publicKeyName) {
		throw new Error(
			`${group.name} vault must contain exactly ${group.publicKeyName}`,
		);
	}
	if (privateKeys.length > 0) {
		throw new Error(`${group.name} vault contains a private key`);
	}
	const secrets = withoutDotenvKeys(values);
	if (Object.keys(secrets).length === 0) {
		throw new Error(`${group.name} vault contains no secret values`);
	}
	for (const [key, value] of Object.entries(secrets)) {
		if (!value.startsWith("encrypted:")) {
			throw new Error(`${group.name} vault contains plaintext key ${key}`);
		}
	}
	return secrets;
}

function publicKeyLine(group: SecretGroupSpec): string | undefined {
	for (const spec of group.files) {
		const vault = absolute(spec.vault);
		if (!existsSync(vault)) continue;
		const line = readFileSync(vault, "utf8")
			.split(/\r?\n/)
			.find((candidate) => candidate.startsWith(`${group.publicKeyName}=`));
		if (line) return line;
	}
	return undefined;
}

function stripPublicKeyAssignments(source: string): string {
	return source
		.split(/\r?\n/)
		.filter(
			(line) =>
				!line.startsWith("DOTENV_PUBLIC_KEY") &&
				!line.startsWith("DOTENV_PRIVATE_KEY"),
		)
		.join("\n")
		.replace(/^\n+/, "");
}

function stripDecryptionBanner(source: string, group: SecretGroupSpec): string {
	const markers = new Set([
		`# ${group.alias}`,
		...group.files.map((spec) => `# ${basename(spec.vault)}`),
	]);
	return source
		.split(/\r?\n/)
		.filter(
			(line) =>
				!line.startsWith("#/") &&
				!line.startsWith("DOTENV_PUBLIC_KEY") &&
				!line.startsWith("DOTENV_PRIVATE_KEY") &&
				!markers.has(line),
		)
		.join("\n")
		.replace(/^\s*\n/, "")
		.replace(/\n*$/, "\n");
}

type SpawnOptions = {
	cwd?: string;
	env?: Record<string, string | undefined>;
	capture?: boolean;
	sanitizedLabel: string;
};

async function spawnCommand(
	command: string,
	args: string[],
	options: SpawnOptions,
): Promise<string> {
	const capture = options.capture ?? false;
	const subprocess = Bun.spawn([command, ...args], {
		cwd: options.cwd ?? ROOT,
		env: { ...process.env, ...options.env },
		stdin: "inherit",
		stdout: capture ? "pipe" : "inherit",
		stderr: capture ? "pipe" : "inherit",
	});
	const stdoutPromise = capture
		? new Response(subprocess.stdout).text()
		: Promise.resolve("");
	const stderrPromise = capture
		? new Response(subprocess.stderr).text()
		: Promise.resolve("");
	const [exitCode, stdout] = await Promise.all([
		subprocess.exited,
		stdoutPromise,
		stderrPromise,
	]);
	if (exitCode !== 0) {
		throw new Error(`${options.sanitizedLabel} failed`);
	}
	return stdout;
}

function dotenvxKeyArgs(): string[] {
	return existsSync(ENV_KEYS_FILE) ? ["-fk", ENV_KEYS_FILE] : [];
}

async function decryptVault(
	group: SecretGroupSpec,
	spec: SecretFileSpec,
	providerFlags: string[] = [],
): Promise<string> {
	const vault = absolute(spec.vault);
	const stdout = await spawnCommand(
		DOTENVX,
		["decrypt", "-f", vault, ...dotenvxKeyArgs(), ...providerFlags, "--stdout"],
		{ capture: true, sanitizedLabel: `decrypting ${spec.vault}` },
	);
	return stripDecryptionBanner(stdout, group);
}

function equalValues(left: SecretValues, right: SecretValues): boolean {
	const normalize = (values: SecretValues) =>
		JSON.stringify(
			Object.entries(values).sort(([a], [b]) => a.localeCompare(b)),
		);
	return normalize(left) === normalize(right);
}

function writeAtomic(path: string, contents: string, mode: number): void {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(temporary, contents, { mode });
	chmodSync(temporary, mode);
	renameSync(temporary, path);
}

async function encryptFile(
	group: SecretGroupSpec,
	spec: SecretFileSpec,
): Promise<void> {
	const plain = absolute(spec.plain);
	const vault = absolute(spec.vault);
	if (!existsSync(plain)) {
		console.log(`skip      ${spec.plain} (no local file)`);
		return;
	}
	chmodSync(plain, 0o600);
	const plainSource = readFileSync(plain, "utf8");
	const plainValues = validateTargetValues(spec, parseValues(plainSource));

	if (existsSync(vault)) {
		validateVaultStructure(group, readFileSync(vault, "utf8"));
		try {
			const current = parseValues(await decryptVault(group, spec));
			if (equalValues(plainValues, current)) {
				console.log(`unchanged ${spec.plain}`);
				return;
			}
		} catch {
			// A public key is sufficient to rotate ciphertext. Decryption is not
			// required when the current machine is write-only.
		}
	}

	const temporaryDirectory = mkdtempSync(
		join(tmpdir(), `relayapi-dotenvx-${group.name}-`),
	);
	try {
		const existingPublicKey = publicKeyLine(group);
		const temporaryFile = join(
			temporaryDirectory,
			existingPublicKey ? basename(spec.vault) : group.alias,
		);
		const encryptionInput = existingPublicKey
			? `${existingPublicKey}\n${stripPublicKeyAssignments(plainSource)}`
			: stripPublicKeyAssignments(plainSource);
		writeFileSync(temporaryFile, encryptionInput, { mode: 0o600 });
		await spawnCommand(
			DOTENVX,
			[
				"encrypt",
				"--no-armor",
				"--no-native",
				"-f",
				temporaryFile,
				"-fk",
				ENV_KEYS_FILE,
			],
			{ capture: true, sanitizedLabel: `encrypting ${spec.plain}` },
		);
		const encrypted = readFileSync(temporaryFile, "utf8");
		validateVaultStructure(group, encrypted);
		writeAtomic(vault, encrypted, 0o644);
		if (existsSync(ENV_KEYS_FILE)) chmodSync(ENV_KEYS_FILE, 0o600);
		console.log(`encrypted ${spec.plain} -> ${spec.vault}`);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function selectedGroups(
	args: string[],
	defaults: SecretGroupName[],
): SecretGroupSpec[] {
	const selection = args.find(
		(value): value is SecretGroupName =>
			value === "development" || value === "production",
	);
	return selection
		? [secretGroups[selection]]
		: defaults.map((name) => secretGroups[name]);
}

async function commandInit(args: string[]): Promise<void> {
	for (const group of selectedGroups(args, ["development"])) {
		for (const spec of group.files) {
			const plain = absolute(spec.plain);
			if (existsSync(plain)) {
				console.log(`unchanged ${spec.plain}`);
				continue;
			}
			copyFileSync(absolute(spec.example), plain);
			chmodSync(plain, 0o600);
			console.log(`created   ${spec.plain} from ${spec.example}`);
		}
	}
	console.log(
		"Replace every required placeholder before encrypting or deploying.",
	);
}

async function commandEncrypt(args: string[]): Promise<void> {
	for (const group of selectedGroups(args, ["development"])) {
		for (const spec of group.files) await encryptFile(group, spec);
	}
	console.log("Done. Commit only the .vault files; never commit .env.keys.");
}

async function commandDecrypt(args: string[]): Promise<void> {
	const force = args.includes("--force");
	const providerFlags = ["--no-armor", "--no-native"].filter((flag) =>
		args.includes(flag),
	);
	for (const group of selectedGroups(args, ["development"])) {
		for (const spec of group.files) {
			const plain = absolute(spec.plain);
			const vault = absolute(spec.vault);
			if (!existsSync(vault)) {
				console.log(`skip      ${spec.vault} (no vault)`);
				continue;
			}
			validateVaultStructure(group, readFileSync(vault, "utf8"));
			const decrypted = await decryptVault(group, spec, providerFlags);
			const decryptedValues = validateTargetValues(
				spec,
				parseValues(decrypted),
			);
			if (existsSync(plain)) {
				const localValues = parseValues(readFileSync(plain, "utf8"));
				if (equalValues(decryptedValues, localValues)) {
					chmodSync(plain, 0o600);
					console.log(`unchanged ${spec.plain}`);
					continue;
				}
				if (!force) {
					console.log(
						`differs   ${spec.plain} (rerun with --force to overwrite)`,
					);
					continue;
				}
			}
			writeAtomic(plain, decrypted, 0o600);
			console.log(`wrote     ${spec.plain}`);
		}
	}
}

async function commandValidate(): Promise<void> {
	let failures = 0;
	for (const group of Object.values(secretGroups)) {
		let groupPublicKey: string | undefined;
		for (const spec of group.files) {
			try {
				validateExampleValues(
					spec,
					parseValues(readFileSync(absolute(spec.example), "utf8")),
				);
				console.log(`example      ${spec.example}`);
			} catch (error) {
				console.error(
					`unsafe       ${spec.example}: ${error instanceof Error ? error.message : "invalid example"}`,
				);
				failures += 1;
			}
			const vault = absolute(spec.vault);
			if (!existsSync(vault)) {
				if (spec.optionalVault) {
					console.log(`unconfigured ${spec.vault}`);
					continue;
				}
				console.error(`missing      ${spec.vault}`);
				failures += 1;
				continue;
			}
			try {
				validateVaultStructure(group, readFileSync(vault, "utf8"));
				const line = readFileSync(vault, "utf8")
					.split(/\r?\n/)
					.find((candidate) => candidate.startsWith(`${group.publicKeyName}=`));
				if (groupPublicKey && line !== groupPublicKey) {
					throw new Error(`${group.name} vaults do not share one public key`);
				}
				groupPublicKey = line;
				console.log(`safe         ${spec.vault}`);
			} catch (error) {
				console.error(
					`unsafe       ${spec.vault}: ${error instanceof Error ? error.message : "invalid vault"}`,
				);
				failures += 1;
			}
		}
	}
	if (failures > 0) throw new Error(`${failures} vault validation failure(s)`);
}

async function commandCheck(): Promise<void> {
	let failures = 0;
	for (const group of Object.values(secretGroups)) {
		for (const spec of group.files) {
			const plain = absolute(spec.plain);
			const vault = absolute(spec.vault);
			if (!existsSync(vault)) {
				if (spec.optionalVault && !existsSync(plain)) {
					console.log(`unconfigured ${spec.vault}`);
					continue;
				}
				console.log(`no-vault    ${spec.plain}`);
				failures += 1;
				continue;
			}
			try {
				validateVaultStructure(group, readFileSync(vault, "utf8"));
				if (!existsSync(plain)) {
					console.log(`no-local    ${spec.plain}`);
					failures += 1;
					continue;
				}
				const decrypted = parseValues(await decryptVault(group, spec));
				const local = parseValues(readFileSync(plain, "utf8"));
				if (equalValues(decrypted, local)) {
					console.log(`in-sync     ${spec.plain}`);
				} else {
					console.log(`drift       ${spec.plain}`);
					failures += 1;
				}
			} catch {
				console.log(`locked      ${spec.vault}`);
				failures += 1;
			}
		}
	}
	if (failures > 0) throw new Error(`${failures} secret status failure(s)`);
}

function keyAvailableLocally(group: SecretGroupSpec): boolean {
	if (!existsSync(ENV_KEYS_FILE)) return false;
	return (
		group.privateKeyName in parseValues(readFileSync(ENV_KEYS_FILE, "utf8"))
	);
}

async function withGroupAlias(
	group: SecretGroupSpec,
	callback: (alias: string) => Promise<void>,
): Promise<void> {
	const sourceSpec = group.files.find((spec) =>
		existsSync(absolute(spec.vault)),
	);
	if (!sourceSpec) {
		console.log(`skip      ${group.name} (no vault)`);
		return;
	}
	const directory = mkdtempSync(
		join(tmpdir(), `relayapi-${group.name}-alias-`),
	);
	try {
		const alias = join(directory, group.alias);
		copyFileSync(absolute(sourceSpec.vault), alias);
		await callback(alias);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function commandArmor(args: string[]): Promise<void> {
	for (const group of selectedGroups(args, ["development"])) {
		await withGroupAlias(group, async (alias) => {
			if (!keyAvailableLocally(group)) {
				try {
					await spawnCommand(
						DOTENVX,
						["native", "pull", "-f", alias, "-fk", ENV_KEYS_FILE],
						{
							capture: true,
							sanitizedLabel: `restoring ${group.name} native key`,
						},
					);
				} catch {
					const sourceSpec = group.files.find((spec) =>
						existsSync(absolute(spec.vault)),
					);
					if (sourceSpec) {
						await decryptVault(group, sourceSpec, ["--no-native"]);
						console.log(`already    ${group.name} key is available in Armor`);
						return;
					}
					throw new Error(`${group.name} private key is unavailable`);
				}
			}
			await spawnCommand(DOTENVX, ["armor", "up", "-f", alias], {
				sanitizedLabel: `armoring ${group.name} key`,
			});
			console.log(`armored    ${group.name} key`);
		});
	}
}

async function commandNative(args: string[]): Promise<void> {
	for (const group of selectedGroups(args, ["development"])) {
		await withGroupAlias(group, async (alias) => {
			if (!keyAvailableLocally(group)) {
				try {
					await spawnCommand(DOTENVX, ["armor", "down", "-f", alias], {
						sanitizedLabel: `restoring ${group.name} Armor key`,
					});
				} catch {
					const sourceSpec = group.files.find((spec) =>
						existsSync(absolute(spec.vault)),
					);
					if (sourceSpec) {
						await decryptVault(group, sourceSpec, ["--no-armor"]);
						console.log(`already    ${group.name} key is in the native store`);
						return;
					}
					throw new Error(`${group.name} private key is unavailable`);
				}
			}
			await spawnCommand(
				DOTENVX,
				["native", "up", "-f", alias, "-fk", ENV_KEYS_FILE],
				{ sanitizedLabel: `storing ${group.name} native key` },
			);
			console.log(`stored     ${group.name} key in the native secret store`);
		});
	}
}

function productionSpec(target: string): SecretFileSpec {
	if (target !== "api" && target !== "app") {
		throw new Error("Cloudflare target must be api or app");
	}
	const spec = secretGroups.production.files.find(
		(candidate) => candidate.cloudflareTarget === target,
	);
	if (!spec) throw new Error(`No production manifest for ${target}`);
	return spec;
}

function workerDirectory(target: CloudflareTargetName): string {
	return absolute(target === "api" ? "apps/api" : "apps/app");
}

async function withSecretsJson(
	spec: SecretFileSpec,
	values: SecretValues,
	callback: (path: string) => Promise<void>,
): Promise<void> {
	const selected = selectCloudflareSecrets(spec, values);
	const directory = mkdtempSync(join(tmpdir(), "relayapi-wrangler-secrets-"));
	try {
		const file = join(directory, "secrets.json");
		writeFileSync(file, `${JSON.stringify(selected)}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		await callback(file);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

async function runCloudflareOperation(
	mode: "sync" | "deploy" | "preflight" | "verify",
	spec: SecretFileSpec,
	values: SecretValues,
	wranglerArgs: string[],
): Promise<void> {
	const target = spec.cloudflareTarget;
	if (!target) throw new Error(`${spec.id} has no Cloudflare target`);
	if (mode === "verify" || mode === "preflight") {
		const expectedNames = Object.keys(
			selectCloudflareSecrets(spec, values),
		).sort();
		const { verifyWorkerSecrets } = await import(
			"./verify-cloudflare-worker-secrets"
		);
		await verifyWorkerSecrets(target, expectedNames, mode === "preflight");
		return;
	}
	await withSecretsJson(spec, values, async (secretsFile) => {
		const args =
			mode === "sync"
				? ["versions", "secret", "bulk", secretsFile, ...wranglerArgs]
				: ["deploy", "--secrets-file", secretsFile, ...wranglerArgs];
		await spawnCommand(WRANGLER, args, {
			cwd: workerDirectory(target),
			sanitizedLabel: `Cloudflare ${mode} for ${target}`,
		});
	});
}

async function runCloudflareThroughArmor(
	mode: "sync" | "deploy" | "preflight" | "verify",
	spec: SecretFileSpec,
	wranglerArgs: string[],
): Promise<void> {
	const token = process.env.DOTENVX_ARMOR_TOKEN;
	if (!token) throw new Error("DOTENVX_ARMOR_TOKEN is required in CI");
	await spawnCommand(
		DOTENVX,
		[
			"run",
			"--redact",
			"--strict",
			"--overload",
			"--token",
			token,
			"-f",
			absolute(spec.vault),
			"--",
			process.execPath,
			join(ROOT, "scripts/secrets.ts"),
			"cf-child",
			mode,
			spec.cloudflareTarget ?? "",
			"--",
			...wranglerArgs,
		],
		{
			env: { RELAYAPI_DOTENVX_CHILD: "1" },
			sanitizedLabel: `Armor-backed Cloudflare ${mode}`,
		},
	);
}

async function commandCloudflare(
	mode: "sync" | "deploy" | "preflight" | "verify",
	args: string[],
): Promise<void> {
	const [targetArg, ...remainder] = args.filter(
		(value, index) => !(value === "--" && index === 0),
	);
	const spec = productionSpec(targetArg ?? "");
	const target = spec.cloudflareTarget as CloudflareTargetName;
	const wranglerArgs = remainder[0] === "--" ? remainder.slice(1) : remainder;
	if (!existsSync(absolute(spec.vault))) {
		if (mode !== "deploy") {
			throw new Error(
				`${spec.vault} is not configured; import and encrypt production secrets first`,
			);
		}
		console.log(
			`No ${spec.vault}; deploying with existing Cloudflare secrets.`,
		);
		await spawnCommand(WRANGLER, ["deploy", ...wranglerArgs], {
			cwd: workerDirectory(target),
			sanitizedLabel: `Cloudflare deploy for ${target}`,
		});
		return;
	}
	validateVaultStructure(
		secretGroups.production,
		readFileSync(absolute(spec.vault), "utf8"),
	);
	if (process.env.CI || process.env.DOTENVX_ARMOR_TOKEN) {
		await runCloudflareThroughArmor(mode, spec, wranglerArgs);
		return;
	}
	const values = parseValues(await decryptVault(secretGroups.production, spec));
	await runCloudflareOperation(mode, spec, values, wranglerArgs);
}

async function commandCloudflareChild(args: string[]): Promise<void> {
	if (process.env.RELAYAPI_DOTENVX_CHILD !== "1") {
		throw new Error("cf-child is an internal command");
	}
	const [modeArg, targetArg, ...remainder] = args;
	if (
		modeArg !== "sync" &&
		modeArg !== "deploy" &&
		modeArg !== "preflight" &&
		modeArg !== "verify"
	) {
		throw new Error("Invalid internal Cloudflare mode");
	}
	const spec = productionSpec(targetArg ?? "");
	const wranglerArgs = remainder[0] === "--" ? remainder.slice(1) : remainder;
	const values = Object.fromEntries(
		[...allowedSecretKeys(spec)].map((key) => [key, process.env[key] ?? ""]),
	);
	await runCloudflareOperation(modeArg, spec, values, wranglerArgs);
}

type CloudflareSecretBinding = { name?: string; type?: string };

export function unexpectedCloudflareSecretNames(
	spec: SecretFileSpec,
	bindings: readonly CloudflareSecretBinding[],
): string[] {
	const allowed = allowedSecretKeys(spec);
	return bindings
		.filter((binding) => binding.type?.startsWith("secret_"))
		.map((binding) => binding.name)
		.filter(
			(name): name is string => typeof name === "string" && !allowed.has(name),
		)
		.sort();
}

function usage(): never {
	throw new Error(
		"usage: secrets.ts init|encrypt|decrypt|check|validate|armor|native [development|production] | cf-sync|cf-deploy|cf-preflight|cf-verify api|app [-- wrangler args]",
	);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const args = [...argv];
	if (args[0] === "--") args.shift();
	const command = args.shift();
	switch (command) {
		case "init":
			return commandInit(args);
		case "encrypt":
			return commandEncrypt(args);
		case "decrypt":
			return commandDecrypt(args);
		case "check":
			return commandCheck();
		case "validate":
			return commandValidate();
		case "armor":
			return commandArmor(args);
		case "native":
			return commandNative(args);
		case "cf-sync":
			return commandCloudflare("sync", args);
		case "cf-deploy":
			return commandCloudflare("deploy", args);
		case "cf-preflight":
			return commandCloudflare("preflight", args);
		case "cf-verify":
			return commandCloudflare("verify", args);
		case "cf-child":
			return commandCloudflareChild(args);
		default:
			return usage();
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(
			`error: ${error instanceof Error ? error.message : "secret command failed"}`,
		);
		process.exit(1);
	});
}
