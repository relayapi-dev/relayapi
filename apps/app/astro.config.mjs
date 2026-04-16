import { fileURLToPath } from "node:url";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://relayapi.dev",
	output: "server",
	adapter: cloudflare({
		persistState: { path: "../../.wrangler/state" },
	}),
	integrations: [react()],
	vite: {
		plugins: [tailwindcss()],
		resolve: {
			alias: {
				"@relayapi/sdk": fileURLToPath(
					new URL("../../packages/sdk/src/index.ts", import.meta.url),
				),
			},
		},
	},
});
