import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	logLevel: "error",
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			// Use local implementations for the bindings exercised here. Loading the
			// complete production config would make the AI binding remote and turn a
			// deterministic CI suite into an authenticated network test.
			miniflare: {
				compatibilityDate: "2026-03-13",
				compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
				bindings: {
					PERF_LOGS: "0",
					R2_EVENT_ACCOUNT_ID: "3496f40fcd55a91da50ded8abea2cf7a",
					R2_MEDIA_BUCKET_NAME: "relayapi-media",
				},
				kvNamespaces: ["KV"],
				r2Buckets: ["MEDIA_BUCKET", "THUMBNAIL_BUCKET", "QUEUE_RESCUE_BUCKET"],
				durableObjects: { REALTIME: "RealtimeDO" },
				queueProducers: {
					QUEUE_RESCUE_QUEUE: { queueName: "relayapi-queue-rescue" },
				},
			},
		}),
	],
	test: {
		include: ["src/__tests__/workerd/**/*.workerd.test.ts"],
	},
});
