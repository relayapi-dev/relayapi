export type MigrationPhase = "baseline" | "expand" | "contract";

export type MigrationPolicy = {
	schemaVersion: 1;
	migrations: Record<
		string,
		{
			phase: MigrationPhase;
			summary: string;
		}
	>;
};

export type PolicyJournal = {
	entries: Array<{ idx: number; tag: string }>;
};

const EXPAND_DESTRUCTIVE_PATTERNS: ReadonlyArray<
	readonly [label: string, pattern: RegExp]
> = [
	["DROP TABLE", /\bDROP\s+TABLE\b/i],
	["DROP COLUMN", /\bDROP\s+COLUMN\b/i],
	["DROP TYPE", /\bDROP\s+TYPE\b/i],
	["DROP INDEX", /\bDROP\s+INDEX\b/i],
	["DROP CONSTRAINT", /\bDROP\s+CONSTRAINT\b/i],
	["DROP FUNCTION", /\bDROP\s+FUNCTION\b/i],
	["DROP PROCEDURE", /\bDROP\s+PROCEDURE\b/i],
	["DROP VIEW", /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/i],
	["DROP SCHEMA", /\bDROP\s+SCHEMA\b/i],
	["DROP EXTENSION", /\bDROP\s+EXTENSION\b/i],
	["DROP TRIGGER", /\bDROP\s+TRIGGER\b/i],
	["TRUNCATE", /\bTRUNCATE\b/i],
	["DELETE", /\bDELETE\s+FROM\b/i],
	["column rename", /\bRENAME\s+COLUMN\b/i],
	["table rename", /\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+TO\b/i],
	["type rename", /\bALTER\s+TYPE\b[\s\S]*?\bRENAME\s+TO\b/i],
	["enum value rename", /\bALTER\s+TYPE\b[\s\S]*?\bRENAME\s+VALUE\b/i],
	["SET NOT NULL", /\bALTER\s+COLUMN\b[\s\S]*?\bSET\s+NOT\s+NULL\b/i],
	["column type rewrite", /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i],
];

/**
 * PostgreSQL treats comments as whitespace, including between keywords. Scan
 * comments outside quoted literals/identifiers, and recurse into dollar-quoted
 * procedural bodies, so comments inserted between `DROP` and `TABLE` cannot
 * evade the expand-policy guard. Scanning dollar bodies is intentionally
 * conservative when they are used as ordinary string values.
 */
function stripSqlComments(source: string): string {
	let normalized = "";
	let index = 0;

	while (index < source.length) {
		const character = source[index];
		const next = source[index + 1];

		if (character === "'" || character === '"') {
			const quote = character;
			const preceding = source[index - 1];
			const beforePrefix = source[index - 2];
			const escapeBackslashes =
				(quote === "'" &&
					(preceding === "e" || preceding === "E") &&
					!/[a-z0-9_$]/i.test(beforePrefix ?? "")) ||
				(preceding === "&" && (beforePrefix === "u" || beforePrefix === "U"));
			normalized += character;
			index += 1;
			while (index < source.length) {
				const quoted = source[index];
				normalized += quoted;
				index += 1;
				if (quoted === "\\" && escapeBackslashes && index < source.length) {
					normalized += source[index];
					index += 1;
					continue;
				}
				if (quoted !== quote) continue;
				if (source[index] === quote) {
					normalized += source[index];
					index += 1;
					continue;
				}
				break;
			}
			continue;
		}

		if (character === "$") {
			const delimiter = source
				.slice(index)
				.match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i)?.[0];
			if (delimiter) {
				const end = source.indexOf(delimiter, index + delimiter.length);
				if (end === -1) {
					normalized += source.slice(index);
					break;
				}
				const bodyStart = index + delimiter.length;
				normalized += `${delimiter}${stripSqlComments(source.slice(bodyStart, end))}${delimiter}`;
				index = end + delimiter.length;
				continue;
			}
		}

		if (character === "-" && next === "-") {
			normalized += " ";
			index += 2;
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}

		if (character === "/" && next === "*") {
			normalized += " ";
			index += 2;
			let depth = 1;
			while (index < source.length && depth > 0) {
				if (source[index] === "/" && source[index + 1] === "*") {
					depth += 1;
					index += 2;
					continue;
				}
				if (source[index] === "*" && source[index + 1] === "/") {
					depth -= 1;
					index += 2;
					continue;
				}
				index += 1;
			}
			continue;
		}

		normalized += character;
		index += 1;
	}

	return normalized;
}

/** Conservative review aid; live compatibility still requires release review. */
export function findDestructiveExpandOperations(source: string): string[] {
	const policySource = stripSqlComments(source);
	return EXPAND_DESTRUCTIVE_PATTERNS.filter(([, pattern]) =>
		pattern.test(policySource),
	).map(([label]) => label);
}

/** Only the immutable first migration may bypass expand/contract SQL rules. */
export function auditBaselinePolicyBoundary(
	journal: PolicyJournal,
	policy: MigrationPolicy,
): string[] {
	const failures: string[] = [];
	const validPhases = new Set<unknown>(["baseline", "expand", "contract"]);
	const first = journal.entries[0];
	if (first?.idx !== 0 || first.tag !== "0000_baseline") {
		failures.push("migration history must start with idx 0 tag 0000_baseline");
	}

	const baselineTags = journal.entries
		.filter(({ tag }) => policy.migrations[tag]?.phase === "baseline")
		.map(({ tag }) => tag);
	if (baselineTags.length !== 1 || baselineTags[0] !== "0000_baseline") {
		failures.push("exactly 0000_baseline may use the baseline migration phase");
	}

	for (const [index, entry] of journal.entries.entries()) {
		const phase = policy.migrations[entry.tag]?.phase as unknown;
		if (phase !== undefined && !validPhases.has(phase)) {
			failures.push(
				`${entry.tag} has invalid migration phase ${JSON.stringify(phase)}`,
			);
		}
		if (index > 0 && phase === "baseline") {
			failures.push(
				`${entry.tag} is appended history and must be expand or contract, not baseline`,
			);
		}
		if (
			index > 0 &&
			phase !== undefined &&
			phase !== "expand" &&
			phase !== "contract"
		) {
			failures.push(
				`${entry.tag} is appended history and must use the expand or contract phase`,
			);
		}
	}
	return failures;
}
