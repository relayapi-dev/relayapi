import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	auditBaselinePolicyBoundary,
	findContractOnlyOperations,
	findDestructiveExpandOperations,
	findProceduralDynamicSql,
	type MigrationPolicy as Policy,
} from "./migration-policy-contract";

type Journal = {
	entries: Array<{ idx: number; tag: string }>;
};

const migrationDirectory = process.env.RELAYAPI_VERIFY_MIGRATION_DIRECTORY
	? resolve(process.env.RELAYAPI_VERIFY_MIGRATION_DIRECTORY)
	: fileURLToPath(new URL("../drizzle", import.meta.url));
const policy = JSON.parse(
	readFileSync(join(migrationDirectory, "migration-policy.json"), "utf8"),
) as Policy;
const journal = JSON.parse(
	readFileSync(join(migrationDirectory, "meta", "_journal.json"), "utf8"),
) as Journal;

if (policy.schemaVersion !== 2) {
	throw new Error("Unsupported migration-policy schema version");
}

const sqlFiles = new Map(
	readdirSync(migrationDirectory)
		.filter((file) => /^\d{4}_.+\.sql$/.test(file))
		.map((file) => [file.replace(/\.sql$/, ""), file]),
);
const journalTags = new Set(journal.entries.map((entry) => entry.tag));

const failures = auditBaselinePolicyBoundary(journal, policy);
for (const tag of journalTags) {
	const entry = policy.migrations[tag];
	const filename = sqlFiles.get(tag);
	if (!entry) {
		failures.push(`${tag} has no reviewed expand/contract policy entry`);
		continue;
	}
	if (!filename) {
		failures.push(`${tag} is journaled but its SQL file is missing`);
		continue;
	}
	if (!entry.summary.trim()) {
		failures.push(`${tag} must have a non-empty migration summary`);
	}

	const source = readFileSync(join(migrationDirectory, filename), "utf8");
	if (entry.phase !== "baseline") {
		for (const finding of findProceduralDynamicSql(source)) {
			failures.push(`${tag} contains ${finding}`);
		}
	}
	if (entry.phase === "expand") {
		for (const label of findDestructiveExpandOperations(source)) {
			failures.push(`${tag} is marked expand but contains ${label}`);
		}
	}

	if (
		entry.phase === "contract" &&
		!source.includes("relayapi:contract-after-compatible-release")
	) {
		failures.push(
			`${tag} is a contract migration but lacks the relayapi:contract-after-compatible-release marker`,
		);
	}
	if (
		entry.phase === "contract" &&
		findContractOnlyOperations(source).length === 0
	) {
		failures.push(
			`${tag} is marked contract but contains no classified contract-only SQL operation`,
		);
	}
}

for (const tag of Object.keys(policy.migrations)) {
	if (!journalTags.has(tag))
		failures.push(`${tag} has policy but is not journaled`);
}
for (const tag of sqlFiles.keys()) {
	if (!journalTags.has(tag))
		failures.push(`${tag} SQL exists but is not journaled`);
}

if (failures.length > 0) {
	throw new Error(
		`Migration policy verification failed:\n- ${failures.join("\n- ")}`,
	);
}

console.log(
	`Migration policy verified (${journalTags.size} reviewed baseline/expand/contract entries).`,
);
