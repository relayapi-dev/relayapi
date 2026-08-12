import { describe, expect, test } from "bun:test";
import {
	QUEUE_NAMES,
	RESOURCE_NAMES,
} from "../src/constants.js";
import type { SelfHostConfig } from "../src/types.js";
import { apiWranglerConfig } from "../src/wrangler-config.js";

const queues = Object.fromEntries(
	QUEUE_NAMES.map((name) => [name, `id-${name}`]),
) as NonNullable<SelfHostConfig["resources"]>["queues"];

function config(mediaProcessing: boolean): SelfHostConfig {
	return {
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
			r2Jurisdiction: "default",
		},
		features: {
			email: false,
			ai: false,
			downloader: false,
			mediaProcessing,
		},
		resources: { kvNamespaceId: "kv", hyperdriveId: "hd", queues },
	};
}

describe("optional media-processing deployment", () => {
	test("keeps paid processing bindings absent by default", () => {
		const generated = apiWranglerConfig(config(false), "/source") as {
			workflows?: unknown;
			containers?: unknown;
			durable_objects: { bindings: Array<{ name: string }> };
			migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
			queues: { producers: Array<{ binding: string }> };
		};
		expect(generated.workflows).toBeUndefined();
		expect(generated.containers).toBeUndefined();
		expect(generated.durable_objects.bindings.map(({ name }) => name)).toEqual([
			"REALTIME",
		]);
		expect(generated.migrations).toEqual([
			{ tag: "v1", new_sqlite_classes: ["RealtimeDO"] },
			{ tag: "v2", new_sqlite_classes: ["MediaProcessorContainer"] },
		]);
		// Queue identity is provisioned for forward-compatible upgrades, but no
		// producer can persist work while the Workflow/Container are absent.
		expect(
			generated.queues.producers.some(
				({ binding }) => binding === "MEDIA_PROCESSING_QUEUE",
			),
		).toBe(true);
	});

	test("emits the private Container, Workflow, and Queue only when opted in", () => {
		const generated = apiWranglerConfig(config(true), "/source") as {
			workflows: Array<{ binding: string }>;
			containers: Array<{ class_name: string; image: string }>;
			durable_objects: { bindings: Array<{ name: string }> };
			migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
			queues: {
				producers: Array<{ binding: string; queue: string }>;
				consumers: Array<{ queue: string; dead_letter_queue?: string }>;
			};
		};
		expect(generated.workflows[0]?.binding).toBe(
			"MEDIA_PROCESSING_WORKFLOW",
		);
		expect(generated.containers[0]).toMatchObject({
			class_name: "MediaProcessorContainer",
			image: "/source/apps/api/media-processor/Dockerfile",
		});
		expect(generated.migrations).toEqual([
			{ tag: "v1", new_sqlite_classes: ["RealtimeDO"] },
			{ tag: "v2", new_sqlite_classes: ["MediaProcessorContainer"] },
		]);
		expect(
			generated.durable_objects.bindings.some(
				({ name }) => name === "MEDIA_PROCESSOR",
			),
		).toBe(true);
		expect(
			generated.queues.producers.find(
				({ binding }) => binding === "MEDIA_PROCESSING_QUEUE",
			),
		).toEqual({
			binding: "MEDIA_PROCESSING_QUEUE",
			queue: "relayapi-selfhost-media-processing",
		});
		expect(
			generated.queues.consumers.find(
				({ queue }) => queue === "relayapi-selfhost-media-processing",
			)?.dead_letter_queue,
		).toBe("relayapi-selfhost-media-processing-dlq");
		expect(RESOURCE_NAMES.buckets.media).toBe("relayapi-selfhost-media");
	});
});
