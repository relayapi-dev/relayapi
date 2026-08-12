import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CLIConfig {
	api_key?: string;
	base_url?: string;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function configPaths(): { directory: string; file: string } {
	const directory = join(process.env.HOME?.trim() || homedir(), ".relayapi");
	return { directory, file: join(directory, "config.json") };
}

/**
 * Create the credential directory securely and migrate permissions from older
 * CLI releases. Symlinks are rejected so a local attacker cannot redirect a
 * credential write to another path.
 */
function secureConfigStorage(create: boolean): {
	directory: string;
	file: string;
} {
	const paths = configPaths();

	if (!existsSync(paths.directory)) {
		if (!create) return paths;
		mkdirSync(paths.directory, { recursive: true, mode: DIRECTORY_MODE });
	} else {
		const directory = lstatSync(paths.directory);
		if (directory.isSymbolicLink() || !directory.isDirectory()) {
			throw new Error(
				`Refusing insecure RelayAPI config path: ${paths.directory}`,
			);
		}
	}
	chmodSync(paths.directory, DIRECTORY_MODE);

	if (existsSync(paths.file)) {
		const file = lstatSync(paths.file);
		if (file.isSymbolicLink() || !file.isFile()) {
			throw new Error(`Refusing insecure RelayAPI config file: ${paths.file}`);
		}
		chmodSync(paths.file, FILE_MODE);
	}

	return paths;
}

export function loadConfig(): CLIConfig {
	const { file } = secureConfigStorage(false);
	try {
		const raw = readFileSync(file, "utf-8");
		return JSON.parse(raw) as CLIConfig;
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return {};
		}
		if (error instanceof SyntaxError) return {};
		throw error;
	}
}

export function saveConfig(config: CLIConfig): void {
	const { directory, file } = secureConfigStorage(true);
	const temporaryFile = join(
		directory,
		`.config.json.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, {
			mode: FILE_MODE,
			flag: "wx",
		});
		chmodSync(temporaryFile, FILE_MODE);
		renameSync(temporaryFile, file);
		chmodSync(file, FILE_MODE);
	} finally {
		if (existsSync(temporaryFile)) rmSync(temporaryFile);
	}
}

export function resolveApiKey(): string | undefined {
	return process.env.RELAYAPI_API_KEY ?? loadConfig().api_key;
}

export function resolveBaseUrl(): string | undefined {
	return process.env.RELAYAPI_API_URL ?? loadConfig().base_url;
}

export function maskKey(key: string): string {
	if (key.length <= 12) return `${key.slice(0, 4)}****`;
	return `${key.slice(0, 10)}****${key.slice(-4)}`;
}
