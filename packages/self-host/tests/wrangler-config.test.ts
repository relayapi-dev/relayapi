import { describe, expect, test } from "bun:test";
import { BASELINE_GENERATION } from "../../config/src/index.js";
import {
	cloudflareQueueName,
	QUEUE_NAMES,
	RESOURCE_NAMES,
} from "../src/constants.js";
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
		publicHostname: "go.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
		r2Jurisdiction: "eu",
	},
	features: { email: false, ai: false, downloader: false },
	resources: { kvNamespaceId: "kv-id", hyperdriveId: "hd-id", queues },
};

describe("generated Wrangler configurations", () => {
	test("keeps the API on the operator's Cloudflare bindings and domains", () => {
		const generated = apiWranglerConfig(config, "/source") as {
			name: string;
			observability: {
				traces: { enabled: boolean; persist: boolean; head_sampling_rate: number };
			};
			vars: Record<string, string>;
			routes: Array<{ pattern: string }>;
			r2_buckets: Array<{ jurisdiction: string }>;
			queues: {
				consumers: Array<{
					queue: string;
					max_retries: number;
					max_batch_timeout?: number;
				}>;
			};
			ai?: unknown;
		};
		expect(generated.name).toBe(RESOURCE_NAMES.workers.api);
		expect(generated.observability.traces).toEqual({
			enabled: true,
			persist: true,
			head_sampling_rate: 0.01,
		});
		expect(generated.routes[0]?.pattern).toBe("api.example.com");
		expect(generated.routes[1]?.pattern).toBe("go.example.com");
		expect(generated.vars.DEPLOYMENT_MODE).toBe("self_hosted");
		expect(generated.vars.BASELINE_GENERATION).toBe(
			String(BASELINE_GENERATION),
		);
		expect(generated.vars.APP_BASE_URL).toBe("https://app.example.com");
		expect(
			Object.keys(generated.vars).some((name) => name.startsWith("STRIPE_")),
		).toBe(false);
		expect(generated.vars.PUBLIC_LINK_BASE_URL).toBe("https://go.example.com");
		expect(generated.vars.MEDIA_PUBLIC_HOST).toBe("media.example.com");
		expect(generated.vars.R2_THUMBNAIL_BUCKET_NAME).toBe(
			RESOURCE_NAMES.buckets.thumbnails,
		);
		expect(generated.vars.R2_THUMBNAIL_BUCKET_JURISDICTION).toBe("eu");
		expect(generated.vars.AI_EMBEDDING_PROVIDER).toBe("openai");
		expect(generated.vars.AI_EMBEDDING_MODEL).toBe("text-embedding-3-small");
		expect(generated.vars.AI_INFERENCE_PROVIDER).toBe("workers_ai");
		expect(generated.vars.AI_INFERENCE_MODEL).toBe("@cf/zai-org/glm-4.7-flash");
		expect(
			generated.r2_buckets.every(({ jurisdiction }) => jurisdiction === "eu"),
		).toBe(true);
		expect(
			generated.queues.consumers.find(
				(consumer) => consumer.queue === "relayapi-selfhost-queue-rescue",
			)?.max_retries,
		).toBe(40);
		expect(
			generated.queues.consumers.find(
				(consumer) => consumer.queue === "relayapi-selfhost-tools",
			)?.max_batch_timeout,
		).toBe(1);
		expect(generated.ai).toBeUndefined();
	});

	test("uses the built Astro entry for the dashboard", () => {
		const generated = appWranglerConfig(config, "/source") as {
			main: string;
			observability: {
				traces: { enabled: boolean; persist: boolean; head_sampling_rate: number };
			};
			assets: { directory: string };
			vars: Record<string, string>;
			r2_buckets: Array<{ jurisdiction: string }>;
			services: Array<{
				binding: string;
				service: string;
				entrypoint: string;
			}>;
			queues?: unknown;
		};
		expect(generated.main).toBe("/source/apps/app/dist/server/entry.mjs");
		expect(generated.observability.traces).toEqual({
			enabled: true,
			persist: true,
			head_sampling_rate: 0.01,
		});
		expect(generated.assets.directory).toBe("/source/apps/app/dist/client");
		expect(generated.vars.IDENTITY_DELETION_CONTRACT_VERSION).toBe(
			"identity-deletion-v1",
		);
		expect(generated.vars.BASELINE_GENERATION).toBe(
			String(BASELINE_GENERATION),
		);
		expect(
			Object.keys(generated.vars).some((name) => name.startsWith("STRIPE_")),
		).toBe(false);
		expect(
			generated.r2_buckets.every(({ jurisdiction }) => jurisdiction === "eu"),
		).toBe(true);
		expect(
			generated.r2_buckets.some(
				(binding) =>
					(binding as { binding?: string }).binding === "QUEUE_RESCUE_BUCKET",
			),
		).toBe(true);
		expect(generated.services).toEqual([
			{
				binding: "EMAIL_INTENTS",
				service: RESOURCE_NAMES.workers.api,
				entrypoint: "EmailIntentEntrypoint",
			},
		]);
		expect(generated.queues).toBeUndefined();
	});

	test("writes only the derived smoke digest to both self-hosted Worker configs", () => {
		const digest = "a".repeat(64);
		const api = apiWranglerConfig(config, "/source", digest) as {
			vars: Record<string, string>;
		};
		const app = appWranglerConfig(config, "/source", digest) as {
			vars: Record<string, string>;
		};
		for (const generated of [api, app]) {
			expect(generated.vars.MAINTENANCE_SMOKE_BYPASS_SHA256).toBe(digest);
			expect(JSON.stringify(generated)).not.toContain("database-smoke-token");
		}
	});

	test("emits the complete self-host Queue identity contract", () => {
		const generated = apiWranglerConfig(config, "/source") as {
			queues: {
				producers: Array<{ queue: string }>;
				consumers: Array<{ queue: string; dead_letter_queue?: string }>;
			};
		};
		const expected = new Set(QUEUE_NAMES.map(cloudflareQueueName));
		const configured = new Set([
			...generated.queues.producers.map(({ queue }) => queue),
			...generated.queues.consumers.map(({ queue }) => queue),
			...generated.queues.consumers.flatMap(({ dead_letter_queue }) =>
				dead_letter_queue ? [dead_letter_queue] : [],
			),
		]);

		expect(configured).toEqual(expected);
		expect(
			[...configured].every((name) => name.startsWith("relayapi-selfhost-")),
		).toBe(true);
	});

	test("represents the default jurisdiction by omitting the binding field", () => {
		const defaultConfig = structuredClone(config);
		defaultConfig.cloudflare.r2Jurisdiction = "default";
		const api = apiWranglerConfig(defaultConfig, "/source") as {
			r2_buckets: Array<{ jurisdiction?: string }>;
		};
		const app = appWranglerConfig(defaultConfig, "/source") as {
			r2_buckets: Array<{ jurisdiction?: string }>;
		};
		expect(
			[...api.r2_buckets, ...app.r2_buckets].every(
				(binding) => !Object.hasOwn(binding, "jurisdiction"),
			),
		).toBe(true);
	});

	test("deploys the API entrypoint before the bound app and keeps Resend API-only", async () => {
		const deploy = await Bun.file(
			new URL("../src/deploy.ts", import.meta.url),
		).text();
		const apiDeploy = deploy.indexOf("configPath: apiConfigPath");
		const appDeploy = deploy.indexOf(
			"configPath: appConfigPath",
			apiDeploy + 1,
		);
		const apiProbe = deploy.indexOf("await probeWorkerDatabase({", apiDeploy);
		const appProbe = deploy.indexOf(
			"await probeWorkerDatabase({",
			apiProbe + 1,
		);
		expect(apiDeploy).toBeGreaterThan(-1);
		expect(apiProbe).toBeGreaterThan(apiDeploy);
		expect(appDeploy).toBeGreaterThan(apiDeploy);
		expect(appDeploy).toBeGreaterThan(apiProbe);
		expect(appProbe).toBeGreaterThan(appDeploy);
		const appBlock = deploy.slice(
			appDeploy,
			deploy.indexOf("console.log(", appDeploy),
		);
		expect(appBlock).not.toContain("RESEND_API_KEY");
	});
});
