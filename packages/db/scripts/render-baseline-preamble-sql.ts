import {
	DATABASE_EXTENSION_INSTALLABILITY_PROBES,
	type DatabaseExtensionInstallabilityProbe,
	type DatabaseExtensionVersionEpoch,
	REQUIRED_DATABASE_EXTENSION_SCHEMAS,
	REQUIRED_DATABASE_EXTENSION_VERSIONS,
	REQUIRED_DATABASE_EXTENSIONS,
} from "../src/database-prerequisites.js";
import {
	DATABASE_EXTENSION_LIFECYCLE_EVENTS,
	type DatabaseExtensionLifecycleEvent,
} from "./database-extension-lifecycle.js";
import {
	findProceduralExtensionDdl,
	stripSqlComments,
} from "./migration-policy-contract.js";

export const BASELINE_PREAMBLE_MARKER =
	"-- RelayAPI required database preamble (generated).";

/**
 * This is the immutable sealed-baseline preamble contract.
 * Ordinary post-freeze requirements belong in REQUIRED_BASELINE_* and an
 * append-only migration; they must never rewrite or invalidate frozen 0000.
 */
export const COLLAPSE_BASELINE_SCHEMAS = ["auth"] as const;
export const COLLAPSE_BASELINE_EXTENSIONS = [
	"btree_gist",
	"pg_trgm",
	"vector",
] as const;
export const COLLAPSE_BASELINE_EXTENSION_SCHEMAS = {
	btree_gist: "public",
	pg_trgm: "public",
	vector: "public",
} as const satisfies Record<
	(typeof COLLAPSE_BASELINE_EXTENSIONS)[number],
	string
>;

/**
 * Current live database requirements. These may grow after the freeze when the
 * corresponding schema/extension is introduced by an append-only migration.
 */
export const REQUIRED_BASELINE_SCHEMAS = ["auth"] as const;
export const REQUIRED_BASELINE_EXTENSIONS = REQUIRED_DATABASE_EXTENSIONS;
export const REQUIRED_BASELINE_EXTENSION_SCHEMAS =
	REQUIRED_DATABASE_EXTENSION_SCHEMAS;

const statementBreak = "--> statement-breakpoint";

export function auditDatabasePrerequisiteRegistries(
	input: {
		activeSchemas?: readonly string[];
		activeExtensions?: readonly string[];
		activeExtensionSchemas?: Readonly<Record<string, string>>;
		activeExtensionVersions?: Readonly<Record<string, string | undefined>>;
	} = {},
): string[] {
	const activeSchemas = input.activeSchemas ?? REQUIRED_BASELINE_SCHEMAS;
	const activeExtensions =
		input.activeExtensions ?? REQUIRED_BASELINE_EXTENSIONS;
	const activeExtensionSchemas: Readonly<Record<string, string>> =
		input.activeExtensionSchemas ?? REQUIRED_BASELINE_EXTENSION_SCHEMAS;
	const activeExtensionVersions: Readonly<Record<string, string | undefined>> =
		input.activeExtensionVersions ?? REQUIRED_DATABASE_EXTENSION_VERSIONS;
	const failures: string[] = [];
	if (new Set(activeSchemas).size !== activeSchemas.length) {
		failures.push("active database schema registry contains duplicate names");
	}
	if (new Set(activeExtensions).size !== activeExtensions.length) {
		failures.push(
			"active database extension registry contains duplicate names",
		);
	}
	for (const extension of activeExtensions) {
		if (!activeExtensionSchemas[extension]) {
			failures.push(
				`active database extension ${extension} has no required schema`,
			);
		}
		if (!Object.hasOwn(activeExtensionVersions, extension)) {
			failures.push(
				`active database extension ${extension} has no expected version entry`,
			);
		} else {
			const version = activeExtensionVersions[extension];
			if (version !== undefined && !version.trim()) {
				failures.push(
					`active database extension ${extension} has an empty expected version`,
				);
			}
		}
	}
	for (const extension of Object.keys(activeExtensionSchemas)) {
		if (!activeExtensions.includes(extension)) {
			failures.push(
				`database extension schema registry contains inactive extension ${extension}`,
			);
		}
	}
	for (const extension of Object.keys(activeExtensionVersions)) {
		if (!activeExtensions.includes(extension)) {
			failures.push(
				`database extension version registry contains inactive extension ${extension}`,
			);
		}
	}
	return failures;
}

