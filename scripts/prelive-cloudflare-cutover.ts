import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
	BASELINE_GENERATION,
	MAINTENANCE_CONTROL_KEY,
	PRELIVE_CONTROL_CONVERGENCE_SECONDS,
	PRELIVE_CUTOVER_HOLD_SECONDS,
	PRELIVE_R2_EVENT_SETTLE_SECONDS,
} from "@relayapi/config";
import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";
import resources from "../apps/api/production-resources.json";

type ApiEnvelope<T> = {
	success?: boolean;
	result?: T;
	result_info?: {
		cursor?: string;
		is_truncated?: boolean;
		page?: number;
		total_pages?: number;
	};
	errors?: Array<{ message?: string }>;
};

type QueueResource = {
	queue_id?: string;
	queue_name?: string;
	settings?: Record<string, unknown> & { delivery_paused?: boolean };
	[key: string]: unknown;
};

type QueueMetrics = {
	backlog_bytes?: number;
	backlog_count?: number;
	oldest_message_timestamp_ms?: number;
};

type KvKey = { name?: string; expiration?: number; metadata?: unknown };
type R2Object = {
	custom_metadata?: Record<string, string>;
	key?: string;
	size?: number;
	etag?: string;
	http_metadata?: Record<string, unknown>;
	last_modified?: string;
	ssec?: boolean;
	storage_class?: string;
};
type R2Bucket = { name?: string; jurisdiction?: string };
type R2Jurisdiction = "default" | "eu" | "fedramp";
type R2LifecycleRule = {
	id: string;
	enabled: true;
	conditions: { prefix: string };
	abortMultipartUploadsTransition?: {
		condition: { type: "Age"; maxAge: number };
	};
	deleteObjectsTransition?: {
		condition: { type: "Age"; maxAge: number };
	};
};

export type PreliveCloudflareInventory = {
	schemaVersion: 1;
	targetBaselineGeneration: number;
	accountId: string;
	kv: {
		namespaceId: string;
		keys: Array<{
			name: string;
			expiration: number | null;
			metadataSha256: string | null;
			valueSha256: string;
		}>;
	};
	queues: Array<{
		id: string;
		name: string;
		configuration: Record<string, unknown>;
		settings: Record<string, unknown> | null;
		metrics: {
			backlogBytes: number;
			backlogCount: number;
			oldestMessageTimestampMs: number;
		} | null;
		destructiveTarget: boolean;
	}>;
	r2: {
		jurisdiction: R2Jurisdiction;
		buckets: Array<{
			name: string;
			jurisdiction: string;
			destructiveTarget: boolean;
			lifecycleRules: unknown[] | null;
			objects: Array<{
				customMetadata: Record<string, string> | null;
				key: string;
				size: number | null;
				etag: string | null;
				httpMetadata: Record<string, unknown> | null;
				lastModified: string | null;
				ssec: boolean | null;
				storageClass: string | null;
			}> | null;
			multipartUploads: Array<{
				initiated: string | null;
				key: string;
				storageClass: string | null;
				uploadId: string;
			}> | null;
		}>;
	};
};

export const CUTOVER_MAINTENANCE_KEY = MAINTENANCE_CONTROL_KEY;
export const CUTOVER_TARGET_GENERATION = BASELINE_GENERATION;
// The drain is consumed by the still-live generation-1 Workers. Generation 2
// is not deployed until the queues are empty, paused, and the control record
// has been advanced to generation-2 maintenance.
export const CUTOVER_DRAIN_GENERATION = 1;
export const CUTOVER_HOLD_SECONDS = PRELIVE_CUTOVER_HOLD_SECONDS;
export const CUTOVER_CONTROL_CONVERGENCE_SECONDS =
	PRELIVE_CONTROL_CONVERGENCE_SECONDS;
export const CUTOVER_R2_EVENT_SETTLE_SECONDS = PRELIVE_R2_EVENT_SETTLE_SECONDS;
const CLOUDFLARE_API_ROOT = "https://api.cloudflare.com/client/v4";
const QUEUE_PURGE_POLL_ATTEMPTS = 300;
const QUEUE_PURGE_POLL_INTERVAL_MS = 2_000;
const QUEUE_DRAIN_ZERO_READS = 3;
const QUEUE_DRAIN_ZERO_INTERVAL_MS = 15_000;

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, nested]) => [key, canonicalize(nested)]),
		);
	}
	return value;
}

export function canonicalCloudflareInventory(
	inventory: PreliveCloudflareInventory,
): string {
	return `${JSON.stringify(canonicalize(inventory), null, 2)}\n`;
}

export function cloudflareInventorySha256(
	inventory: PreliveCloudflareInventory,
): string {
	return createHash("sha256")
		.update(canonicalCloudflareInventory(inventory))
		.digest("hex");
}

export function parseApprovedCloudflareInventory(
	source: string,
): PreliveCloudflareInventory {
	const inventory = JSON.parse(source) as PreliveCloudflareInventory;
	if (
		inventory.schemaVersion !== 1 ||
		inventory.targetBaselineGeneration !== CUTOVER_TARGET_GENERATION ||
		!inventory.accountId ||
		!inventory.kv?.namespaceId ||
		!Array.isArray(inventory.kv.keys) ||
		!Array.isArray(inventory.queues) ||
		!Array.isArray(inventory.r2?.buckets)
	) {
		throw new Error("Approved Cloudflare inventory has an invalid shape");
	}
	return inventory;
}

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value || /\s/.test(value)) throw new Error(`${name} is required`);
	return value;
}

function queueNames(): string[] {
	return Array.from(
		new Set(resources.queueConsumers.map((consumer) => consumer.queue)),
	).sort();
}

function bucketNames(): string[] {
	return Array.from(
		new Set([...resources.privateR2Buckets, resources.publicAssetsBucket]),
	).sort();
}

