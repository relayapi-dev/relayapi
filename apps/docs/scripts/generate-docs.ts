import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";
import fs from "node:fs";
import path from "node:path";

const specUrl = "https://api.relayapi.dev/openapi.json";
const outputDir = "./content/docs/api-reference";
// Build into a temp dir OUTSIDE content/docs, then atomically swap into place.
// A failure must never leave `api-reference/` empty — that is exactly how every
// generated page was wiped and committed by the sync workflow before.
const tmpDir = "./.api-reference-tmp";

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

console.log(`Fetching OpenAPI spec from: ${specUrl}`);

const res = await fetch(specUrl, {
	cache: "no-store",
	headers: { accept: "application/json" },
});
if (!res.ok) {
	throw new Error(
		`Failed to fetch OpenAPI spec: HTTP ${res.status} ${res.statusText}`,
	);
}

const spec = await res.json();

// Validate the spec actually describes operations BEFORE touching the file system.
const paths =
	spec && typeof spec === "object" && spec.paths ? spec.paths : {};
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
	.filter((d) => d.isDirectory());

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
		.filter((f) => f.endsWith(".mdx") && f !== "index.mdx");

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

	const indexContent = `---
title: ${categoryTitle}
---

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
${rows}
`;

	fs.writeFileSync(path.join(dirPath, "index.mdx"), indexContent);
}

// Atomically swap the freshly generated docs into place.
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(outputDir), { recursive: true });
fs.renameSync(tmpDir, outputDir);

console.log(
	`API reference docs generated successfully! (${tagDirs.length} categories)`,
);