type SqlToken = {
	kind: "word" | "identifier" | "string" | "literal" | "symbol";
	value: string;
	index: number;
};

function tokenizeStaticSql(source: string): SqlToken[] {
	const sql = stripSqlComments(source);
	const tokens: SqlToken[] = [];
	let index = 0;
	while (index < sql.length) {
		const character = sql[index];
		if (character === undefined) break;
		if (/\s/.test(character)) {
			index += 1;
			continue;
		}
		if (character === "'") {
			const start = index;
			let value = "";
			const prefix = sql[index - 1];
			const beforePrefix = sql[index - 2];
			const escapeBackslashes =
				(prefix === "e" || prefix === "E") &&
				!/[a-z0-9_$]/i.test(beforePrefix ?? "");
			index += 1;
			while (index < sql.length) {
				const quoted = sql[index];
				index += 1;
				if (quoted === "\\" && escapeBackslashes && index < sql.length) {
					value += sql[index] ?? "";
					index += 1;
					continue;
				}
				if (quoted !== "'") {
					value += quoted ?? "";
					continue;
				}
				if (sql[index] === "'") {
					value += "'";
					index += 1;
					continue;
				}
				break;
			}
			tokens.push({ kind: "string", value, index: start });
			continue;
		}
		if (character === '"') {
			const start = index;
			let value = "";
			index += 1;
			while (index < sql.length) {
				const quoted = sql[index];
				index += 1;
				if (quoted !== '"') {
					value += quoted ?? "";
					continue;
				}
				if (sql[index] === '"') {
					value += '"';
					index += 1;
					continue;
				}
				break;
			}
			tokens.push({ kind: "identifier", value, index: start });
			continue;
		}
		if (character === "$") {
			const delimiter = sql
				.slice(index)
				.match(/^\$[a-z_][a-z0-9_]*\$|^\$\$/i)?.[0];
			if (delimiter) {
				const start = index;
				const end = sql.indexOf(delimiter, index + delimiter.length);
				index = end === -1 ? sql.length : end + delimiter.length;
				tokens.push({ kind: "literal", value: "", index: start });
				continue;
			}
		}
		const word = sql.slice(index).match(/^[a-z_][a-z0-9_$]*/i)?.[0];
		if (word) {
			tokens.push({ kind: "word", value: word.toLowerCase(), index });
			index += word.length;
			continue;
		}
		tokens.push({ kind: "symbol", value: character, index });
		index += 1;
	}
	return tokens;
}

function isWord(token: SqlToken | undefined, value: string): boolean {
	return token?.kind === "word" && token.value === value;
}

function identifierValue(token: SqlToken | undefined): string | undefined {
	return token?.kind === "word" || token?.kind === "identifier"
		? token.value
		: undefined;
}

function extensionVersionValue(
	tokens: readonly SqlToken[],
	index: number,
): string | undefined {
	const token = tokens[index];
	if (token?.kind === "string") return token.value;
	if (
		token !== undefined &&
		isWord(token, "e") &&
		tokens[index + 1]?.kind === "string" &&
		tokens[index + 1]?.index === token.index + 1
	) {
		return tokens[index + 1]?.value;
	}
	return identifierValue(token);
}

function statementEnd(tokens: readonly SqlToken[], start: number): number {
	const end = tokens.findIndex(
		(token, index) =>
			index >= start && token.kind === "symbol" && token.value === ";",
	);
	return end === -1 ? tokens.length : end;
}

type ParsedExtensionEvents = {
	events: DatabaseExtensionLifecycleEvent[];
	failures: string[];
};