export function queuePurgeCompleted(value: unknown): boolean {
	if (value === true || value === false) return value;
	if (value === undefined) return false;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	throw new Error(
		`Cloudflare Queue purge returned an invalid completed value: ${JSON.stringify(value)}`,
	);
}

/**
 * Cloudflare exposes only the last purge's `started_at`, not an operation ID.
 * Preserve it before POST and require a different valid timestamp afterwards
 * so an old `completed: true` cannot attest the new destructive request.
 * https://developers.cloudflare.com/api/resources/queues/subresources/purge/
 */
export function queuePurgeStartedAt(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`Cloudflare Queue purge returned an invalid started_at value: ${JSON.stringify(value)}`,
		);
	}
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) {
		throw new Error(
			`Cloudflare Queue purge returned an invalid started_at value: ${JSON.stringify(value)}`,
		);
	}
	return new Date(milliseconds).toISOString();
}

export function reviewedLifecycleRules(bucket: string): R2LifecycleRule[] {
	const rules: R2LifecycleRule[] = [
		{
			id: "relayapi-abort-incomplete-multipart",
			enabled: true,
			conditions: { prefix: "" },
			abortMultipartUploadsTransition: {
				condition: {
					type: "Age",
					maxAge: resources.incompleteMultipartRetentionSeconds,
				},
			},
		},
	];
	if (bucket === resources.mediaBucket) {
		rules.push({
			id: "relayapi-media-expiry",
			enabled: true,
			conditions: { prefix: "" },
			deleteObjectsTransition: {
				condition: {
					type: "Age",
					maxAge: resources.mediaRetentionSeconds,
				},
			},
		});
	}
	if (bucket === resources.queueRescueBucket) {
		rules.push({
			id: "relayapi-queue-rescue-expiry",
			enabled: true,
			conditions: { prefix: "" },
			deleteObjectsTransition: {
				condition: {
					type: "Age",
					maxAge: resources.queueRescueRetentionSeconds,
				},
			},
		});
	}
	return rules;
}

function encodeR2ObjectKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

class CloudflareCutoverClient {
	private readonly r2S3FetchOverride?: typeof fetch;
	private readonly r2S3Client: AwsClient | null;

	constructor(
		private readonly accountId: string,
		private readonly token: string,
		private readonly baseUrl = CLOUDFLARE_API_ROOT,
		private readonly sleep: (milliseconds: number) => Promise<void> = (
			milliseconds,
		) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		r2?: {
			accessKeyId?: string;
			secretAccessKey?: string;
			fetch?: typeof fetch;
		},
	) {
		this.r2S3FetchOverride = r2?.fetch;
		this.r2S3Client =
			r2?.accessKeyId && r2.secretAccessKey
				? new AwsClient({
						accessKeyId: r2.accessKeyId,
						secretAccessKey: r2.secretAccessKey,
						service: "s3",
						region: "auto",
					})
				: null;
	}

