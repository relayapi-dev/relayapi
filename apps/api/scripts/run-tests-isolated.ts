/**
 * Runs every test file in its own `bun test` process.
 *
 * Why: bun executes all files given to `bun test` in ONE process, and several
 * suites use mock.module("@relayapi/db", ...) which patches the module
 * registry globally. Files that need the real module (the automation suites
 * use a live DB fixture when the SSH tunnel is up) get poisoned by whichever
 * mock happened to register first, producing failures that don't reproduce
 * when a file runs alone. Per-file processes give each suite a clean
 * registry. DB-dependent suites skip themselves when no DB is reachable, so
 * this runner is CI-safe without a database. The protected database acceptance
 * gate uses `test:db-fixtures:required` instead.
 *
 * Usage: bun run scripts/run-tests-isolated.ts [filter...]
 *   filter — only run files whose path contains one of these substrings
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, "..", "src", "__tests__");
const filters = process.argv.slice(2);

const files = readdirSync(TEST_DIR)
	.filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.js"))
	.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
	.sort();

if (files.length === 0) {
	console.error("No test files matched.");
	process.exit(1);
}

const failed: string[] = [];
let totalPass = 0;
let totalFail = 0;
let totalSkip = 0;
const started = Date.now();

for (const file of files) {
	const path = join(TEST_DIR, file);
	const proc = Bun.spawnSync(["bun", "test", path], {
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const out = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
	const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
	const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
	const skip = Number(/(\d+) skip/.exec(out)?.[1] ?? 0);
	totalPass += pass;
	totalFail += fail;
	totalSkip += skip;

	if (proc.exitCode !== 0 || fail > 0) {
		failed.push(file);
		console.error(`\n✗ ${file} (${pass} pass, ${fail} fail)`);
		if (process.env.RELAYAPI_TEST_VERBOSE_FAILURES === "1") {
			console.error(out.trim());
			continue;
		}
		// Surface the failing assertions without dumping full output
		const lines = out.split("\n");
		const interesting = lines.filter(
			(l) =>
				l.includes("(fail)") ||
				l.includes("error:") ||
				l.includes("Expected") ||
				l.includes("Received"),
		);
		console.error(interesting.slice(0, 40).join("\n"));
	} else {
		console.log(`✓ ${file} (${pass} pass${skip > 0 ? `, ${skip} skip` : ""})`);
	}
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
	`\n${files.length} files, ${totalPass} pass, ${totalSkip} skip, ${totalFail} fail in ${secs}s`,
);
if (failed.length > 0) {
	console.error(
		`\nFailing files:\n${failed.map((f) => `  - ${f}`).join("\n")}`,
	);
	process.exit(1);
}
