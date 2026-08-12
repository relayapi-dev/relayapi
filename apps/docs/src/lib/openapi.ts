import type { OpenAPIV3_2 } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";
import pinnedOpenApiSpec from "../../openapi.json";

export const specUrl = "https://api.relayapi.dev/openapi.json";

export const openapi = createOpenAPI({
	input: {
		// The deployed OpenNext Worker has no repository filesystem. Bundle the
		// pinned document so generated operation pages can resolve it at runtime.
		// Fumadocs' current server declaration accepts only its newest document
		// type even though the runtime loader supports the pinned OpenAPI 3.1 spec.
		[specUrl]: pinnedOpenApiSpec as unknown as OpenAPIV3_2.Document,
	},
});
