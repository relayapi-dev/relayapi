import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	BASELINE_GENERATION,
	MAINTENANCE_SMOKE_HASH_DOMAIN,
	RUNTIME_CONTROL_CACHE_TTL_SECONDS,
} from "@relayapi/config";
import {
	assertRuntimeOpenForInternalRpc,
	createControlledWorker,
	interpretRuntimeControl,
	MAINTENANCE_CONTROL_KEY,
	MAINTENANCE_SMOKE_HEADER,
	readRuntimeControl,
} from "../lib/runtime-controls";
import type { Env } from "../types";

const warningSpy = spyOn(console, "warn").mockImplementation(() => {});
afterAll(() => warningSpy.mockRestore());
const workerEntrypointSource = readFileSync(
	resolve(import.meta.dir, "../index.ts"),
	"utf8",
);

class RuntimeControlKv {
	reads = 0;
	cacheTtls: number[] = [];

	constructor(
		private readonly value: string | null,
		private readonly readError = false,
	) {}

	async get(
		key: string,
		options?: { cacheTtl?: number },
	): Promise<string | null> {
		this.reads++;
		expect(key).toBe(MAINTENANCE_CONTROL_KEY);
		this.cacheTtls.push(options?.cacheTtl ?? -1);
		if (this.readError) throw new Error("simulated KV outage");
		return this.value;
	}
}

function controlRecord(input: {
	maintenance: boolean;
	generation?: number;
	mode?: "open" | "draining" | "maintenance";
}): string {
	return JSON.stringify({
		schema_version: 1,
		target_baseline_generation: input.generation ?? BASELINE_GENERATION,
		maintenance: input.maintenance,
		...(input.mode ? { mode: input.mode } : {}),
	});
}

function testEnv(kv: RuntimeControlKv, overrides: Partial<Env> = {}): Env {
	return {
		BASELINE_GENERATION: String(BASELINE_GENERATION),
		KV: kv,
		PUBLIC_LINK_BASE_URL: "https://go.relayapi.dev",
		MAINTENANCE_SMOKE_BYPASS_SHA256: "0".repeat(64),
		...overrides,
	} as Env;
}

