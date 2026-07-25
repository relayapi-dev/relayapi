import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectory = mkdtempSync(
	join(tmpdir(), "relayapi-self-host-package-"),
);
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
		{ cwd: packageDirectory, encoding: "utf8" },
	),
);
const tarball = join(temporaryDirectory, output[0].filename);
writeFileSync(
	join(temporaryDirectory, "package.json"),
	JSON.stringify({ private: true, type: "module" }),
);
execFileSync(
	"npm",
	["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
	{ cwd: temporaryDirectory, stdio: "inherit" },
);

const installedPackage = JSON.parse(
	readFileSync(
		join(temporaryDirectory, "node_modules/@relayapi/self-host/package.json"),
		"utf8",
	),
);
if (installedPackage.engines?.node !== ">=22.12.0") {
	throw new Error("Packed self-host CLI does not declare its Node.js floor");
}
const executable = join(
	temporaryDirectory,
	"node_modules/.bin/relayapi-self-host",
);
const help = spawnSync(executable, ["--help"], {
	cwd: temporaryDirectory,
	encoding: "utf8",
});
if (
	help.status !== 0 ||
	!help.stdout.includes("RelayAPI self-host deployment CLI")
) {
	throw new Error(
		`Installed self-host CLI failed (status ${help.status}): ${help.stderr || help.stdout}`,
	);
}

console.log("Self-host CLI package smoke passed.");
