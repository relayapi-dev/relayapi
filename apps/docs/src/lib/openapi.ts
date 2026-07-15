import { createOpenAPI } from "fumadocs-openapi/server";

const specUrl = "https://api.relayapi.dev/openapi.json";

export const openapi = createOpenAPI({
	input: {
		[specUrl]: "./openapi.json",
	},
});
