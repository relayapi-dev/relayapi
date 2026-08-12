export type MigrationPhase = "baseline" | "expand" | "contract";

export type MigrationPolicyEntry = {
	phase: MigrationPhase;
	summary: string;
	affectedObjects?: string[];
	compatibleReleasePrerequisite?: string;
};

export type MigrationPolicy = {
	schemaVersion: 2;
	migrations: Record<string, MigrationPolicyEntry>;
};

export type PolicyJournal = {
	entries: Array<{ idx: number; tag: string }>;
};

const CONTRACT_ONLY_PATTERNS: ReadonlyArray<
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
export function stripSqlComments(source: string): string {
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

export function canonicalSqlIdentifier(value: string): string {
	return /^[a-z_][a-z0-9_$]*$/.test(value)
		? value
		: `"${value.replaceAll('"', '""')}"`;
}

/**
 * Normalize SQL for exact structural contracts. Comments become whitespace,
 * quoted identifiers keep their identifier value, and string/dollar literals
 * are masked so example text cannot impersonate executable DDL.
 */
export function normalizeSqlForStructuralContracts(source: string): string {
	const uncommented = stripSqlComments(source);
	let normalized = "";
	let index = 0;
	while (index < uncommented.length) {
		const character = uncommented[index];
		if (character === undefined) break;
		if (character === '"') {
			let identifier = "";
			index += 1;
			while (index < uncommented.length) {
				const quoted = uncommented[index];
				index += 1;
				if (quoted !== '"') {
					identifier += quoted;
					continue;
				}
				if (uncommented[index] === '"') {
					identifier += '"';
					index += 1;
					continue;
				}
				break;
			}
			normalized += canonicalSqlIdentifier(identifier);
			continue;
		}
		if (character === "'") {
			const preceding = uncommented[index - 1];
			const beforePrefix = uncommented[index - 2];
			const escapeBackslashes =
				(preceding === "e" || preceding === "E") &&
				!/[a-z0-9_$]/i.test(beforePrefix ?? "");
			normalized += " ";
			index += 1;
			while (index < uncommented.length) {
				const quoted = uncommented[index];
				index += 1;
				if (
					quoted === "\\" &&
					escapeBackslashes &&
					index < uncommented.length
				) {
					index += 1;
					continue;
				}
				if (quoted !== "'") continue;
				if (uncommented[index] === "'") {
					index += 1;
					continue;
				}
				break;
			}
			continue;
		}
		if (character === "$") {
			const delimiter = uncommented
				.slice(index)
				.match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i)?.[0];
			if (delimiter) {
				const end = uncommented.indexOf(delimiter, index + delimiter.length);
				normalized += " ";
				index = end === -1 ? uncommented.length : end + delimiter.length;
				continue;
			}
		}
		normalized += character.toLowerCase();
		index += 1;
	}
	return normalized.replace(/\s+/g, " ").trim();
}

type SqlLiteral = { value: string; rawValue: string; end: number };

function stringPrefixMode(
	source: string,
	start: number,
): "escape" | "unicode" | "standard" {
	const prefix = source[start - 1];
	const beforePrefix = source[start - 2];
	if (
		(prefix === "e" || prefix === "E") &&
		!/[a-z0-9_$]/i.test(beforePrefix ?? "")
	) {
		return "escape";
	}
	if (
		prefix === "&" &&
		(beforePrefix === "u" || beforePrefix === "U") &&
		!/[a-z0-9_$]/i.test(source[start - 3] ?? "")
	) {
		return "unicode";
	}
	return "standard";
}

function codePoint(value: number, fallback: string): string {
	if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
		return fallback;
	}
	return String.fromCodePoint(value);
}

