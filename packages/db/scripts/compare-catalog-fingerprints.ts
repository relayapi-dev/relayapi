import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertValidCatalogFingerprint,
	assertValidCatalogDifferenceReview,
	buildCatalogDifferenceReviewDraft,
	type CatalogDifferenceReview,
	type CatalogFingerprint,
	compareCatalogFingerprints,
} from "./catalog-fingerprint-contract";

function requiredPath(name: string): string {
	const prefix = `${name}=`;
	const value = process.argv
		.slice(2)
		.find((argument) => argument.startsWith(prefix));
	if (!value) throw new Error(`Missing ${name}=<path>`);
	return resolve(value.slice(prefix.length));
}

const oldPath = requiredPath("--old");
const candidatePath = requiredPath("--candidate");
const reviewArgument = process.argv
	.slice(2)
	.find((argument) => argument.startsWith("--review="));
const printReviewDraft = process.argv.includes("--print-review-draft");
if (reviewArgument && printReviewDraft) {
	throw new Error("--review and --print-review-draft are mutually exclusive");
}
const oldChain = JSON.parse(
	readFileSync(oldPath, "utf8"),
) as CatalogFingerprint;
const candidate = JSON.parse(
	readFileSync(candidatePath, "utf8"),
) as CatalogFingerprint;
const auditDocument = readFileSync(
	fileURLToPath(
		new URL(
			"../../../docs/SCHEMA_OPTIMALITY_AUDIT_PRE_FREEZE_2026-07-27.md",
			import.meta.url,
		),
	),
	"utf8",
);
assertValidCatalogFingerprint(oldChain, oldPath);
assertValidCatalogFingerprint(candidate, candidatePath);

const differences = compareCatalogFingerprints(oldChain, candidate);
if (printReviewDraft) {
	process.stdout.write(
		`${JSON.stringify(
			buildCatalogDifferenceReviewDraft(oldChain, candidate),
			null,
			2,
		)}\n`,
	);
	process.exit(0);
}

if (differences.length > 0) {
	if (!reviewArgument) {
		throw new Error(
			`Candidate catalog has ${differences.length} intentional-or-accidental difference(s). Generate an exact review draft with --print-review-draft, link every entry to an audit decision, then verify it with --review=<path>.`,
		);
	}
	const reviewPath = resolve(reviewArgument.slice("--review=".length));
	const review = JSON.parse(
		readFileSync(reviewPath, "utf8"),
	) as CatalogDifferenceReview;
	assertValidCatalogDifferenceReview(
		review,
		oldChain,
		candidate,
		auditDocument,
	);
	console.log(
		`Reviewed ${differences.length} generation-1-to-2 catalog difference(s) (${oldChain.catalogSha256} -> ${candidate.catalogSha256}).`,
	);
} else {
	if (reviewArgument) {
		const reviewPath = resolve(reviewArgument.slice("--review=".length));
		const review = JSON.parse(
			readFileSync(reviewPath, "utf8"),
		) as CatalogDifferenceReview;
		assertValidCatalogDifferenceReview(
			review,
			oldChain,
			candidate,
			auditDocument,
		);
	}
	console.log(
		`Old-chain and candidate catalogs are equivalent (${oldChain.catalogSha256}; ${oldChain.objects.length} objects).`,
	);
}
