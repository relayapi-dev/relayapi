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
			// Keep a single React copy across the SSR + client graphs (Astro 7 / Vite 8).
			dedupe: ["react", "react-dom"],
			alias: {
				"@relayapi/sdk": fileURLToPath(
					new URL("../../packages/sdk/src/index.ts", import.meta.url),
				),
				// React 19 on Cloudflare Workers: use the edge build of react-dom/server
				// in production so SSR doesn't pull in react-dom/server.browser, which
				// needs a MessageChannel polyfill that isn't available on workerd.
				...(process.env.NODE_ENV === "production"
					? { "react-dom/server": "react-dom/server.edge" }
					: {}),
			},
		},
	},
});
