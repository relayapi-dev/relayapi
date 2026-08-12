/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import ts from "typescript";
import {
	KV_PRIVACY_KEY_PREFIX_BY_STORE_ID,
	type KvPrivacyStoreId,
} from "./kv-key-contracts";
import { EXTERNAL_PRIVACY_RETENTION_STORES } from "./privacy-retention-registry";

interface StaticStart {
	text: string;
	complete: boolean;
}

interface EvaluationContext {
	checker: ts.TypeChecker;
	substitutions: ReadonlyMap<ts.Symbol, ts.Expression>;
	seen: ReadonlySet<ts.Node>;
}

const KV_METHODS = new Set(["get", "put", "delete", "list"]);

function symbolAt(
	checker: ts.TypeChecker,
	node: ts.Node,
): ts.Symbol | undefined {
	const symbol = checker.getSymbolAtLocation(node);
	if (!symbol) return undefined;
	return symbol.flags & ts.SymbolFlags.Alias
		? checker.getAliasedSymbol(symbol)
		: symbol;
}

function combineStarts(
	left: readonly StaticStart[],
	right: readonly StaticStart[],
): StaticStart[] {
	const combined: StaticStart[] = [];
	for (const lhs of left) {
		if (!lhs.complete) {
			combined.push(lhs);
			continue;
		}
		for (const rhs of right) {
			combined.push({
				text: lhs.text + rhs.text,
				complete: rhs.complete,
			});
		}
	}
	return combined;
}

function dedupeStarts(starts: readonly StaticStart[]): StaticStart[] {
	return [
		...new Map(
			starts.map((start) => [
				`${start.complete ? "1" : "0"}:${start.text}`,
				start,
			]),
		).values(),
	];
}

function functionReturns(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
	if (!fn.body) return [];
	if (!ts.isBlock(fn.body)) return [fn.body];
	const returns: ts.Expression[] = [];
	const visit = (node: ts.Node): void => {
		if (node !== fn && ts.isFunctionLike(node)) return;
		if (ts.isReturnStatement(node) && node.expression) {
			returns.push(node.expression);
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(fn.body);
	return returns;
}

function functionDeclarationForCall(
	call: ts.CallExpression,
	checker: ts.TypeChecker,
): ts.FunctionLikeDeclaration | undefined {
	const target = ts.isPropertyAccessExpression(call.expression)
		? call.expression.name
		: call.expression;
	const symbol = symbolAt(checker, target);
	for (const declaration of symbol?.declarations ?? []) {
		if (
			ts.isFunctionDeclaration(declaration) ||
			ts.isMethodDeclaration(declaration)
		) {
			return declaration;
		}
		if (
			ts.isVariableDeclaration(declaration) &&
			declaration.initializer &&
			(ts.isArrowFunction(declaration.initializer) ||
				ts.isFunctionExpression(declaration.initializer))
		) {
			return declaration.initializer;
		}
	}
	return undefined;
}

function staticStarts(
	expression: ts.Expression,
	context: EvaluationContext,
): StaticStart[] {
	let node = expression;
	while (
		ts.isParenthesizedExpression(node) ||
		ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) ||
		ts.isSatisfiesExpression(node) ||
		ts.isNonNullExpression(node) ||
		ts.isAwaitExpression(node)
	) {
		node = node.expression;
	}
	if (context.seen.has(node)) return [];
	const seen = new Set(context.seen).add(node);
	const next = { ...context, seen };

	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
		return [{ text: node.text, complete: true }];
	}
	if (ts.isTemplateExpression(node)) {
		let starts: StaticStart[] = [{ text: node.head.text, complete: true }];
		for (const span of node.templateSpans) {
			const valueStarts = staticStarts(span.expression, next);
			starts = combineStarts(
				starts,
				valueStarts.length > 0 ? valueStarts : [{ text: "", complete: false }],
			);
			starts = starts.map((start) =>
				start.complete
					? {
							text: start.text + span.literal.text,
							complete: true,
						}
					: start,
			);
		}
		return dedupeStarts(starts);
	}
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		const left = staticStarts(node.left, next);
		const right = staticStarts(node.right, next);
		return dedupeStarts(
			combineStarts(
				left.length > 0 ? left : [{ text: "", complete: false }],
				right.length > 0 ? right : [{ text: "", complete: false }],
			),
		);
	}
	if (ts.isConditionalExpression(node)) {
		return dedupeStarts([
			...staticStarts(node.whenTrue, next),
			...staticStarts(node.whenFalse, next),
		]);
	}
	if (ts.isArrayLiteralExpression(node)) {
		return dedupeStarts(
			node.elements.flatMap((element) =>
				ts.isSpreadElement(element)
					? staticStarts(element.expression, next)
					: staticStarts(element as ts.Expression, next),
			),
		);
	}
	if (ts.isIdentifier(node)) {
		const symbol = symbolAt(context.checker, node);
		if (!symbol) return [];
		const substitution = context.substitutions.get(symbol);
		if (substitution) return staticStarts(substitution, next);
		for (const declaration of symbol.declarations ?? []) {
			if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
				return staticStarts(declaration.initializer, next);
			}
			if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
				return staticStarts(declaration.initializer, next);
			}
		}
		return [];
	}
	if (ts.isCallExpression(node)) {
		const fn = functionDeclarationForCall(node, context.checker);
		if (!fn) return [];
		const substitutions = new Map(context.substitutions);
		for (const [index, parameter] of fn.parameters.entries()) {
			if (!ts.isIdentifier(parameter.name)) continue;
			const parameterSymbol = symbolAt(context.checker, parameter.name);
			const argument = node.arguments[index];
			if (parameterSymbol && argument) {
				substitutions.set(parameterSymbol, argument);
			}
		}
		return dedupeStarts(
			functionReturns(fn).flatMap((returned) =>
				staticStarts(returned, { ...next, substitutions }),
			),
		);
	}
	return [];
}

