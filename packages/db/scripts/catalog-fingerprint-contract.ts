import { createHash } from "node:crypto";
import { REQUIRED_DATABASE_EXTENSION_VERSIONS } from "../src/database-prerequisites.js";
import type { BaselineGeneration } from "./baseline-generation-contract";

export const OLD_CHAIN_CATALOG_EVIDENCE_FILE =
	"catalog-fingerprint-generation-1-old-chain.json";
export const CANDIDATE_CATALOG_EVIDENCE_FILE =
	"catalog-fingerprint-generation-2-candidate.json";
export const CATALOG_DIFFERENCE_REVIEW_EVIDENCE_FILE =
	"catalog-difference-review-generation-1-to-2.json";

export type CatalogObject = {
	kind: string;
	identity: string;
	definition: string;
};

export type CatalogFingerprint = {
	schemaVersion: 1;
	source: "old-chain" | "candidate";
	generation: number;
	postgresMajor: number;
	migrationManifestSha256: string;
	catalogSha256: string;
	objects: CatalogObject[];
};

type ExtensionVersionContract = Readonly<Record<string, string | undefined>>;

function sha256(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function normalizeExtensionDefinition(
	object: CatalogObject,
	extensionVersions: ExtensionVersionContract,
): string {
	if (
		object.kind !== "extension" ||
		!Object.hasOwn(extensionVersions, object.identity) ||
		extensionVersions[object.identity] !== undefined
	) {
		return object.definition;
	}
	try {
		const definition = JSON.parse(object.definition) as {
			schema?: unknown;
		};
		if (typeof definition.schema !== "string" || !definition.schema.trim()) {
			return object.definition;
		}
		return JSON.stringify({
			schema: definition.schema,
			versionPolicy: "provider-default",
		});
	} catch {
		return object.definition;
	}
}

export function normalizeCatalogObjects(
	objects: readonly CatalogObject[],
	extensionVersions: ExtensionVersionContract = REQUIRED_DATABASE_EXTENSION_VERSIONS,
): CatalogObject[] {
	return objects
		.map((object) => ({
			kind: object.kind,
			identity: object.identity,
			definition: normalizeExtensionDefinition(object, extensionVersions),
		}))
		.sort((left, right) =>
			`${left.kind}\0${left.identity}\0${left.definition}`.localeCompare(
				`${right.kind}\0${right.identity}\0${right.definition}`,
			),
		);
}

export function catalogObjectsSha256(
	objects: readonly CatalogObject[],
): string {
	return sha256(JSON.stringify(normalizeCatalogObjects(objects)));
}

export function buildCatalogFingerprint(input: {
	source: CatalogFingerprint["source"];
	generation: number;
	postgresMajor: number;
	migrationManifestSha256: string;
	objects: readonly CatalogObject[];
}): CatalogFingerprint {
	const objects = normalizeCatalogObjects(input.objects);
	return {
		schemaVersion: 1,
		source: input.source,
		generation: input.generation,
		postgresMajor: input.postgresMajor,
		migrationManifestSha256: input.migrationManifestSha256,
		catalogSha256: catalogObjectsSha256(objects),
		objects,
	};
}

export function auditCatalogFingerprint(
	fingerprint: CatalogFingerprint,
): string[] {
	const failures: string[] = [];
	if (fingerprint.schemaVersion !== 1) {
		failures.push("catalog fingerprint schemaVersion must be 1");
	}
	if (
		fingerprint.source !== "old-chain" &&
		fingerprint.source !== "candidate"
	) {
		failures.push("catalog fingerprint source must be old-chain or candidate");
	}
	if (
		!Number.isSafeInteger(fingerprint.generation) ||
		fingerprint.generation <= 0
	) {
		failures.push("catalog fingerprint generation must be positive");
	}
	if (
		!Number.isSafeInteger(fingerprint.postgresMajor) ||
		fingerprint.postgresMajor <= 0
	) {
		failures.push("catalog fingerprint postgresMajor must be positive");
	}
	if (!/^[0-9a-f]{64}$/i.test(fingerprint.migrationManifestSha256)) {
		failures.push("catalog fingerprint migrationManifestSha256 is invalid");
	}
	const normalized = normalizeCatalogObjects(fingerprint.objects ?? []);
	if (JSON.stringify(normalized) !== JSON.stringify(fingerprint.objects)) {
		failures.push("catalog fingerprint objects are not canonically ordered");
	}
	const identities = new Set<string>();
	for (const object of normalized) {
		if (!object.kind.trim() || !object.identity.trim()) {
			failures.push("catalog object kind and identity must be non-empty");
		}
		const key = `${object.kind}\0${object.identity}`;
		if (identities.has(key)) {
			failures.push(
				`catalog object identity is duplicated: ${object.kind} ${object.identity}`,
			);
		}
		identities.add(key);
	}
	if (fingerprint.catalogSha256 !== catalogObjectsSha256(normalized)) {
		failures.push("catalog fingerprint checksum does not match its objects");
	}
	return failures;
}

export type CatalogDifference = {
	key: string;
	oldDefinition?: string;
	candidateDefinition?: string;
};

export type CatalogDifferenceDecision = {
	id: string;
	auditSection: string;
	summary: string;
};

export type ReviewedCatalogDifference = {
	key: string;
	oldDefinitionSha256: string | null;
	candidateDefinitionSha256: string | null;
	decisionId: string;
};

export type CatalogDifferenceReview = {
	schemaVersion: 1;
	fromGeneration: 1;
	toGeneration: 2;
	oldCatalogSha256: string;
	candidateCatalogSha256: string;
	decisions: CatalogDifferenceDecision[];
	differences: ReviewedCatalogDifference[];
};

export function markdownAuditSectionIds(source: string): Set<string> {
	const sections = new Set<string>();
	for (const match of source.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) {
		const heading = match[1]
			?.replace(/\s+#+\s*$/, "")
			.trim()
			.toLowerCase()
			.replace(/[`*_~]/g, "")
			.replace(/[^\p{L}\p{N}\s-]/gu, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-");
		if (heading) sections.add(`#${heading}`);
	}
	return sections;
}

export function auditCatalogDecisionSections(
	review: CatalogDifferenceReview,
	auditDocument: string,
): string[] {
	const sections = markdownAuditSectionIds(auditDocument);
	const failures: string[] = [];
	for (const decision of review.decisions ?? []) {
		if (!sections.has(decision.auditSection)) {
			failures.push(
				`catalog decision ${decision.id} references missing audit section ${decision.auditSection}`,
			);
		}
	}
	return failures;
}

export function compareCatalogFingerprints(
	oldChain: CatalogFingerprint,
	candidate: CatalogFingerprint,
): CatalogDifference[] {
	const differences: CatalogDifference[] = [];
	if (oldChain.source !== "old-chain") {
		differences.push({ key: "metadata:old source must be old-chain" });
	}
	if (candidate.source !== "candidate") {
		differences.push({ key: "metadata:candidate source must be candidate" });
	}
	if (oldChain.postgresMajor !== candidate.postgresMajor) {
		differences.push({
			key: "metadata:postgresMajor",
			oldDefinition: String(oldChain.postgresMajor),
			candidateDefinition: String(candidate.postgresMajor),
		});
	}

	const oldObjects = new Map(
		oldChain.objects.map((object) => [
			`${object.kind}\0${object.identity}`,
			object.definition,
		]),
	);
	const candidateObjects = new Map(
		candidate.objects.map((object) => [
			`${object.kind}\0${object.identity}`,
			object.definition,
		]),
	);
	const keys = [...new Set([...oldObjects.keys(), ...candidateObjects.keys()])]
		.sort()
		.values();
	for (const key of keys) {
		const oldDefinition = oldObjects.get(key);
		const candidateDefinition = candidateObjects.get(key);
		if (oldDefinition !== candidateDefinition) {
			const [kind, identity] = key.split("\0");
			differences.push({
				key: `${kind}:${identity}`,
				oldDefinition,
				candidateDefinition,
			});
		}
	}
	return differences;
}

function definitionSha256(value: string | undefined): string | null {
	return value === undefined ? null : sha256(value);
}

export function buildCatalogDifferenceReviewDraft(
	oldChain: CatalogFingerprint,
	candidate: CatalogFingerprint,
): CatalogDifferenceReview {
	return {
		schemaVersion: 1,
		fromGeneration: 1,
		toGeneration: 2,
		oldCatalogSha256: oldChain.catalogSha256,
		candidateCatalogSha256: candidate.catalogSha256,
		decisions: [],
		differences: compareCatalogFingerprints(oldChain, candidate).map(
			(difference) => ({
				key: difference.key,
				oldDefinitionSha256: definitionSha256(difference.oldDefinition),
				candidateDefinitionSha256: definitionSha256(
					difference.candidateDefinition,
				),
				decisionId: "unreviewed",
			}),
		),
	};
}

export function auditCatalogDifferenceReview(
	review: CatalogDifferenceReview,
	oldChain: CatalogFingerprint,
	candidate: CatalogFingerprint,
	auditDocument?: string,
): string[] {
	const failures = [
		...auditCatalogFingerprint(oldChain).map(
			(message) => `old-chain ${message}`,
		),
		...auditCatalogFingerprint(candidate).map(
			(message) => `candidate ${message}`,
		),
	];
	if (review.schemaVersion !== 1) {
		failures.push("catalog difference review schemaVersion must be 1");
	}
	if (review.fromGeneration !== 1 || review.toGeneration !== 2) {
		failures.push(
			"catalog difference review must cover exactly generation 1 to 2",
		);
	}
	if (oldChain.source !== "old-chain" || oldChain.generation !== 1) {
		failures.push("review source must be the generation-1 old-chain catalog");
	}
	if (candidate.source !== "candidate" || candidate.generation !== 2) {
		failures.push("review target must be the generation-2 candidate catalog");
	}
	if (oldChain.postgresMajor !== candidate.postgresMajor) {
		failures.push("review catalogs must use the same PostgreSQL major version");
	}
	if (review.oldCatalogSha256 !== oldChain.catalogSha256) {
		failures.push("catalog difference review old catalog checksum is stale");
	}
	if (review.candidateCatalogSha256 !== candidate.catalogSha256) {
		failures.push(
			"catalog difference review candidate catalog checksum is stale",
		);
	}

	const decisions = new Map<string, CatalogDifferenceDecision>();
	const canonicalDecisions = [...(review.decisions ?? [])].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
	if (JSON.stringify(canonicalDecisions) !== JSON.stringify(review.decisions)) {
		failures.push("catalog difference decisions are not canonically ordered");
	}
	for (const decision of review.decisions ?? []) {
		if (!/^[a-z][a-z0-9_]{2,63}$/.test(decision.id)) {
			failures.push(`invalid catalog decision id: ${decision.id}`);
		}
		if (decisions.has(decision.id)) {
			failures.push(`duplicate catalog decision id: ${decision.id}`);
		}
		if (
			decision.auditSection.trim().length === 0 ||
			decision.auditSection.length > 160
		) {
			failures.push(
				`catalog decision ${decision.id} has no bounded audit section`,
			);
		}
		if (decision.summary.trim().length === 0 || decision.summary.length > 500) {
			failures.push(`catalog decision ${decision.id} has no bounded summary`);
		}
		decisions.set(decision.id, decision);
	}

	const expected = buildCatalogDifferenceReviewDraft(
		oldChain,
		candidate,
	).differences;
	const canonicalDifferences = [...(review.differences ?? [])].sort(
		(left, right) => left.key.localeCompare(right.key),
	);
	if (
		JSON.stringify(canonicalDifferences) !== JSON.stringify(review.differences)
	) {
		failures.push("reviewed catalog differences are not canonically ordered");
	}
	if (review.differences?.length !== expected.length) {
		failures.push(
			`catalog difference review has ${review.differences?.length ?? 0} entries; expected ${expected.length}`,
		);
	}
	const reviewedByKey = new Map<string, ReviewedCatalogDifference>();
	const usedDecisionIds = new Set<string>();
	for (const difference of review.differences ?? []) {
		if (reviewedByKey.has(difference.key)) {
			failures.push(`duplicate reviewed catalog difference: ${difference.key}`);
		}
		reviewedByKey.set(difference.key, difference);
		if (!decisions.has(difference.decisionId)) {
			failures.push(
				`catalog difference ${difference.key} has no reviewed decision`,
			);
		} else {
			usedDecisionIds.add(difference.decisionId);
		}
	}
	for (const expectedDifference of expected) {
		const reviewed = reviewedByKey.get(expectedDifference.key);
		if (!reviewed) {
			failures.push(
				`catalog difference review is missing ${expectedDifference.key}`,
			);
			continue;
		}
		if (
			reviewed.oldDefinitionSha256 !== expectedDifference.oldDefinitionSha256 ||
			reviewed.candidateDefinitionSha256 !==
				expectedDifference.candidateDefinitionSha256
		) {
			failures.push(
				`catalog difference review definition checksum is stale for ${expectedDifference.key}`,
			);
		}
	}
	for (const decisionId of decisions.keys()) {
		if (!usedDecisionIds.has(decisionId)) {
			failures.push(`catalog decision ${decisionId} is unused`);
		}
	}
	if (auditDocument !== undefined) {
		failures.push(...auditCatalogDecisionSections(review, auditDocument));
	}
	return failures;
}

export function assertValidCatalogDifferenceReview(
	review: CatalogDifferenceReview,
	oldChain: CatalogFingerprint,
	candidate: CatalogFingerprint,
	auditDocument?: string,
): void {
	const failures = auditCatalogDifferenceReview(
		review,
		oldChain,
		candidate,
		auditDocument,
	);
	if (failures.length > 0) {
		throw new Error(
			`Catalog difference review is invalid:\n- ${failures.join("\n- ")}`,
		);
	}
}

export function assertValidCatalogFingerprint(
	fingerprint: CatalogFingerprint,
	label: string,
): void {
	const failures = auditCatalogFingerprint(fingerprint);
	if (failures.length > 0) {
		throw new Error(`${label} is invalid:\n- ${failures.join("\n- ")}`);
	}
}

/**
 * Generation 2 keeps the reviewed candidate catalog and the exact difference
 * review as repository evidence. This makes every transition hash re-verifiable
 * after the one-time collapse rather than trusting an untracked input path.
 */
export function auditCollapsedCatalogEvidence(input: {
	generation: BaselineGeneration;
	oldChain: CatalogFingerprint;
	candidate: CatalogFingerprint;
	review: CatalogDifferenceReview;
	reviewText: string;
	requiredPostgresMajor: number;
	auditDocument?: string;
}): string[] {
	const failures: string[] = [];
	if (
		input.generation.generation !== 2 ||
		input.generation.transition.kind !== "collapse" ||
		input.generation.transition.fromGeneration !== 1
	) {
		return [
			"candidate catalog evidence requires the authorized generation-1-to-2 collapse",
		];
	}
	const transition = input.generation.transition;
	failures.push(
		...auditCatalogDifferenceReview(
			input.review,
			input.oldChain,
			input.candidate,
			input.auditDocument,
		).map((message) => `catalog transition ${message}`),
	);
	if (
		input.candidate.source !== "candidate" ||
		input.candidate.generation !== 2
	) {
		failures.push(
			"committed candidate catalog must describe generation 2 with source=candidate",
		);
	}
	if (input.candidate.postgresMajor !== input.requiredPostgresMajor) {
		failures.push(
			`committed candidate catalog must come from PostgreSQL ${input.requiredPostgresMajor}`,
		);
	}
	if (
		input.candidate.migrationManifestSha256 !==
		transition.candidateManifestSha256
	) {
		failures.push(
			"committed candidate catalog is not bound to the collapse-boundary manifest",
		);
	}
	if (transition.oldChainCatalogSha256 !== input.oldChain.catalogSha256) {
		failures.push(
			"collapse transition is not bound to the committed old-chain catalog",
		);
	}
	if (transition.candidateCatalogSha256 !== input.candidate.catalogSha256) {
		failures.push(
			"collapse transition is not bound to the committed candidate catalog",
		);
	}
	if (transition.catalogDifferenceReviewSha256 !== sha256(input.reviewText)) {
		failures.push(
			"collapse transition is not bound to the committed catalog difference review bytes",
		);
	}
	return failures;
}

/**
 * Keep the disposable generation-1 database replay as durable evidence after
 * the numbered migration chain is replaced. Generation 1 binds the evidence to
 * the active manifest; generation 2 binds it to the attested base manifest and
 * the captured catalog checksum.
 */
export function auditPreservedOldChainCatalogEvidence(input: {
	fingerprint: CatalogFingerprint;
	generation: BaselineGeneration;
	currentManifestText: string;
	requiredPostgresMajor: number;
}): string[] {
	const failures = auditCatalogFingerprint(input.fingerprint).map(
		(message) => `old-chain evidence ${message}`,
	);
	if (input.fingerprint.source !== "old-chain") {
		failures.push("preserved catalog evidence source must be old-chain");
	}
	if (input.fingerprint.generation !== 1) {
		failures.push("preserved catalog evidence must describe generation 1");
	}
	if (input.fingerprint.postgresMajor !== input.requiredPostgresMajor) {
		failures.push(
			`preserved catalog evidence must come from PostgreSQL ${input.requiredPostgresMajor}`,
		);
	}

	if (input.generation.generation === 1) {
		if (
			input.fingerprint.migrationManifestSha256 !==
			sha256(input.currentManifestText)
		) {
			failures.push(
				"generation-1 catalog evidence is not bound to the active migration manifest",
			);
		}
		return failures;
	}

	if (
		input.generation.generation === 2 &&
		input.generation.transition.kind === "collapse" &&
		input.generation.transition.fromGeneration === 1
	) {
		if (
			input.fingerprint.migrationManifestSha256 !==
			input.generation.transition.baseManifestSha256
		) {
			failures.push(
				"generation-2 transition is not bound to the preserved generation-1 manifest",
			);
		}
		if (
			input.fingerprint.catalogSha256 !==
			input.generation.transition.oldChainCatalogSha256
		) {
			failures.push(
				"generation-2 transition is not bound to the preserved old-chain catalog",
			);
		}
		return failures;
	}

	failures.push(
		"preserved generation-1 catalog evidence supports only the initial generation and its authorized generation-2 collapse",
	);
	return failures;
}
