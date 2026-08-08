import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	CONFIG_FILENAME,
	DEFAULT_SOURCE_REPOSITORY,
	LOCK_FILENAME,
	QUEUE_NAMES,
} from "./constants.js";
import type { SelfHostConfig, SelfHostLock } from "./types.js";

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value.trim();
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
	return value;
}

function hostname(value: unknown, label: string): string {
	const parsed = string(value, label).toLowerCase().replace(/\.$/, "");
	if (
		parsed.length > 253 ||
		!parsed.includes(".") ||
		!parsed
			.split(".")
			.every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
	) {
		throw new Error(`${label} is not a valid hostname`);
	}
	return parsed;
}

function r2Jurisdiction(value: unknown): "default" | "eu" {
	const parsed =
		value === undefined
			? "default"
			: string(value, "cloudflare.r2Jurisdiction");
	if (parsed !== "default" && parsed !== "eu") {
		throw new Error('cloudflare.r2Jurisdiction must be "default" or "eu"');
	}
	return parsed;
}

const CLOUDFLARE_CERTIFICATE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateHyperdriveCaCertificateId(
	value: unknown,
	label = "cloudflare.hyperdriveCaCertificateId",
): string {
	const parsed = string(value, label).toLowerCase();
	if (!CLOUDFLARE_CERTIFICATE_ID.test(parsed)) {
		throw new Error(`${label} must be a Cloudflare certificate UUID`);
	}
	return parsed;
}

export function withResolvedHyperdriveCaCertificateId(
	config: SelfHostConfig,
	caCertificateId: string,
	options: { allowExplicitReplacement?: boolean } = {},
): SelfHostConfig {
	const resolved = validateHyperdriveCaCertificateId(caCertificateId);
	const configured = config.cloudflare.hyperdriveCaCertificateId
		? validateHyperdriveCaCertificateId(
				config.cloudflare.hyperdriveCaCertificateId,
			)
		: undefined;
	if (
		configured &&
		configured !== resolved &&
		!options.allowExplicitReplacement
	) {
		throw new Error(
			"Resolved Hyperdrive CA certificate ID conflicts with relayapi.selfhost.json",
		);
	}
	if (
		configured === resolved &&
		config.cloudflare.hyperdriveCaCertificateId === resolved
	) {
		return config;
	}
	return {
		...config,
		cloudflare: {
			...config.cloudflare,
			hyperdriveCaCertificateId: resolved,
		},
	};
}