async function smokeHash(token: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${MAINTENANCE_SMOKE_HASH_DOMAIN}${token}`),
		),
	);
	return Array.from(digest)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function executionContext(): ExecutionContext {
	return {} as ExecutionContext;
}

function scheduledController(): ScheduledController {
	return {
		cron: "*/5 * * * *",
		scheduledTime: Date.now(),
		type: "scheduled",
		noRetry() {},
	} as ScheduledController;
}

function messageBatch(retries: QueueRetryOptions[]): MessageBatch {
	return {
		queue: "relayapi-publish",
		messages: [
			{
				id: "message-1",
				timestamp: new Date(),
				body: { postId: "post_1" },
				attempts: 1,
				retry() {},
				ack() {},
			},
		],
		metadata: {
			metrics: { backlogCount: 1, backlogBytes: 32 },
		},
		retryAll(options) {
			retries.push(options ?? {});
		},
		ackAll() {},
	};
}

function controlledWorker(calls: {
	fetch: number;
	queue: number;
	scheduled: number;
}) {
	return createControlledWorker({
		async fetch() {
			calls.fetch++;
			return Response.json({ ok: true });
		},
		async queue() {
			calls.queue++;
		},
		async scheduled() {
			calls.scheduled++;
		},
	});
}

describe("generation-aware runtime control", () => {
	it("treats a missing key as normal operation", async () => {
		const kv = new RuntimeControlKv(null);
		expect(await readRuntimeControl(testEnv(kv))).toEqual({
			status: "open",
			source: "missing",
		});
		expect(kv.reads).toBe(1);
		expect(kv.cacheTtls).toEqual([RUNTIME_CONTROL_CACHE_TTL_SECONDS]);
	});

	it("opens only a valid record for the deployed baseline generation", async () => {
		expect(
			await readRuntimeControl(
				testEnv(new RuntimeControlKv(controlRecord({ maintenance: false }))),
			),
		).toEqual({ status: "open", source: "record" });
		expect(
			await readRuntimeControl(
				testEnv(
					new RuntimeControlKv(
						controlRecord({
							maintenance: false,
							generation: BASELINE_GENERATION + 1,
						}),
					),
				),
			),
		).toEqual({ status: "blocked", reason: "generation_mismatch" });
	});

	it("fails closed on deployed-generation drift, malformed state, and KV errors", async () => {
		expect(
			await readRuntimeControl(
				testEnv(new RuntimeControlKv(null), {
					BASELINE_GENERATION: String(BASELINE_GENERATION + 1),
				}),
			),
		).toEqual({ status: "blocked", reason: "configuration_mismatch" });
		expect(
			await readRuntimeControl(testEnv(new RuntimeControlKv('{"oops":true}'))),
		).toEqual({ status: "blocked", reason: "malformed" });
		expect(
			await readRuntimeControl(testEnv(new RuntimeControlKv(null, true))),
		).toEqual({ status: "blocked", reason: "read_failed" });
	});

	it("gates private WorkerEntrypoint RPC before durable work", async () => {
		await expect(
			assertRuntimeOpenForInternalRpc(testEnv(new RuntimeControlKv(null))),
		).resolves.toBeUndefined();
		for (const env of [
			testEnv(new RuntimeControlKv(controlRecord({ maintenance: true }))),
			testEnv(new RuntimeControlKv('{"malformed":true}')),
			testEnv(new RuntimeControlKv(null, true)),
			testEnv(new RuntimeControlKv(null), {
				BASELINE_GENERATION: String(BASELINE_GENERATION + 1),
			}),
		]) {
			await expect(assertRuntimeOpenForInternalRpc(env)).rejects.toThrow(
				"internal RPC is unavailable",
			);
		}
		const entrypoint = workerEntrypointSource.slice(
			workerEntrypointSource.indexOf("export class EmailIntentEntrypoint"),
			workerEntrypointSource.indexOf("export { RealtimeDO }"),
		);
		expect(
			entrypoint.indexOf("assertRuntimeOpenForInternalRpc(this.env)"),
		).toBeLessThan(
			entrypoint.indexOf("stageInternalEmailIntent(this.env, intent)"),
		);
	});
});

describe("public-host dispatch", () => {
	it("rejects API and root paths on go.relayapi.dev before downstream work", async () => {
		const kv = new RuntimeControlKv(null);
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");

		for (const path of ["/", "/health", "/v1/posts", "/s/"]) {
			const response = await fetch(
				new Request(`https://go.relayapi.dev${path}`),
				testEnv(kv),
				executionContext(),
			);
			expect(response.status).toBe(404);
			expect((await response.json()) as unknown).toEqual({
				error: { code: "NOT_FOUND", message: "Not found" },
			});
		}
		expect(calls.fetch).toBe(0);
		expect(kv.reads).toBe(0);
	});

	it("allows only approved public surfaces and preserves the /r legacy alias", async () => {
		const kv = new RuntimeControlKv(null);
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");

		for (const path of [
			"/s/current01",
			"/r/legacy01",
			"/q/opaque01",
			"/l/org/page",
		]) {
			const response = await fetch(
				new Request(`https://go.relayapi.dev${path}`),
				testEnv(kv),
				executionContext(),
			);
			expect(response.status).toBe(200);
		}
		expect(calls.fetch).toBe(4);
		expect(kv.reads).toBe(4);
	});

	it("does not restrict the API hostname", async () => {
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");
		const response = await fetch(
			new Request("https://api.relayapi.dev/v1/posts"),
			testEnv(new RuntimeControlKv(null)),
			executionContext(),
		);
		expect(response.status).toBe(200);
		expect(calls.fetch).toBe(1);
	});

	it("applies the same fail-closed dispatch to a configured self-host public host", async () => {
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");
		const env = testEnv(new RuntimeControlKv(null), {
			PUBLIC_LINK_BASE_URL: "https://go.example.com",
		});

		const blocked = await fetch(
			new Request("https://go.example.com/v1/posts"),
			env,
			executionContext(),
		);
		const allowed = await fetch(
			new Request("https://go.example.com/s/current01"),
			env,
			executionContext(),
		);

		expect(blocked.status).toBe(404);
		expect(allowed.status).toBe(200);
		expect(calls.fetch).toBe(1);
	});
});

