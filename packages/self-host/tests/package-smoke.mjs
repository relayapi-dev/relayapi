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
	!help.stdout.includes("RelayAPI self-host deployment CLI") ||
	!help.stdout.includes("plan [--hyperdrive-ca-certificate-id UUID]") ||
	!help.stdout.includes("doctor [--hyperdrive-ca-certificate-id UUID]") ||
	!help.stdout.includes("configure [--hyperdrive-ca-certificate-id UUID]") ||
	!help.stdout.includes(
		"deploy [--source /path/to/relayapi] [--hyperdrive-ca-certificate-id UUID]",
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
	{ cwd: temporaryDirectory, encoding: "utf8" },
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
	{ cwd: temporaryDirectory, encoding: "utf8" },
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

const missingRotationValue = spawnSync(
	executable,
	["plan", "--config", validConfig, "--hyperdrive-ca-certificate-id"],
	{ cwd: temporaryDirectory, encoding: "utf8" },
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
	{ cwd: temporaryDirectory, encoding: "utf8" },
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
