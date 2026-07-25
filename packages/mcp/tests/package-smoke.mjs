import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sdkDirectory = resolve(packageDirectory, "../sdk");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "relayapi-mcp-package-"));

execFileSync("bun", ["run", "build"], { cwd: sdkDirectory, stdio: "inherit" });

function pack(directory) {
	const output = JSON.parse(
		execFileSync(
			"npm",
			[
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temporaryDirectory,
			],
			{ cwd: directory, encoding: "utf8" },
		),
	);
	return join(temporaryDirectory, output[0].filename);
}

const sdkTarball = pack(sdkDirectory);
const mcpTarball = pack(packageDirectory);
writeFileSync(
	join(temporaryDirectory, "package.json"),
	JSON.stringify({ private: true }),
);
execFileSync(
	"npm",
	[
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		sdkTarball,
		mcpTarball,
	],
	{ cwd: temporaryDirectory, stdio: "inherit" },
);

const installedPackage = JSON.parse(
	readFileSync(
		join(temporaryDirectory, "node_modules/@relayapi/mcp-server/package.json"),
		"utf8",
	),
);
if (
	/^(workspace:|catalog:)/.test(installedPackage.dependencies["@relayapi/sdk"])
) {
	throw new Error("Packed MCP server contains a workspace-only dependency");
}
if (
	"main" in installedPackage ||
	"types" in installedPackage ||
	"exports" in installedPackage
) {
	throw new Error(
		"Executable-only MCP package advertises a library entrypoint",
	);
}
if (installedPackage.engines?.node !== ">=18") {
	throw new Error("Packed MCP server does not declare its Node.js floor");
}

const executable = join(
	temporaryDirectory,
	"node_modules/.bin/relayapi-mcp-server",
);
const run = spawnSync(executable, ["unsupported-transport"], {
	cwd: temporaryDirectory,
	encoding: "utf8",
});
if (run.status !== 2 || !run.stderr.includes("Unknown transport")) {
	throw new Error(
		`Installed MCP executable failed (status ${run.status}): ${run.stderr || run.stdout}`,
	);
}

console.log(`MCP package smoke passed (${basename(mcpTarball)}).`);
