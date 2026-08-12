/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import pinnedOpenApiSpec from "../../openapi.json";
import {
	createOperationDocument,
	preloadOpenApiOperations,
	specUrl,
} from "./openapi";

const HTTP_METHODS = new Set([
	"delete",
	"get",
	"head",
	"options",
	"patch",
	"post",
	"put",
	"trace",
]);

function resolveLocalReference(
	document: Record<string, unknown>,
	reference: string,
): unknown {
	let current: unknown = document;
	for (const rawSegment of reference.slice(2).split("/")) {
		const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function collectReferences(value: unknown, references: Set<string>): void {
	if (typeof value === "string") {
		if (value.startsWith("#/")) references.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectReferences(item, references);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const nested of Object.values(value)) {
		collectReferences(nested, references);
	}
}

describe("operation-scoped OpenAPI documents", () => {
	test("keeps the selected operation and its transitive component references", () => {
		const document = createOperationDocument([
			{ path: "/v1/accounts", method: "get" },
		]) as unknown as Record<string, unknown>;
		const paths = document.paths as Record<string, Record<string, unknown>>;

		expect(paths["/v1/accounts"]?.get).toBeDefined();
		expect(paths["/v1/posts"]).toBeUndefined();
		expect(document.components).toBeDefined();

		const serialized = JSON.stringify(document);
		expect(serialized).toContain("Account");
		expect(serialized.length).toBeLessThan(500_000);
	});

	test("returns the preloaded shape expected by generated MDX pages", () => {
		const props = preloadOpenApiOperations([
			{ path: "/v1/accounts", method: "get" },
		]);

		expect(props.preloaded.docs[specUrl]).toMatchObject({
			info: { title: "RelayAPI", version: "1.0.0" },
			paths: { "/v1/accounts": { get: expect.any(Object) } },
		});
	});

	test("keeps every generated operation compact with no dangling local references", () => {
		const paths = pinnedOpenApiSpec.paths as Record<
			string,
			Record<string, unknown>
		>;
		let operationCount = 0;
		let largestDocument = 0;

		for (const [path, pathItem] of Object.entries(paths)) {
			for (const method of Object.keys(pathItem)) {
				if (!HTTP_METHODS.has(method.toLowerCase())) continue;
				operationCount += 1;

				const document = createOperationDocument([
					{ path, method },
				]) as unknown as Record<string, unknown>;
				largestDocument = Math.max(
					largestDocument,
					JSON.stringify(document).length,
				);

				const references = new Set<string>();
				collectReferences(document, references);
				for (const reference of references) {
					expect(
						resolveLocalReference(document, reference),
						`${method.toUpperCase()} ${path} has dangling ${reference}`,
					).toBeDefined();
				}
			}
		}

		expect(operationCount).toBe(499);
		expect(largestDocument).toBeLessThan(100_000);
	});

	test("fails the build when a generated operation no longer exists", () => {
		expect(() =>
			createOperationDocument([{ path: "/v1/missing", method: "get" }]),
		).toThrow("OpenAPI path does not exist");
	});
});
