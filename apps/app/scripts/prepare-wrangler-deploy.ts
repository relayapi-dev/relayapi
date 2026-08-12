import { readFile, writeFile } from "node:fs/promises";
import { BASELINE_GENERATION } from "@relayapi/config";

const DEFAULT_CONFIG_PATH = new URL(
	"../dist/server/wrangler.json",
	import.meta.url,
);
const EXPECTED_COMPATIBILITY_DATE = "2026-07-18";
const EXPECTED_COMPATIBILITY_FLAGS = [
	"nodejs_compat",
	"global_fetch_strictly_public",
] as const;
const EXPECTED_IDENTITY_DELETION_CONTRACT_VERSION = "identity-deletion-v1";
const EXPECTED_BASELINE_GENERATION = String(BASELINE_GENERATION);
const FORBIDDEN_SESSION_KV_BINDING = "SESSION";
const EXPECTED_R2_BINDINGS = new Map([
	["AVATARS_BUCKET", "relayapi-avatars"],
	["PUBLIC_ASSETS", "relayapi-public-assets"],
	["QUEUE_RESCUE_BUCKET", "relayapi-queue-rescue-ledger"],
]);
const EXPECTED_EMAIL_INTENT_SERVICE = {
	binding: "EMAIL_INTENTS",
	service: "relayapi",
	entrypoint: "EmailIntentEntrypoint",
} as const;
const EXPECTED_COMPATIBILITY_FLAG_SET = new Set<string>(
	EXPECTED_COMPATIBILITY_FLAGS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsKvBinding(value: unknown, binding: string): boolean {
	if (Array.isArray(value)) {
		return value.some((item) => containsKvBinding(item, binding));
	}
	if (!isRecord(value)) return false;
	if (
		Array.isArray(value.kv_namespaces) &&
		value.kv_namespaces.some(
			(namespace) => isRecord(namespace) && namespace.binding === binding,
		)
	) {
		return true;
	}
	return Object.values(value).some((item) => containsKvBinding(item, binding));
}

function hasExpectedR2Bindings(value: unknown): boolean {
	if (!Array.isArray(value) || value.length !== EXPECTED_R2_BINDINGS.size) {
		return false;
	}
	return value.every((binding) => {
		if (!isRecord(binding) || typeof binding.binding !== "string") return false;
		return (
			EXPECTED_R2_BINDINGS.get(binding.binding) === binding.bucket_name &&
			!Object.hasOwn(binding, "jurisdiction")
		);
	});
}

function hasExpectedEmailIntentService(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length === 1 &&
		isRecord(value[0]) &&
		value[0].binding === EXPECTED_EMAIL_INTENT_SERVICE.binding &&
		value[0].service === EXPECTED_EMAIL_INTENT_SERVICE.service &&
		value[0].entrypoint === EXPECTED_EMAIL_INTENT_SERVICE.entrypoint
	);
}

function isEmptyGeneratedQueueConfig(value: unknown): boolean {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		Array.isArray(value.producers) &&
		value.producers.length === 0 &&
		Array.isArray(value.consumers) &&
		value.consumers.length === 0
	);
}

/**
 * Normalize Astro's generated deploy config to the reviewed production policy.
 * Wrangler 4.112 rejects the generated `legacy_env` field, while Astro currently
 * drops the same-zone fetch compatibility flag from the source Wrangler config
 * and emits an empty Queue container even when the app has no Queue binding.
 */
export async function prepareWranglerDeploy(
	configPath: string | URL = DEFAULT_CONFIG_PATH,
): Promise<boolean> {
	const raw = await readFile(configPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error("Astro generated an invalid Wrangler deploy configuration");
	}
	if (containsKvBinding(parsed, FORBIDDEN_SESSION_KV_BINDING)) {
		throw new Error(
			"Astro generated the forbidden SESSION KV binding; keep Astro sessions on the null driver",
		);
	}
	if (
		parsed.name !== "relayapi-app" ||
		parsed.main !== "entry.mjs" ||
		parsed.no_bundle !== true ||
		!isRecord(parsed.assets) ||
		parsed.assets.directory !== "../client" ||
		!isRecord(parsed.vars) ||
		parsed.vars.IDENTITY_DELETION_CONTRACT_VERSION !==
			EXPECTED_IDENTITY_DELETION_CONTRACT_VERSION ||
		parsed.vars.BASELINE_GENERATION !== EXPECTED_BASELINE_GENERATION ||
		!hasExpectedR2Bindings(parsed.r2_buckets) ||
		!hasExpectedEmailIntentService(parsed.services) ||
		(Object.hasOwn(parsed, "queues") &&
			!isEmptyGeneratedQueueConfig(parsed.queues))
	) {
		throw new Error(
			"Astro generated an unexpected Wrangler deploy configuration",
		);
	}

	let changed = false;
	if (Object.hasOwn(parsed, "legacy_env")) {
		if (parsed.legacy_env !== true) {
			throw new Error(
				"Refusing to alter an unexpected generated legacy_env setting",
			);
		}
		delete parsed.legacy_env;
		changed = true;
	}
	if (Object.hasOwn(parsed, "queues")) {
		delete parsed.queues;
		changed = true;
	}
	if (parsed.compatibility_date !== EXPECTED_COMPATIBILITY_DATE) {
		throw new Error("Astro generated an unexpected compatibility date");
	}
	if (
		!Array.isArray(parsed.compatibility_flags) ||
		!parsed.compatibility_flags.every((flag) => typeof flag === "string")
	) {
		throw new Error("Astro generated invalid compatibility flags");
	}
	const unexpectedFlags = parsed.compatibility_flags.filter(
		(flag) => !EXPECTED_COMPATIBILITY_FLAG_SET.has(flag),
	);
	if (unexpectedFlags.length > 0) {
		throw new Error("Astro generated unexpected compatibility flags");
	}
	if (
		parsed.compatibility_flags.join("\0") !==
		EXPECTED_COMPATIBILITY_FLAGS.join("\0")
	) {
		parsed.compatibility_flags = [...EXPECTED_COMPATIBILITY_FLAGS];
		changed = true;
	}
	if (!changed) return false;
	await writeFile(configPath, `${JSON.stringify(parsed)}\n`, "utf8");
	return true;
}

if (import.meta.main) {
	prepareWranglerDeploy().catch((error) => {
		console.error(
			`error: ${error instanceof Error ? error.message : "failed to prepare Wrangler deploy config"}`,
		);
		process.exitCode = 1;
	});
}
