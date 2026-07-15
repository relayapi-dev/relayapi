import fs from "node:fs";
import path from "node:path";
import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";

const specPath = path.resolve("./openapi.json");
const specUrl = "https://api.relayapi.dev/openapi.json";
const compareText = (left: string, right: string) =>
	left < right ? -1 : left > right ? 1 : 0;
const outputDir = "./content/docs/api-reference";
const checkOnly = process.argv.includes("--check");
// Build into a temp dir OUTSIDE content/docs, then transactionally swap it in.
// A failure must never leave `api-reference/` empty — that is exactly how every
// generated page was wiped and committed by the sync workflow before.
const tmpDir = "./.api-reference-tmp";
const backupDir = "./.api-reference-backup";

const TAG_INTROS: Readonly<Record<string, string>> = {
	"organization-settings": `## Workspace requirement semantics

\`Require Workspace ID\` controls independent operational-root creation. When it is disabled, an omitted \`workspace_id\` creates an organization-scoped row; any credential with at least one workspace grant may access those shared rows, while a zero-grant credential sees none. When it is enabled, independent roots require an explicit active, tenant-owned, authorized workspace. Parent-bound creates may inherit the authoritative parent workspace. Shared definitions remain organization-global in either mode.
`,
	contacts: `## Workspace behavior

\`workspace_id\` is optional. A standalone contact created without it is organization-scoped when \`Require Workspace ID\` is disabled and is rejected when that policy is enabled. If an initial channel account is supplied, omission inherits that account's authoritative workspace in either mode; \`account_id\`, \`platform\`, and \`identifier\` must be supplied together.
`,
};

function listFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	const visit = (relativeDir: string) => {
		const absoluteDir = path.join(root, relativeDir);
		for (const entry of fs
			.readdirSync(absoluteDir, { withFileTypes: true })
			.sort((left, right) => compareText(left.name, right.name))) {
			const relativePath = path.join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				visit(relativePath);
			} else if (entry.isFile()) {
				files.push(relativePath);
			}
		}
	};
	visit("");
	return files;
}

function generatedTreeDrift(
	currentDir: string,
	generatedDir: string,
): string[] {
	const currentFiles = new Set(listFiles(currentDir));
	const generatedFiles = new Set(listFiles(generatedDir));
	const allFiles = [...new Set([...currentFiles, ...generatedFiles])].sort(
		compareText,
	);
	const drift: string[] = [];
	for (const relativePath of allFiles) {
		if (!currentFiles.has(relativePath)) {
			drift.push(`missing ${relativePath}`);
			continue;
		}
		if (!generatedFiles.has(relativePath)) {
			drift.push(`stale ${relativePath}`);
			continue;
		}
		if (
			!fs
				.readFileSync(path.join(currentDir, relativePath))
				.equals(fs.readFileSync(path.join(generatedDir, relativePath)))
		) {
			drift.push(`changed ${relativePath}`);
		}
	}
	return drift;
}

const HTTP_METHODS = new Set([
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"options",
	"head",
	"trace",
]);

console.log(`Reading pinned OpenAPI spec from: ${specPath}`);

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

// Validate the spec actually describes operations BEFORE touching the file system.
const paths = spec && typeof spec === "object" && spec.paths ? spec.paths : {};
let operationCount = 0;
const discoveredTags: string[] = [];
const seenTags = new Set<string>();
for (const pathItem of Object.values<Record<string, unknown>>(paths)) {
	if (!pathItem || typeof pathItem !== "object") continue;
	for (const [method, op] of Object.entries(pathItem)) {
		if (!HTTP_METHODS.has(method) || !op || typeof op !== "object") continue;
		operationCount++;
		for (const tag of (op as { tags?: string[] }).tags ?? []) {
			if (!seenTags.has(tag)) {
				seenTags.add(tag);
				discoveredTags.push(tag);
			}
		}
	}
}

if (operationCount === 0) {
	throw new Error(
		"OpenAPI spec contains zero operations — refusing to regenerate (would wipe existing docs).",
	);
}

