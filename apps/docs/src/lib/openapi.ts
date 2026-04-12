import { createOpenAPI } from "fumadocs-openapi/server";

export const openapi = createOpenAPI({
	async input() {
		const res = await fetch("https://api.relayapi.dev/openapi.json", {
			cache: "no-store",
		});
		return {
			"https://api.relayapi.dev/openapi.json": await res.json(),
		};
	},
});