describe("maintenance behavior before database work", () => {
	it("returns a safe control 503 and exposes only a narrow read-only smoke", async () => {
		const token = "test-smoke-token";
		const hash = await smokeHash(token);
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");
		const env = testEnv(
			new RuntimeControlKv(controlRecord({ maintenance: true })),
			{ MAINTENANCE_SMOKE_BYPASS_SHA256: hash },
		);

		const blocked = await fetch(
			new Request("https://api.relayapi.dev/health/control"),
			env,
			executionContext(),
		);
		expect(blocked.status).toBe(503);
		expect(blocked.headers.get("retry-after")).toBe("60");
		expect(blocked.headers.get("cache-control")).toBe("no-store");
		expect(blocked.headers.get("access-control-allow-origin")).toBe("*");
		const blockedBody = await blocked.json();
		expect(blockedBody).toMatchObject({
			status: "maintenance",
			application_baseline_generation: BASELINE_GENERATION,
			configured_baseline_generation: String(BASELINE_GENERATION),
		});
		expect(JSON.stringify(blockedBody)).not.toContain(token);

		const invalid = await fetch(
			new Request("https://api.relayapi.dev/internal/cutover-smoke", {
				headers: { [MAINTENANCE_SMOKE_HEADER]: "wrong-token" },
			}),
			env,
			executionContext(),
		);
		expect(invalid.status).toBe(404);

		const smoke = await fetch(
			new Request("https://api.relayapi.dev/internal/cutover-smoke", {
				headers: { [MAINTENANCE_SMOKE_HEADER]: token },
			}),
			env,
			executionContext(),
		);
		expect(smoke.status).toBe(200);
		expect(await smoke.json()).toMatchObject({
			ok: true,
			control: { status: "maintenance" },
		});

		const ordinaryRoute = await fetch(
			new Request("https://api.relayapi.dev/v1/posts", {
				headers: { [MAINTENANCE_SMOKE_HEADER]: token },
			}),
			env,
			executionContext(),
		);
		expect(ordinaryRoute.status).toBe(503);
		expect(await ordinaryRoute.json()).toMatchObject({
			error: { code: "SERVICE_MAINTENANCE" },
		});
		expect(calls.fetch).toBe(0);
	});

	it("reports malformed or wrong-generation containment without running application code", async () => {
		const token = "test-smoke-token";
		const hash = await smokeHash(token);
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");
		for (const value of [
			'{"malformed":true}',
			controlRecord({
				maintenance: true,
				generation: BASELINE_GENERATION + 1,
			}),
		]) {
			const response = await fetch(
				new Request("https://api.relayapi.dev/internal/cutover-smoke", {
					headers: { [MAINTENANCE_SMOKE_HEADER]: token },
				}),
				testEnv(new RuntimeControlKv(value), {
					MAINTENANCE_SMOKE_BYPASS_SHA256: hash,
				}),
				executionContext(),
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				control: { status: "blocked" },
			});
		}
		expect(calls.fetch).toBe(0);
	});

	it("runs the opt-in database identity probe only for self-hosted smoke requests", async () => {
		const token = "test-smoke-token";
		const hash = await smokeHash(token);
		let probes = 0;
		const worker = createControlledWorker(
			{
				async fetch() {
					return Response.json({ downstream: true });
				},
				async queue() {},
				async scheduled() {},
			},
			async () => ({ status: "open", source: "missing" }),
			async () => {
				probes++;
				return { name: "relayapi", user: "relayapi_runtime" };
			},
		);
		const env = testEnv(new RuntimeControlKv(null), {
			DEPLOYMENT_MODE: "self_hosted",
			MAINTENANCE_SMOKE_BYPASS_SHA256: hash,
		});
		const response = await worker.fetch(
			new Request(
				"https://api.example.com/internal/cutover-smoke?probe=database",
				{ headers: { [MAINTENANCE_SMOKE_HEADER]: token } },
			),
			env,
			executionContext(),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			ok: true,
			database: { name: "relayapi", user: "relayapi_runtime" },
		});
		expect(probes).toBe(1);

		const hostedResponse = await worker.fetch(
			new Request(
				"https://api.relayapi.dev/internal/cutover-smoke?probe=database",
				{ headers: { [MAINTENANCE_SMOKE_HEADER]: token } },
			),
			testEnv(new RuntimeControlKv(null), {
				MAINTENANCE_SMOKE_BYPASS_SHA256: hash,
			}),
			executionContext(),
		);
		expect(await hostedResponse.json()).not.toHaveProperty("database");
		expect(probes).toBe(1);
	});

	it("sanitizes self-hosted database probe failures", async () => {
		const token = "test-smoke-token";
		const worker = createControlledWorker(
			{
				async fetch() {
					return Response.json({ downstream: true });
				},
				async queue() {},
				async scheduled() {},
			},
			async () => ({ status: "open", source: "missing" }),
			async () => {
				throw new Error("postgresql://runtime:secret@db.example.com/relayapi");
			},
		);
		const response = await worker.fetch(
			new Request(
				"https://api.example.com/internal/cutover-smoke?probe=database",
				{ headers: { [MAINTENANCE_SMOKE_HEADER]: token } },
			),
			testEnv(new RuntimeControlKv(null), {
				DEPLOYMENT_MODE: "self_hosted",
				MAINTENANCE_SMOKE_BYPASS_SHA256: await smokeHash(token),
			}),
			executionContext(),
		);
		expect(response.status).toBe(503);
		const body = JSON.stringify(await response.json());
		expect(body).toContain("DATABASE_PROBE_FAILED");
		expect(body).not.toContain("secret");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("never permits mutation methods on cutover control surfaces", async () => {
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		if (!fetch) throw new Error("fetch handler missing");
		for (const path of ["/health/control", "/internal/cutover-smoke"]) {
			const response = await fetch(
				new Request(`https://api.relayapi.dev${path}`, { method: "POST" }),
				testEnv(new RuntimeControlKv(null)),
				executionContext(),
			);
			expect(response.status).toBe(405);
			expect(response.headers.get("allow")).toBe("GET, HEAD");
		}
		expect(calls.fetch).toBe(0);
	});

	it("retries queued messages and skips cron work while closed", async () => {
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const queue = worker.queue;
		const scheduled = worker.scheduled;
		if (!queue || !scheduled) throw new Error("async handlers missing");
		const env = testEnv(
			new RuntimeControlKv(controlRecord({ maintenance: true })),
		);
		const retries: QueueRetryOptions[] = [];

		await queue(messageBatch(retries), env, executionContext());
		await scheduled(scheduledController(), env, executionContext());

		expect(retries).toEqual([{ delaySeconds: 600 }]);
		expect(calls.queue).toBe(0);
		expect(calls.scheduled).toBe(0);
	});

	it("drains existing Queue work while blocking fetch, cron, and RPC producers", async () => {
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		const queue = worker.queue;
		const scheduled = worker.scheduled;
		if (!fetch || !queue || !scheduled) throw new Error("handlers missing");
		const env = testEnv(
			new RuntimeControlKv(
				controlRecord({ maintenance: false, mode: "draining" }),
			),
		);

		expect(
			await fetch(
				new Request("https://api.relayapi.dev/v1/posts"),
				env,
				executionContext(),
			),
		).toMatchObject({ status: 503 });
		await queue(messageBatch([]), env, executionContext());
		await scheduled(scheduledController(), env, executionContext());
		await expect(assertRuntimeOpenForInternalRpc(env)).rejects.toThrow(
			"internal RPC is unavailable",
		);

		expect(calls).toEqual({ fetch: 0, queue: 1, scheduled: 0 });
	});

	it("lets the generation-1 reader drain Queues before generation-2 maintenance takes ownership", async () => {
		const generationOneDrain = controlRecord({
			maintenance: false,
			generation: 1,
			mode: "draining",
		});
		const generationTwoMaintenance = controlRecord({
			maintenance: true,
			generation: 2,
			mode: "maintenance",
		});
		expect(interpretRuntimeControl(generationOneDrain, 1)).toEqual({
			status: "draining",
			targetBaselineGeneration: 1,
		});
		expect(interpretRuntimeControl(generationTwoMaintenance, 1)).toEqual({
			status: "blocked",
			reason: "generation_mismatch",
		});
		expect(interpretRuntimeControl(generationTwoMaintenance, 2)).toEqual({
			status: "maintenance",
			targetBaselineGeneration: 2,
		});

		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = createControlledWorker(
			{
				async fetch() {
					calls.fetch++;
					return Response.json({ ok: true });
				},
				async queue() {
					calls.queue++;
				},
				async scheduled() {
					calls.scheduled++;
				},
			},
			async () => interpretRuntimeControl(generationOneDrain, 1),
		);
		await worker.fetch(
			new Request("https://api.relayapi.dev/v1/posts"),
			testEnv(new RuntimeControlKv(null)),
			executionContext(),
		);
		await worker.queue(
			messageBatch([]),
			testEnv(new RuntimeControlKv(null)),
			executionContext(),
		);
		await worker.scheduled(
			scheduledController(),
			testEnv(new RuntimeControlKv(null)),
			executionContext(),
		);
		expect(calls).toEqual({ fetch: 0, queue: 1, scheduled: 0 });
	});

	it("runs fetch, queue, and cron handlers when the control key is absent", async () => {
		const calls = { fetch: 0, queue: 0, scheduled: 0 };
		const worker = controlledWorker(calls);
		const fetch = worker.fetch;
		const queue = worker.queue;
		const scheduled = worker.scheduled;
		if (!fetch || !queue || !scheduled) throw new Error("handlers missing");
		const env = testEnv(new RuntimeControlKv(null));

		await fetch(
			new Request("https://api.relayapi.dev/health"),
			env,
			executionContext(),
		);
		await queue(messageBatch([]), env, executionContext());
		await scheduled(scheduledController(), env, executionContext());

		expect(calls).toEqual({ fetch: 1, queue: 1, scheduled: 1 });
	});
});
