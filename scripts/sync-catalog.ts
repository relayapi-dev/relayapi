#!/usr/bin/env bun
/**
 * Make sure every catalog-eligible workspace package references the Bun catalog
 * instead of pinning literal version ranges.
 *
 * The root `package.json` catalog (`workspaces.catalog`) is the single source of
 * truth for shared dependency versions; Bun-installed packages reference it with
 * `"<pkg>": "catalog:"` (see https://bun.com/docs/pm/catalogs). This script scans
 * every workspace package, finds dependencies still on a literal range, copies
 * that range into the default catalog (if it isn't there yet), and rewrites the
 * package entry to `"catalog:"`. Run `bun run deps:upgrade` afterwards to bump the
 * catalog ranges to their latest versions — or use `bun run packages:update`,
 * which chains both steps and then `bun install`.
 *
 * Intentionally NOT synced (they're published with npm, which doesn't understand
 * the `catalog:` protocol — see CLAUDE.md):
 *   - packages/sdk, packages/mcp
 *   - packages/integrations/*
 * `workspace:*` links, `catalog:` / `catalog:<name>` refs, and non-plain-semver
 * specs (git/url/"*"/"latest") are left untouched.
 *
 * Usage:
 *   bun run deps:sync             # convert literals -> catalog:, then edit package.json files
 *   bun run deps:sync --dry-run   # print what would change, write nothing
 */

import { dirname, join } from "node:path";

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

type DepBlock = Record<string, string>;

interface PackageJson {
	name?: string;
	dependencies?: DepBlock;
	devDependencies?: DepBlock;
	peerDependencies?: DepBlock;
	optionalDependencies?: DepBlock;
	[key: string]: unknown;
}

const DEP_BLOCKS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

// Packages published with `npm publish` keep literal versions — the `catalog:`
// protocol is only understood by Bun/pnpm. Everything else under the workspace
// globs is catalog-eligible. Matches the convention documented in CLAUDE.md.
const EXCLUDED_DIRS = new Set(["packages/sdk", "packages/mcp"]);
const EXCLUDED_PREFIXES = ["packages/integrations/"];

function isExcluded(relDir: string): boolean {
	if (EXCLUDED_DIRS.has(relDir)) return true;
	return EXCLUDED_PREFIXES.some((prefix) => relDir.startsWith(prefix));
}

// Pull off the leading semver operator we want to preserve (^, ~, >=, etc.).
function rangePrefix(range: string): string {
	return range.match(/^(\^|~|>=|<=|>|<|=)/)?.[1] ?? "";
}

// A plain `^/~/exact` semver range we know how to move into the catalog. Skips
// "*", "15.*", "workspace:*", "catalog:", "latest", git/url specs, etc.
function isPlainSemver(range: string): boolean {
	const rest = range.slice(rangePrefix(range).length);
	return /^\d+(\.\d+)*(\.\d+)?([-+][0-9A-Za-z.-]+)?$/.test(rest);
}

function bareVersion(range: string): string {
	return range.slice(rangePrefix(range).length);
}

// Return the range whose bare version is the highest (keeps the first range's
// operator). Used when two packages pin the same dep at different versions.
function higherRange(a: string, b: string): string {
	try {
		return Bun.semver.order(bareVersion(a), bareVersion(b)) >= 0 ? a : b;
	} catch {
		return a;
	}
}

interface Conversion {
	pkgName: string;
	relDir: string;
	block: string;
	dep: string;
	from: string;
}

interface CatalogAddition {
	dep: string;
	range: string;
}

const root = (await Bun.file(ROOT_PKG).json()) as RootPkg;
const workspaces = root.workspaces;
if (!workspaces?.packages) {
	console.error("No `workspaces.packages` found in root package.json.");
	process.exit(1);
}
if (!workspaces.catalog) workspaces.catalog = {};
const catalog: Catalog = workspaces.catalog;

