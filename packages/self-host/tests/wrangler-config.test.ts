import { describe, expect, test } from "bun:test";
import { QUEUE_NAMES, RESOURCE_NAMES } from "../src/constants.js";
import type { SelfHostConfig } from "../src/types.js";
import {
	apiWranglerConfig,
	appWranglerConfig,
} from "../src/wrangler-config.js";

const queues = Object.fromEntries(
	QUEUE_NAMES.map((name) => [name, `id-${name}`]),
) as NonNullable<SelfHostConfig["resources"]>["queues"];

const config: SelfHostConfig = {
	schemaVersion: 1,
	instance: "relayapi",
	cloudflare: {
		accountId: "account-id",
		zoneId: "zone-id",
		rootDomain: "example.com",
		apiHostname: "api.example.com",
		appHostname: "app.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
	},
	features: { email: false, ai: false, downloader: false },
	resources: { kvNamespaceId: "kv-id", hyperdriveId: "hd-id", queues },
};

describe("generated Wrangler configurations", () => {
	test("keeps the API on the operator's Cloudflare bindings and domains", () => {
		const generated = apiWranglerConfig(config, "/source") as {
			name: string;
			vars: Record<string, string>;
			routes: Array<{ pattern: string }>;
			ai?: unknown;
		};
		expect(generated.name).toBe(RESOURCE_NAMES.workers.api);
		expect(generated.routes[0]?.pattern).toBe("api.example.com");
		expect(generated.vars.DEPLOYMENT_MODE).toBe("self_hosted");
		expect(generated.vars.MEDIA_PUBLIC_HOST).toBe("media.example.com");
		expect(generated.ai).toBeUndefined();
	});

	test("uses the built Astro entry for the dashboard", () => {
		const generated = appWranglerConfig(config, "/source") as {
			main: string;
			assets: { directory: string };
		};
		expect(generated.main).toBe("/source/apps/app/dist/server/entry.mjs");
		expect(generated.assets.directory).toBe("/source/apps/app/dist/client");
	});
});