export function validateConfig(value: unknown): SelfHostConfig {
	const root = object(value, "configuration");
	if (root.schemaVersion !== 1) {
		throw new Error("configuration.schemaVersion must be 1");
	}
	if (root.instance !== "relayapi") {
		throw new Error('configuration.instance must be "relayapi"');
	}
	const cf = object(root.cloudflare, "configuration.cloudflare");
	const features = object(root.features, "configuration.features");
	const rootDomain = hostname(cf.rootDomain, "cloudflare.rootDomain");
	const apiHostname = hostname(cf.apiHostname, "cloudflare.apiHostname");
	const appHostname = hostname(cf.appHostname, "cloudflare.appHostname");
	const publicHostname = hostname(
		cf.publicHostname ?? `go.${rootDomain}`,
		"cloudflare.publicHostname",
	);
	const mediaHostname = hostname(cf.mediaHostname, "cloudflare.mediaHostname");
	const thumbnailHostname = hostname(
		cf.thumbnailHostname,
		"cloudflare.thumbnailHostname",
	);
	for (const [label, child] of [
		["apiHostname", apiHostname],
		["appHostname", appHostname],
		["publicHostname", publicHostname],
		["mediaHostname", mediaHostname],
		["thumbnailHostname", thumbnailHostname],
	] as const) {
		if (child !== rootDomain && !child.endsWith(`.${rootDomain}`)) {
			throw new Error(`cloudflare.${label} must belong to ${rootDomain}`);
		}
	}

	let resources: SelfHostConfig["resources"];
	if (root.resources !== undefined) {
		const rawResources = object(root.resources, "configuration.resources");
		const rawQueues = object(rawResources.queues, "resources.queues");
		const queues = Object.fromEntries(
			QUEUE_NAMES.map((name) => [
				name,
				string(rawQueues[name], `resources.queues.${name}`),
			]),
		) as NonNullable<SelfHostConfig["resources"]>["queues"];
		resources = {
			kvNamespaceId: string(
				rawResources.kvNamespaceId,
				"resources.kvNamespaceId",
			),
			hyperdriveId: string(rawResources.hyperdriveId, "resources.hyperdriveId"),
			queues,
		};
	}

	let github: SelfHostConfig["github"];
	if (root.github !== undefined) {
		const rawGithub = object(root.github, "configuration.github");
		const repository = string(rawGithub.repository, "github.repository");
		if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
			throw new Error("github.repository must use owner/repository format");
		}
		github = { repository };
	}

	return {
		schemaVersion: 1,
		instance: "relayapi",
		cloudflare: {
			accountId: string(cf.accountId, "cloudflare.accountId"),
			zoneId: string(cf.zoneId, "cloudflare.zoneId"),
			rootDomain,
			apiHostname,
			appHostname,
			publicHostname,
			mediaHostname,
			thumbnailHostname,
			r2Jurisdiction: r2Jurisdiction(cf.r2Jurisdiction),
			...(cf.hyperdriveCaCertificateId === undefined
				? {}
				: {
						hyperdriveCaCertificateId: validateHyperdriveCaCertificateId(
							cf.hyperdriveCaCertificateId,
						),
					}),
		},
		features: {
			email: boolean(features.email, "features.email"),
			ai: boolean(features.ai, "features.ai"),
			downloader: boolean(features.downloader, "features.downloader"),
		},
		...(github ? { github } : {}),
		...(resources ? { resources } : {}),
	};
}

export function validateLock(value: unknown): SelfHostLock {
	const root = object(value, "lock file");
	if (root.schemaVersion !== 1 || root.channel !== "stable") {
		throw new Error("lock file must use schemaVersion 1 and stable channel");
	}
	const version = string(root.version, "lock.version");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("lock.version must be a semantic version");
	}
	const sourceRepository = string(
		root.sourceRepository,
		"lock.sourceRepository",
	);
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
		throw new Error("lock.sourceRepository must use owner/repository format");
	}
	return {
		schemaVersion: 1,
		channel: "stable",
		version,
		sourceRepository,
		updatedAt: string(root.updatedAt, "lock.updatedAt"),
	};
}

export async function readConfig(
	path = CONFIG_FILENAME,
): Promise<SelfHostConfig> {
	return validateConfig(JSON.parse(await readFile(resolve(path), "utf8")));
}

export async function writeConfig(
	config: SelfHostConfig,
	path = CONFIG_FILENAME,
): Promise<void> {
	await writeFile(
		resolve(path),
		`${JSON.stringify(validateConfig(config), null, 2)}\n`,
		{ mode: 0o600 },
	);
}

export async function readLock(
	configPath = CONFIG_FILENAME,
): Promise<SelfHostLock> {
	const path = resolve(dirname(resolve(configPath)), LOCK_FILENAME);
	return validateLock(JSON.parse(await readFile(path, "utf8")));
}

export async function writeLock(
	lock: SelfHostLock,
	configPath = CONFIG_FILENAME,
): Promise<void> {
	const path = resolve(dirname(resolve(configPath)), LOCK_FILENAME);
	await writeFile(path, `${JSON.stringify(validateLock(lock), null, 2)}\n`, {
		mode: 0o600,
	});
}

export function initialLock(version: string): SelfHostLock {
	return {
		schemaVersion: 1,
		channel: "stable",
		version,
		sourceRepository: DEFAULT_SOURCE_REPOSITORY,
		updatedAt: new Date().toISOString(),
	};
}
