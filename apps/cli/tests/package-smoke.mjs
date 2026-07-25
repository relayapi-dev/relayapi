import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const sdkDirectory = resolve(packageDirectory, "../../packages/sdk");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "relayapi-cli-package-"));

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
const cliTarball = pack(packageDirectory);
writeFileSync(
	join(temporaryDirectory, "package.json"),
	JSON.stringify({ private: true, type: "module" }),
);
execFileSync(
	"npm",
	[
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		sdkTarball,
		cliTarball,
	],
	{ cwd: temporaryDirectory, stdio: "inherit" },
);

const server = createServer((_request, response) => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(
		JSON.stringify({ data: [], next_cursor: null, has_more: false }),
	);
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string")
	throw new Error("Failed to start smoke server");

const executable = join(temporaryDirectory, "node_modules/.bin/relay");
const installedPackage = JSON.parse(
	readFileSync(
		join(temporaryDirectory, "node_modules/@relayapi/cli/package.json"),
		"utf8",
	),
);
if (installedPackage.engines?.node !== ">=22.12.0") {
	throw new Error("Packed CLI does not declare Commander's Node.js floor");
}
const child = spawn(executable, ["accounts", "list"], {
	cwd: temporaryDirectory,
	env: {
		...process.env,
		RELAYAPI_API_KEY: "rlay_test_package_smoke",
		RELAYAPI_API_URL: `http://127.0.0.1:${address.port}`,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
	stdout += chunk;
});
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
const exitCode = await new Promise((resolve) => child.once("close", resolve));
server.close();

if (exitCode !== 0 || !stdout.includes('"data": []')) {
	throw new Error(
		`Installed CLI smoke failed (${exitCode}): ${stderr || stdout}`,
	);
}

console.log("CLI package smoke passed with the packed SDK under Node.js.");
