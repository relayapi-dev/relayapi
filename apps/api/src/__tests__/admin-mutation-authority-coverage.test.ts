import { describe, expect, it } from "bun:test";
import { FENCED_ADMIN_MUTATION_OPERATION_IDS } from "../routes/admin";

interface RouteDefinition {
	variableName: string;
	operationId: string;
	method: string;
}

function routeDefinitions(source: string): RouteDefinition[] {
	return [
		...source.matchAll(/const\s+(\w+)\s*=\s*createRoute\(\{([\s\S]*?)\n\}\);/g),
	]
		.map((match) => {
			const operationId = match[2]?.match(/operationId:\s*"([^"]+)"/)?.[1];
			const method = match[2]?.match(/method:\s*"([^"]+)"/)?.[1];
			return operationId && method && match[1]
				? { variableName: match[1], operationId, method }
				: null;
		})
		.filter((value): value is RouteDefinition => value !== null);
}

describe("admin mutation authority coverage", () => {
	it("classifies every non-read route and fences its handler", async () => {
		const source = await Bun.file(
			new URL("../routes/admin.ts", import.meta.url),
		).text();
		const mutations = routeDefinitions(source).filter(
			(route) => route.method !== "get",
		);

		expect(mutations.map((route) => route.operationId).sort()).toEqual(
			[...FENCED_ADMIN_MUTATION_OPERATION_IDS].sort(),
		);
		for (const route of mutations) {
			const handlerStart = source.indexOf(`app.openapi(${route.variableName},`);
			const nextHandler = source.indexOf("\napp.openapi(", handlerStart + 1);
			const handler = source.slice(
				handlerStart,
				nextHandler === -1 ? source.length : nextHandler,
			);
			expect(handlerStart, route.operationId).toBeGreaterThan(-1);
			expect(handler, route.operationId).toContain(
				"withCredentialMutationAuthority(",
			);
			expect(handler, route.operationId).toContain(
				"{ requireGlobalAdmin: true }",
			);
		}
	});
});
