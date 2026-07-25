/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const baseSha = execFileSync(
	"git",
	["-C", repositoryRoot, "rev-parse", "HEAD"],
	{ encoding: "utf8" },
).trim();

describe("append-only migration workflow invocation", () => {
	test("resolves the protected manifest when invoked from packages/db", () => {
		const output = execFileSync(
			process.execPath,
			["run", "scripts/verify-migration-append-only.ts"],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: { ...process.env, MIGRATION_BASE_SHA: baseSha },
			},
		);

		expect(output).toContain("Append-only migration prefix verified");
		expect(output).not.toContain("one-time append-only policy bootstrap");
	});
});
