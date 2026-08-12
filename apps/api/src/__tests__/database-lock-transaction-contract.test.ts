import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const sourceRoot = new URL("../", import.meta.url).pathname;

interface RawForUpdateLock {
	file: string;
	line: number;
	atomicMutation: boolean;
	insideTransaction: boolean;
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "__tests__") return [];
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

function literalSql(template: ts.TemplateLiteral): string {
	if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
	return (
		template.head.text +
		template.templateSpans.map((span) => span.literal.text).join("")
	);
}

function isTransactionCallback(
	node: ts.ArrowFunction | ts.FunctionExpression,
): boolean {
	const call = node.parent;
	return (
		ts.isCallExpression(call) &&
		call.arguments.includes(node) &&
		ts.isPropertyAccessExpression(call.expression) &&
		call.expression.name.text === "transaction"
	);
}

function isInsideTransaction(node: ts.Node): boolean {
	for (let ancestor: ts.Node | undefined = node.parent; ancestor; ) {
		if (
			(ts.isArrowFunction(ancestor) || ts.isFunctionExpression(ancestor)) &&
			isTransactionCallback(ancestor)
		) {
			return true;
		}
		ancestor = ancestor.parent;
	}
	return false;
}

function isInsideTransactionOnlyHelper(node: ts.Node): boolean {
	for (let ancestor: ts.Node | undefined = node.parent; ancestor; ) {
		if (ts.isFunctionDeclaration(ancestor)) {
			return ancestor.parameters.some((parameter) => {
				if (!ts.isIdentifier(parameter.name) || !parameter.type) return false;
				const transactionType = parameter.type.getText();
				if (!transactionType.includes('Database["transaction"]')) return false;

				for (let callAncestor: ts.Node | undefined = node.parent; callAncestor; ) {
					if (
						ts.isCallExpression(callAncestor) &&
						ts.isPropertyAccessExpression(callAncestor.expression) &&
						callAncestor.expression.name.text === "execute" &&
						callAncestor.expression.expression.getText() ===
							parameter.name.text
					) {
						return true;
					}
					if (callAncestor === ancestor) break;
					callAncestor = callAncestor.parent;
				}
				return false;
			});
		}
		ancestor = ancestor.parent;
	}
	return false;
}

function rawForUpdateLocks(): RawForUpdateLock[] {
	const locks: RawForUpdateLock[] = [];
	for (const absolutePath of sourceFiles(sourceRoot)) {
		const sourceText = readFileSync(absolutePath, "utf8");
		const sourceFile = ts.createSourceFile(
			absolutePath,
			sourceText,
			ts.ScriptTarget.Latest,
			true,
			absolutePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		const visit = (node: ts.Node): void => {
			if (
				ts.isTaggedTemplateExpression(node) &&
				node.tag.getText(sourceFile) === "sql"
			) {
				const sqlText = literalSql(node.template).toUpperCase();
				if (/\bFOR\s+UPDATE\b/.test(sqlText)) {
					const withoutLockClause = sqlText.replace(/\bFOR\s+UPDATE\b/g, "");
					locks.push({
						file: relative(sourceRoot, absolutePath),
						line:
							sourceFile.getLineAndCharacterOfPosition(
								node.getStart(sourceFile),
							).line + 1,
						// UPDATE/DELETE CTEs acquire their locks and mutate in one
						// statement. A SELECT-only lock requires an explicit transaction
						// callback or a helper whose executor type can only be the
						// transaction client.
						atomicMutation: /\b(?:UPDATE|DELETE)\b/.test(withoutLockClause),
						insideTransaction:
							isInsideTransaction(node) ||
							isInsideTransactionOnlyHelper(node),
					});
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}
	return locks;
}

describe("raw PostgreSQL row-lock transaction contract", () => {
	test("keeps every SELECT-only FOR UPDATE lock inside a transaction callback", () => {
		const locks = rawForUpdateLocks();
		expect(locks.length).toBeGreaterThan(0);
		expect(
			locks
				.filter((lock) => !lock.atomicMutation && !lock.insideTransaction)
				.map(({ file, line }) => `${file}:${line}`),
		).toEqual([]);
	});

	test("pins the intentionally non-atomic lock inventory", () => {
		expect(
			rawForUpdateLocks()
				.filter((lock) => !lock.atomicMutation)
				.map(({ file }) => file)
				.sort(),
		).toEqual([
			"services/inbox-effect-reconciler.ts",
			"services/inbox-maintenance.ts",
			"services/timed-domain-retention.ts",
			"services/webhook-delivery.ts",
			"services/webhook-retention.ts",
		]);
	});
});
