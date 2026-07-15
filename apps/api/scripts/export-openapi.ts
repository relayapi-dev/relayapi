import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import app from "../src/app";

const DEFAULT_OUTPUT = path.resolve(import.meta.dir, "../../docs/openapi.json");
const PRODUCTION_SPEC_URL = "https://api.relayapi.dev/openapi.json";
const HTTP_METHODS = new Set([
	"delete",
	"get",
	"head",
	"options",
	"patch",
	"post",
	"put",
	"trace",
]);
const compareText = (left: string, right: string) =>
	left < right ? -1 : left > right ? 1 : 0;

function validateDocument(document: unknown, source: string): void {
	if (!document || typeof document !== "object") {
		throw new Error(`${source} OpenAPI document is not an object.`);
	}
	const candidate = document as {
		openapi?: unknown;
		paths?: Record<string, Record<string, unknown>>;
	};
	if (
		typeof candidate.openapi !== "string" ||
		!candidate.openapi.startsWith("3.")
	) {
		throw new Error(`${source} document is not OpenAPI 3.x.`);
	}
	let operationCount = 0;
	for (const pathItem of Object.values(candidate.paths ?? {})) {
		operationCount += Object.keys(pathItem).filter((method) =>
			HTTP_METHODS.has(method.toLowerCase()),
		).length;
	}
	if (operationCount === 0) {
		throw new Error(`${source} OpenAPI document contains zero operations.`);
	}
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => compareText(left, right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

function serialize(document: unknown): string {
	// Stable indentation keeps source-control diffs reviewable; Vite minifies the
	// JSON when bundling the docs Worker, so this does not affect runtime size.
	return `${JSON.stringify(canonicalize(document), null, 2)}\n`;
}

async function generateFromCheckout(): Promise<string> {
	const response = await app.request(
		new Request("http://openapi.local/openapi.json"),
		{},
		{} as never,
	);
	if (!response.ok) {
		throw new Error(
			`Checked-out API failed to generate OpenAPI: HTTP ${response.status}`,
		);
	}
	const document = await response.json();
	validateDocument(document, "Checked-out API");
	return serialize(document);
}

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
const outputPath =
	outputFlag >= 0 && args[outputFlag + 1]
		? path.resolve(process.cwd(), args[outputFlag + 1])
		: DEFAULT_OUTPUT;
const check = args.includes("--check");
const compareProduction = args.includes("--compare-production");
const generated = await generateFromCheckout();

if (check) {
	let pinned: string;
	try {
		pinned = await readFile(outputPath, "utf8");
	} catch (error) {
		throw new Error(
			`Pinned OpenAPI artifact is missing at ${outputPath}. Run \`bun run openapi:export\`.`,
			{ cause: error },
		);
	}
	if (pinned !== generated) {
		throw new Error(
			`Pinned OpenAPI artifact is stale: ${outputPath}. Run \`bun run openapi:export\` and commit the result.`,
		);
	}
	console.log(`OpenAPI artifact matches the checked-out API: ${outputPath}`);
}

if (compareProduction) {
	const response = await fetch(PRODUCTION_SPEC_URL, {
		headers: { accept: "application/json" },
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(
			`Failed to fetch production OpenAPI: HTTP ${response.status} ${response.statusText}`,
		);
	}
	const productionDocument = await response.json();
	validateDocument(productionDocument, "Production");
	const production = serialize(productionDocument);
	if (production !== generated) {
		throw new Error(
			"Production OpenAPI differs from the checked-out API. Deploy the intended revision or investigate production drift.",
		);
	}
	console.log("Production OpenAPI matches the checked-out API.");
}

if (!check && !compareProduction) {
	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, generated, "utf8");
	console.log(`Wrote deterministic OpenAPI artifact: ${outputPath}`);
}