function decodePostgresEscapeString(value: string): string {
	let decoded = "";
	let index = 0;
	while (index < value.length) {
		const character = value[index];
		if (character !== "\\") {
			decoded += character ?? "";
			index += 1;
			continue;
		}
		const escaped = value[index + 1];
		if (escaped === undefined) {
			decoded += "\\";
			break;
		}
		if (escaped === "\n") {
			index += 2;
			continue;
		}
		if (escaped === "\r") {
			index += value[index + 2] === "\n" ? 3 : 2;
			continue;
		}
		const simpleEscapes: Readonly<Record<string, string>> = {
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "\t",
			v: "\v",
		};
		if (simpleEscapes[escaped] !== undefined) {
			decoded += simpleEscapes[escaped];
			index += 2;
			continue;
		}
		if (/[0-7]/.test(escaped)) {
			const digits = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
			decoded += codePoint(Number.parseInt(digits, 8), `\\${digits}`);
			index += 1 + digits.length;
			continue;
		}
		if (escaped === "x" || escaped === "X") {
			const digits = value.slice(index + 2).match(/^[0-9a-f]{1,2}/i)?.[0];
			if (digits) {
				decoded += codePoint(
					Number.parseInt(digits, 16),
					`\\${escaped}${digits}`,
				);
				index += 2 + digits.length;
				continue;
			}
		}
		if (escaped === "u" || escaped === "U") {
			const length = escaped === "u" ? 4 : 8;
			const digits = value.slice(index + 2, index + 2 + length);
			if (
				digits.length === length &&
				new RegExp(`^[0-9a-f]{${length}}$`, "i").test(digits)
			) {
				const numeric = Number.parseInt(digits, 16);
				if (
					length === 4 &&
					numeric >= 0xd800 &&
					numeric <= 0xdbff &&
					value.slice(index + 2 + length, index + 4 + length) === "\\u"
				) {
					const lowDigits = value.slice(index + 4 + length, index + 8 + length);
					const low = Number.parseInt(lowDigits, 16);
					if (
						/^[0-9a-f]{4}$/i.test(lowDigits) &&
						low >= 0xdc00 &&
						low <= 0xdfff
					) {
						decoded += String.fromCodePoint(
							0x10000 + (numeric - 0xd800) * 0x400 + (low - 0xdc00),
						);
						index += 4 + length + 4;
						continue;
					}
				}
				decoded += codePoint(numeric, `\\${escaped}${digits}`);
				index += 2 + length;
				continue;
			}
		}
		decoded += escaped;
		index += 2;
	}
	return decoded;
}

function decodePostgresUnicodeString(
	value: string,
	escapeCharacter: string,
): string {
	let decoded = "";
	let index = 0;
	while (index < value.length) {
		const character = value[index];
		if (character !== escapeCharacter) {
			decoded += character ?? "";
			index += 1;
			continue;
		}
		if (value[index + 1] === escapeCharacter) {
			decoded += escapeCharacter;
			index += 2;
			continue;
		}
		const extended = value[index + 1] === "+";
		const digitsStart = index + (extended ? 2 : 1);
		const length = extended ? 6 : 4;
		const digits = value.slice(digitsStart, digitsStart + length);
		if (
			digits.length === length &&
			new RegExp(`^[0-9a-f]{${length}}$`, "i").test(digits)
		) {
			const numeric = Number.parseInt(digits, 16);
			const next = digitsStart + length;
			if (
				!extended &&
				numeric >= 0xd800 &&
				numeric <= 0xdbff &&
				value[next] === escapeCharacter
			) {
				const lowDigits = value.slice(next + 1, next + 5);
				const low = Number.parseInt(lowDigits, 16);
				if (
					/^[0-9a-f]{4}$/i.test(lowDigits) &&
					low >= 0xdc00 &&
					low <= 0xdfff
				) {
					decoded += String.fromCodePoint(
						0x10000 + (numeric - 0xd800) * 0x400 + (low - 0xdc00),
					);
					index = next + 5;
					continue;
				}
			}
			decoded += codePoint(
				numeric,
				`${escapeCharacter}${extended ? "+" : ""}${digits}`,
			);
			index = digitsStart + length;
			continue;
		}
		decoded += escapeCharacter;
		index += 1;
	}
	return decoded;
}

function readSingleQuotedLiteral(source: string, start: number): SqlLiteral {
	const mode = stringPrefixMode(source, start);
	let rawValue = "";
	let index = start + 1;
	while (index < source.length) {
		const character = source[index];
		index += 1;
		if (character === "\\" && mode === "escape" && index < source.length) {
			rawValue += `\\${source[index] ?? ""}`;
			index += 1;
			continue;
		}
		if (character !== "'") {
			rawValue += character ?? "";
			continue;
		}
		if (source[index] === "'") {
			rawValue += "'";
			index += 1;
			continue;
		}
		break;
	}
	let value =
		mode === "escape"
			? decodePostgresEscapeString(rawValue)
			: mode === "unicode"
				? decodePostgresUnicodeString(rawValue, "\\")
				: rawValue;
	if (mode === "unicode") {
		const escapeClause = source
			.slice(index)
			.match(/^\s+uescape\s+'([^0-9a-f+'"\s])'/i);
		const escapeCharacter = escapeClause?.[1];
		if (escapeCharacter) {
			value = decodePostgresUnicodeString(rawValue, escapeCharacter);
		}
	}
	return { value, rawValue, end: index };
}

function readDollarQuotedLiteral(
	source: string,
	start: number,
): SqlLiteral | undefined {
	const delimiter = source
		.slice(start)
		.match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i)?.[0];
	if (!delimiter) return undefined;
	const bodyStart = start + delimiter.length;
	const end = source.indexOf(delimiter, bodyStart);
	return {
		value: end === -1 ? source.slice(bodyStart) : source.slice(bodyStart, end),
		rawValue:
			end === -1 ? source.slice(bodyStart) : source.slice(bodyStart, end),
		end: end === -1 ? source.length : end + delimiter.length,
	};
}

