import type { AdditiveQueueName, QueueName } from "./constants.js";

export type PersistedQueueIds = Record<
	Exclude<QueueName, AdditiveQueueName>,
	string
> &
	Partial<Record<AdditiveQueueName, string>>;

export type ResolvedCloudflareResources = {
	kvNamespaceId: string;
	hyperdriveId: string;
	queues: Record<QueueName, string>;
};

export interface SelfHostFeatures {
	email: boolean;
	ai: boolean;
	downloader: boolean;
	/** Opt-in Cloudflare Container + Workflow media normalization. */
	mediaProcessing?: boolean;
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
		publicHostname: string;
		mediaHostname: string;
		thumbnailHostname: string;
		r2Jurisdiction: "default" | "eu";
		/**
		 * Non-secret Cloudflare certificate-authority bundle ID used to pin the
		 * Hyperdrive server trust anchor. Optional only while reading legacy operator
		 * configs; a clean create requires it and an existing config adopts the exact
		 * ID already attached to its pinned Hyperdrive.
		 */
		hyperdriveCaCertificateId?: string;
	};
	features: SelfHostFeatures;
	publishing?: {
		/**
		 * Non-secret HTTPS URL prefixes verified in the operator's TikTok app.
		 * These are copied into immutable account metadata when TikTok connects.
		 */
		tiktokVerifiedUrlPrefixes: string[];
	};
	github?: {
		repository: string;
	};
	resources?: {
		kvNamespaceId: string;
		hyperdriveId: string;
		queues: PersistedQueueIds;
	};
}

export interface SelfHostLock {
	schemaVersion: 1;
	channel: "stable";
	version: string;
	sourceRepository: string;
	/** SHA-256 of the exact GitHub stable-tag archive approved by the operator. */
	sourceArchiveSha256?: string;
	updatedAt: string;
}

export interface CliOptions {
	configPath: string;
	nonInteractive: boolean;
	dryRun: boolean;
	force: boolean;
	source?: string;
	/** Explicit acknowledgement that --source bypasses the sealed release archive. */
	allowUnsealedSource?: boolean;
	/** Explicit CA intent supplied by the operator for create or pinned rotation. */
	hyperdriveCaCertificateId?: string;
}

export interface CloudflareResourcePlan {
	kv: { name: string; id?: string; action: "create" | "reuse" };
	buckets: Array<{
		name: string;
		jurisdiction: "default" | "eu";
		action: "create" | "reuse";
	}>;
	queues: Array<{
		logicalName: QueueName;
		name: string;
		id?: string;
		messageRetentionSeconds: number;
		currentMessageRetentionSeconds?: number;
		action: "create" | "reuse";
	}>;
	hyperdrive: {
		name: string;
		id?: string;
		/** CA certificate observed from Cloudflare while producing this plan. */
		currentCaCertificateId?: string;
		caCertificateId: string;
		caCertificateAction: "set" | "retain" | "adopt" | "rotate";
		action: "create" | "reconcile";
		/** Readable Cloudflare fields that differ from the desired configuration. */
		visibleDrift: string[];
		/** Passwords are write-only, so an existing config is always re-attested. */
		credentialAction: "set" | "reapply_write_only";
	};
}
