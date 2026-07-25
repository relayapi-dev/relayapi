import {
	cloudflareQueueName,
	QUEUE_NAMES,
	type QueueName,
	RESOURCE_NAMES,
} from "./constants.js";
import type { CloudflareResourcePlan, SelfHostConfig } from "./types.js";

interface ApiEnvelope<T> {
	success: boolean;
	result: T;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: Array<{ code?: number; message?: string }>;
}

interface KvNamespace {
	id: string;
	title: string;
}

interface R2Bucket {
	name: string;
}

interface Queue {
	queue_id: string;
	queue_name: string;
}

interface HyperdriveConfig {
	id: string;
	name: string;
	origin?: {
		host?: string;
		port?: number;
		database?: string;
		user?: string;
	};
}

function errorMessage(body: ApiEnvelope<unknown>, status: number): string {
	const details = [...(body.errors ?? []), ...(body.messages ?? [])]
		.map((entry) => entry.message)
		.filter(Boolean)
		.join("; ");
	return details || `Cloudflare API request failed with HTTP ${status}`;
}

export class CloudflareClient {
	readonly accountId: string;
	readonly token: string;
	readonly baseUrl: string;

	constructor(
		accountId: string,
		token: string,
		baseUrl = "https://api.cloudflare.com/client/v4",
	) {
		if (!accountId || !token) {
			throw new Error("Cloudflare account ID and API token are required");
		}
		this.accountId = accountId;
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/$/, "");
	}

	private async request<T>(
		method: "GET" | "POST" | "PUT",
		path: string,
		body?: unknown,
	): Promise<T> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		let envelope: ApiEnvelope<T>;
		try {
			envelope = (await response.json()) as ApiEnvelope<T>;
		} catch {
			throw new Error(`Cloudflare API returned HTTP ${response.status}`);
		}
		if (!response.ok || !envelope.success) {
			throw new Error(errorMessage(envelope, response.status));
		}
		return envelope.result;
	}

	private account(path: string): string {
		return `/accounts/${encodeURIComponent(this.accountId)}${path}`;
	}

	async verifyAccess(zoneId: string): Promise<void> {
		const zone = await this.request<{ id: string; account?: { id?: string } }>(
			"GET",
			`/zones/${encodeURIComponent(zoneId)}`,
		);
		if (zone.id !== zoneId || zone.account?.id !== this.accountId) {
			throw new Error(
				"The configured zone does not belong to the configured Cloudflare account",
			);
		}
	}

	async listKvNamespaces(): Promise<KvNamespace[]> {
		return this.request(
			"GET",
			this.account("/storage/kv/namespaces?per_page=100"),
		);
	}

	async listBuckets(): Promise<R2Bucket[]> {
		const result = await this.request<{ buckets: R2Bucket[] }>(
			"GET",
			this.account("/r2/buckets?per_page=1000"),
		);
		return result.buckets ?? [];
	}

	async listQueues(): Promise<Queue[]> {
		return this.request("GET", this.account("/queues?per_page=100"));
	}

	async listHyperdrives(): Promise<HyperdriveConfig[]> {
		return this.request(
			"GET",
			this.account("/hyperdrive/configs?per_page=100"),
		);
	}

	async plan(): Promise<CloudflareResourcePlan> {
		const [kv, buckets, queues, hyperdrives] = await Promise.all([
			this.listKvNamespaces(),
			this.listBuckets(),
			this.listQueues(),
			this.listHyperdrives(),
		]);
		const kvMatches = kv.filter((item) => item.title === RESOURCE_NAMES.kv);
		if (kvMatches.length > 1) {
			throw new Error(`Multiple KV namespaces are named ${RESOURCE_NAMES.kv}`);
		}
		const hyperdriveMatches = hyperdrives.filter(
			(item) => item.name === RESOURCE_NAMES.hyperdrive,
		);
		if (hyperdriveMatches.length > 1) {
			throw new Error(
				`Multiple Hyperdrive configurations are named ${RESOURCE_NAMES.hyperdrive}`,
			);
		}
		const bucketNames = new Set(buckets.map((item) => item.name));
		const queueByName = new Map(queues.map((item) => [item.queue_name, item]));
		return {
			kv: {
				name: RESOURCE_NAMES.kv,
				...(kvMatches[0] ? { id: kvMatches[0].id } : {}),
				action: kvMatches[0] ? "reuse" : "create",
			},
			buckets: Object.values(RESOURCE_NAMES.buckets).map((name) => ({
				name,
				action: bucketNames.has(name) ? "reuse" : "create",
			})),
			queues: QUEUE_NAMES.map((logicalName) => {
				const name = cloudflareQueueName(logicalName);
				const existing = queueByName.get(name);
				return {
					logicalName,
					name,
					...(existing ? { id: existing.queue_id } : {}),
					action: existing ? "reuse" : "create",
				};
			}),
			hyperdrive: {
				name: RESOURCE_NAMES.hyperdrive,
				...(hyperdriveMatches[0] ? { id: hyperdriveMatches[0].id } : {}),
				action: hyperdriveMatches[0] ? "reuse" : "create",
			},
		};
	}

	async apply(
		config: SelfHostConfig,
		runtimeDatabaseUrl: string,
	): Promise<NonNullable<SelfHostConfig["resources"]>> {
		const plan = await this.plan();
		if (config.resources) {
			if (
				plan.kv.id !== config.resources.kvNamespaceId ||
				plan.hyperdrive.id !== config.resources.hyperdriveId ||
				plan.queues.some(
					(queue) => config.resources?.queues[queue.logicalName] !== queue.id,
				)
			) {
				throw new Error(
					"Provisioned Cloudflare resource IDs drifted from relayapi.selfhost.json",
				);
			}
		}
		let kvNamespaceId = plan.kv.id;
		if (!kvNamespaceId) {
			const created = await this.request<KvNamespace>(
				"POST",
				this.account("/storage/kv/namespaces"),
				{ title: RESOURCE_NAMES.kv },
			);
			kvNamespaceId = created.id;
		}

		for (const bucket of plan.buckets) {
			if (bucket.action === "create") {
				await this.request("POST", this.account("/r2/buckets"), {
					name: bucket.name,
				});
			}
		}

		const queueIds = {} as Record<QueueName, string>;
		for (const queue of plan.queues) {
			let id = queue.id;
			if (!id) {
				const created = await this.request<Queue>(
					"POST",
					this.account("/queues"),
					{ queue_name: queue.name },
				);
				id = created.queue_id;
			}
			queueIds[queue.logicalName] = id;
		}

		let hyperdriveId = plan.hyperdrive.id;
		const database = parsePostgresUrl(runtimeDatabaseUrl);
		if (!hyperdriveId) {
			const created = await this.request<HyperdriveConfig>(
				"POST",
				this.account("/hyperdrive/configs"),
				{
					name: RESOURCE_NAMES.hyperdrive,
					origin: {
						host: database.hostname,
						port: database.port,
						scheme: "postgresql",
						database: database.database,
						user: database.username,
						password: database.password,
					},
					caching: { disabled: true },
					mtls: { sslmode: database.sslmode },
				},
			);
			hyperdriveId = created.id;
		} else {
			const existing = await this.request<HyperdriveConfig>(
				"GET",
				this.account(`/hyperdrive/configs/${encodeURIComponent(hyperdriveId)}`),
			);
			if (
				existing.origin?.host !== database.hostname ||
				existing.origin?.port !== database.port ||
				existing.origin?.database !== database.database ||
				existing.origin?.user !== database.username
			) {
				throw new Error(
					`Existing Hyperdrive ${RESOURCE_NAMES.hyperdrive} points to a different database origin`,
				);
			}
		}

		await this.configureBucketPolicies(config, queueIds);

		return { kvNamespaceId, hyperdriveId, queues: queueIds };
	}

	private async configureBucketPolicies(
		config: SelfHostConfig,
		queues: Record<QueueName, string>,
	): Promise<void> {
		const mediaCleanupQueueId = queues["media-cleanup"];
		if (!mediaCleanupQueueId) {
			throw new Error("The media cleanup queue was not provisioned");
		}
		await this.ensureLifecycleRule(
			RESOURCE_NAMES.buckets.media,
			"relayapi-media-expiry",
			30,
		);
		await this.ensureLifecycleRule(
			RESOURCE_NAMES.buckets.queueRescue,
			"relayapi-queue-rescue-expiry",
			30,
		);
		await this.request(
			"PUT",
			this.account(
				`/event_notifications/r2/${encodeURIComponent(RESOURCE_NAMES.buckets.media)}/configuration/queues/${encodeURIComponent(mediaCleanupQueueId)}`,
			),
			{
				rules: [
					{
						prefix: "",
						suffix: "",
						actions: [
							"PutObject",
							"CompleteMultipartUpload",
							"CopyObject",
							"DeleteObject",
							"LifecycleDeletion",
						],
						description: "RelayAPI media thumbnail and cleanup events",
					},
				],
			},
		);

		await this.ensureBucketDomain(
			RESOURCE_NAMES.buckets.media,
			config.cloudflare.mediaHostname,
			config.cloudflare.zoneId,
		);
		await this.ensureBucketDomain(
			RESOURCE_NAMES.buckets.thumbnails,
			config.cloudflare.thumbnailHostname,
			config.cloudflare.zoneId,
		);
	}

	private async ensureLifecycleRule(
		bucket: string,
		id: string,
		expireDays: number,
	): Promise<void> {
		const path = this.account(
			`/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`,
		);
		const current = await this.request<{
			rules?: Array<Record<string, unknown>>;
		}>("GET", path);
		const rules = (current.rules ?? []).filter((rule) => rule.id !== id);
		rules.push({
			id,
			enabled: true,
			conditions: {},
			deleteObjectsTransition: {
				condition: { type: "Age", maxAge: expireDays * 86_400 },
			},
		});
		await this.request("PUT", path, { rules });
	}

	private async ensureBucketDomain(
		bucket: string,
		hostname: string,
		zoneId: string,
	): Promise<void> {
		const domains = await this.request<{ domains: Array<{ domain: string }> }>(
			"GET",
			this.account(`/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`),
		);
		if (!domains.domains.some((item) => item.domain === hostname)) {
			await this.request(
				"POST",
				this.account(
					`/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`,
				),
				{
					domain: hostname,
					zoneId,
					minTLS: "1.2",
					enabled: true,
				},
			);
		}
	}
}

export function parsePostgresUrl(value: string): {
	hostname: string;
	port: number;
	database: string;
	username: string;
	password: string;
	sslmode: "require" | "verify-ca" | "verify-full";
} {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Database URL is not a valid URL");
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new Error("Database URL must use postgres:// or postgresql://");
	}
	const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
	const username = decodeURIComponent(url.username);
	const password = decodeURIComponent(url.password);
	if (!url.hostname || !database || !username || !password) {
		throw new Error(
			"Database URL must contain host, database, username, and password",
		);
	}
	const configuredSslmode = url.searchParams.get("sslmode") ?? "require";
	if (!["require", "verify-ca", "verify-full"].includes(configuredSslmode)) {
		throw new Error(
			"Database sslmode must be require, verify-ca, or verify-full",
		);
	}
	return {
		hostname: url.hostname,
		port: url.port ? Number(url.port) : 5432,
		database,
		username,
		password,
		sslmode: configuredSslmode as "require" | "verify-ca" | "verify-full",
	};
}