	private async request<T>(
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		options: {
			body?: unknown;
			r2?: boolean;
			r2Jurisdiction?: R2Jurisdiction;
			contentType?: string;
		} = {},
	): Promise<{
		result: T;
		cursor?: string;
		isTruncated?: boolean;
		page?: number;
		totalPages?: number;
	}> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...(options.r2 || options.r2Jurisdiction
					? {
							"cf-r2-jurisdiction":
								options.r2Jurisdiction ?? resources.r2Jurisdiction,
						}
					: {}),
				...(options.body === undefined
					? {}
					: {
							"Content-Type": options.contentType ?? "application/json",
						}),
			},
			...(options.body === undefined
				? {}
				: {
						body:
							typeof options.body === "string"
								? options.body
								: JSON.stringify(options.body),
					}),
			signal: AbortSignal.timeout(30_000),
		});
		let envelope: ApiEnvelope<T>;
		try {
			envelope = (await response.json()) as ApiEnvelope<T>;
		} catch {
			throw new Error(`Cloudflare returned non-JSON HTTP ${response.status}`);
		}
		if (!response.ok || !envelope.success || envelope.result === undefined) {
			const detail = envelope.errors
				?.map((error) => error.message)
				.filter(Boolean)
				.join("; ");
			throw new Error(
				detail || `Cloudflare request failed with HTTP ${response.status}`,
			);
		}
		return {
			result: envelope.result,
			...(envelope.result_info?.cursor
				? { cursor: envelope.result_info.cursor }
				: {}),
			...(envelope.result_info?.is_truncated === undefined
				? {}
				: { isTruncated: envelope.result_info.is_truncated }),
			...(envelope.result_info?.page === undefined
				? {}
				: { page: envelope.result_info.page }),
			...(envelope.result_info?.total_pages === undefined
				? {}
				: { totalPages: envelope.result_info.total_pages }),
		};
	}

	private account(path: string): string {
		return `/accounts/${encodeURIComponent(this.accountId)}${path}`;
	}

	private async requestBytes(path: string): Promise<Uint8Array> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			headers: { Authorization: `Bearer ${this.token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			throw new Error(
				`Cloudflare raw-value request failed with HTTP ${response.status}`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async setRuntimeMode(
		mode: "open" | "draining" | "maintenance",
		targetBaselineGeneration = CUTOVER_TARGET_GENERATION,
	): Promise<void> {
		if (
			!Number.isSafeInteger(targetBaselineGeneration) ||
			targetBaselineGeneration < 1
		) {
			throw new Error(
				"Runtime control target generation must be a positive safe integer",
			);
		}
		const value = JSON.stringify({
			schema_version: 1,
			target_baseline_generation: targetBaselineGeneration,
			maintenance: mode === "maintenance",
			mode,
		});
		await this.request(
			"PUT",
			this.account(
				`/storage/kv/namespaces/${encodeURIComponent(resources.kvNamespaceId)}/values/${encodeURIComponent(CUTOVER_MAINTENANCE_KEY)}`,
			),
			{ body: value, contentType: "text/plain" },
		);
	}

	async setMaintenance(maintenance: boolean): Promise<void> {
		return this.setRuntimeMode(maintenance ? "maintenance" : "open");
	}

	private async listQueues(): Promise<QueueResource[]> {
		const queues: QueueResource[] = [];
		for (let pageNumber = 1; pageNumber <= 10_000; pageNumber++) {
			const query = new URLSearchParams({ per_page: "100" });
			if (pageNumber > 1) query.set("page", String(pageNumber));
			const page = await this.request<QueueResource[]>(
				"GET",
				this.account(`/queues?${query}`),
			);
			queues.push(...page.result);
			const totalPages = page.totalPages;
			if (
				(totalPages !== undefined && pageNumber >= totalPages) ||
				(totalPages === undefined && page.result.length < 100)
			) {
				return queues;
			}
		}
		throw new Error("Cloudflare Queue inventory exceeded 10000 pages");
	}

	private async reviewedQueues(): Promise<Map<string, QueueResource>> {
		const result = await this.listQueues();
		const byName = new Map(
			result.map((queue) => [queue.queue_name ?? "", queue]),
		);
		if (byName.size !== result.length) {
			throw new Error("Cloudflare Queue inventory contains duplicate names");
		}
		for (const name of queueNames()) {
			const queue = byName.get(name);
			if (!queue?.queue_id) throw new Error(`Missing reviewed queue ${name}`);
		}
		return byName;
	}

	private async queueMetrics(queue: QueueResource): Promise<{
		backlogBytes: number;
		backlogCount: number;
		oldestMessageTimestampMs: number;
	}> {
		if (!queue.queue_id || !queue.queue_name) {
			throw new Error(
				"Cloudflare Queue metrics require an exact queue identity",
			);
		}
		const { result } = await this.request<QueueMetrics>(
			"GET",
			this.account(`/queues/${encodeURIComponent(queue.queue_id)}/metrics`),
		);
		for (const [name, value] of Object.entries({
			backlog_bytes: result.backlog_bytes,
			backlog_count: result.backlog_count,
			oldest_message_timestamp_ms: result.oldest_message_timestamp_ms,
		})) {
			if (
				typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0
			) {
				throw new Error(
					`Cloudflare Queue ${queue.queue_name} returned invalid ${name}`,
				);
			}
		}
		return {
			backlogBytes: result.backlog_bytes as number,
			backlogCount: result.backlog_count as number,
			oldestMessageTimestampMs: result.oldest_message_timestamp_ms as number,
		};
	}

	/** Realtime metrics are approximate; require three spaced all-zero reads. */
	async assertReviewedQueuesDrained(): Promise<void> {
		for (let read = 0; read < QUEUE_DRAIN_ZERO_READS; read++) {
			const byName = await this.reviewedQueues();
			for (const name of queueNames()) {
				const queue = byName.get(name);
				if (!queue?.queue_id) throw new Error(`Missing reviewed queue ${name}`);
				if (queue.settings?.delivery_paused === true) {
					throw new Error(
						`Reviewed Queue ${name} was paused before its backlog drained`,
					);
				}
				const metrics = await this.queueMetrics(queue);
				if (metrics.backlogCount !== 0 || metrics.backlogBytes !== 0) {
					throw new Error(
						`Reviewed Queue ${name} still has ${metrics.backlogCount} messages/${metrics.backlogBytes} bytes`,
					);
				}
			}
			if (read + 1 < QUEUE_DRAIN_ZERO_READS) {
				await this.sleep(QUEUE_DRAIN_ZERO_INTERVAL_MS);
			}
		}
	}

	async setQueueDeliveryPaused(paused: boolean): Promise<void> {
		const byName = await this.reviewedQueues();
		for (const name of queueNames()) {
			const queue = byName.get(name);
			if (!queue?.queue_id) throw new Error(`Missing reviewed queue ${name}`);
			if (queue.settings?.delivery_paused !== paused) {
				await this.request(
					"PATCH",
					this.account(`/queues/${encodeURIComponent(queue.queue_id)}`),
					{ body: { settings: { delivery_paused: paused } } },
				);
			}
			const readback = await this.request<QueueResource>(
				"GET",
				this.account(`/queues/${encodeURIComponent(queue.queue_id)}`),
			);
			if (
				readback.result.queue_id !== queue.queue_id ||
				readback.result.queue_name !== name ||
				readback.result.settings?.delivery_paused !== paused
			) {
				throw new Error(
					`Cloudflare Queue ${name} delivery pause readback did not equal ${paused}`,
				);
			}
		}
	}

	async assertQueueDeliveryPaused(paused: boolean): Promise<void> {
		const byName = await this.reviewedQueues();
		for (const name of queueNames()) {
			const queue = byName.get(name);
			if (!queue?.queue_id) throw new Error(`Missing reviewed queue ${name}`);
			const readback = await this.request<QueueResource>(
				"GET",
				this.account(`/queues/${encodeURIComponent(queue.queue_id)}`),
			);
			if (
				readback.result.queue_id !== queue.queue_id ||
				readback.result.queue_name !== name ||
				readback.result.settings?.delivery_paused !== paused
			) {
				throw new Error(
					`Reviewed Queue ${name} is not ${paused ? "paused" : "resumed"}`,
				);
			}
		}
	}

	async purgeQueues(): Promise<void> {
		const byName = await this.reviewedQueues();
		await this.purgeQueueResources(
			queueNames().map((name) => {
				const queue = byName.get(name);
				if (!queue?.queue_id) throw new Error(`Missing reviewed queue ${name}`);
				return { id: queue.queue_id, name };
			}),
		);
	}

	async purgeApprovedQueues(
		expected: PreliveCloudflareInventory,
	): Promise<void> {
		const current = await this.listQueues();
		const byId = new Map(current.map((queue) => [queue.queue_id ?? "", queue]));
		const targets = expected.queues.filter(
			({ destructiveTarget }) => destructiveTarget,
		);
		for (const target of targets) {
			const queue = byId.get(target.id);
			if (
				queue?.queue_name !== target.name ||
				JSON.stringify(canonicalize(queue)) !==
					JSON.stringify(canonicalize(target.configuration)) ||
				queue.settings?.delivery_paused !== true
			) {
				throw new Error(
					`Approved Queue ${target.name}/${target.id} changed or is not paused`,
				);
			}
		}
		await this.purgeQueueResources(
			targets.map(({ id, name }) => ({ id, name })),
		);
	}

	private async purgeQueueResources(
		queues: Array<{ id: string; name: string }>,
	): Promise<void> {
		const previousPurgeStarts = new Map<string, string | undefined>();
		for (const queue of queues) {
			const previous = await this.request<{
				completed?: boolean | string;
				started_at?: string;
			}>("GET", this.account(`/queues/${encodeURIComponent(queue.id)}/purge`));
			previousPurgeStarts.set(
				queue.name,
				queuePurgeStartedAt(previous.result.started_at),
			);
		}
		for (const queue of queues) {
			await this.request(
				"POST",
				this.account(`/queues/${encodeURIComponent(queue.id)}/purge`),
				{ body: { delete_messages_permanently: true } },
			);
		}
		for (let poll = 0; poll < QUEUE_PURGE_POLL_ATTEMPTS; poll++) {
			let allComplete = true;
			for (const queue of queues) {
				const { result } = await this.request<{
					completed?: boolean | string;
					started_at?: string;
				}>(
					"GET",
					this.account(`/queues/${encodeURIComponent(queue.id)}/purge`),
				);
				const startedAt = queuePurgeStartedAt(result.started_at);
				const isCurrentOperation =
					startedAt !== undefined &&
					startedAt !== previousPurgeStarts.get(queue.name);
				const completed = queuePurgeCompleted(result.completed);
				allComplete = isCurrentOperation && completed && allComplete;
			}
			if (allComplete) return;
			await this.sleep(QUEUE_PURGE_POLL_INTERVAL_MS);
		}
		throw new Error("Queue purge did not complete within ten minutes");
	}

	async clearApplicationKv(): Promise<void> {
		const namespacePath = this.account(
			`/storage/kv/namespaces/${encodeURIComponent(resources.kvNamespaceId)}`,
		);
		const names = (await this.listApplicationKvKeys())
			.map(({ name }) => name)
			.filter((name) => name !== CUTOVER_MAINTENANCE_KEY);

		for (let index = 0; index < names.length; index += 10_000) {
			await this.request("POST", `${namespacePath}/bulk/delete`, {
				body: names.slice(index, index + 10_000),
			});
		}
	}

	private async listApplicationKvKeys(): Promise<KvKey[]> {
		const namespacePath = this.account(
			`/storage/kv/namespaces/${encodeURIComponent(resources.kvNamespaceId)}`,
		);
		const keys: KvKey[] = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ limit: "1000" });
			if (cursor) query.set("cursor", cursor);
			const page = await this.request<KvKey[]>(
				"GET",
				`${namespacePath}/keys?${query}`,
			);
			for (const key of page.result) {
				if (!key.name)
					throw new Error("Cloudflare KV returned an empty key name");
				keys.push(key);
			}
			cursor = page.cursor;
		} while (cursor);
		const sorted = [...keys].sort((left, right) =>
			(left.name as string).localeCompare(right.name as string),
		);
		if (new Set(sorted.map(({ name }) => name)).size !== keys.length) {
			throw new Error("Cloudflare KV inventory contains duplicate key names");
		}
		return sorted;
	}

	private async listR2Buckets(
		jurisdiction: R2Jurisdiction,
	): Promise<R2Bucket[]> {
		const buckets: R2Bucket[] = [];
		let cursor: string | undefined;
		const seenCursors = new Set<string>();
		do {
			const query = new URLSearchParams({ per_page: "1000" });
			if (cursor) query.set("cursor", cursor);
			const page = await this.request<{ buckets?: R2Bucket[] }>(
				"GET",
				this.account(`/r2/buckets?${query}`),
				{ r2Jurisdiction: jurisdiction },
			);
			if (!Array.isArray(page.result.buckets)) {
				throw new Error(`R2 ${jurisdiction} returned an invalid bucket list`);
			}
			buckets.push(...page.result.buckets);
			cursor = page.cursor;
			if (cursor && seenCursors.has(cursor)) {
				throw new Error(`R2 ${jurisdiction} repeated a bucket-list cursor`);
			}
			if (cursor) seenCursors.add(cursor);
		} while (cursor);
		return buckets;
	}

	private async listR2Objects(
		bucket: string,
	): Promise<
		NonNullable<PreliveCloudflareInventory["r2"]["buckets"][number]["objects"]>
	> {
		const objects: NonNullable<
			PreliveCloudflareInventory["r2"]["buckets"][number]["objects"]
		> = [];
		let cursor: string | undefined;
		do {
			const query = new URLSearchParams({ per_page: "1000" });
			if (cursor) query.set("cursor", cursor);
			const page = await this.request<R2Object[]>(
				"GET",
				this.account(
					`/r2/buckets/${encodeURIComponent(bucket)}/objects?${query}`,
				),
				{ r2: true },
			);
			for (const object of page.result) {
				if (!object.key) throw new Error(`R2 ${bucket} returned an empty key`);
				objects.push({
					customMetadata:
						object.custom_metadata &&
						typeof object.custom_metadata === "object" &&
						!Array.isArray(object.custom_metadata)
							? (canonicalize(object.custom_metadata) as Record<string, string>)
							: null,
					key: object.key,
					size:
						typeof object.size === "number" && Number.isSafeInteger(object.size)
							? object.size
							: null,
					etag:
						typeof object.etag === "string" && object.etag.length > 0
							? object.etag
							: null,
					httpMetadata:
						object.http_metadata &&
						typeof object.http_metadata === "object" &&
						!Array.isArray(object.http_metadata)
							? (canonicalize(object.http_metadata) as Record<string, unknown>)
							: null,
					lastModified:
						typeof object.last_modified === "string" &&
						object.last_modified.length > 0
							? object.last_modified
							: null,
					ssec: typeof object.ssec === "boolean" ? object.ssec : null,
					storageClass:
						typeof object.storage_class === "string" &&
						object.storage_class.length > 0
							? object.storage_class
							: null,
				});
			}
			cursor = page.isTruncated ? page.cursor : undefined;
			if (page.isTruncated && !cursor) {
				throw new Error(
					`R2 ${bucket} object inventory truncated without a cursor`,
				);
			}
		} while (cursor);
		const sorted = [...objects].sort((left, right) =>
			left.key.localeCompare(right.key),
		);
		if (new Set(sorted.map(({ key }) => key)).size !== objects.length) {
			throw new Error(`R2 ${bucket} inventory contains duplicate object keys`);
		}
		return sorted;
	}

	private async r2S3Fetch(url: URL, init?: RequestInit): Promise<Response> {
		if (this.r2S3FetchOverride) return this.r2S3FetchOverride(url, init);
		if (!this.r2S3Client) {
			throw new Error(
				"R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required for multipart inventory",
			);
		}
		return this.r2S3Client.fetch(url, init);
	}

	private async listR2MultipartUploads(
		bucket: string,
	): Promise<
		NonNullable<
			PreliveCloudflareInventory["r2"]["buckets"][number]["multipartUploads"]
		>
	> {
		const uploads: NonNullable<
			PreliveCloudflareInventory["r2"]["buckets"][number]["multipartUploads"]
		> = [];
		let keyMarker: string | undefined;
		let uploadIdMarker: string | undefined;
		for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
			const url = new URL(
				`https://${this.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}`,
			);
			url.searchParams.set("uploads", "");
			url.searchParams.set("max-uploads", "1000");
			if (keyMarker) url.searchParams.set("key-marker", keyMarker);
			if (uploadIdMarker) {
				url.searchParams.set("upload-id-marker", uploadIdMarker);
			}
			const response = await this.r2S3Fetch(url, { method: "GET" });
			if (!response.ok) {
				throw new Error(
					`R2 ${bucket} multipart inventory failed with HTTP ${response.status}`,
				);
			}
			const parsed = new XMLParser({ trimValues: true }).parse(
				await response.text(),
			) as {
				ListMultipartUploadsResult?: {
					Upload?: Array<Record<string, unknown>> | Record<string, unknown>;
					IsTruncated?: boolean | string;
					NextKeyMarker?: string;
					NextUploadIdMarker?: string;
				};
			};
			const result = parsed.ListMultipartUploadsResult;
			if (!result) {
				throw new Error(
					`R2 ${bucket} returned invalid multipart inventory XML`,
				);
			}
			const pageUploads = result.Upload
				? Array.isArray(result.Upload)
					? result.Upload
					: [result.Upload]
				: [];
			for (const upload of pageUploads) {
				const key = upload.Key;
				const uploadId = upload.UploadId;
				if (
					typeof key !== "string" ||
					key.length === 0 ||
					typeof uploadId !== "string" ||
					uploadId.length === 0
				) {
					throw new Error(`R2 ${bucket} returned an invalid multipart upload`);
				}
				uploads.push({
					key,
					uploadId,
					initiated:
						typeof upload.Initiated === "string" ? upload.Initiated : null,
					storageClass:
						typeof upload.StorageClass === "string"
							? upload.StorageClass
							: null,
				});
			}
			const truncated =
				result.IsTruncated === true || result.IsTruncated === "true";
			if (!truncated) {
				return uploads.sort(
					(left, right) =>
						left.key.localeCompare(right.key) ||
						left.uploadId.localeCompare(right.uploadId),
				);
			}
			if (
				typeof result.NextKeyMarker !== "string" ||
				!result.NextKeyMarker ||
				typeof result.NextUploadIdMarker !== "string" ||
				!result.NextUploadIdMarker ||
				(result.NextKeyMarker === keyMarker &&
					result.NextUploadIdMarker === uploadIdMarker)
			) {
				throw new Error(
					`R2 ${bucket} multipart inventory truncated without advancing markers`,
				);
			}
			keyMarker = result.NextKeyMarker;
			uploadIdMarker = result.NextUploadIdMarker;
		}
		throw new Error(`R2 ${bucket} multipart inventory exceeded 10000 pages`);
	}

	private async abortR2MultipartUpload(
		bucket: string,
		key: string,
		uploadId: string,
	): Promise<void> {
		const encodedKey = key.split("/").map(encodeURIComponent).join("/");
		const url = new URL(
			`https://${this.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(bucket)}/${encodedKey}`,
		);
		url.searchParams.set("uploadId", uploadId);
		const response = await this.r2S3Fetch(url, { method: "DELETE" });
		if (!response.ok && response.status !== 404) {
			throw new Error(
				`R2 ${bucket} multipart abort failed with HTTP ${response.status}`,
			);
		}
	}

	private async captureKvInventory(): Promise<
		PreliveCloudflareInventory["kv"]["keys"]
	> {
		const keys = await this.listApplicationKvKeys();
		const inventory = await Promise.all(
			keys.map(async (key) => {
				const name = key.name as string;
				const bytes = await this.requestBytes(
					this.account(
						`/storage/kv/namespaces/${encodeURIComponent(resources.kvNamespaceId)}/values/${encodeURIComponent(name)}`,
					),
				);
				return {
					name,
					expiration:
						typeof key.expiration === "number" &&
						Number.isSafeInteger(key.expiration)
							? key.expiration
							: null,
					metadataSha256:
						key.metadata === undefined
							? null
							: createHash("sha256")
									.update(JSON.stringify(canonicalize(key.metadata)))
									.digest("hex"),
					valueSha256: createHash("sha256").update(bytes).digest("hex"),
				};
			}),
		);
		inventory.sort((left, right) => left.name.localeCompare(right.name));
		return inventory;
	}

	async captureInventory(): Promise<PreliveCloudflareInventory> {
		const jurisdiction = resources.r2Jurisdiction as R2Jurisdiction;
		const [queues, kvKeys, defaultBuckets, euBuckets, fedrampBuckets] =
			await Promise.all([
				this.listQueues(),
				this.captureKvInventory(),
				this.listR2Buckets("default"),
				this.listR2Buckets("eu"),
				this.listR2Buckets("fedramp"),
			]);
		const reviewedQueueNames = new Set(queueNames());
		const reviewedBucketNames = new Set(bucketNames());
		const queueInventory = await Promise.all(
			queues.map(async (queue) => {
				if (!queue.queue_id || !queue.queue_name) {
					throw new Error(
						"Cloudflare Queue inventory returned an empty ID or name",
					);
				}
				return {
					id: queue.queue_id,
					name: queue.queue_name,
					configuration: canonicalize(queue) as Record<string, unknown>,
					settings: queue.settings
						? (canonicalize(queue.settings) as Record<string, unknown>)
						: null,
					metrics: reviewedQueueNames.has(queue.queue_name)
						? await this.queueMetrics(queue)
						: null,
					destructiveTarget: reviewedQueueNames.has(queue.queue_name),
				};
			}),
		);
		queueInventory.sort(
			(left, right) =>
				left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
		);
		if (
			new Set(queueInventory.map(({ name }) => name)).size !== queues.length
		) {
			throw new Error("Cloudflare Queue inventory contains duplicate names");
		}
		for (const name of reviewedQueueNames) {
			if (!queueInventory.some((queue) => queue.name === name)) {
				throw new Error(`Missing reviewed queue ${name}`);
			}
		}

		const bucketByIdentity = new Map<string, R2Bucket>();
		for (const bucket of [...defaultBuckets, ...euBuckets, ...fedrampBuckets]) {
			if (!bucket.name || !bucket.jurisdiction) {
				throw new Error(
					"Cloudflare R2 inventory returned an empty bucket identity",
				);
			}
			const key = `${bucket.jurisdiction}:${bucket.name}`;
			if (bucketByIdentity.has(key)) {
				throw new Error(`Cloudflare R2 inventory repeated ${key}`);
			}
			bucketByIdentity.set(key, bucket);
		}
		for (const name of reviewedBucketNames) {
			const expected = bucketByIdentity.get(`${jurisdiction}:${name}`);
			if (!expected) {
				throw new Error(
					`Missing reviewed R2 bucket ${name} in ${jurisdiction}`,
				);
			}
			const crossJurisdiction = [...bucketByIdentity.values()].find(
				(bucket) =>
					bucket.name === name && bucket.jurisdiction !== jurisdiction,
			);
			if (crossJurisdiction) {
				throw new Error(
					`Reviewed R2 bucket ${name} exists in multiple jurisdictions`,
				);
			}
		}
		const buckets = await Promise.all(
			[...bucketByIdentity.values()].map(async (bucket) => {
				const name = bucket.name as string;
				const destructiveTarget =
					bucket.jurisdiction === jurisdiction && reviewedBucketNames.has(name);
				const lifecycle = destructiveTarget
					? await this.request<{ rules?: unknown[] }>(
							"GET",
							this.account(`/r2/buckets/${encodeURIComponent(name)}/lifecycle`),
							{ r2Jurisdiction: jurisdiction },
						)
					: null;
				if (destructiveTarget && !Array.isArray(lifecycle?.result.rules)) {
					throw new Error(`R2 ${name} returned invalid lifecycle rules`);
				}
				return {
					name,
					jurisdiction: bucket.jurisdiction as string,
					destructiveTarget,
					lifecycleRules: destructiveTarget
						? (canonicalize(lifecycle?.result.rules) as unknown[])
						: null,
					objects: destructiveTarget ? await this.listR2Objects(name) : null,
					multipartUploads: destructiveTarget
						? await this.listR2MultipartUploads(name)
						: null,
				};
			}),
		);
		buckets.sort(
			(left, right) =>
				left.jurisdiction.localeCompare(right.jurisdiction) ||
				left.name.localeCompare(right.name),
		);
		return {
			schemaVersion: 1,
			targetBaselineGeneration: CUTOVER_TARGET_GENERATION,
			accountId: this.accountId,
			kv: { namespaceId: resources.kvNamespaceId, keys: kvKeys },
			queues: queueInventory,
			r2: { jurisdiction, buckets },
		};
	}

	async assertInventory(
		expected: PreliveCloudflareInventory,
		expectedSha256: string,
	): Promise<void> {
		if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
			throw new Error("Approved Cloudflare inventory SHA-256 is invalid");
		}
		if (expected.accountId !== this.accountId) {
			throw new Error("Approved Cloudflare inventory targets another account");
		}
		if (expected.kv.namespaceId !== resources.kvNamespaceId) {
			throw new Error(
				"Approved Cloudflare inventory targets another KV namespace",
			);
		}
		const approvedDigest = cloudflareInventorySha256(expected);
		if (approvedDigest !== expectedSha256) {
			throw new Error(
				"Approved Cloudflare inventory file digest does not match",
			);
		}
		const actual = await this.captureInventory();
		if (
			canonicalCloudflareInventory(actual) !==
			canonicalCloudflareInventory(expected)
		) {
			throw new Error(
				`Live Cloudflare inventory changed; expected ${expectedSha256}, got ${cloudflareInventorySha256(actual)}`,
			);
		}
	}

	async emptyApprovedR2(expected: PreliveCloudflareInventory): Promise<void> {
		const jurisdiction = resources.r2Jurisdiction as R2Jurisdiction;
		for (const bucket of expected.r2.buckets.filter(
			(bucket) => bucket.destructiveTarget,
		)) {
			if (
				bucket.jurisdiction !== jurisdiction ||
				!Array.isArray(bucket.objects) ||
				!Array.isArray(bucket.multipartUploads) ||
				!Array.isArray(bucket.lifecycleRules)
			) {
				throw new Error(
					`Approved R2 target ${bucket.name} has an invalid shape`,
				);
			}
			const lifecycle = await this.request<{ rules?: unknown[] }>(
				"GET",
				this.account(
					`/r2/buckets/${encodeURIComponent(bucket.name)}/lifecycle`,
				),
				{ r2Jurisdiction: jurisdiction },
			);
			const actualObjects = await this.listR2Objects(bucket.name);
			const actualMultipartUploads = await this.listR2MultipartUploads(
				bucket.name,
			);
			if (
				JSON.stringify(canonicalize(lifecycle.result.rules ?? null)) !==
					JSON.stringify(canonicalize(bucket.lifecycleRules)) ||
				JSON.stringify(actualObjects) !== JSON.stringify(bucket.objects) ||
				JSON.stringify(actualMultipartUploads) !==
					JSON.stringify(bucket.multipartUploads)
			) {
				throw new Error(
					`R2 ${bucket.name} changed after inventory approval; refusing deletion`,
				);
			}
			for (const upload of bucket.multipartUploads) {
				await this.abortR2MultipartUpload(
					bucket.name,
					upload.key,
					upload.uploadId,
				);
			}
			for (const object of bucket.objects) {
				await this.request(
					"DELETE",
					this.account(
						`/r2/buckets/${encodeURIComponent(bucket.name)}/objects/${encodeR2ObjectKey(object.key)}`,
					),
					{ r2: true },
				);
			}
		}
	}

	async clearApprovedApplicationKv(
		expected: PreliveCloudflareInventory,
	): Promise<void> {
		if (expected.kv.namespaceId !== resources.kvNamespaceId) {
			throw new Error("Approved inventory targets another KV namespace");
		}
		const actual = await this.captureKvInventory();
		if (JSON.stringify(actual) !== JSON.stringify(expected.kv.keys)) {
			throw new Error("KV changed after inventory approval; refusing deletion");
		}
		const namespacePath = this.account(
			`/storage/kv/namespaces/${encodeURIComponent(resources.kvNamespaceId)}`,
		);
		const names = expected.kv.keys
			.map(({ name }) => name)
			.filter((name) => name !== CUTOVER_MAINTENANCE_KEY);
		for (let index = 0; index < names.length; index += 10_000) {
			await this.request("POST", `${namespacePath}/bulk/delete`, {
				body: names.slice(index, index + 10_000),
			});
		}
		const remaining = await this.listApplicationKvKeys();
		if (
			remaining.some(({ name }) => name !== CUTOVER_MAINTENANCE_KEY) ||
			remaining.length > 1
		) {
			throw new Error("KV contains an unapproved or undeleted key after wipe");
		}
	}

	async ensureR2Buckets(): Promise<void> {
		const jurisdiction = resources.r2Jurisdiction as R2Jurisdiction;
		const byJurisdiction = new Map<R2Jurisdiction, R2Bucket[]>();
		await Promise.all(
			(["default", "eu", "fedramp"] as const).map(async (candidate) => {
				byJurisdiction.set(candidate, await this.listR2Buckets(candidate));
			}),
		);
		const selected = byJurisdiction.get(jurisdiction) ?? [];
		const selectedByName = new Map(
			selected.map((bucket) => [bucket.name ?? "", bucket]),
		);
		const collisions = new Map(
			[...byJurisdiction.entries()]
				.filter(([candidate]) => candidate !== jurisdiction)
				.flatMap(([candidate, buckets]) =>
					buckets.map((bucket) => [bucket.name ?? "", candidate] as const),
				),
		);

		for (const name of bucketNames()) {
			const existing = selectedByName.get(name);
			if (existing) {
				if (existing.jurisdiction !== jurisdiction) {
					throw new Error(
						`R2 bucket ${name} returned jurisdiction ${existing.jurisdiction ?? "missing"}; expected ${jurisdiction}`,
					);
				}
				continue;
			}
			const collision = collisions.get(name);
			if (collision) {
				throw new Error(
					`R2 bucket ${name} already exists in ${collision}; bucket jurisdiction is immutable`,
				);
			}
			const created = await this.request<R2Bucket>(
				"POST",
				this.account("/r2/buckets"),
				{
					body: { name },
					r2Jurisdiction: jurisdiction,
				},
			);
			if (
				created.result.name !== name ||
				created.result.jurisdiction !== jurisdiction
			) {
				throw new Error(
					`Cloudflare did not create R2 bucket ${name} in ${jurisdiction}`,
				);
			}
		}
		for (const name of bucketNames()) {
			await this.request(
				"PUT",
				this.account(`/r2/buckets/${encodeURIComponent(name)}/lifecycle`),
				{
					body: { rules: reviewedLifecycleRules(name) },
					r2Jurisdiction: jurisdiction,
				},
			);
		}
	}

	async emptyR2(): Promise<void> {
		for (const bucket of bucketNames()) {
			for (const upload of await this.listR2MultipartUploads(bucket)) {
				await this.abortR2MultipartUpload(bucket, upload.key, upload.uploadId);
			}
			let emptied = false;
			for (let batch = 0; batch < 10_000; batch++) {
				const query = new URLSearchParams({ per_page: "1000" });
				const page = await this.request<R2Object[]>(
					"GET",
					this.account(
						`/r2/buckets/${encodeURIComponent(bucket)}/objects?${query}`,
					),
					{ r2: true },
				);
				if (page.result.length === 0) {
					if (page.isTruncated) {
						throw new Error(
							`R2 ${bucket} returned an empty truncated object page`,
						);
					}
					emptied = true;
					break;
				}
				for (const object of page.result) {
					if (!object.key)
						throw new Error(`R2 ${bucket} returned an empty key`);
					await this.request(
						"DELETE",
						this.account(
							`/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeR2ObjectKey(object.key)}`,
						),
						{ r2: true },
					);
				}
			}
			if (!emptied) {
				throw new Error(
					`R2 ${bucket} did not become empty within 10000 deletion batches`,
				);
			}
		}
	}

	async assertR2Empty(): Promise<void> {
		for (const bucket of bucketNames()) {
			const query = new URLSearchParams({ per_page: "1" });
			const page = await this.request<R2Object[]>(
				"GET",
				this.account(
					`/r2/buckets/${encodeURIComponent(bucket)}/objects?${query}`,
				),
				{ r2: true },
			);
			if (page.result.length !== 0 || page.isTruncated) {
				throw new Error(`R2 ${bucket} is not empty after the cutover wipe`);
			}
			if ((await this.listR2MultipartUploads(bucket)).length !== 0) {
				throw new Error(
					`R2 ${bucket} has incomplete multipart uploads after the cutover wipe`,
				);
			}
		}
	}
}

