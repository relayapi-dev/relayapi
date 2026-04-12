import { generateFiles } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";
import fs from "node:fs";
import path from "node:path";

const specUrl = "https://api.relayapi.dev/openapi.json";
const outputDir = "./content/docs/api-reference";

// Clean output directory so removed endpoints don't leave stale pages
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

console.log(`Fetching OpenAPI spec from: ${specUrl}`);

const spec = await fetch(specUrl).then((r) => r.json());

const openapi = createOpenAPI({
	input: () => ({
		[specUrl]: spec,
	}),
});

await generateFiles({
	input: openapi,
	output: outputDir,
	per: "operation",
	groupBy: "tag",
});

// Auto-generate index.mdx for each tag directory
const tagDirs = fs
	.readdirSync(outputDir, { withFileTypes: true })
	.filter((d) => d.isDirectory());

for (const dir of tagDirs) {
	const dirPath = path.join(outputDir, dir.name);
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

console.log(
	`API reference docs generated successfully! (${tagDirs.length} categories)`,
);