// Resolve the workspace globs to package.json files.
const pkgFiles = new Set<string>();
for (const pattern of workspaces.packages) {
	const glob = new Bun.Glob(`${pattern}/package.json`);
	for await (const file of glob.scan({ cwd: ROOT, onlyFiles: true })) {
		pkgFiles.add(file);
	}
}

const conversions: Conversion[] = [];
const conflicts: string[] = [];
// dep -> desired catalog range we want to introduce for deps not yet cataloged.
const wanted = new Map<string, string>();
// Mutated package.json docs to write at the end (only those that changed).
const edited = new Map<string, PackageJson>();

for (const relFile of [...pkgFiles].sort()) {
	const relDir = dirname(relFile);
	if (isExcluded(relDir)) continue;

	const absFile = join(ROOT, relFile);
	const pkg = (await Bun.file(absFile).json()) as PackageJson;
	let changed = false;

	for (const block of DEP_BLOCKS) {
		const deps = pkg[block] as DepBlock | undefined;
		if (!deps) continue;
		for (const [dep, spec] of Object.entries(deps)) {
			if (spec.startsWith("catalog:") || spec.startsWith("workspace:")) continue;
			if (!isPlainSemver(spec)) continue;

			conversions.push({
				pkgName: pkg.name ?? relDir,
				relDir,
				block,
				dep,
				from: spec,
			});

			const existing = catalog[dep];
			if (existing === undefined) {
				// Not cataloged yet: remember the range to add (highest wins on conflict).
				const prev = wanted.get(dep);
				wanted.set(dep, prev ? higherRange(prev, spec) : spec);
			} else if (bareVersion(existing) !== bareVersion(spec)) {
				conflicts.push(
					`${dep}: ${pkg.name ?? relDir} pins ${spec}, catalog keeps ${existing}`,
				);
			}

			deps[dep] = "catalog:";
			changed = true;
		}
	}

	if (changed) edited.set(absFile, pkg);
}

const additions: CatalogAddition[] = [...wanted.entries()]
	.map(([dep, range]) => ({ dep, range }))
	.sort((a, b) => a.dep.localeCompare(b.dep));

if (conversions.length === 0) {
	console.log("Every catalog-eligible package already uses `catalog:`. Nothing to do.");
	process.exit(0);
}

if (additions.length > 0) {
	console.log(`New default-catalog entries (${additions.length}):\n`);
	const w = Math.max(...additions.map((a) => a.dep.length));
	for (const a of additions) console.log(`  ${a.dep.padEnd(w)}  ${a.range}`);
	console.log("");
}

console.log(`Packages converted to \`catalog:\` (${conversions.length}):\n`);
const dw = Math.max(...conversions.map((c) => `${c.relDir} ${c.block}`.length));
for (const c of conversions) {
	console.log(`  ${`${c.relDir} ${c.block}`.padEnd(dw)}  ${c.dep}  (${c.from})`);
}

if (conflicts.length > 0) {
	console.warn(`\nVersion conflicts kept at the catalog value (${conflicts.length}):`);
	for (const c of conflicts) console.warn(`  ! ${c}`);
}

if (DRY_RUN) {
	console.log("\n--dry-run: no files were changed.");
	process.exit(0);
}

// Add the new catalog entries, then re-sort the default catalog so additions land
// in their alphabetical place (matches the existing on-disk ordering).
for (const { dep, range } of additions) catalog[dep] = range;
const sorted: Catalog = {};
for (const key of Object.keys(catalog).sort()) sorted[key] = catalog[key];
workspaces.catalog = sorted;

// Re-serialize with tabs to match the existing indentation, trailing newline.
await Bun.write(ROOT_PKG, `${JSON.stringify(root, null, "\t")}\n`);
for (const [absFile, pkg] of edited) {
	await Bun.write(absFile, `${JSON.stringify(pkg, null, "\t")}\n`);
}

console.log(
	`\nUpdated the catalog and ${edited.size} package.json file(s).` +
		" Run `bun install` (or `bun run deps:upgrade`) to apply.",
);