function isProceduralBodyPrefix(prefix: string): boolean {
	const normalized = prefix
		.replace(/\b[eE]\s*$/, "")
		.replace(/\b[uU]&\s*$/, "")
		.trim();
	return (
		/\bdo(?:\s+language\s+[a-z_][a-z0-9_$]*)?\s*$/i.test(normalized) ||
		/\bcreate(?:\s+or\s+replace)?\s+(?:function|procedure)\b[\s\S]*\bas\s*$/i.test(
			normalized,
		)
	);
}

function findExtensionDdlInProceduralBody(body: string): string[] {
	const source = stripSqlComments(body);
	const findings: string[] = [];
	let visible = "";
	let concatenatedLiterals = "";
	let bodyVisible = "";
	let bodyLiterals = "";
	let bodyRawLiterals = "";
	let bodyEscapeDecodedLiterals = "";
	let index = 0;

	const inspectStatement = (): void => {
		for (const candidate of [visible, concatenatedLiterals]) {
			for (const match of candidate.matchAll(
				/\b(create|drop|alter)\s+extension\b/gi,
			)) {
				findings.push(
					`${match[1]?.toUpperCase() ?? "UNKNOWN"} EXTENSION in procedural body`,
				);
			}
		}
		visible = "";
		concatenatedLiterals = "";
	};

	while (index < source.length) {
		const character = source[index];
		if (character === "'") {
			const literal = readSingleQuotedLiteral(source, index);
			visible += ` ${literal.value} `;
			concatenatedLiterals += literal.value;
			bodyVisible += ` ${literal.value} `;
			bodyLiterals += literal.value;
			bodyRawLiterals += literal.rawValue;
			bodyEscapeDecodedLiterals += decodePostgresEscapeString(literal.value);
			index = literal.end;
			continue;
		}
		if (character === "$") {
			const literal = readDollarQuotedLiteral(source, index);
			if (literal) {
				visible += ` ${literal.value} `;
				concatenatedLiterals += literal.value;
				bodyVisible += ` ${literal.value} `;
				bodyLiterals += literal.value;
				bodyRawLiterals += literal.rawValue;
				bodyEscapeDecodedLiterals += decodePostgresEscapeString(literal.value);
				index = literal.end;
				continue;
			}
		}
		if (character === ";") {
			inspectStatement();
			bodyVisible += " ; ";
			index += 1;
			continue;
		}
		visible += character ?? "";
		bodyVisible += character ?? "";
		index += 1;
	}
	inspectStatement();
	for (const candidate of [
		source,
		bodyVisible,
		bodyLiterals,
		bodyRawLiterals,
		bodyEscapeDecodedLiterals,
	]) {
		if (!/\bextension\b/i.test(candidate)) continue;
		for (const operation of ["create", "drop", "alter"]) {
			if (new RegExp(`\\b${operation}\\b`, "i").test(candidate)) {
				findings.push(
					`${operation.toUpperCase()} EXTENSION in procedural body`,
				);
			}
		}
	}
	return [...new Set(findings)];
}

/**
 * Dynamic extension DDL cannot be owned by the static lifecycle parser. Scan
 * valid dollar-, standard-single-, E-string, and U&-string DO/routine bodies,
 * decoding and correlating SQL fragments across statement and variable
 * boundaries so EXECUTE-built operations also fail closed. Quoted examples
 * outside procedural context remain ignored.
 */
