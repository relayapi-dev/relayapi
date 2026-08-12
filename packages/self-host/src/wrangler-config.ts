import { join } from "node:path";
import { BASELINE_GENERATION } from "../../config/src/index.js";
import { cloudflareQueueName, RESOURCE_NAMES } from "./constants.js";
import type { SelfHostConfig } from "./types.js";

const observability = {
	enabled: true,
	head_sampling_rate: 0.1,
	logs: {
		enabled: true,
		head_sampling_rate: 0.1,
		persist: true,
		invocation_logs: true,
	},
	traces: {
		enabled: true,
		persist: true,
		head_sampling_rate: 0.01,
	},
};

const consumer = (
	queue: Parameters<typeof cloudflareQueueName>[0],
	options: Record<string, number | string> = {},
) => ({ queue: cloudflareQueueName(queue), ...options });

function r2Binding(
	binding: string,
	bucketName: string,
	jurisdiction: SelfHostConfig["cloudflare"]["r2Jurisdiction"],
) {
	return {
		binding,
		bucket_name: bucketName,
		// Cloudflare's Wrangler schema accepts only named restrictions here.
		// The global/default choice is fixed at bucket creation and represented
		// on a Worker binding by omitting `jurisdiction`.
		...(jurisdiction === "default" ? {} : { jurisdiction }),
	};
}

