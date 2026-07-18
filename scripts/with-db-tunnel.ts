import { createConnection } from "node:net";

const CONNECTION_ENV =
	"CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";
const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_LOCAL_PORT = 5433;
const DEFAULT_REMOTE_PORT = 5432;
const DEFAULT_REMOTE_HOST = "localhost";

export interface DatabaseTunnelConfig {
	localHost: typeof LOOPBACK_HOST;
	localPort: number;
	remoteHost: string;
	remotePort: number;
	sshTarget: string;
}

function parsePort(value: string | undefined, fallback: number, name: string) {
	const port = value ? Number(value) : fallback;
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${name} must be an integer between 1 and 65535`);
	}
	return port;
}

function safeSshValue(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.startsWith("-") || /\s/.test(normalized)) {
		throw new Error(`${name} is invalid`);
	}
	return normalized;
}

function requiredSshValue(value: string | undefined, name: string): string {
	if (!value?.trim()) {
		throw new Error(`${name} is required`);
	}
	return safeSshValue(value, name);
}

export function resolveDatabaseTunnelConfig(
	environment: Record<string, string | undefined>,
): DatabaseTunnelConfig {
	return {
		localHost: LOOPBACK_HOST,
		localPort: parsePort(
			environment.RELAYAPI_DB_LOCAL_PORT,
			DEFAULT_LOCAL_PORT,
			"RELAYAPI_DB_LOCAL_PORT",
		),
		remoteHost: safeSshValue(
			environment.RELAYAPI_DB_REMOTE_HOST || DEFAULT_REMOTE_HOST,
			"RELAYAPI_DB_REMOTE_HOST",
		),
		remotePort: parsePort(
			environment.RELAYAPI_DB_REMOTE_PORT,
			DEFAULT_REMOTE_PORT,
			"RELAYAPI_DB_REMOTE_PORT",
		),
		sshTarget: requiredSshValue(
			environment.RELAYAPI_DB_SSH_TARGET,
			"RELAYAPI_DB_SSH_TARGET",
		),
	};
}

/**
 * Refuse to open a tunnel while the child command points anywhere other than
 * that exact loopback listener. This prevents a stale shell variable from
 * silently sending a migration directly to another database.
 */
export function assertTunnelConnectionString(
	environment: Record<string, string | undefined>,
	config: DatabaseTunnelConfig,
): void {
	const value = environment[CONNECTION_ENV]?.trim();
	if (!value) {
		throw new Error(`${CONNECTION_ENV} is not set`);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${CONNECTION_ENV} must be a valid PostgreSQL URL`);
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new Error(`${CONNECTION_ENV} must use PostgreSQL`);
	}
	const loopbackNames = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
	if (!loopbackNames.has(url.hostname.toLowerCase())) {
		throw new Error(`${CONNECTION_ENV} must point at the local SSH tunnel`);
	}
	const connectionPort = url.port ? Number(url.port) : 5432;
	if (connectionPort !== config.localPort) {
		throw new Error(
			`${CONNECTION_ENV} must use local tunnel port ${config.localPort}`,
		);
	}
}

export function normalizedTunnelConnectionString(
	environment: Record<string, string | undefined>,
	config: DatabaseTunnelConfig,
): string {
	assertTunnelConnectionString(environment, config);
	const url = new URL(environment[CONNECTION_ENV] as string);
	url.hostname = config.localHost;
	url.port = String(config.localPort);
	return url.toString();
}

export function commandFromArguments(args: string[]): string[] {
	const command = args[0] === "--" ? args.slice(1) : args;
	if (command.length === 0) {
		throw new Error("Usage: with-db-tunnel.ts -- <command> [args...]");
	}
	return command;
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
	return await new Promise((resolve) => {
		const socket = createConnection({ host, port });
		let settled = false;
		const finish = (open: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(250, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function waitForTunnel(
	tunnel: ReturnType<typeof Bun.spawn>,
	config: DatabaseTunnelConfig,
): Promise<void> {
	let tunnelExitCode: number | null = null;
	void tunnel.exited.then((code) => {
		tunnelExitCode = code;
	});

	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (tunnelExitCode !== null) {
			throw new Error(
				`SSH tunnel exited before it was ready (${tunnelExitCode})`,
			);
		}
		if (await isPortOpen(config.localHost, config.localPort)) return;
		await Bun.sleep(100);
	}
	throw new Error("Timed out waiting for the SSH database tunnel");
}

async function stopProcess(process: ReturnType<typeof Bun.spawn>) {
	if (process.exitCode !== null) return;
	process.kill("SIGTERM");
	await Promise.race([process.exited, Bun.sleep(2_000)]);
	if (process.exitCode === null) {
		process.kill("SIGKILL");
		await process.exited;
	}
}

export async function runWithDatabaseTunnel(
	args = process.argv.slice(2),
	environment: Record<string, string | undefined> = process.env,
): Promise<number> {
	const command = commandFromArguments(args);
	const config = resolveDatabaseTunnelConfig(environment);
	const connectionString = normalizedTunnelConnectionString(
		environment,
		config,
	);
	const childEnvironment = {
		...environment,
		// The development seed uses DATABASE_URL while Drizzle/Wrangler use the
		// Hyperdrive local override. Both must resolve to the owned tunnel.
		[CONNECTION_ENV]: connectionString,
		DATABASE_URL: connectionString,
	};

	if (await isPortOpen(config.localHost, config.localPort)) {
		throw new Error(
			`Refusing to continue: ${config.localHost}:${config.localPort} is already in use`,
		);
	}

	console.info(
		`Opening command-scoped database tunnel on ${config.localHost}:${config.localPort}...`,
	);
	const tunnel = Bun.spawn(
		[
			"ssh",
			"-T",
			"-N",
			"-o",
			"BatchMode=yes",
			"-o",
			"ExitOnForwardFailure=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"ServerAliveInterval=30",
			"-o",
			"ServerAliveCountMax=3",
			"-L",
			`${config.localHost}:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
			config.sshTarget,
		],
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: environment,
		},
	);

	let child: ReturnType<typeof Bun.spawn> | null = null;
	let requestedExitCode: number | null = null;
	const handleSignal = (signal: NodeJS.Signals, exitCode: number) => {
		requestedExitCode = exitCode;
		if (child?.exitCode === null) child.kill(signal);
		if (tunnel.exitCode === null) tunnel.kill("SIGTERM");
	};
	const onInterrupt = () => handleSignal("SIGINT", 130);
	const onTerminate = () => handleSignal("SIGTERM", 143);
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onTerminate);

	try {
		await waitForTunnel(tunnel, config);
		child = Bun.spawn(command, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env: childEnvironment,
		});
		const childExitCode = await child.exited;
		return requestedExitCode ?? childExitCode;
	} finally {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
		if (child && child.exitCode === null) await stopProcess(child);
		await stopProcess(tunnel);
		console.info("Database tunnel closed.");
	}
}

if (import.meta.main) {
	try {
		process.exitCode = await runWithDatabaseTunnel();
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "Database tunnel failed",
		);
		process.exitCode = 1;
	}
}
