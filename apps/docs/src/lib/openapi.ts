import { createOpenAPI } from "fumadocs-openapi/server";

export const openapi = createOpenAPI({
	input: {
		"https://api.relayapi.dev/openapi.json": async () => {
			const res = await fetch("https://api.relayapi.dev/openapi.json", {
				cache: "no-store",
			});
			return res.json();
		},
	},
});
