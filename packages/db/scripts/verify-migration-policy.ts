import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	auditBaselinePolicyBoundary,
	findDestructiveExpandOperations,
	type MigrationPolicy as Policy,
} from "./migration-policy-contract";

type Journal = {
	entries: Array<{ idx: number; tag: string }>;
};

const migrationDirectory = fileURLToPath(
	new URL("../drizzle", import.meta.url),
);
const policy = JSON.parse(
	readFileSync(
		new URL("../drizzle/migration-policy.json", import.meta.url),
		"utf8",
	),
) as Policy;
const journal = JSON.parse(
	readFileSync(
		new URL("../drizzle/meta/_journal.json", import.meta.url),
		"utf8",
	),
) as Journal;

if (policy.schemaVersion !== 1) {
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

	const source = readFileSync(`${migrationDirectory}/${filename}`, "utf8");
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
