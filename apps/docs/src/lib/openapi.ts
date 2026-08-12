import type { OpenAPIV3_2 } from "fumadocs-openapi";
import pinnedOpenApiSpec from "../../openapi.json";

export const specUrl = "https://api.relayapi.dev/openapi.json";

type JsonObject = Record<string, unknown>;

export interface OpenApiOperationSelection {
	path: string;
	method: string;
}

const sourceDocument = pinnedOpenApiSpec as unknown as JsonObject;

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodePointer(pointer: string): string[] {
	return pointer
		.slice(2)
		.split("/")
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function getAtPointer(root: JsonObject, segments: string[]): unknown {
	let current: unknown = root;
	for (const segment of segments) {
		if (!isObject(current) && !Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function collectLocalReferences(value: unknown, references: Set<string>): void {
	if (typeof value === "string") {
		if (value.startsWith("#/")) references.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectLocalReferences(item, references);
		return;
	}
	if (!isObject(value)) return;
	for (const nested of Object.values(value)) {
		collectLocalReferences(nested, references);
	}
}

function copyReferencedComponents(
	document: JsonObject,
	references: Set<string>,
): void {
	const copied = new Set<string>();
	const pending = [...references];

	for (let index = 0; index < pending.length; index += 1) {
		const pointer = pending[index];
		if (!pointer) continue;
		const segments = decodePointer(pointer);
		if (segments[0] !== "components" || segments.length < 3) continue;
		const group = segments[1];
		const name = segments[2];
		if (!group || !name) continue;

		// A reference can point below a component entry. Copy the complete entry so
		// discriminators, examples, and sibling fields keep their original context.
		const componentSegments = ["components", group, name];
		const componentPointer = `#/${componentSegments
			.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
			.join("/")}`;
		if (copied.has(componentPointer)) continue;

		const component = getAtPointer(sourceDocument, componentSegments);
		if (component === undefined) {
			throw new Error(`OpenAPI reference does not resolve: ${pointer}`);
		}

		if (!isObject(document.components)) document.components = {};
		const components = document.components as JsonObject;
		if (!isObject(components[group])) components[group] = {};
		const targetGroup = components[group] as JsonObject;
		targetGroup[name] = component;
		copied.add(componentPointer);

		const nested = new Set<string>();
		collectLocalReferences(component, nested);
		for (const reference of nested) {
			if (!pending.includes(reference)) pending.push(reference);
		}
	}
}

/**
 * Build the smallest OpenAPI document needed to render a generated operation
 * page. Serializing the complete multi-megabyte spec into every static page
 * made the OpenNext cache several gigabytes and exhausted Worker resources
 * under modest concurrent traffic.
 */
export function createOperationDocument(
	selections: readonly OpenApiOperationSelection[],
): OpenAPIV3_2.Document {
	if (selections.length === 0) {
		throw new Error(
			"An OpenAPI operation page must select at least one operation",
		);
	}

	const sourcePaths = sourceDocument.paths;
	if (!isObject(sourcePaths)) {
		throw new Error("The pinned OpenAPI document is missing a paths object");
	}

	const document: JsonObject = {};
	for (const key of [
		"openapi",
		"info",
		"jsonSchemaDialect",
		"servers",
		"security",
		"tags",
		"externalDocs",
	]) {
		if (sourceDocument[key] !== undefined) document[key] = sourceDocument[key];
	}
	document.paths = {};

	const references = new Set<string>();
	collectLocalReferences(document.security, references);

	for (const selection of selections) {
		const sourcePathItem = sourcePaths[selection.path];
		if (!isObject(sourcePathItem)) {
			throw new Error(`OpenAPI path does not exist: ${selection.path}`);
		}

		const method = selection.method.toLowerCase();
		const operation = sourcePathItem[method];
		if (!isObject(operation)) {
			throw new Error(
				`OpenAPI operation does not exist: ${selection.method.toUpperCase()} ${selection.path}`,
			);
		}

		const targetPathItem: JsonObject = {};
		for (const key of [
			"$ref",
			"summary",
			"description",
			"servers",
			"parameters",
		]) {
			if (sourcePathItem[key] !== undefined) {
				targetPathItem[key] = sourcePathItem[key];
			}
		}
		targetPathItem[method] = operation;
		(document.paths as JsonObject)[selection.path] = targetPathItem;
		collectLocalReferences(targetPathItem, references);
	}

	// Security requirements use scheme names instead of $ref values. They are
	// small, so retain all schemes while pruning every other component group.
	const sourceComponents = sourceDocument.components;
	if (
		isObject(sourceComponents) &&
		isObject(sourceComponents.securitySchemes)
	) {
		if (!isObject(document.components)) document.components = {};
		(document.components as JsonObject).securitySchemes =
			sourceComponents.securitySchemes;
		collectLocalReferences(sourceComponents.securitySchemes, references);
	}

	copyReferencedComponents(document, references);
	return document as unknown as OpenAPIV3_2.Document;
}

export function preloadOpenApiOperations(operations: unknown): {
	preloaded: { docs: Record<string, OpenAPIV3_2.Document> };
} {
	if (!Array.isArray(operations)) {
		throw new Error("Generated OpenAPI page props are missing operations");
	}

	const selections = operations.map((operation) => {
		if (
			!isObject(operation) ||
			typeof operation.path !== "string" ||
			typeof operation.method !== "string"
		) {
			throw new Error("Generated OpenAPI page contains an invalid operation");
		}
		return { path: operation.path, method: operation.method };
	});

	return {
		preloaded: {
			docs: { [specUrl]: createOperationDocument(selections) },
		},
	};
}
