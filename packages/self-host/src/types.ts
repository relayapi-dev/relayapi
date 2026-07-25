import type { QueueName } from "./constants.js";

export interface SelfHostFeatures {
	email: boolean;
	ai: boolean;
	downloader: boolean;
}

export interface SelfHostConfig {
	schemaVersion: 1;
	instance: "relayapi";
	cloudflare: {
		accountId: string;
		zoneId: string;
		rootDomain: string;
		apiHostname: string;
		appHostname: string;
		mediaHostname: string;
		thumbnailHostname: string;
	};
	features: SelfHostFeatures;
	github?: {
		repository: string;
	};
	resources?: {
		kvNamespaceId: string;
		hyperdriveId: string;
		queues: Record<QueueName, string>;
	};
}

export interface SelfHostLock {
	schemaVersion: 1;
	channel: "stable";
	version: string;
	sourceRepository: string;
	updatedAt: string;
}

export interface CliOptions {
	configPath: string;
	nonInteractive: boolean;
	dryRun: boolean;
	source?: string;
}

export interface CloudflareResourcePlan {
	kv: { name: string; id?: string; action: "create" | "reuse" };
	buckets: Array<{ name: string; action: "create" | "reuse" }>;
	queues: Array<{
		logicalName: QueueName;
		name: string;
		id?: string;
		action: "create" | "reuse";
	}>;
	hyperdrive: {
		name: string;
		id?: string;
		action: "create" | "reuse";
	};
}
