import { join } from "node:path";
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
};

const consumer = (
	queue: Parameters<typeof cloudflareQueueName>[0],
	options: Record<string, number | string> = {},
) => ({ queue: cloudflareQueueName(queue), ...options });

export function apiWranglerConfig(
	config: SelfHostConfig,
	sourceRoot: string,
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
		routes: [{ pattern: config.cloudflare.apiHostname, custom_domain: true }],
		vars: {
			DEPLOYMENT_MODE: "self_hosted",
			SELF_HOSTED_FEATURE_AI: config.features.ai ? "1" : "0",
			SELF_HOSTED_FEATURE_EMAIL: config.features.email ? "1" : "0",
			SELF_HOSTED_FEATURE_DOWNLOADER: config.features.downloader ? "1" : "0",
			PERF_LOGS: "0",
			API_BASE_URL: `https://${config.cloudflare.apiHostname}`,
			APP_BASE_URL: `https://${config.cloudflare.appHostname}`,
			MEDIA_PUBLIC_HOST: config.cloudflare.mediaHostname,
			THUMBNAIL_PUBLIC_HOST: config.cloudflare.thumbnailHostname,
			R2_EVENT_ACCOUNT_ID: config.cloudflare.accountId,
			R2_MEDIA_BUCKET_NAME: RESOURCE_NAMES.buckets.media,
		},
		...(config.features.ai ? { ai: { binding: "AI" } } : {}),
		durable_objects: {
			bindings: [{ name: "REALTIME", class_name: "RealtimeDO" }],
		},
		migrations: [{ tag: "v1", new_sqlite_classes: ["RealtimeDO"] }],
		kv_namespaces: [{ binding: "KV", id: config.resources.kvNamespaceId }],
		r2_buckets: [
			{ binding: "MEDIA_BUCKET", bucket_name: RESOURCE_NAMES.buckets.media },
			{ binding: "AVATAR_BUCKET", bucket_name: RESOURCE_NAMES.buckets.avatars },
			{
				binding: "THUMBNAIL_BUCKET",
				bucket_name: RESOURCE_NAMES.buckets.thumbnails,
			},
			{
				binding: "QUEUE_RESCUE_BUCKET",
				bucket_name: RESOURCE_NAMES.buckets.queueRescue,
			},
		],
		images: { binding: "IMAGES" },
		media: { binding: "MEDIA" },
		hyperdrive: [{ binding: "HYPERDRIVE", id: config.resources.hyperdriveId }],
		triggers: {
			crons: [
				"*/1 * * * *",
				"*/5 * * * *",
				"*/30 * * * *",
				"0 0 1 * *",
				"0 9 * * *",
				"0 9 * * 1",
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
					max_retries: 100,
					max_concurrency: 2,
				}),
			],
		},
	};
}

export function appWranglerConfig(
	config: SelfHostConfig,
	sourceRoot: string,
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
			IDENTITY_DELETION_CONTRACT_VERSION: "0005",
			DEPLOYMENT_MODE: "self_hosted",
			SELF_HOSTED_FEATURE_AI: config.features.ai ? "1" : "0",
			SELF_HOSTED_FEATURE_EMAIL: config.features.email ? "1" : "0",
			API_BASE_URL: `https://${config.cloudflare.apiHostname}`,
			BETTER_AUTH_URL: `https://${config.cloudflare.appHostname}`,
		},
		kv_namespaces: [{ binding: "KV", id: config.resources.kvNamespaceId }],
		hyperdrive: [{ binding: "HYPERDRIVE", id: config.resources.hyperdriveId }],
		r2_buckets: [
			{
				binding: "AVATARS_BUCKET",
				bucket_name: RESOURCE_NAMES.buckets.avatars,
			},
			{
				binding: "PUBLIC_ASSETS",
				bucket_name: RESOURCE_NAMES.buckets.publicAssets,
			},
		],
		images: { binding: "IMAGES" },
		queues: {
			producers: [
				{ binding: "EMAIL_QUEUE", queue: cloudflareQueueName("email") },
			],
		},
	};
}