function parseStaticExtensionEvents(
	migration: string,
	source: string,
): ParsedExtensionEvents {
	const tokens = tokenizeStaticSql(source);
	const events: DatabaseExtensionLifecycleEvent[] = [];
	const failures: string[] = [];
	for (let index = 0; index < tokens.length - 1; index += 1) {
		const operation = tokens[index];
		if (
			operation?.kind !== "word" ||
			!["create", "drop", "alter"].includes(operation.value) ||
			!isWord(tokens[index + 1], "extension")
		) {
			continue;
		}
		const end = statementEnd(tokens, index + 2);
		let cursor = index + 2;
		if (operation.value === "create") {
			let ifNotExists = false;
			if (
				isWord(tokens[cursor], "if") &&
				isWord(tokens[cursor + 1], "not") &&
				isWord(tokens[cursor + 2], "exists")
			) {
				ifNotExists = true;
				cursor += 3;
			}
			const extension = identifierValue(tokens[cursor]);
			if (!extension) {
				failures.push(
					`migration ${migration} contains an unparseable CREATE EXTENSION statement`,
				);
				continue;
			}
			let schema: string | undefined;
			let version: string | undefined;
			let versionSpecified = false;
			let cascade = false;
			for (let option = cursor + 1; option < end; option += 1) {
				if (isWord(tokens[option], "schema")) {
					schema = identifierValue(tokens[option + 1]);
				}
				if (isWord(tokens[option], "version")) {
					versionSpecified = true;
					version = extensionVersionValue(tokens, option + 1);
				}
				if (isWord(tokens[option], "cascade")) cascade = true;
			}
			if (!ifNotExists) {
				failures.push(
					`migration ${migration} CREATE EXTENSION ${extension} must use IF NOT EXISTS`,
				);
			}
			if (!schema) {
				failures.push(
					`migration ${migration} CREATE EXTENSION ${extension} must declare SCHEMA`,
				);
				continue;
			}
			if (versionSpecified && !version) {
				failures.push(
					`migration ${migration} contains an unparseable CREATE EXTENSION ${extension} VERSION clause`,
				);
				continue;
			}
			if (cascade) {
				failures.push(
					`migration ${migration} CREATE EXTENSION ${extension} uses unmodelled CASCADE dependency installation`,
				);
			}
			events.push({
				operation: "create",
				extension,
				migration,
				schema,
				...(version === undefined ? {} : { version }),
			});
			continue;
		}

		if (operation.value === "drop") {
			if (tokens.slice(cursor, end).some((token) => isWord(token, "cascade"))) {
				failures.push(
					`migration ${migration} DROP EXTENSION uses unmodelled CASCADE destruction`,
				);
			}
			if (
				isWord(tokens[cursor], "if") &&
				isWord(tokens[cursor + 1], "exists")
			) {
				cursor += 2;
			}
			let parsedAny = false;
			while (cursor < end) {
				if (
					isWord(tokens[cursor], "cascade") ||
					isWord(tokens[cursor], "restrict")
				) {
					break;
				}
				const extension = identifierValue(tokens[cursor]);
				if (!extension) {
					failures.push(
						`migration ${migration} contains an unparseable DROP EXTENSION statement`,
					);
					break;
				}
				parsedAny = true;
				events.push({ operation: "drop", extension, migration });
				cursor += 1;
				if (
					tokens[cursor]?.kind === "symbol" &&
					tokens[cursor]?.value === ","
				) {
					cursor += 1;
					continue;
				}
				break;
			}
			if (!parsedAny) {
				failures.push(
					`migration ${migration} contains an unparseable DROP EXTENSION statement`,
				);
			}
			continue;
		}

		const extension = identifierValue(tokens[cursor]);
		if (!extension) {
			failures.push(
				`migration ${migration} contains an unparseable ALTER EXTENSION statement`,
			);
			continue;
		}
		cursor += 1;
		if (isWord(tokens[cursor], "set") && isWord(tokens[cursor + 1], "schema")) {
			const schema = identifierValue(tokens[cursor + 2]);
			if (!schema) {
				failures.push(
					`migration ${migration} contains an unparseable ALTER EXTENSION ${extension} SET SCHEMA statement`,
				);
				continue;
			}
			events.push({
				operation: "set_schema",
				extension,
				migration,
				schema,
			});
			continue;
		}
		if (isWord(tokens[cursor], "update")) {
			if (!isWord(tokens[cursor + 1], "to")) {
				failures.push(
					`migration ${migration} ALTER EXTENSION ${extension} UPDATE must pin an exact version with TO`,
				);
				continue;
			}
			const version = extensionVersionValue(tokens, cursor + 2);
			if (!version) {
				failures.push(
					`migration ${migration} contains an unparseable ALTER EXTENSION ${extension} UPDATE TO statement`,
				);
				continue;
			}
			events.push({
				operation: "update",
				extension,
				migration,
				version,
			});
			continue;
		}
		failures.push(
			`migration ${migration} contains unsupported ALTER EXTENSION ${extension} DDL; register only SET SCHEMA or UPDATE lifecycle operations`,
		);
	}
	return { events, failures };
}

