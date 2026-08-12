import { spawn } from "node:child_process";

const MAX_CAPTURED_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	stdin?: string;
	quiet?: boolean;
}

export async function run(
	command: string,
	args: string[],
	options: RunOptions = {},
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: [
				options.stdin === undefined ? "inherit" : "pipe",
				options.quiet ? "ignore" : "inherit",
				"inherit",
			],
		});
		if (options.stdin !== undefined) {
			if (!child.stdin) throw new Error(`Unable to open stdin for ${command}`);
			child.stdin.end(options.stdin);
		}
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else {
				reject(
					new Error(
						`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
					),
				);
			}
		});
	});
}

/**
 * Run a command while retaining bounded stdout for machine-readable CLI output.
 * Stderr remains attached to the operator terminal so failures stay actionable.
 */
export async function runCaptured(
	command: string,
	args: string[],
	options: RunOptions = {},
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: [
				options.stdin === undefined ? "ignore" : "pipe",
				"pipe",
				"inherit",
			],
		});
		if (!child.stdout) {
			child.kill("SIGTERM");
			reject(new Error(`Unable to capture stdout for ${command}`));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let outputError: Error | undefined;
		child.stdout.on("data", (chunk: Buffer | Uint8Array | string) => {
			if (outputError) return;
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.byteLength;
			if (size > MAX_CAPTURED_OUTPUT_BYTES) {
				outputError = new Error(
					`${command} produced more than ${MAX_CAPTURED_OUTPUT_BYTES} bytes of stdout`,
				);
				child.kill("SIGTERM");
				return;
			}
			chunks.push(bytes);
		});
		if (options.stdin !== undefined) {
			if (!child.stdin) {
				child.kill("SIGTERM");
				reject(new Error(`Unable to open stdin for ${command}`));
				return;
			}
			child.stdin.end(options.stdin);
		}
		child.once("error", reject);
		// "close" rather than "exit": exit fires when the process terminates, but
		// stdout may still hold buffered bytes at that point, so resolving there
		// truncates output that has not been delivered yet. Anything larger than
		// the pipe buffer — a `wrangler versions list --json` on a long-lived
		// Worker, say — would come back as malformed JSON mid-deploy.
		child.once("close", (code, signal) => {
			if (outputError) {
				reject(outputError);
				return;
			}
			if (code === 0) {
				resolve(Buffer.concat(chunks).toString("utf8"));
				return;
			}
			reject(
				new Error(
					`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
				),
			);
		});
	});
}

export async function commandExists(command: string): Promise<boolean> {
	try {
		await run(command, ["--version"], { quiet: true });
		return true;
	} catch {
		return false;
	}
}
