import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import {
	BASELINE_GENERATION,
	MAINTENANCE_SMOKE_HASH_DOMAIN,
} from "@relayapi/config";
import { createHash } from "node:crypto";
import { defineConfig } from "vitest/config";

const maintenanceSmokeHash = createHash("sha256")
	.update(`${MAINTENANCE_SMOKE_HASH_DOMAIN}workerd-smoke-token`)
	.digest("hex");

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
					BASELINE_GENERATION: String(BASELINE_GENERATION),
					ENCRYPTION_KEY: `test=${"a".repeat(64)}`,
					MAINTENANCE_SMOKE_BYPASS_SHA256: maintenanceSmokeHash,
					PERF_LOGS: "0",
					PUBLIC_LINK_BASE_URL: "https://go.relayapi.dev",
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
