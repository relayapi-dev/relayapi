import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readBaselineBuildPolicy } from "./rebuild-baseline";

type Journal = {
	entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

const policyPath = fileURLToPath(
	new URL("../baseline-build-policy.json", import.meta.url),
);
const policy = readBaselineBuildPolicy(policyPath);

if (policy.lifecycle !== "sealed") {
	throw new Error(
		"Production database initialization requires baseline-build-policy.json lifecycle=sealed",
	);
}

const journal = JSON.parse(
	readFileSync(
		new URL("../drizzle/meta/_journal.json", import.meta.url),
		"utf8",
	),
) as Journal;
const baselineEntry = journal.entries?.[0];
if (
	baselineEntry?.idx !== 0 ||
	baselineEntry.tag !== policy.baseline.tag ||
	baselineEntry.when !== policy.baseline.folderMillis
) {
	throw new Error(
		"The sealed baseline policy does not match the first Drizzle journal entry",
	);
}

console.log("Virgin baseline is sealed; destructive rebuild mode is disabled.");
