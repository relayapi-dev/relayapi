import { readFile, writeFile } from "node:fs/promises";

export const GENERATION_ONE_STAMP_KIND =
	"prelive-generation-1-worker-stamp" as const;

export type GenerationOneStampRecord = {
	schemaVersion: 1;
	kind: typeof GENERATION_ONE_STAMP_KIND;
	generation: 1;
	workflowRunId: string;
	sourceCommitSha: string;
	apiVersionId: string;
	appVersionId: string;
	tag: string;
	message: string;
};

export type GenerationOneStampIdentity = {
	workflowRunId: string;
	sourceCommitSha: string;
	apiVersionId: string;
	appVersionId: string;
};

function requireRunId(value: string): string {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error("Generation-1 stamp workflow run ID must be numeric");
	}
	return value;
}

function requireSourceCommitSha(value: string): string {
	if (!/^[0-9a-f]{40}$/.test(value)) {
		throw new Error(
			"Generation-1 stamp source commit must be a lowercase full Git SHA",
		);
	}
	return value;
}

function requireVersionId(label: string, value: string): string {
	if (!value || /\s/.test(value)) {
		throw new Error(`${label} generation-1 stamp version ID is invalid`);
	}
	return value;
}

export function createGenerationOneStampRecord(
	input: GenerationOneStampIdentity,
): GenerationOneStampRecord {
	const workflowRunId = requireRunId(input.workflowRunId);
	const sourceCommitSha = requireSourceCommitSha(input.sourceCommitSha);
	const apiVersionId = requireVersionId("API", input.apiVersionId);
	const appVersionId = requireVersionId("App", input.appVersionId);
	return {
		schemaVersion: 1,
		kind: GENERATION_ONE_STAMP_KIND,
		generation: 1,
		workflowRunId,
		sourceCommitSha,
		apiVersionId,
		appVersionId,
		tag: `baseline-1-stamp-${sourceCommitSha}`,
		message: `Generation 1 stamp ${sourceCommitSha}`,
	};
}

export function verifyGenerationOneStampRecord(
	actual: unknown,
	expected: GenerationOneStampIdentity,
): GenerationOneStampRecord {
	const canonical = createGenerationOneStampRecord(expected);
	if (
		typeof actual !== "object" ||
		actual === null ||
		Array.isArray(actual) ||
		Object.keys(actual).sort().join("\0") !==
			Object.keys(canonical).sort().join("\0") ||
		Object.entries(canonical).some(
			([key, value]) => (actual as Record<string, unknown>)[key] !== value,
		)
	) {
		throw new Error(
			"Generation-1 stamp record does not exactly match the protected workflow run, source, and Worker versions",
		);
	}
	return canonical;
}

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function identityFromEnvironment(prefix: "ACTUAL" | "EXPECTED") {
	return {
		workflowRunId: requiredEnvironment(`${prefix}_GENERATION_1_STAMP_RUN_ID`),
		sourceCommitSha: requiredEnvironment(
			`${prefix}_GENERATION_1_STAMP_COMMIT_SHA`,
		),
		apiVersionId: requiredEnvironment(`${prefix}_GENERATION_1_API_VERSION_ID`),
		appVersionId: requiredEnvironment(`${prefix}_GENERATION_1_APP_VERSION_ID`),
	};
}

if (import.meta.main) {
	const writeArgument = process.argv.find((value) =>
		value.startsWith("--write="),
	);
	const verifyArgument = process.argv.find((value) =>
		value.startsWith("--verify="),
	);
	if (Boolean(writeArgument) === Boolean(verifyArgument)) {
		throw new Error("Pass exactly one of --write=<path> or --verify=<path>");
	}
	if (writeArgument) {
		const outputPath = writeArgument.slice("--write=".length);
		if (!outputPath) throw new Error("--write requires a path");
		const record = createGenerationOneStampRecord(
			identityFromEnvironment("ACTUAL"),
		);
		await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		console.log(JSON.stringify(record));
	} else if (verifyArgument) {
		const inputPath = verifyArgument.slice("--verify=".length);
		if (!inputPath) throw new Error("--verify requires a path");
		const parsed: unknown = JSON.parse(await readFile(inputPath, "utf8"));
		console.log(
			JSON.stringify(
				verifyGenerationOneStampRecord(
					parsed,
					identityFromEnvironment("EXPECTED"),
				),
			),
		);
	}
}