export function apiWranglerConfig(
	config: SelfHostConfig,
	sourceRoot: string,
	maintenanceSmokeBypassSha256?: string,
): Record<string, unknown> {
	if (!config.resources)
		throw new Error("Cloudflare resources are not configured");
	return {
		$schema: join(sourceRoot, "node_modules/wrangler/config-schema.json"),
		name: RESOURCE_NAMES.workers.api,
		main: join(sourceRoot, "apps/api/src/index.ts"),
		compatibility_date: "2026-07-18",
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		minify: true,
		placement: { mode: "smart" },
		observability,
		routes: [
			{ pattern: config.cloudflare.apiHostname, custom_domain: true },
			{ pattern: config.cloudflare.publicHostname, custom_domain: true },
		],
		vars: {
			DEPLOYMENT_MODE: "self_hosted",
			SELF_HOSTED_FEATURE_AI: config.features.ai ? "1" : "0",
			SELF_HOSTED_FEATURE_EMAIL: config.features.email ? "1" : "0",
			SELF_HOSTED_FEATURE_DOWNLOADER: config.features.downloader ? "1" : "0",
			PERF_LOGS: "0",
			BASELINE_GENERATION: String(BASELINE_GENERATION),
			API_BASE_URL: `https://${config.cloudflare.apiHostname}`,
			PUBLIC_LINK_BASE_URL: `https://${config.cloudflare.publicHostname}`,
			APP_BASE_URL: `https://${config.cloudflare.appHostname}`,
			MEDIA_PUBLIC_HOST: config.cloudflare.mediaHostname,
			THUMBNAIL_PUBLIC_HOST: config.cloudflare.thumbnailHostname,
			R2_EVENT_ACCOUNT_ID: config.cloudflare.accountId,
			R2_MEDIA_BUCKET_NAME: RESOURCE_NAMES.buckets.media,
			R2_MEDIA_BUCKET_JURISDICTION: config.cloudflare.r2Jurisdiction,
			R2_THUMBNAIL_BUCKET_NAME: RESOURCE_NAMES.buckets.thumbnails,
			R2_THUMBNAIL_BUCKET_JURISDICTION: config.cloudflare.r2Jurisdiction,
			AI_EMBEDDING_PROVIDER: "openai",
			AI_EMBEDDING_MODEL: "text-embedding-3-small",
			AI_INFERENCE_PROVIDER: "workers_ai",
			AI_INFERENCE_MODEL: "@cf/zai-org/glm-4.7-flash",
			...(config.publishing?.tiktokVerifiedUrlPrefixes.length
				? {
						TIKTOK_VERIFIED_URL_PREFIXES:
							config.publishing.tiktokVerifiedUrlPrefixes.join("\n"),
					}
				: {}),
			...(maintenanceSmokeBypassSha256
				? {
						MAINTENANCE_SMOKE_BYPASS_SHA256: maintenanceSmokeBypassSha256,
					}
				: {}),
		},
		...(config.features.ai ? { ai: { binding: "AI" } } : {}),
		durable_objects: {
			bindings: [
				{ name: "REALTIME", class_name: "RealtimeDO" },
				...(config.features.mediaProcessing
					? [
							{
								name: "MEDIA_PROCESSOR",
								class_name: "MediaProcessorContainer",
							},
						]
					: []),
			],
		},
		migrations: [
			{ tag: "v1", new_sqlite_classes: ["RealtimeDO"] },
			// Legacy Durable Object migrations are an append-only lifecycle. Keep v2
			// even while the optional runtime binding is disabled so an operator can
			// never roll the deployed migration tag backwards after opting in once.
			{
				tag: "v2",
				new_sqlite_classes: ["MediaProcessorContainer"],
			},
		],
		...(config.features.mediaProcessing
			? {
					workflows: [
						{
							binding: "MEDIA_PROCESSING_WORKFLOW",
							name: "relayapi-selfhost-media-processing",
							class_name: "MediaProcessingWorkflow",
							limits: { steps: 20 },
						},
					],
					containers: [
						{
							name: "relayapi-selfhost-media-processor",
							class_name: "MediaProcessorContainer",
							image: join(sourceRoot, "apps/api/media-processor/Dockerfile"),
							image_build_context: join(sourceRoot, "apps/api/media-processor"),
							instance_type: "standard-1",
							max_instances: 2,
						},
					],
				}
			: {}),
		kv_namespaces: [{ binding: "KV", id: config.resources.kvNamespaceId }],
		r2_buckets: [
			r2Binding(
				"MEDIA_BUCKET",
				RESOURCE_NAMES.buckets.media,
				config.cloudflare.r2Jurisdiction,
			),
			r2Binding(
				"AVATAR_BUCKET",
				RESOURCE_NAMES.buckets.avatars,
				config.cloudflare.r2Jurisdiction,
			),
			r2Binding(
				"THUMBNAIL_BUCKET",
				RESOURCE_NAMES.buckets.thumbnails,
				config.cloudflare.r2Jurisdiction,
			),
			r2Binding(
				"QUEUE_RESCUE_BUCKET",
				RESOURCE_NAMES.buckets.queueRescue,
				config.cloudflare.r2Jurisdiction,
			),
			r2Binding(
				"AD_REPORT_BUCKET",
				RESOURCE_NAMES.buckets.adReports,
				config.cloudflare.r2Jurisdiction,
			),
		],
		images: { binding: "IMAGES" },
		media: { binding: "MEDIA" },
		hyperdrive: [{ binding: "HYPERDRIVE", id: config.resources.hyperdriveId }],
		triggers: {
			crons: [
				"*/1 * * * *",
				"*/5 * * * *",
				"*/30 * * * *",
				"0 9 * * *",
				"0 9 * * MON",
			],
		},
		ratelimits: [
			{
				name: "FREE_RATE_LIMITER",
				namespace_id: "2001",
				simple: { limit: 100, period: 60 },
			},
			{
				name: "PRO_RATE_LIMITER",
				namespace_id: "2002",
				simple: { limit: 1000, period: 60 },
			},
			{
				name: "FREE_KEY_BURST_LIMITER",
				namespace_id: "2003",
				simple: { limit: 50, period: 60 },
			},
			{
				name: "PRO_KEY_BURST_LIMITER",
				namespace_id: "2004",
				simple: { limit: 500, period: 60 },
			},
		],
		queues: {
			producers: [
				{ binding: "PUBLISH_QUEUE", queue: cloudflareQueueName("publish") },
				{ binding: "EMAIL_QUEUE", queue: cloudflareQueueName("email") },
				{ binding: "REFRESH_QUEUE", queue: cloudflareQueueName("refresh") },
				{ binding: "INBOX_QUEUE", queue: cloudflareQueueName("inbox") },
				{ binding: "TOOLS_QUEUE", queue: cloudflareQueueName("tools") },
				{ binding: "ADS_QUEUE", queue: cloudflareQueueName("ads") },
				{ binding: "SYNC_QUEUE", queue: cloudflareQueueName("sync") },
				{
					binding: "CUSTOMER_WEBHOOK_QUEUE",
					queue: cloudflareQueueName("customer-webhooks"),
				},
				{
					binding: "MEDIA_PROCESSING_QUEUE",
					queue: cloudflareQueueName("media-processing"),
				},
				{
					binding: "QUEUE_RESCUE_QUEUE",
					queue: cloudflareQueueName("queue-rescue"),
				},
			],
			consumers: [
				consumer("media-cleanup", {
					max_batch_size: 10,
					max_retries: 3,
					dead_letter_queue: cloudflareQueueName("media-cleanup-dlq"),
				}),
				consumer("publish", {
					max_batch_size: 1,
					max_batch_timeout: 1,
					max_retries: 3,
					dead_letter_queue: cloudflareQueueName("publish-dlq"),
				}),
				consumer("email", {
					max_batch_size: 1,
					max_batch_timeout: 1,
					max_concurrency: 1,
					max_retries: 5,
					dead_letter_queue: cloudflareQueueName("email-dlq"),
				}),
				consumer("refresh", {
					max_batch_size: 10,
					max_retries: 3,
					max_concurrency: 5,
					dead_letter_queue: cloudflareQueueName("refresh-dlq"),
				}),
				consumer("inbox", {
					max_batch_size: 10,
					max_retries: 5,
					max_concurrency: 5,
					dead_letter_queue: cloudflareQueueName("inbox-dlq"),
				}),
				consumer("tools", {
					max_batch_size: 5,
					max_batch_timeout: 1,
					max_retries: 3,
					max_concurrency: 3,
					dead_letter_queue: cloudflareQueueName("tools-dlq"),
				}),
				consumer("ads", {
					max_batch_size: 5,
					max_retries: 3,
					max_concurrency: 3,
					dead_letter_queue: cloudflareQueueName("ads-dlq"),
				}),
				consumer("sync", {
					max_batch_size: 5,
					max_retries: 3,
					max_concurrency: 5,
					dead_letter_queue: cloudflareQueueName("sync-dlq"),
				}),
				consumer("customer-webhooks", {
					max_batch_size: 10,
					max_retries: 5,
					max_concurrency: 5,
					dead_letter_queue: cloudflareQueueName("customer-webhooks-dlq"),
				}),
				consumer("media-processing", {
					max_batch_size: 1,
					max_batch_timeout: 1,
					max_retries: 5,
					max_concurrency: 2,
					dead_letter_queue: cloudflareQueueName("media-processing-dlq"),
				}),
				...[
					"media-cleanup-dlq",
					"publish-dlq",
					"email-dlq",
					"refresh-dlq",
					"inbox-dlq",
					"tools-dlq",
					"ads-dlq",
					"sync-dlq",
					"customer-webhooks-dlq",
					"media-processing-dlq",
				].map((queue) =>
					consumer(queue as Parameters<typeof cloudflareQueueName>[0], {
						max_batch_size: 10,
						max_retries: 3,
						max_concurrency: 1,
						dead_letter_queue: cloudflareQueueName("queue-rescue"),
					}),
				),
				consumer("queue-rescue", {
					max_batch_size: 10,
					max_batch_timeout: 5,
					max_retries: 40,
					max_concurrency: 2,
				}),
			],
		},
	};
}

