import { spawn } from "node:child_process";

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

export async function commandExists(command: string): Promise<boolean> {
	try {
		await run(command, ["--version"], { quiet: true });
		return true;
	} catch {
		return false;
	}
}
