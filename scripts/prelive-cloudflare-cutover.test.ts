import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	BASELINE_GENERATION,
	MAINTENANCE_CONTROL_KEY,
	PRELIVE_CONTROL_CONVERGENCE_SECONDS,
	PRELIVE_CUTOVER_HOLD_SECONDS,
	PRELIVE_R2_EVENT_SETTLE_SECONDS,
} from "@relayapi/config";
import resources from "../apps/api/production-resources.json";
import {
	CUTOVER_CONTROL_CONVERGENCE_SECONDS,
	CUTOVER_DRAIN_GENERATION,
	CUTOVER_HOLD_SECONDS,
	CUTOVER_MAINTENANCE_KEY,
	CUTOVER_R2_EVENT_SETTLE_SECONDS,
	CUTOVER_TARGET_GENERATION,
	canonicalCloudflareInventory,
	cloudflareInventorySha256,
	createCloudflareCutoverClient,
	type PreliveCloudflareInventory,
	parseApprovedCloudflareInventory,
	queuePurgeCompleted,
	queuePurgeStartedAt,
	reviewedLifecycleRules,
} from "./prelive-cloudflare-cutover";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function response(
	result: unknown,
	resultInfo?: Record<string, unknown>,
): Response {
	return Response.json({
		success: true,
		result,
		...(resultInfo ? { result_info: resultInfo } : {}),
	});
}