function sameLifecycleEvent(
	left: DatabaseExtensionLifecycleEvent | undefined,
	right: DatabaseExtensionLifecycleEvent | undefined,
): boolean {
	const schema = (
		event: DatabaseExtensionLifecycleEvent | undefined,
	): string | undefined =>
		event?.operation === "create" || event?.operation === "set_schema"
			? event.schema
			: undefined;
	const version = (
		event: DatabaseExtensionLifecycleEvent | undefined,
	): string | undefined =>
		event?.operation === "create" || event?.operation === "update"
			? event.version
			: undefined;
	return (
		left?.operation === right?.operation &&
		left?.extension === right?.extension &&
		left?.migration === right?.migration &&
		schema(left) === schema(right) &&
		version(left) === version(right)
	);
}

function describeLifecycleEvent(
	event: DatabaseExtensionLifecycleEvent | undefined,
): string {
	if (!event) return "<missing>";
	const qualifiers = [
		"schema" in event ? `schema=${event.schema}` : undefined,
		"version" in event && event.version !== undefined
			? `version=${event.version}`
			: undefined,
	].filter(Boolean);
	return `${event.migration}:${event.operation}:${event.extension}${qualifiers.length ? ` (${qualifiers.join(", ")})` : ""}`;
}

function lifecycleVersionEpochs(
	events: readonly DatabaseExtensionLifecycleEvent[],
): DatabaseExtensionVersionEpoch[] {
	const epochs: Array<{
		schema: string;
		createVersion?: string;
		updateTargets: string[];
		dropAfter: boolean;
	}> = [];
	let currentEpoch:
		| {
				schema: string;
				createVersion?: string;
				updateTargets: string[];
				dropAfter: boolean;
		  }
		| undefined;
	for (const event of events) {
		switch (event.operation) {
			case "create": {
				currentEpoch = {
					schema: event.schema,
					...(event.version === undefined
						? {}
						: { createVersion: event.version }),
					updateTargets: [],
					dropAfter: false,
				};
				epochs.push(currentEpoch);
				break;
			}
			case "update": {
				currentEpoch?.updateTargets.push(event.version);
				break;
			}
			case "drop": {
				if (currentEpoch) currentEpoch.dropAfter = true;
				currentEpoch = undefined;
				break;
			}
			case "set_schema":
				break;
		}
	}
	return epochs;
}

function describeVersionEpochs(
	epochs: readonly DatabaseExtensionVersionEpoch[],
): string {
	return `[${epochs
		.map(
			(epoch) =>
				`schema=${epoch.schema};create=${epoch.createVersion ?? "<provider-default>"};updates=${epoch.updateTargets.join("->") || "<none>"};drop=${epoch.dropAfter}`,
		)
		.join(" | ")}]`;
}

