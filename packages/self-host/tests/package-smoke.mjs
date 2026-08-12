import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const postgresPackageDirectory = join(temporaryDirectory, "postgres-package");
cpSync(
	resolve(packageDirectory, "../../node_modules/postgres"),
	postgresPackageDirectory,
	{
		recursive: true,
	},
);
const postgresPackageJsonPath = join(postgresPackageDirectory, "package.json");
const postgresPackageJson = JSON.parse(
	readFileSync(postgresPackageJsonPath, "utf8"),
);
delete postgresPackageJson.scripts?.prepare;
writeFileSync(
	postgresPackageJsonPath,
	`${JSON.stringify(postgresPackageJson, null, 2)}\n`,
);
const postgresOutput = JSON.parse(
	execFileSync(
		"npm",
		[
			"pack",
			"--json",
			"--ignore-scripts",
			"--pack-destination",
			temporaryDirectory,
		],
		{ cwd: postgresPackageDirectory, encoding: "utf8", timeout: 30_000 },
	),
);
writeFileSync(
	join(temporaryDirectory, "package.json"),
	JSON.stringify({
		private: true,
		type: "module",
		dependencies: {
			"@relayapi/self-host": `file:./${output[0].filename}`,
			postgres: `file:./${postgresOutput[0].filename}`,
		},
	}),
);
execFileSync(
	"npm",
	["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
	{ cwd: temporaryDirectory, stdio: "inherit", timeout: 30_000 },
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
const releaseArchive = "offline package-smoke release archive";
const releaseArchiveSha256 = createHash("sha256")
	.update(releaseArchive)
	.digest("hex");
const fetchPreload = join(temporaryDirectory, "offline-fetch.mjs");
writeFileSync(
	fetchPreload,
	`const expectedUrl = ${JSON.stringify(`https://github.com/relayapi-dev/relayapi/archive/refs/tags/self-host-v${installedPackage.version}.tar.gz`)};
const archive = new TextEncoder().encode(${JSON.stringify(releaseArchive)});
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== expectedUrl) throw new Error(\`Package smoke blocked unexpected network request: \${url}\`);
  return new Response(archive, {
    status: 200,
    headers: { "content-length": String(archive.byteLength), "content-type": "application/gzip" },
  });
};
`,
);
const cliEnvironment = {
	...process.env,
	NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchPreload}`]
		.filter(Boolean)
		.join(" "),
};
const cliSpawnOptions = {
	cwd: temporaryDirectory,
	encoding: "utf8",
	env: cliEnvironment,
	timeout: 10_000,
};
const help = spawnSync(executable, ["--help"], {
	...cliSpawnOptions,
});
if (
	help.status !== 0 ||
	!help.stdout.includes("RelayAPI self-host deployment CLI") ||
	!help.stdout.includes("plan [--hyperdrive-ca-certificate-id UUID]") ||
	!help.stdout.includes("doctor [--hyperdrive-ca-certificate-id UUID]") ||
	!help.stdout.includes("configure [--hyperdrive-ca-certificate-id UUID]") ||
	!help.stdout.includes(
		"deploy [--source /path/to/relayapi --allow-unsealed-source] [--hyperdrive-ca-certificate-id UUID]",
	)
) {
	throw new Error(
		`Installed self-host CLI failed (status ${help.status}): ${help.stderr || help.stdout}`,
	);
}

const missingCaConfig = join(temporaryDirectory, "missing-ca.json");
const missingCa = spawnSync(
	executable,
	[
		"init",
		"--non-interactive",
		"--config",
		missingCaConfig,
		"--account-id",
		"account-id",
		"--zone-id",
		"zone-id",
		"--domain",
		"example.com",
		"--admin-email",
		"admin@example.com",
	],
	cliSpawnOptions,
);
if (
	missingCa.status === 0 ||
	!missingCa.stderr.includes("Hyperdrive CA certificate ID is required")
) {
	throw new Error(
		`Installed self-host CLI did not require CA intent during init (status ${missingCa.status}): ${missingCa.stderr || missingCa.stdout}`,
	);
}

const validConfig = join(
	temporaryDirectory,
	"operator",
	"relayapi.selfhost.json",
);
const certificateId = "11111111-2222-4333-8444-555555555555";
const initialized = spawnSync(
	executable,
	[
		"init",
		"--non-interactive",
		"--config",
		validConfig,
		"--account-id",
		"account-id",
		"--zone-id",
		"zone-id",
		"--domain",
		"example.com",
		"--admin-email",
		"admin@example.com",
		"--hyperdrive-ca-certificate-id",
		certificateId,
	],
	cliSpawnOptions,
);
if (initialized.status !== 0) {
	throw new Error(
		`Installed self-host CLI init failed (status ${initialized.status}): ${initialized.stderr || initialized.stdout}`,
	);
}
const initializedConfig = JSON.parse(readFileSync(validConfig, "utf8"));
if (initializedConfig.cloudflare?.hyperdriveCaCertificateId !== certificateId) {
	throw new Error(
		"Installed self-host CLI did not persist Hyperdrive CA intent",
	);
}
const initializedLock = JSON.parse(
	readFileSync(
		join(temporaryDirectory, "operator", "relayapi.lock.json"),
		"utf8",
	),
);
if (initializedLock.sourceArchiveSha256 !== releaseArchiveSha256) {
	throw new Error(
		"Installed self-host CLI did not seal the lock to the mocked release archive",
	);
}

const missingRotationValue = spawnSync(
	executable,
	["plan", "--config", validConfig, "--hyperdrive-ca-certificate-id"],
	cliSpawnOptions,
);
if (
	missingRotationValue.status === 0 ||
	!missingRotationValue.stderr.includes("requires a UUID value")
) {
	throw new Error(
		`Installed self-host CLI accepted a valueless CA rotation flag (status ${missingRotationValue.status}): ${missingRotationValue.stderr || missingRotationValue.stdout}`,
	);
}

const invalidRotationValue = spawnSync(
	executable,
	[
		"plan",
		"--config",
		validConfig,
		"--hyperdrive-ca-certificate-id",
		"not-a-certificate-id",
	],
	cliSpawnOptions,
);
if (
	invalidRotationValue.status === 0 ||
	!invalidRotationValue.stderr.includes("Cloudflare certificate UUID")
) {
	throw new Error(
		`Installed self-host CLI accepted an invalid CA rotation UUID (status ${invalidRotationValue.status}): ${invalidRotationValue.stderr || invalidRotationValue.stdout}`,
	);
}

console.log("Self-host CLI package smoke passed.");
