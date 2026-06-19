import { fileURLToPath } from "node:url";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

export default defineConfig({
	site: "https://relayapi.dev",
	output: "server",
	// Geist is served via Astro's Fonts API (not @fontsource @import) so we can
	// use font-display:"optional" + preload: the metric-matched fallback shows
	// for the ~100ms block window and the font NEVER swaps in afterwards, while
	// the preload makes the cached woff2 win that window on refresh (no flash).
	// The only stable contract for consumers is the cssVariable below — Astro
	// emits the @font-face under a hashed family name, so reference the var, not
	// "Geist Variable". latin subset only (English UI); normal-only variants
	// preserve the current synthetic-italic behavior.
	fonts: [
		{
			name: "Geist",
			cssVariable: "--font-geist-sans",
			provider: fontProviders.local(),
			display: "optional",
			optimizedFallbacks: true,
			fallbacks: ["system-ui", "sans-serif"],
			options: {
				variants: [
					{
						weight: "100 900",
						style: "normal",
						src: [
							"@fontsource-variable/geist/files/geist-latin-wght-normal.woff2",
						],
					},
				],
			},
		},
		{
			name: "Geist Mono",
			cssVariable: "--font-geist-mono",
			provider: fontProviders.local(),
			display: "optional",
			optimizedFallbacks: true,
			fallbacks: ["ui-monospace", "monospace"],
			options: {
				variants: [
					{
						weight: "100 900",
						style: "normal",
						src: [
							"@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
						],
					},
				],
			},
		},
	],
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
