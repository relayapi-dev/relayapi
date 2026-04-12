import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CLIConfig {
	api_key?: string;
	base_url?: string;
}

const CONFIG_DIR = join(homedir(), ".relayapi");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): CLIConfig {
	try {
		const raw = readFileSync(CONFIG_FILE, "utf-8");
		return JSON.parse(raw) as CLIConfig;
	} catch {
		return {};
	}
}

export function saveConfig(config: CLIConfig): void {
	if (!existsSync(CONFIG_DIR)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
	}
	writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function resolveApiKey(): string | undefined {
	return process.env["RELAYAPI_API_KEY"] ?? loadConfig().api_key;
}

export function resolveBaseUrl(): string | undefined {
	return process.env["RELAYAPI_API_URL"] ?? loadConfig().base_url;
}

export function maskKey(key: string): string {
	if (key.length <= 12) return key.slice(0, 4) + "****";
	return key.slice(0, 10) + "****" + key.slice(-4);
}