export function createCloudflareCutoverClient(input: {
	accountId: string;
	token: string;
	baseUrl?: string;
	sleep?: (milliseconds: number) => Promise<void>;
	r2AccessKeyId?: string;
	r2SecretAccessKey?: string;
	r2S3Fetch?: typeof fetch;
}): CloudflareCutoverClient {
	return new CloudflareCutoverClient(
		input.accountId,
		input.token,
		input.baseUrl,
		input.sleep,
		{
			accessKeyId: input.r2AccessKeyId,
			secretAccessKey: input.r2SecretAccessKey,
			fetch: input.r2S3Fetch,
		},
	);
}

if (import.meta.main) {
	const command = process.argv[2];
	const duration = {
		"hold-seconds": CUTOVER_HOLD_SECONDS,
		"control-convergence-seconds": CUTOVER_CONTROL_CONVERGENCE_SECONDS,
		"r2-event-settle-seconds": CUTOVER_R2_EVENT_SETTLE_SECONDS,
	}[command ?? ""];
	if (duration !== undefined) {
		console.log(String(duration));
		process.exit(0);
	}
	const client = createCloudflareCutoverClient({
		accountId: required("CLOUDFLARE_ACCOUNT_ID"),
		token: required("CLOUDFLARE_API_TOKEN"),
		r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
		r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
	});
	const approvedInventory = (): {
		inventory: PreliveCloudflareInventory;
		sha256: string;
	} => {
		const input = required("PRELIVE_APPROVED_CLOUDFLARE_INVENTORY");
		return {
			inventory: parseApprovedCloudflareInventory(readFileSync(input, "utf8")),
			sha256: required("PRELIVE_APPROVED_CLOUDFLARE_INVENTORY_SHA256"),
		};
	};
	switch (command) {
		case "inventory": {
			const inventory = await client.captureInventory();
			const output = required("PRELIVE_CLOUDFLARE_INVENTORY_OUTPUT");
			writeFileSync(output, canonicalCloudflareInventory(inventory), {
				flag: "wx",
			});
			console.log(
				JSON.stringify({
					event: "prelive_cloudflare_inventory_captured",
					sha256: cloudflareInventorySha256(inventory),
					output,
				}),
			);
			break;
		}
		case "inventory-verify": {
			const approved = approvedInventory();
			await client.assertInventory(approved.inventory, approved.sha256);
			console.log(
				JSON.stringify({
					event: "prelive_cloudflare_inventory_verified",
					sha256: approved.sha256,
				}),
			);
			break;
		}
		case "queues-purge-approved":
			await client.purgeApprovedQueues(approvedInventory().inventory);
			break;
		case "kv-clear-approved":
			await client.clearApprovedApplicationKv(approvedInventory().inventory);
			break;
		case "r2-empty-approved":
			await client.emptyApprovedR2(approvedInventory().inventory);
			break;
		case "maintenance-on":
			await client.setMaintenance(true);
			break;
		case "maintenance-off":
			await client.setMaintenance(false);
			break;
		case "drain-on":
			await client.setRuntimeMode("draining", CUTOVER_DRAIN_GENERATION);
			break;
		case "queues-pause":
			await client.setQueueDeliveryPaused(true);
			break;
		case "queues-resume":
			await client.setQueueDeliveryPaused(false);
			break;
		case "queues-verify-paused":
			await client.assertQueueDeliveryPaused(true);
			break;
		case "queues-verify-drained":
			await client.assertReviewedQueuesDrained();
			break;
		case "queues-purge":
			await client.purgeQueues();
			break;
		case "kv-clear":
			await client.clearApplicationKv();
			break;
		case "r2-empty":
			await client.emptyR2();
			break;
		case "r2-verify-empty":
			await client.assertR2Empty();
			break;
		case "r2-prepare":
			await client.ensureR2Buckets();
			break;
		default:
			throw new Error(
				"Usage: prelive-cloudflare-cutover.ts hold-seconds|control-convergence-seconds|r2-event-settle-seconds|inventory|inventory-verify|drain-on|maintenance-on|maintenance-off|queues-pause|queues-resume|queues-verify-drained|queues-verify-paused|queues-purge-approved|kv-clear-approved|r2-empty-approved|r2-verify-empty|r2-prepare",
			);
	}
	console.log(
		JSON.stringify({ event: "prelive_cutover_step_complete", command }),
	);
}
