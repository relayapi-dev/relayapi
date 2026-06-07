#!/usr/bin/env bun
/**
 * Upgrade every Bun catalog dependency to its latest published version.
 *
 * Bun's `bun update --latest` re-resolves catalog references *within* the range
 * defined in the root catalog, but it does NOT bump the catalog range itself —
 * the catalog is the single source of truth and is meant to be edited by hand
 * (see https://bun.com/docs/pm/catalogs). This script automates that edit: it
 * reads every entry in `workspaces.catalog` (and any named `workspaces.catalogs`),
 * looks up the latest version on the npm registry, rewrites the range while
 * preserving its operator (^, ~, or exact), and then runs `bun install` so the
 * lockfile and every workspace that uses `catalog:` pick up the new versions.
 *
 * Intentionally NOT touched (they don't use the catalog):
 *   - packages/sdk, packages/mcp        → published via `npm publish`
 *   - packages/integrations/*           → installed/built/pushed via npm
 *   - root devDependencies (@biomejs/biome), patched deps
 * The `catalog:` protocol is only understood by Bun/pnpm, so those packages keep
 * literal versions and are upgraded manually (e.g. `bun update --latest <pkg>`).
 *
 * A small set of packages is held back from auto-bumping (see HELD below) because
 * their latest release needs a deliberate migration or breaks the build; the script
 * logs each one it skips. Pass --force to bump them anyway.
 *
 * Usage:
 *   bun run deps:upgrade              # upgrade catalog (minus HELD), then `bun install`
 *   bun run deps:upgrade --dry-run    # print what would change, write nothing
 *   bun run deps:upgrade --force      # also bump the held-back packages
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ROOT_PKG = join(ROOT, "package.json");
const DRY_RUN = process.argv.includes("--dry-run");

type Catalog = Record<string, string>;

interface RootPkg {
	workspaces?: {
		packages?: string[];
		catalog?: Catalog;
		catalogs?: Record<string, Catalog>;
	};
	[key: string]: unknown;
}

interface Change {
	name: string;
	from: string;
	to: string;
	catalog: string;
}

// Packages whose newest versions are intentionally NOT auto-bumped because their
// latest release needs a deliberate migration or breaks the build. Upgrade these
// by hand (and re-validate with `bun run typecheck`) when you're ready to migrate.
// Pass `--force` to ignore this list. Keep the reasons up to date.
const HELD: Record<string, string> = {
	typescript:
		"TS 6.0 errors on this repo's moduleResolution:node10 and tightens rootDir — needs a tsconfig migration",
	"@tsparticles/engine": "v4 is an API rewrite (initParticlesEngine moved, shape/effect props renamed)",
	"@tsparticles/react": "v4 is an API rewrite (see @tsparticles/engine)",
	"@tsparticles/slim": "v4 is an API rewrite (see @tsparticles/engine)",
	three:
		"@react-three/postprocessing@3.x transitively caps three < 0.184 — bumping forces a duplicate three (runtime hazard)",
	"@types/three": "must track the held `three` version",
	postprocessing:
		"pinned so a single postprocessing version is shared with @react-three/postprocessing@3.x (avoids duplicate Effect classes)",
};

const FORCE = process.argv.includes("--force");

// Pull off the leading semver operator we want to preserve (^, ~, >=, etc.).
function rangePrefix(range: string): string {
	return range.match(/^(\^|~|>=|<=|>|<|=)/)?.[1] ?? "";
}

// Skip anything that isn't a plain `^/~/exact` semver range — e.g. "*", "15.*",
// "workspace:*", "latest", git/url specs. We don't know how to bump those safely.
function isUpgradeable(range: string): boolean {
	const rest = range.slice(rangePrefix(range).length);
	return /^\d+(\.\d+)*(\.\d+)?([-+][0-9A-Za-z.-]+)?$/.test(rest);
}

async function fetchLatest(name: string): Promise<string | null> {
	// Scoped names need the slash encoded: @scope/pkg -> @scope%2Fpkg
	const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
	try {
		const res = await fetch(url, {
			headers: { accept: "application/vnd.npm.install-v1+json" },
		});
		if (!res.ok) {
			console.warn(`  ! ${name}: registry returned HTTP ${res.status}`);
			return null;
		}
		const data = (await res.json()) as { "dist-tags"?: { latest?: string } };
		return data["dist-tags"]?.latest ?? null;
	} catch (err) {
		console.warn(`  ! ${name}: ${(err as Error).message}`);
		return null;
	}
}

async function upgradeCatalog(
	label: string,
	catalog: Catalog,
	changes: Change[],
): Promise<void> {
	const names = Object.keys(catalog).sort();
	const latest = await Promise.all(
		names.map(async (name) => [name, await fetchLatest(name)] as const),
	);
	for (const [name, version] of latest) {
		if (!version) continue;
		if (!FORCE && name in HELD) {
			console.warn(`  - ${name}: held back — ${HELD[name]}`);
			continue;
		}
		const current = catalog[name];
		if (!isUpgradeable(current)) {
			console.warn(`  - ${name}: skipped (non-standard range "${current}")`);
			continue;
		}
		const next = `${rangePrefix(current)}${version}`;
		if (next !== current) {
			catalog[name] = next;
			changes.push({ name, from: current, to: next, catalog: label });
		}
	}
}

const pkg = (await Bun.file(ROOT_PKG).json()) as RootPkg;
const workspaces = pkg.workspaces;
if (!workspaces || (!workspaces.catalog && !workspaces.catalogs)) {
	console.error("No catalog found under `workspaces` in root package.json.");
	process.exit(1);
}

console.log("Resolving latest versions from the npm registry...\n");
const changes: Change[] = [];
if (workspaces.catalog) {
	await upgradeCatalog("catalog", workspaces.catalog, changes);
}
for (const [name, catalog] of Object.entries(workspaces.catalogs ?? {})) {
	await upgradeCatalog(`catalogs.${name}`, catalog, changes);
}

if (changes.length === 0) {
	console.log("\nEverything in the catalog is already up to date.");
	process.exit(0);
}

const width = Math.max(...changes.map((c) => c.name.length));
console.log(`\n${changes.length} update(s):\n`);
for (const c of changes) {
	console.log(`  ${c.name.padEnd(width)}  ${c.from}  →  ${c.to}`);
}

if (DRY_RUN) {
	console.log("\n--dry-run: package.json left unchanged.");
	process.exit(0);
}

// Re-serialize with tabs to match the root package.json's existing indentation.
await Bun.write(ROOT_PKG, `${JSON.stringify(pkg, null, "\t")}\n`);
console.log("\nUpdated package.json catalog. Running `bun install`...\n");

const install = Bun.spawn(["bun", "install"], {
	cwd: ROOT,
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await install.exited);