export function findProceduralExtensionDdl(source: string): string[] {
	const uncommented = stripSqlComments(source);
	const findings: string[] = [];
	let statementStart = 0;
	let index = 0;

	while (index < uncommented.length) {
		const character = uncommented[index];
		if (character === "'") {
			const literal = readSingleQuotedLiteral(uncommented, index);
			if (isProceduralBodyPrefix(uncommented.slice(statementStart, index))) {
				for (const body of new Set([literal.value, literal.rawValue])) {
					findings.push(...findExtensionDdlInProceduralBody(body));
				}
			}
			index = literal.end;
			continue;
		}
		if (character === '"') {
			index += 1;
			while (index < uncommented.length) {
				if (uncommented[index] !== '"') {
					index += 1;
					continue;
				}
				index += 1;
				if (uncommented[index] === '"') {
					index += 1;
					continue;
				}
				break;
			}
			continue;
		}
		if (character === "$") {
			const literal = readDollarQuotedLiteral(uncommented, index);
			if (literal) {
				if (isProceduralBodyPrefix(uncommented.slice(statementStart, index))) {
					for (const body of new Set([literal.value, literal.rawValue])) {
						findings.push(...findExtensionDdlInProceduralBody(body));
					}
				}
				index = literal.end;
				continue;
			}
		}
		if (character === ";") statementStart = index + 1;
		index += 1;
	}

	return [...new Set(findings)];
}

/**
 * Post-freeze migrations may not hide arbitrary SQL behind procedural
 * EXECUTE. Static policy, object ownership, and destructive-operation scans
 * cannot prove a value assembled with format(), chr(), reverse(), or table
 * data. Keep the immutable baseline exempt at the policy layer; every later
 * dynamic statement needs to be replaced with explicit, reviewable DDL.
 */
export function findProceduralDynamicSql(source: string): string[] {
	const uncommented = stripSqlComments(source);
	const findings: string[] = [];
	let statementStart = 0;
	let index = 0;

	const inspect = (prefixEnd: number, body: SqlLiteral): void => {
		if (!isProceduralBodyPrefix(uncommented.slice(statementStart, prefixEnd))) {
			return;
		}
		for (const candidate of new Set([body.value, body.rawValue])) {
			if (/\bexecute\b/i.test(stripSqlComments(candidate))) {
				findings.push("dynamic EXECUTE in procedural body");
			}
		}
	};

	while (index < uncommented.length) {
		const character = uncommented[index];
		if (character === "'") {
			const literal = readSingleQuotedLiteral(uncommented, index);
			inspect(index, literal);
			index = literal.end;
			continue;
		}
		if (character === '"') {
			index += 1;
			while (index < uncommented.length) {
				if (uncommented[index] !== '"') {
					index += 1;
					continue;
				}
				index += 1;
				if (uncommented[index] === '"') {
					index += 1;
					continue;
				}
				break;
			}
			continue;
		}
		if (character === "$") {
			const literal = readDollarQuotedLiteral(uncommented, index);
			if (literal) {
				inspect(index, literal);
				index = literal.end;
				continue;
			}
		}
		if (character === ";") statementStart = index + 1;
		index += 1;
	}
	return [...new Set(findings)];
}

/** Conservative review aid; live compatibility still requires release review. */
export function findDestructiveExpandOperations(source: string): string[] {
	const policySource = stripSqlComments(source);
	return CONTRACT_ONLY_PATTERNS.filter(([, pattern]) =>
		pattern.test(policySource),
	).map(([label]) => label);
}

/** Classify operations that need an explicit compatible-release boundary. */
export const findContractOnlyOperations = findDestructiveExpandOperations;

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

		const policyEntry = policy.migrations[entry.tag];
		if (phase === "contract") {
			if (
				!Array.isArray(policyEntry?.affectedObjects) ||
				policyEntry.affectedObjects.length === 0 ||
				policyEntry.affectedObjects.some(
					(object) => typeof object !== "string" || !object.trim(),
				)
			) {
				failures.push(
					`${entry.tag} is contract and must declare non-empty affectedObjects`,
				);
			}
			if (!policyEntry?.compatibleReleasePrerequisite?.trim()) {
				failures.push(
					`${entry.tag} is contract and must declare a compatibleReleasePrerequisite`,
				);
			}
		} else if (
			policyEntry &&
			(policyEntry.affectedObjects !== undefined ||
				policyEntry.compatibleReleasePrerequisite !== undefined)
		) {
			failures.push(
				`${entry.tag} is ${String(phase)} and must not declare contract-only rollout metadata`,
			);
		}
	}
	return failures;
}