export function appWranglerConfig(
	config: SelfHostConfig,
	sourceRoot: string,
	maintenanceSmokeBypassSha256?: string,
): Record<string, unknown> {
	if (!config.resources)
		throw new Error("Cloudflare resources are not configured");
	return {
		$schema: join(sourceRoot, "node_modules/wrangler/config-schema.json"),
		name: RESOURCE_NAMES.workers.app,
		main: join(sourceRoot, "apps/app/dist/server/entry.mjs"),
		compatibility_date: "2026-07-18",
		compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
		no_bundle: true,
		assets: {
			binding: "ASSETS",
			directory: join(sourceRoot, "apps/app/dist/client"),
		},
		observability,
		routes: [{ pattern: config.cloudflare.appHostname, custom_domain: true }],
		vars: {
			IDENTITY_DELETION_CONTRACT_VERSION: "identity-deletion-v1",
			BASELINE_GENERATION: String(BASELINE_GENERATION),
			DEPLOYMENT_MODE: "self_hosted",
			SELF_HOSTED_FEATURE_AI: config.features.ai ? "1" : "0",
			SELF_HOSTED_FEATURE_EMAIL: config.features.email ? "1" : "0",
			API_BASE_URL: `https://${config.cloudflare.apiHostname}`,
			BETTER_AUTH_URL: `https://${config.cloudflare.appHostname}`,
			...(maintenanceSmokeBypassSha256
				? {
						MAINTENANCE_SMOKE_BYPASS_SHA256: maintenanceSmokeBypassSha256,
					}
				: {}),
		},
		kv_namespaces: [{ binding: "KV", id: config.resources.kvNamespaceId }],
		hyperdrive: [{ binding: "HYPERDRIVE", id: config.resources.hyperdriveId }],
		r2_buckets: [
			r2Binding(
				"AVATARS_BUCKET",
				RESOURCE_NAMES.buckets.avatars,
				config.cloudflare.r2Jurisdiction,
			),
			r2Binding(
				"PUBLIC_ASSETS",
				RESOURCE_NAMES.buckets.publicAssets,
				config.cloudflare.r2Jurisdiction,
			),
			r2Binding(
				"QUEUE_RESCUE_BUCKET",
				RESOURCE_NAMES.buckets.queueRescue,
				config.cloudflare.r2Jurisdiction,
			),
		],
		images: { binding: "IMAGES" },
		services: [
			{
				binding: "EMAIL_INTENTS",
				service: RESOURCE_NAMES.workers.api,
				entrypoint: "EmailIntentEntrypoint",
			},
		],
	};
}
