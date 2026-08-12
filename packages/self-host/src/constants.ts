export const CLI_VERSION = "0.2.0"; // x-release-please-version
export const CONFIG_FILENAME = "relayapi.selfhost.json";
export const LOCK_FILENAME = "relayapi.lock.json";
export const DEFAULT_SOURCE_REPOSITORY = "relayapi-dev/relayapi";
export const RELEASE_TAG_PREFIX = "self-host-v";

export const RESOURCE_NAMES = {
	kv: "relayapi-selfhost-kv",
	hyperdrive: "relayapi-selfhost-db",
	workers: {
		api: "relayapi-selfhost-api",
		app: "relayapi-selfhost-app",
	},
	buckets: {
		media: "relayapi-selfhost-media",
		avatars: "relayapi-selfhost-avatars",
		thumbnails: "relayapi-selfhost-thumbnails",
		publicAssets: "relayapi-selfhost-public-assets",
		queueRescue: "relayapi-selfhost-queue-rescue-ledger",
		adReports: "relayapi-selfhost-ad-reports",
	},
} as const;

export const QUEUE_NAMES = [
	"media-cleanup",
	"publish",
	"email",
	"refresh",
	"inbox",
	"tools",
	"ads",
	"sync",
	"customer-webhooks",
	"media-processing",
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
	"queue-rescue",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
export const ADDITIVE_QUEUE_NAMES = [
	"media-processing",
	"media-processing-dlq",
] as const satisfies readonly QueueName[];
export type AdditiveQueueName = (typeof ADDITIVE_QUEUE_NAMES)[number];
export const ADDITIVE_QUEUE_NAME_SET: ReadonlySet<QueueName> = new Set(
	ADDITIVE_QUEUE_NAMES,
);

// Cloudflare Free fixes Queue retention at 24 hours. Paid plans permit a longer
// horizon, but using the same minimum everywhere keeps transient payload
// residency bounded and makes self-hosted behavior plan-independent.
export const QUEUE_MESSAGE_RETENTION_SECONDS = 86_400;
export const INCOMPLETE_MULTIPART_RETENTION_SECONDS = 86_400;

export function cloudflareQueueName(name: QueueName): string {
	return `relayapi-selfhost-${name}`;
}

export const REQUIRED_LOCAL_SECRETS = [
	"CLOUDFLARE_API_TOKEN",
	"CLOUDFLARE_ACCOUNT_ID",
	"RELAYAPI_MIGRATION_DATABASE_URL",
	"RELAYAPI_RUNTIME_DATABASE_URL",
	"R2_ACCESS_KEY_ID",
	"R2_SECRET_ACCESS_KEY",
] as const;
