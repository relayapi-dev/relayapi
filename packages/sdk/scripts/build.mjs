import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageDirectory, "src/index.ts");
const outputDirectory = resolve(packageDirectory, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const [format, filename] of [
	["esm", "index.mjs"],
	["cjs", "index.cjs"],
]) {
	const result = await Bun.build({
		entrypoints: [source],
		format,
		target: "node",
		outdir: outputDirectory,
		naming: filename,
		sourcemap: "external",
	});
	if (!result.success) {
		for (const message of result.logs) console.error(message);
		throw new Error(`Failed to build the ${format.toUpperCase()} SDK bundle`);
	}
}

// CommonJS users traditionally expect `require("@relayapi/sdk")` itself to be
// the client constructor. Preserve named exports on that constructor too.
await appendFile(
	resolve(outputDirectory, "index.cjs"),
	'\nmodule.exports = Object.assign(module.exports.default, module.exports);\n',
);

const declarations = Bun.spawnSync([
	process.execPath,
	"x",
	"tsc",
	"-p",
	resolve(packageDirectory, "tsconfig.build.json"),
], {
	cwd: packageDirectory,
	stdout: "inherit",
	stderr: "inherit",
});
if (declarations.exitCode !== 0) {
	throw new Error("Failed to emit SDK declarations");
}