export function auditDatabaseExtensionLifecycle(
	migrationsByTag: Readonly<Record<string, string>>,
	input: {
		migrationOrder?: readonly string[];
		activeSchemas?: readonly string[];
		activeExtensions?: readonly string[];
		activeExtensionSchemas?: Readonly<Record<string, string>>;
		activeExtensionVersions?: Readonly<Record<string, string | undefined>>;
		installabilityProbes?: Readonly<
			Record<string, DatabaseExtensionInstallabilityProbe>
		>;
		lifecycleEvents?: readonly DatabaseExtensionLifecycleEvent[];
	} = {},
): string[] {
	const migrationOrder = input.migrationOrder ?? Object.keys(migrationsByTag);
	const activeSchemas = input.activeSchemas ?? REQUIRED_BASELINE_SCHEMAS;
	const activeExtensions =
		input.activeExtensions ?? REQUIRED_BASELINE_EXTENSIONS;
	const activeExtensionSchemas: Readonly<Record<string, string>> =
		input.activeExtensionSchemas ?? REQUIRED_BASELINE_EXTENSION_SCHEMAS;
	const activeExtensionVersions: Readonly<Record<string, string | undefined>> =
		input.activeExtensionVersions ?? REQUIRED_DATABASE_EXTENSION_VERSIONS;
	const installabilityProbes: Readonly<
		Record<string, DatabaseExtensionInstallabilityProbe>
	> = input.installabilityProbes ?? DATABASE_EXTENSION_INSTALLABILITY_PROBES;
	const lifecycleEvents: readonly DatabaseExtensionLifecycleEvent[] =
		input.lifecycleEvents ?? DATABASE_EXTENSION_LIFECYCLE_EVENTS;
	const failures: string[] = [];
	failures.push(
		...auditDatabasePrerequisiteRegistries({
			activeSchemas,
			activeExtensions,
			activeExtensionSchemas,
			activeExtensionVersions,
		}),
	);
	const createdExtensions = new Set(
		lifecycleEvents
			.filter((event) => event.operation === "create")
			.map((event) => event.extension),
	);
	for (const extension of createdExtensions) {
		const probe = installabilityProbes[extension];
		const extensionEvents = lifecycleEvents.filter(
			(event) => event.extension === extension,
		);
		const lifecycleEpochs = lifecycleVersionEpochs(extensionEvents);
		const probeEpochs = probe?.versionEpochs ?? [];
		const invalidProbeEpoch = probeEpochs.some(
			(epoch) =>
				!epoch.schema.trim() ||
				(epoch.createVersion !== undefined && !epoch.createVersion.trim()) ||
				epoch.updateTargets.some((target) => !target.trim()),
		);
		const epochsMatch =
			!invalidProbeEpoch &&
			probeEpochs.length === lifecycleEpochs.length &&
			probeEpochs.every((probeEpoch, epochIndex) => {
				const lifecycleEpoch = lifecycleEpochs[epochIndex];
				return (
					lifecycleEpoch !== undefined &&
					probeEpoch.schema === lifecycleEpoch.schema &&
					probeEpoch.createVersion === lifecycleEpoch.createVersion &&
					probeEpoch.dropAfter === lifecycleEpoch.dropAfter &&
					probeEpoch.updateTargets.length ===
						lifecycleEpoch.updateTargets.length &&
					probeEpoch.updateTargets.every(
						(target, targetIndex) =>
							target === lifecycleEpoch.updateTargets[targetIndex],
					)
				);
			});
		if (!epochsMatch) {
			failures.push(
				`database extension ${extension} installability epochs ${describeVersionEpochs(probeEpochs)} do not exactly match lifecycle epochs ${describeVersionEpochs(lifecycleEpochs)}`,
			);
		}
	}
	for (const extension of Object.keys(installabilityProbes)) {
		if (!createdExtensions.has(extension)) {
			failures.push(
				`database extension installability registry contains never-created extension ${extension}`,
			);
		}
	}
	if (new Set(migrationOrder).size !== migrationOrder.length) {
		failures.push(
			"database extension lifecycle migration order contains duplicates",
		);
	}
	for (const migration of Object.keys(migrationsByTag)) {
		if (!migrationOrder.includes(migration)) {
			failures.push(
				`database extension lifecycle SQL contains migration ${migration} outside journal order`,
			);
		}
	}
	for (const schema of activeSchemas) {
		const hasCreation = migrationOrder.some((migration) => {
			const tokens = tokenizeStaticSql(migrationsByTag[migration] ?? "");
			return tokens.some(
				(token, index) =>
					isWord(token, "create") &&
					isWord(tokens[index + 1], "schema") &&
					isWord(tokens[index + 2], "if") &&
					isWord(tokens[index + 3], "not") &&
					isWord(tokens[index + 4], "exists") &&
					identifierValue(tokens[index + 5]) === schema,
			);
		});
		if (!hasCreation) {
			failures.push(
				`active database schema ${schema} has no owning migration DDL`,
			);
		}
	}

	const actualEvents: DatabaseExtensionLifecycleEvent[] = [];
	for (const migration of migrationOrder) {
		const source = migrationsByTag[migration];
		if (source === undefined) {
			failures.push(
				`database extension lifecycle journal migration ${migration} has no SQL`,
			);
			continue;
		}
		for (const finding of findProceduralExtensionDdl(source)) {
			failures.push(
				`migration ${migration} contains dynamic ${finding}; extension lifecycle DDL must be static`,
			);
		}
		const parsed = parseStaticExtensionEvents(migration, source);
		actualEvents.push(...parsed.events);
		failures.push(...parsed.failures);
	}

	const eventCount = Math.max(actualEvents.length, lifecycleEvents.length);
	for (let index = 0; index < eventCount; index += 1) {
		const actual = actualEvents[index];
		const registered = lifecycleEvents[index];
		if (!sameLifecycleEvent(actual, registered)) {
			failures.push(
				`database extension lifecycle event ${index + 1} differs: registered ${describeLifecycleEvent(registered)}, SQL ${describeLifecycleEvent(actual)}`,
			);
		}
	}

	const migrationIndexes = new Map(
		migrationOrder.map((migration, index) => [migration, index]),
	);
	let previousMigrationIndex = -1;
	const activeState = new Map<
		string,
		{ schema: string; version: string | undefined }
	>();
	for (const event of lifecycleEvents) {
		const migrationIndex = migrationIndexes.get(event.migration);
		if (migrationIndex === undefined) {
			failures.push(
				`database extension lifecycle event ${describeLifecycleEvent(event)} references a migration outside journal order`,
			);
		} else {
			if (migrationIndex < previousMigrationIndex) {
				failures.push(
					`database extension lifecycle event ${describeLifecycleEvent(event)} is out of migration order`,
				);
			}
			previousMigrationIndex = migrationIndex;
		}
		if (event.operation === "create") {
			if (event.version === undefined && event.migration !== "0000_baseline") {
				failures.push(
					`database extension lifecycle CREATE ${event.extension} outside 0000_baseline must pin an exact version`,
				);
			}
			if (activeState.has(event.extension)) {
				failures.push(
					`database extension lifecycle creates already-active extension ${event.extension}`,
				);
			} else {
				activeState.set(event.extension, {
					schema: event.schema,
					version: event.version,
				});
			}
			continue;
		}
		if (event.operation === "drop") {
			if (!activeState.delete(event.extension)) {
				failures.push(
					`database extension lifecycle drops inactive extension ${event.extension}`,
				);
			}
			continue;
		}
		const current = activeState.get(event.extension);
		if (!current) {
			failures.push(
				`database extension lifecycle ${event.operation} targets inactive extension ${event.extension}`,
			);
			continue;
		}
		if (event.operation === "set_schema") {
			activeState.set(event.extension, {
				schema: event.schema,
				version: current.version,
			});
		} else {
			activeState.set(event.extension, {
				schema: current.schema,
				version: event.version,
			});
		}
	}

	for (const [extension, state] of activeState) {
		if (!activeExtensions.includes(extension)) {
			failures.push(
				`database extension lifecycle leaves unregistered active extension ${extension}`,
			);
		} else if (activeExtensionSchemas[extension] !== state.schema) {
			failures.push(
				`database extension lifecycle leaves ${extension} in schema ${state.schema} instead of active schema ${activeExtensionSchemas[extension]}`,
			);
		} else if (activeExtensionVersions[extension] !== state.version) {
			failures.push(
				`database extension lifecycle leaves ${extension} at version ${state.version ?? "<provider-default>"} instead of active version ${activeExtensionVersions[extension] ?? "<provider-default>"}`,
			);
		}
	}
	for (const extension of activeExtensions) {
		if (!activeState.has(extension)) {
			failures.push(
				`active database extension ${extension} is absent after lifecycle replay`,
			);
		}
	}
	return failures;
}

function identifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function renderBaselinePreambleSql(): string {
	const statements = [
		...COLLAPSE_BASELINE_SCHEMAS.map(
			(schema) => `CREATE SCHEMA IF NOT EXISTS ${identifier(schema)};`,
		),
		"REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
		"GRANT USAGE ON SCHEMA public TO PUBLIC;",
		...COLLAPSE_BASELINE_EXTENSIONS.map(
			(extension) =>
				`CREATE EXTENSION IF NOT EXISTS ${identifier(extension)} WITH SCHEMA ${identifier(COLLAPSE_BASELINE_EXTENSION_SCHEMAS[extension])};`,
		),
	];
	return `${[
		BASELINE_PREAMBLE_MARKER,
		...statements.flatMap((statement) => [statement, statementBreak]),
		"DO $relay_verify_extension_schema$",
		"BEGIN",
		...COLLAPSE_BASELINE_EXTENSIONS.flatMap((extension) => [
			"\tIF NOT EXISTS (",
			"\t\tSELECT 1 FROM pg_catalog.pg_extension extension_row",
			"\t\tJOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = extension_row.extnamespace",
			`\t\tWHERE extension_row.extname = '${extension.replaceAll("'", "''")}'`,
			`\t\t\tAND namespace_row.nspname = '${COLLAPSE_BASELINE_EXTENSION_SCHEMAS[extension].replaceAll("'", "''")}'`,
			"\t) THEN",
			`\t\tRAISE EXCEPTION 'required extension ${extension} must be installed in schema ${COLLAPSE_BASELINE_EXTENSION_SCHEMAS[extension]}';`,
			"\tEND IF;",
		]),
		"END;",
		"$relay_verify_extension_schema$;",
		statementBreak,
	].join("\n")}\n`;
}

if (import.meta.main) {
	process.stdout.write(renderBaselinePreambleSql());
}
