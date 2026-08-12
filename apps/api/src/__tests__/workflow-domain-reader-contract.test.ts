import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as dbSchema from "@relayapi/db";
import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import ts from "typescript";

const WORKFLOW_STATE_COLUMN = /(^|_)(status|state|phase|outcome)$/;
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

type WorkflowDomain = {
	tableExport: string;
	columnProperty: string;
	columnName: string;
	values: ReadonlySet<string>;
};

function workflowDomains(): Map<string, Map<string, WorkflowDomain>> {
	const domains = new Map<string, Map<string, WorkflowDomain>>();
	for (const [tableExport, value] of Object.entries(dbSchema)) {
		if (!is(value, PgTable)) continue;
		const columns = getTableColumns(value);
		for (const [columnProperty, column] of Object.entries(columns)) {
			const enumValues =
				(column as typeof column & { enumValues?: readonly string[] })
					.enumValues ?? [];
			if (
				column.dataType !== "string" ||
				!WORKFLOW_STATE_COLUMN.test(column.name) ||
				enumValues.length === 0
			) {
				continue;
			}
			const tableDomains = domains.get(tableExport) ?? new Map();
			tableDomains.set(columnProperty, {
				tableExport,
				columnProperty,
				columnName: column.name,
				values: new Set(enumValues),
			});
			domains.set(tableExport, tableDomains);
		}
	}
	return domains;
}

function importedTableAliases(
	sourceFile: ts.SourceFile,
	domains: ReadonlyMap<string, Map<string, WorkflowDomain>>,
): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const statement of sourceFile.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== "@relayapi/db"
		) {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) continue;
		for (const binding of bindings.elements) {
			const exported = binding.propertyName?.text ?? binding.name.text;
			if (domains.has(exported)) aliases.set(binding.name.text, exported);
		}
	}
	return aliases;
}

function propertyDomain(
	expression: ts.Expression,
	aliases: ReadonlyMap<string, string>,
	domains: ReadonlyMap<string, Map<string, WorkflowDomain>>,
): WorkflowDomain | undefined {
	let candidate = expression;
	while (
		ts.isParenthesizedExpression(candidate) ||
		ts.isAsExpression(candidate) ||
		ts.isTypeAssertionExpression(candidate)
	) {
		candidate = candidate.expression;
	}
	if (
		!ts.isPropertyAccessExpression(candidate) ||
		!ts.isIdentifier(candidate.expression)
	) {
		return undefined;
	}
	const tableExport = aliases.get(candidate.expression.text);
	return tableExport
		? domains.get(tableExport)?.get(candidate.name.text)
		: undefined;
}

function sqlStringLiterals(value: string): string[] {
	return [...value.matchAll(/'((?:''|[^'])*)'/g)].map((match) =>
		(match[1] ?? "").replaceAll("''", "'"),
	);
}

function literalsAfterState(fragment: string): string[] {
	const scalar = fragment.match(
		/^\s*(?:::text\s*)?(?:=|<>|!=)\s*('(?:''|[^'])*')/i,
	);
	if (scalar?.[1]) return sqlStringLiterals(scalar[1]);
	const list = fragment.match(/^\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/i);
	return list?.[1] ? sqlStringLiterals(list[1]) : [];
}

function literalsBeforeState(fragment: string): string[] {
	const scalar = fragment.match(
		/('(?:''|[^'])*')\s*(?:=|<>|!=)\s*(?:::text\s*)?$/i,
	);
	return scalar?.[1] ? sqlStringLiterals(scalar[1]) : [];
}

test("raw SQL readers use only values from their schema-derived workflow domains", () => {
	const domains = workflowDomains();
	const roots = [
		"apps/api/src",
		"apps/app/src",
		"packages/auth/src",
		"packages/db/src",
	];
	const violations: string[] = [];

	for (const root of roots) {
		const glob = new Bun.Glob("**/*.ts");
		for (const relativePath of glob.scanSync({ cwd: `${repoRoot}${root}` })) {
			if (
				relativePath.includes("__tests__/") ||
				relativePath.endsWith(".test.ts")
			) {
				continue;
			}
			const repoPath = `${root}/${relativePath}`;
			const sourceText = readFileSync(`${repoRoot}${repoPath}`, "utf8");
			const sourceFile = ts.createSourceFile(
				repoPath,
				sourceText,
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TS,
			);
			const aliases = importedTableAliases(sourceFile, domains);
			if (aliases.size === 0) continue;

			const visit = (node: ts.Node): void => {
				if (
					ts.isTaggedTemplateExpression(node) &&
					node.tag.getText(sourceFile) === "sql" &&
					ts.isTemplateExpression(node.template)
				) {
					let before = node.template.head.text;
					for (const span of node.template.templateSpans) {
						const domain = propertyDomain(span.expression, aliases, domains);
						if (domain) {
							const literals = [
								...literalsBeforeState(before),
								...literalsAfterState(span.literal.text),
							];
							for (const literal of literals) {
								if (!domain.values.has(literal)) {
									const { line } = sourceFile.getLineAndCharacterOfPosition(
										span.expression.getStart(sourceFile),
									);
									violations.push(
										`${repoPath}:${line + 1} compares ${domain.tableExport}.${domain.columnProperty} (${domain.columnName}) to ${JSON.stringify(literal)}; allowed=${JSON.stringify([...domain.values])}`,
									);
								}
							}
						}
						before = span.literal.text;
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		}
	}

	expect(domains.size).toBeGreaterThan(40);
	expect(violations).toEqual([]);
});