// fumadocs-openapi groups pages using the DOCUMENT-level `tags` array. This API's
// spec only declares tags per-operation, so without backfilling the top-level list
// `groupBy: "tag"` silently produces zero pages. Preserve any already-declared
// top-level tags and append the rest in first-seen order.
const existingTopLevel: Array<{ name?: string }> = Array.isArray(spec.tags)
	? spec.tags
	: [];
const existingNames = new Set(
	existingTopLevel.map((t) => t?.name).filter(Boolean),
);
spec.tags = [
	...existingTopLevel,
	...discoveredTags
		.filter((name) => !existingNames.has(name))
		.map((name) => ({ name })),
];

console.log(
	`Spec OK: ${operationCount} operations across ${spec.tags.length} tags`,
);

const openapi = createOpenAPI({
	input: { [specUrl]: spec },
	disableCache: true,
});

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

await generateFiles({
	input: openapi,
	output: tmpDir,
	per: "operation",
	groupBy: "tag",
});

const tagDirs = fs
	.readdirSync(tmpDir, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.sort((left, right) => compareText(left.name, right.name));

if (tagDirs.length === 0) {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	throw new Error(
		"Generated zero API reference pages — refusing to replace existing docs.",
	);
}

// Auto-generate index.mdx for each tag directory
for (const dir of tagDirs) {
	const dirPath = path.join(tmpDir, dir.name);
	const mdxFiles = fs
		.readdirSync(dirPath)
		.filter((f) => f.endsWith(".mdx") && f !== "index.mdx")
		.sort(compareText);

	// Read each MDX file to extract title and method
	const endpoints: { method: string; file: string; title: string }[] = [];
	for (const file of mdxFiles) {
		const content = fs.readFileSync(path.join(dirPath, file), "utf-8");
		const titleMatch = content.match(/^title:\s*(.+)$/m);
		const methodMatch = content.match(/method:\s*(\w+)/);
		if (titleMatch && methodMatch) {
			endpoints.push({
				method: methodMatch[1].toUpperCase(),
				file: file.replace(".mdx", ""),
				title: titleMatch[1].trim(),
			});
		}
	}

	// Derive a readable category title from the directory name
	const categoryTitle = dir.name
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");

	const rows = endpoints
		.map(
			(e) =>
				`| \`${e.method}\` | [${e.title}](/api-reference/${dir.name}/${e.file}) | ${e.title} |`,
		)
		.join("\n");
	const intro = TAG_INTROS[dir.name];

	const indexContent = `---
title: ${categoryTitle}
---

${intro ? `${intro}\n` : ""}## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
${rows}
`;

	fs.writeFileSync(path.join(dirPath, "index.mdx"), indexContent);
}

if (checkOnly) {
	const drift = generatedTreeDrift(outputDir, tmpDir);
	fs.rmSync(tmpDir, { recursive: true, force: true });
	if (drift.length > 0) {
		throw new Error(
			`Generated API reference is stale. Run bun run generate-docs.\n${drift
				.slice(0, 20)
				.map((entry) => `- ${entry}`)
				.join(
					"\n",
				)}${drift.length > 20 ? `\n- ...and ${drift.length - 20} more` : ""}`,
		);
	}
	console.log(
		`Verified generated API reference (${tagDirs.length} categories).`,
	);
} else {
	// Move the old tree aside so a failed final rename can restore it.
	fs.mkdirSync(path.dirname(outputDir), { recursive: true });
	fs.rmSync(backupDir, { recursive: true, force: true });
	const hadExistingOutput = fs.existsSync(outputDir);
	if (hadExistingOutput) fs.renameSync(outputDir, backupDir);
	try {
		fs.renameSync(tmpDir, outputDir);
	} catch (error) {
		if (hadExistingOutput) fs.renameSync(backupDir, outputDir);
		throw error;
	}
	fs.rmSync(backupDir, { recursive: true, force: true });

	console.log(
		`API reference docs generated successfully! (${tagDirs.length} categories)`,
	);
}
