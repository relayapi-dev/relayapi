import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "relayapi-sdk-package-"));
const packed = JSON.parse(
	execFileSync(
		"npm",
		["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory],
		{ cwd: packageDirectory, encoding: "utf8" },
	),
);
const tarball = join(temporaryDirectory, packed[0].filename);

writeFileSync(
	join(temporaryDirectory, "package.json"),
	JSON.stringify({ private: true, type: "module" }),
);
execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
	cwd: temporaryDirectory,
	stdio: "inherit",
});

const esm = execFileSync(
	process.execPath,
	[
		"--input-type=module",
		"--eval",
		'import Relay, { Relay as NamedRelay } from "@relayapi/sdk"; console.log(Relay === NamedRelay && typeof new Relay({ apiKey: "rlay_test_smoke" }).posts.list === "function")',
	],
	{ cwd: temporaryDirectory, encoding: "utf8" },
).trim();
if (esm !== "true") throw new Error(`ESM package smoke failed: ${esm}`);

const cjs = execFileSync(
	process.execPath,
	[
		"--input-type=commonjs",
		"--eval",
		'const Relay = require("@relayapi/sdk"); console.log(typeof Relay === "function" && Relay === Relay.default && typeof new Relay({ apiKey: "rlay_test_smoke" }).posts.list === "function")',
	],
	{ cwd: temporaryDirectory, encoding: "utf8" },
).trim();
if (cjs !== "true") throw new Error(`CommonJS package smoke failed: ${cjs}`);

const internalEsm = execFileSync(
	process.execPath,
	[
		"--input-type=module",
		"--eval",
		'import { createEmailIntentClient } from "@relayapi/sdk/internal"; const client = createEmailIntentClient({ stageEmailIntent: async () => ({ deliveryId: "email_1", status: "staged" }) }); console.log((await client.stage({ type: "organization_invitation", invitationId: "invite_1", occurrenceId: "created" })).status === "staged")',
	],
	{ cwd: temporaryDirectory, encoding: "utf8" },
).trim();
if (internalEsm !== "true") {
	throw new Error(`Internal ESM package smoke failed: ${internalEsm}`);
}

const internalCjs = execFileSync(
	process.execPath,
	[
		"--input-type=commonjs",
		"--eval",
		'const { createEmailIntentClient } = require("@relayapi/sdk/internal"); const client = createEmailIntentClient({ stageEmailIntent: async () => ({ deliveryId: "email_1", status: "staged" }) }); client.stage({ type: "organization_invitation", invitationId: "invite_1", occurrenceId: "created" }).then((result) => console.log(result.status === "staged"))',
	],
	{ cwd: temporaryDirectory, encoding: "utf8" },
).trim();
if (internalCjs !== "true") {
	throw new Error(`Internal CommonJS package smoke failed: ${internalCjs}`);
}

writeFileSync(
	join(temporaryDirectory, "smoke.ts"),
	'import Relay, { type ClientOptions } from "@relayapi/sdk";\nimport { createEmailIntentClient, type InternalEmailIntent } from "@relayapi/sdk/internal";\nconst options: ClientOptions = { apiKey: "rlay_test_smoke" };\nnew Relay(options).posts.list();\nconst intent: InternalEmailIntent = { type: "organization_invitation", invitationId: "invite_1", occurrenceId: "created" };\ncreateEmailIntentClient({ stageEmailIntent: async () => ({ deliveryId: "email_1", status: "staged" }) }).stage(intent);\n',
);
writeFileSync(
	join(temporaryDirectory, "tsconfig.json"),
	JSON.stringify({
		compilerOptions: {
			strict: true,
			noEmit: true,
			target: "ES2022",
			module: "NodeNext",
			moduleResolution: "NodeNext",
			skipLibCheck: true,
		},
		include: ["smoke.ts"],
	}),
);
execFileSync(
	resolve(packageDirectory, "node_modules/.bin/tsc"),
	["-p", join(temporaryDirectory, "tsconfig.json")],
	{ cwd: temporaryDirectory, stdio: "inherit" },
);

const installed = JSON.parse(
	readFileSync(join(temporaryDirectory, "node_modules/@relayapi/sdk/package.json"), "utf8"),
);
if (installed.exports["."].import !== "./dist/index.mjs") {
	throw new Error("Installed package did not retain conditional exports");
}
if (installed.exports["./internal"].import !== "./dist/internal.mjs") {
	throw new Error("Installed package did not retain the internal conditional export");
}

console.log("SDK package smoke passed (ESM, CommonJS, and TypeScript).");