function explicitStoreIds(
	expression: ts.Expression,
): KvPrivacyStoreId[] | null {
	if (
		!ts.isCallExpression(expression) ||
		!ts.isIdentifier(expression.expression) ||
		expression.expression.text !== "assertKvPrivacyStoreKey"
	) {
		return null;
	}
	const allowed = expression.arguments[0];
	if (!allowed) return [];
	const values = ts.isArrayLiteralExpression(allowed)
		? allowed.elements
		: [allowed];
	return values.flatMap((value) =>
		ts.isStringLiteral(value) &&
		Object.hasOwn(KV_PRIVACY_KEY_PREFIX_BY_STORE_ID, value.text)
			? [value.text as KvPrivacyStoreId]
			: [],
	);
}

function storesForStarts(starts: readonly StaticStart[]): KvPrivacyStoreId[] {
	const stores = new Set<KvPrivacyStoreId>();
	for (const start of starts) {
		for (const [storeId, prefix] of Object.entries(
			KV_PRIVACY_KEY_PREFIX_BY_STORE_ID,
		) as Array<[KvPrivacyStoreId, string]>) {
			if (start.text.startsWith(prefix)) stores.add(storeId);
		}
	}
	return [...stores];
}

function isKvCall(
	call: ts.CallExpression,
	checker: ts.TypeChecker,
	keyStores: readonly KvPrivacyStoreId[],
): boolean {
	if (
		!ts.isPropertyAccessExpression(call.expression) ||
		!KV_METHODS.has(call.expression.name.text)
	) {
		return false;
	}
	const receiver = call.expression.expression;
	const receiverText = receiver.getText();
	if (
		receiverText === "kv" ||
		receiverText.endsWith(".KV") ||
		receiverText.endsWith(".kv")
	) {
		return true;
	}
	const receiverType = checker.typeToString(
		checker.getTypeAtLocation(receiver),
	);
	return /KV|Kv|KeyValue/.test(receiverType) || keyStores.length > 0;
}

test("KV privacy coverage is derived from every production get/put/delete/list key", async () => {
	const repoRoot = new URL("../../../", import.meta.url).pathname;
	const unsupportedKvSources: string[] = [];
	for (const root of ["apps/api/src", "apps/app/src", "scripts"]) {
		for await (const relative of new Bun.Glob(
			"**/*.{js,jsx,mjs,cjs,astro}",
		).scan({
			cwd: `${repoRoot}${root}`,
		})) {
			if (
				relative.includes("__tests__/") ||
				relative.includes(".test.") ||
				relative.endsWith(".d.ts")
			) {
				continue;
			}
			const source = await Bun.file(`${repoRoot}${root}/${relative}`).text();
			if (
				/(?:\b(?:[A-Za-z_$][\w$]*\.)*KV|\bkv)\s*\.\s*(?:get|put|delete|list)\s*\(/.test(
					source,
				)
			) {
				unsupportedKvSources.push(`${root}/${relative}`);
			}
		}
	}
	expect(
		unsupportedKvSources,
		"extend the KV source audit before adding KV access in a non-TypeScript source",
	).toEqual([]);

	const rootNames: string[] = [];
	for (const root of ["apps/api/src", "apps/app/src", "scripts"]) {
		for await (const relative of new Bun.Glob("**/*.{ts,tsx}").scan({
			cwd: `${repoRoot}${root}`,
		})) {
			if (
				relative.includes("__tests__/") ||
				relative.endsWith(".test.ts") ||
				relative.endsWith(".test.tsx") ||
				relative.endsWith(".d.ts")
			) {
				continue;
			}
			rootNames.push(`${repoRoot}${root}/${relative}`);
		}
	}
	const program = ts.createProgram(rootNames, {
		allowJs: false,
		esModuleInterop: true,
		jsx: ts.JsxEmit.ReactJSX,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
	});
	const checker = program.getTypeChecker();
	const derived = new Set<KvPrivacyStoreId>();
	const unresolved: string[] = [];
	let kvCalls = 0;

	for (const sourceFile of program.getSourceFiles()) {
		if (!rootNames.includes(sourceFile.fileName)) continue;
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && node.arguments[0]) {
				const explicit = explicitStoreIds(node.arguments[0]);
				const starts =
					explicit === null
						? staticStarts(node.arguments[0], {
								checker,
								substitutions: new Map(),
								seen: new Set(),
							})
						: [];
				const stores = explicit ?? storesForStarts(starts);
				if (isKvCall(node, checker, stores)) {
					kvCalls += 1;
					for (const store of stores) derived.add(store);
					if (stores.length === 0) {
						const position = sourceFile.getLineAndCharacterOfPosition(
							node.getStart(sourceFile),
						);
						unresolved.push(
							`${sourceFile.fileName.slice(repoRoot.length)}:${position.line + 1} ${node.arguments[0].getText(sourceFile)}`,
						);
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(sourceFile);
	}

	const registered = EXTERNAL_PRIVACY_RETENTION_STORES.filter(
		(store) => store.kind === "kv",
	)
		.map((store) => store.id)
		.sort();
	expect(kvCalls).toBeGreaterThan(100);
	expect(unresolved).toEqual([]);
	expect(Object.keys(KV_PRIVACY_KEY_PREFIX_BY_STORE_ID).sort()).toEqual(
		registered,
	);
	expect([...derived].sort() as string[]).toEqual(registered);
});
