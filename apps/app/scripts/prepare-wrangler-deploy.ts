import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_CONFIG_PATH = new URL(
	"../dist/server/wrangler.json",
	import.meta.url,
);
const EXPECTED_COMPATIBILITY_DATE = "2026-07-18";
const EXPECTED_COMPATIBILITY_FLAGS = [
	"nodejs_compat",
	"global_fetch_strictly_public",
] as const;
const EXPECTED_COMPATIBILITY_FLAG_SET = new Set<string>(
	EXPECTED_COMPATIBILITY_FLAGS,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize Astro's generated deploy config to the reviewed production policy.
 * Wrangler 4.112 rejects the generated `legacy_env` field, while Astro currently
 * drops the same-zone fetch compatibility flag from the source Wrangler config.
 */
export async function prepareWranglerDeploy(
	configPath: string | URL = DEFAULT_CONFIG_PATH,
): Promise<boolean> {
	const raw = await readFile(configPath, "utf8");
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error("Astro generated an invalid Wrangler deploy configuration");
	}
	if (
		parsed.name !== "relayapi-app" ||
		parsed.main !== "entry.mjs" ||
		parsed.no_bundle !== true ||
		!isRecord(parsed.assets) ||
		parsed.assets.directory !== "../client" ||
		!isRecord(parsed.vars) ||
		parsed.vars.IDENTITY_DELETION_CONTRACT_VERSION !== "0005"
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
