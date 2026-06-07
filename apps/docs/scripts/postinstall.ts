/**
 * Custom postinstall script that uses Bun.build instead of esbuild
 * to compile source.config.ts. This works around esbuild binary issues.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, ".source");
const monoRoot = path.resolve(root, "../..");
const distDir = path.join(monoRoot, "node_modules/fumadocs-mdx/dist");

// Step 1: Compile source.config.ts with Bun
console.log("[postinstall] Compiling source.config.ts with Bun...");
const result = await Bun.build({
	entrypoints: [path.join(root, "source.config.ts")],
	outdir: outDir,
	format: "esm",
	target: "node",
	packages: "external",
	naming: "[name].mjs",
});

if (!result.success) {
	console.error("[postinstall] Build failed:", result.logs);
	process.exit(1);
}

console.log("[postinstall] Compiled to .source/source.config.mjs");

// Step 2: Find fumadocs-mdx internal modules dynamically (hashed filenames change per version)
function findFile(dir: string, prefix: string): string {
	const files = fs.readdirSync(dir);
	const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".js"));
	if (!match) throw new Error(`Cannot find ${prefix}*.js in ${dir}`);
	return path.join(dir, match);
}

// fumadocs-mdx 15.x consolidated `buildConfig` into the core module, exposed via
// the minified export `i` (createCore is `n`, both from core-*.js). If a future
// version renames these, the guard below fails loudly — update to match the new
// exports in node_modules/fumadocs-mdx/dist/core-*.js.
const corePath = findFile(distDir, "core-");
const indexFilePath = path.join(distDir, "plugins/index-file.js");

// Import core modules
const coreModule = await import(pathToFileURL(corePath).href);
const indexFileModule = await import(pathToFileURL(indexFilePath).href);

const { n: createCore, i: buildConfig } = coreModule;
const indexFile = indexFileModule.default;

if (
	typeof createCore !== "function" ||
	typeof buildConfig !== "function" ||
	typeof indexFile !== "function"
) {
	throw new Error(
		"[postinstall] fumadocs-mdx internal exports changed (createCore/buildConfig/indexFile). " +
			"Update apps/docs/scripts/postinstall.ts to match node_modules/fumadocs-mdx/dist exports.",
	);
}

// Create core with our options
const core = createCore({
	environment: "next",
	outDir: ".source",
	configPath: "source.config.ts",
	plugins: [indexFile({})],
});

// Load the compiled config
const configUrl = pathToFileURL(path.join(outDir, "source.config.mjs"));
configUrl.searchParams.set("hash", Date.now().toString());
const loaded = await import(configUrl.href);
// buildConfig(config, cwd) — cwd resolves collection `dir` paths like content/docs
const config = buildConfig(loaded, root);

// Init and emit
await core.init({ config });
await core.emit({ write: true });

console.log("[postinstall] Generated .source files:");
const files = fs.readdirSync(outDir);
for (const f of files) console.log(`  ${f}`);