function multipartResponse(
	uploads: Array<{
		key: string;
		uploadId: string;
		initiated?: string;
		storageClass?: string;
	}> = [],
): Response {
	const uploadXml = uploads
		.map(
			(upload) =>
				`<Upload><Key>${upload.key}</Key><UploadId>${upload.uploadId}</UploadId><Initiated>${upload.initiated ?? "2026-07-30T12:00:00.000Z"}</Initiated><StorageClass>${upload.storageClass ?? "STANDARD"}</StorageClass></Upload>`,
		)
		.join("");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?><ListMultipartUploadsResult>${uploadXml}<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`,
		{ status: 200, headers: { "Content-Type": "application/xml" } },
	);
}

describe("pre-live Cloudflare cutover controls", () => {
	it("uses the canonical Worker generation and maintenance control key", () => {
		expect(CUTOVER_TARGET_GENERATION).toBe(BASELINE_GENERATION);
		expect(CUTOVER_DRAIN_GENERATION).toBe(1);
		expect(CUTOVER_MAINTENANCE_KEY).toBe(MAINTENANCE_CONTROL_KEY);
		expect(CUTOVER_HOLD_SECONDS).toBe(PRELIVE_CUTOVER_HOLD_SECONDS);
		expect(CUTOVER_HOLD_SECONDS).toBe(65 * 60);
		expect(CUTOVER_CONTROL_CONVERGENCE_SECONDS).toBe(
			PRELIVE_CONTROL_CONVERGENCE_SECONDS,
		);
		expect(CUTOVER_R2_EVENT_SETTLE_SECONDS).toBe(
			PRELIVE_R2_EVENT_SETTLE_SECONDS,
		);
	});

	it("reads back every reviewed Queue after pausing delivery", async () => {
		const names = [
			...new Set(resources.queueConsumers.map((consumer) => consumer.queue)),
		].sort();
		const paused = new Set<string>();
		const readbacks = new Set<string>();
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/queues?per_page=100")) {
					return response(
						names.map((name, index) => ({
							queue_id: `queue-${index}`,
							queue_name: name,
							settings: { delivery_paused: false },
						})),
					);
				}
				const queueIndex = Number(url.match(/queue-(\d+)$/)?.[1]);
				const queueName = names[queueIndex];
				if (!queueName) throw new Error(`Unhandled queue URL ${url}`);
				if (init?.method === "PATCH") {
					paused.add(queueName);
					return response({
						queue_id: `queue-${queueIndex}`,
						queue_name: queueName,
						settings: { delivery_paused: true },
					});
				}
				readbacks.add(queueName);
				return response({
					queue_id: `queue-${queueIndex}`,
					queue_name: queueName,
					settings: { delivery_paused: paused.has(queueName) },
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});
		await client.setQueueDeliveryPaused(true);
		await client.assertQueueDeliveryPaused(true);
		expect([...paused].sort()).toEqual(names);
		expect([...readbacks].sort()).toEqual(names);
	});

	it("requires three spaced zero-backlog Queue metric reads before freezing", async () => {
		const names = [
			...new Set(resources.queueConsumers.map((consumer) => consumer.queue)),
		].sort();
		const metricReads = new Map<string, number>();
		const sleeps: number[] = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/queues?per_page=100")) {
					return response(
						names.map((name, index) => ({
							queue_id: `queue-${index}`,
							queue_name: name,
							settings: { delivery_paused: false },
						})),
					);
				}
				const queueIndex = Number(url.match(/queue-(\d+)\/metrics$/)?.[1]);
				const queueName = names[queueIndex];
				if (!queueName) throw new Error(`Unhandled queue URL ${url}`);
				metricReads.set(queueName, (metricReads.get(queueName) ?? 0) + 1);
				return response({
					backlog_bytes: 0,
					backlog_count: 0,
					oldest_message_timestamp_ms: 0,
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
			sleep: async (milliseconds) => sleeps.push(milliseconds),
		});

		await client.assertReviewedQueuesDrained();

		expect([...metricReads.values()]).toEqual(names.map(() => 3));
		expect(sleeps).toEqual([15_000, 15_000]);
	});

	it("fails the drain gate when any reviewed Queue has backlog", async () => {
		const names = [
			...new Set(resources.queueConsumers.map((consumer) => consumer.queue)),
		].sort();
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.endsWith("/queues?per_page=100")) {
					return response(
						names.map((name, index) => ({
							queue_id: `queue-${index}`,
							queue_name: name,
							settings: { delivery_paused: false },
						})),
					);
				}
				if (url.endsWith("/metrics")) {
					return response({
						backlog_bytes: 32,
						backlog_count: 1,
						oldest_message_timestamp_ms: Date.now(),
					});
				}
				throw new Error(`Unhandled queue URL ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});

		await expect(client.assertReviewedQueuesDrained()).rejects.toThrow(
			"still has 1 messages/32 bytes",
		);
	});

	it("rejects a stale completed purge and waits through a current false status", async () => {
		const names = [
			...new Set(resources.queueConsumers.map((consumer) => consumer.queue)),
		].sort();
		const purgeStatusReads = new Map<number, number>();
		const sleeps: number[] = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/queues?per_page=100")) {
					return response(
						names.map((name, index) => ({
							queue_id: `queue-${index}`,
							queue_name: name,
						})),
					);
				}
				if (init?.method === "POST" && url.endsWith("/purge")) {
					return response({});
				}
				if (url.endsWith("/purge")) {
					const queueIndex = Number(url.match(/queue-(\d+)\/purge$/)?.[1]);
					const read = (purgeStatusReads.get(queueIndex) ?? 0) + 1;
					purgeStatusReads.set(queueIndex, read);
					return response({
						completed: read === 3 ? "false" : " TRUE ",
						started_at:
							read <= 2
								? "2026-07-29T12:00:00.000Z"
								: "2026-07-29T12:01:00.000Z",
					});
				}
				throw new Error(`Unhandled request ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds);
			},
		});

		await client.purgeQueues();

		expect([...purgeStatusReads.values()]).toEqual(names.map(() => 4));
		expect(sleeps).toEqual([2_000, 2_000]);
		expect(queuePurgeCompleted(true)).toBe(true);
		expect(queuePurgeCompleted(false)).toBe(false);
		expect(queuePurgeCompleted(undefined)).toBe(false);
		expect(() => queuePurgeCompleted("pending")).toThrow("invalid completed");
		expect(queuePurgeStartedAt("2026-07-29T12:01:00Z")).toBe(
			"2026-07-29T12:01:00.000Z",
		);
		expect(() => queuePurgeStartedAt("yesterday")).toThrow(
			"invalid started_at",
		);
	});

	it("writes a no-TTL generation-targeted maintenance record", async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				captured = { url: String(input), init };
				return response({});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});
		await client.setMaintenance(true);
		expect(captured?.url).toContain(
			encodeURIComponent(CUTOVER_MAINTENANCE_KEY),
		);
		expect(captured?.init?.method).toBe("PUT");
		expect(JSON.parse(String(captured?.init?.body))).toEqual({
			schema_version: 1,
			target_baseline_generation: CUTOVER_TARGET_GENERATION,
			maintenance: true,
			mode: "maintenance",
		});
		expect(String(captured?.init?.body)).not.toContain("expiration");
	});

	it("targets draining at the still-live generation 1", async () => {
		let captured: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				captured = { url: String(input), init };
				return response({});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});

		await client.setRuntimeMode("draining", CUTOVER_DRAIN_GENERATION);

		expect(JSON.parse(String(captured?.init?.body))).toEqual({
			schema_version: 1,
			target_baseline_generation: 1,
			maintenance: false,
			mode: "draining",
		});
	});

	it("clears application KV while preserving the maintenance key", async () => {
		const deleted: string[][] = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/keys?")) {
					return response([
						{ name: CUTOVER_MAINTENANCE_KEY },
						{ name: "apikey:one" },
						{ name: "queue-schedule:org" },
					]);
				}
				if (url.endsWith("/bulk/delete")) {
					deleted.push(JSON.parse(String(init?.body)));
					return response({
						successful_key_count: deleted.at(-1)?.length,
						unsuccessful_keys: [],
					});
				}
				throw new Error(`Unhandled request ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});
		await client.clearApplicationKv();
		expect(deleted).toEqual([["apikey:one", "queue-schedule:org"]]);
	});

	it("captures and hashes the exact reviewed Cloudflare wipe inventory", async () => {
		const queueNames = [
			...new Set(resources.queueConsumers.map((consumer) => consumer.queue)),
		].sort();
		const bucketNames = [
			...new Set([...resources.privateR2Buckets, resources.publicAssetsBucket]),
		].sort();
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.endsWith("/queues?per_page=100")) {
					return response(
						[
							...queueNames.map((name, index) => ({
								queue_id: `reviewed-${index}`,
								queue_name: name,
								settings: { delivery_paused: true },
							})),
							{
								queue_id: "unrelated-id",
								queue_name: "unrelated-queue",
								settings: { delivery_paused: false },
							},
						],
						{ page: 1, total_pages: 1 },
					);
				}
				if (url.includes("/queues/") && url.endsWith("/metrics")) {
					return response({
						backlog_bytes: 0,
						backlog_count: 0,
						oldest_message_timestamp_ms: 0,
					});
				}
				if (url.includes("/storage/kv/namespaces/") && url.includes("/keys?")) {
					return response([
						{ name: "z-key" },
						{ name: CUTOVER_MAINTENANCE_KEY },
						{ name: "a-key" },
					]);
				}
				if (
					url.includes("/storage/kv/namespaces/") &&
					url.includes("/values/")
				) {
					return new Response(`value:${url.split("/").at(-1)}`);
				}
				if (url.includes("/r2/buckets?") && !url.includes("/objects?")) {
					const jurisdiction = new Headers(init?.headers).get(
						"cf-r2-jurisdiction",
					);
					return response({
						buckets:
							jurisdiction === "eu"
								? [{ name: "unrelated-eu", jurisdiction: "eu" }]
								: jurisdiction === "fedramp"
									? [
											{
												name: "unrelated-fedramp",
												jurisdiction: "fedramp",
											},
										]
									: bucketNames.map((name) => ({
											name,
											jurisdiction: "default",
										})),
					});
				}
				if (url.endsWith("/lifecycle")) {
					return response({ rules: reviewedLifecycleRules("relayapi-media") });
				}
				if (url.includes("/r2/buckets/") && url.includes("/objects?")) {
					return response([{ key: "only/object" }], { is_truncated: false });
				}
				throw new Error(`Unhandled request ${url}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
			r2S3Fetch: mock(async () => multipartResponse()),
		});
		const inventory = await client.captureInventory();
		expect(inventory.kv.keys.map(({ name }) => name)).toEqual(
			[CUTOVER_MAINTENANCE_KEY, "a-key", "z-key"].sort(),
		);
		expect(
			inventory.queues.filter(({ destructiveTarget }) => destructiveTarget),
		).toHaveLength(queueNames.length);
		expect(
			inventory.r2.buckets.filter(({ destructiveTarget }) => destructiveTarget),
		).toHaveLength(bucketNames.length);
		expect(
			inventory.r2.buckets.find(({ name }) => name === "unrelated-eu")?.objects,
		).toBeNull();
		const canonical = canonicalCloudflareInventory(inventory);
		expect(canonical).toBe(canonicalCloudflareInventory(inventory));
		expect(cloudflareInventorySha256(inventory)).toMatch(/^[0-9a-f]{64}$/);
		expect(parseApprovedCloudflareInventory(canonical)).toEqual(inventory);
		await client.assertInventory(
			inventory,
			cloudflareInventorySha256(inventory),
		);
	});

	it("refuses to delete an unapproved KV addition after inventory", async () => {
		let deleteCalled = false;
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/keys?")) {
					return response([{ name: "approved" }, { name: "late-addition" }]);
				}
				if (url.includes("/values/")) return new Response("same-value");
				if (url.endsWith("/bulk/delete")) {
					deleteCalled = true;
					return response({});
				}
				throw new Error(`Unhandled request ${url} ${init?.method ?? "GET"}`);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const valueSha256 = new Bun.CryptoHasher("sha256")
			.update("same-value")
			.digest("hex");
		const approved: PreliveCloudflareInventory = {
			schemaVersion: 1,
			targetBaselineGeneration: CUTOVER_TARGET_GENERATION,
			accountId: "account",
			kv: {
				namespaceId: resources.kvNamespaceId,
				keys: [
					{
						name: "approved",
						expiration: null,
						metadataSha256: null,
						valueSha256,
					},
				],
			},
			queues: [],
			r2: { jurisdiction: "default", buckets: [] },
		};
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});
		await expect(client.clearApprovedApplicationKv(approved)).rejects.toThrow(
			"changed after inventory approval",
		);
		expect(deleteCalled).toBe(false);
	});

	it("sends the default-jurisdiction header on every R2 call", async () => {
		const r2Calls: Array<{ url: string; header: string | null }> = [];
		let avatarObjectExists = true;
		let multipartExists = true;
		const multipartCalls: Array<{ method: string; url: string }> = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				r2Calls.push({
					url,
					header: new Headers(init?.headers).get("cf-r2-jurisdiction"),
				});
				if (init?.method === "DELETE") {
					avatarObjectExists = false;
					return response({ key: "a/b.txt" });
				}
				return response(
					url.includes("relayapi-avatars") && avatarObjectExists
						? [{ key: "a/b.txt" }]
						: [],
					{ is_truncated: false },
				);
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
			r2S3Fetch: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				multipartCalls.push({ method: init?.method ?? "GET", url });
				if (init?.method === "DELETE") {
					multipartExists = false;
					return new Response(null, { status: 204 });
				}
				return multipartResponse(
					url.includes("relayapi-avatars") && multipartExists
						? [{ key: "pending/video", uploadId: "upload-1" }]
						: [],
				);
			}),
		});
		await client.emptyR2();
		await client.assertR2Empty();
		expect(r2Calls.length).toBeGreaterThan(5);
		expect(r2Calls.every((call) => call.header === "default")).toBe(true);
		expect(
			r2Calls.some(
				(call) =>
					call.url.endsWith("/objects/a/b.txt") && !call.url.includes("%2F"),
			),
		).toBe(true);
		expect(
			multipartCalls.some(
				(call) =>
					call.method === "DELETE" &&
					call.url.includes("pending/video") &&
					call.url.includes("uploadId=upload-1"),
			),
		).toBe(true);
	});

	it("fails closed when any R2 object remains after the wipe", async () => {
		globalThis.fetch = Object.assign(
			mock(async () =>
				response([{ key: "late/object.txt" }], { is_truncated: false }),
			),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});

		await expect(client.assertR2Empty()).rejects.toThrow(
			"is not empty after the cutover wipe",
		);
	});

	it("creates every missing hosted bucket in the reviewed default jurisdiction", async () => {
		const calls: Array<{
			method: string;
			url: string;
			jurisdiction: string | null;
			body?: unknown;
		}> = [];
		globalThis.fetch = Object.assign(
			mock(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const jurisdiction = new Headers(init?.headers).get(
					"cf-r2-jurisdiction",
				);
				calls.push({
					method: init?.method ?? "GET",
					url,
					jurisdiction,
					...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
				});
				if (init?.method === "POST") {
					const { name } = JSON.parse(String(init.body)) as { name: string };
					return response({ name, jurisdiction: "default" });
				}
				if (jurisdiction !== "default") return response({ buckets: [] });
				return response({
					buckets: [{ name: "relayapi-media", jurisdiction: "default" }],
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});

		await client.ensureR2Buckets();

		const creates = calls.filter((call) => call.method === "POST");
		expect(creates).toHaveLength(4);
		expect(creates.every((call) => call.jurisdiction === "default")).toBe(true);
		expect(creates.map((call) => call.body)).toContainEqual({
			name: "relayapi-public-assets",
		});
		const lifecycleUpdates = calls.filter(
			(call) => call.method === "PUT" && call.url.endsWith("/lifecycle"),
		);
		expect(lifecycleUpdates).toHaveLength(5);
		for (const update of lifecycleUpdates) {
			expect(update.jurisdiction).toBe("default");
			expect(update.body).toMatchObject({
				rules: expect.arrayContaining([
					{
						id: "relayapi-abort-incomplete-multipart",
						enabled: true,
						conditions: { prefix: "" },
						abortMultipartUploadsTransition: {
							condition: { type: "Age", maxAge: 86_400 },
						},
					},
				]),
			});
		}
		expect(reviewedLifecycleRules("relayapi-media")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "relayapi-media-expiry",
					deleteObjectsTransition: {
						condition: { type: "Age", maxAge: 2_592_000 },
					},
				}),
			]),
		);
	});

	it("rejects an immutable cross-jurisdiction bucket collision", async () => {
		globalThis.fetch = Object.assign(
			mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
				const jurisdiction = new Headers(init?.headers).get(
					"cf-r2-jurisdiction",
				);
				return response({
					buckets:
						jurisdiction === "eu"
							? [{ name: "relayapi-avatars", jurisdiction: "eu" }]
							: [],
				});
			}),
			{ preconnect: originalFetch.preconnect },
		);
		const client = createCloudflareCutoverClient({
			accountId: "account",
			token: "token",
			baseUrl: "https://cloudflare.test/client/v4",
		});

		await expect(client.ensureR2Buckets()).rejects.toThrow(
			"already exists in eu",
		);
	});
});
