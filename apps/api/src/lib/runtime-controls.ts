import {
	BASELINE_GENERATION,
	MAINTENANCE_CONTROL_KEY,
	MAINTENANCE_SMOKE_HASH_DOMAIN,
	RUNTIME_CONTROL_CACHE_TTL_SECONDS,
} from "@relayapi/config";
import { createDb, sql } from "@relayapi/db";
import type { Env } from "../types";

/**
 * This value advances with the sealed database baseline generation. During a
 * generation transition, operators first write a maintenance record targeting
 * the incoming generation, then preserve this reserved key while clearing
 * application KV data.
 */
export { BASELINE_GENERATION, MAINTENANCE_CONTROL_KEY };
export const MAINTENANCE_SMOKE_HEADER = "x-relayapi-maintenance-smoke-bypass";

const CONTROL_SCHEMA_VERSION = 1;
const QUEUE_RETRY_DELAY_SECONDS = 600;
const HOSTED_PUBLIC_LINK_HOSTNAME = "go.relayapi.dev";
const APPROVED_PUBLIC_PATH_PREFIXES = ["/s/", "/r/", "/q/", "/l/"] as const;
const CONTROL_HEALTH_PATH = "/health/control";
const CUTOVER_SMOKE_PATH = "/internal/cutover-smoke";

type MaintenanceControlRecord = {
	schema_version: typeof CONTROL_SCHEMA_VERSION;
	target_baseline_generation: number;
	maintenance: boolean;
	mode: "open" | "draining" | "maintenance";
};

export type RuntimeControlState =
	| {
			status: "open";
			source: "missing" | "record";
	  }
	| {
			status: "maintenance";
			targetBaselineGeneration: number;
	  }
	| {
			status: "draining";
			targetBaselineGeneration: number;
	  }
	| {
			status: "blocked";
			reason:
				| "configuration_mismatch"
				| "read_failed"
				| "malformed"
				| "generation_mismatch";
	  };

type ControlledWorkerDependencies = {
	fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Response | Promise<Response>;
	queue(
		batch: MessageBatch,
		env: Env,
		ctx: ExecutionContext,
	): void | Promise<void>;
	scheduled(
		event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): void | Promise<void>;
};

type DatabaseProbeResult = { name: string; user: string };
type DatabaseProbe = (env: Env) => Promise<DatabaseProbeResult>;

export type ControlledWorker = {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
	queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void>;
	scheduled(
		event: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void>;
};

function parseControlRecord(raw: string): MaintenanceControlRecord | null {
	if (raw.length > 1_024) return null;

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;

	const candidate = value as Record<string, unknown>;
	if (
		candidate.schema_version !== CONTROL_SCHEMA_VERSION ||
		!Number.isSafeInteger(candidate.target_baseline_generation) ||
		(candidate.target_baseline_generation as number) < 1 ||
		typeof candidate.maintenance !== "boolean" ||
		(candidate.mode !== undefined &&
			candidate.mode !== "open" &&
			candidate.mode !== "draining" &&
			candidate.mode !== "maintenance")
	) {
		return null;
	}
	const mode =
		candidate.mode === undefined
			? candidate.maintenance
				? "maintenance"
				: "open"
			: candidate.mode;
	if (candidate.maintenance !== (mode === "maintenance")) return null;

	return {
		schema_version: CONTROL_SCHEMA_VERSION,
		target_baseline_generation: candidate.target_baseline_generation as number,
		maintenance: candidate.maintenance,
		mode,
	};
}

/**
 * Read-only runtime gate. The key deliberately has no storage TTL. A missing
 * key is normal operation; malformed or unreadable state fails closed.
 *
 * Workers KV can cache a prior value for the read cache TTL, so maintenance
 * activation must include a drain interval longer than this 30-second window
 * before destructive database work begins.
 */
export async function readRuntimeControl(
	env: Env,
): Promise<RuntimeControlState> {
	if (env.BASELINE_GENERATION !== String(BASELINE_GENERATION)) {
		return { status: "blocked", reason: "configuration_mismatch" };
	}

	let raw: string | null;
	try {
		raw = await env.KV.get(MAINTENANCE_CONTROL_KEY, {
			type: "text",
			cacheTtl: RUNTIME_CONTROL_CACHE_TTL_SECONDS,
		});
	} catch {
		return { status: "blocked", reason: "read_failed" };
	}
	return interpretRuntimeControl(raw, BASELINE_GENERATION);
}

/**
 * Pure generation-aware interpretation used by cutover contract tests to
 * exercise readers across a Worker/database generation boundary.
 */
export function interpretRuntimeControl(
	raw: string | null,
	baselineGeneration: number,
): RuntimeControlState {
	if (raw === null) return { status: "open", source: "missing" };

	const record = parseControlRecord(raw);
	if (!record) return { status: "blocked", reason: "malformed" };
	if (record.target_baseline_generation !== baselineGeneration) {
		return { status: "blocked", reason: "generation_mismatch" };
	}
	if (record.mode === "maintenance") {
		return {
			status: "maintenance",
			targetBaselineGeneration: record.target_baseline_generation,
		};
	}
	if (record.mode === "draining") {
		return {
			status: "draining",
			targetBaselineGeneration: record.target_baseline_generation,
		};
	}
	return { status: "open", source: "record" };
}

function decodeSha256Hex(value: string): {
	bytes: Uint8Array;
	valid: boolean;
} {
	const bytes = new Uint8Array(32);
	const normalized = value.padEnd(64, "0").slice(0, 64);
	let valid = value.length === 64;
	for (let index = 0; index < bytes.length; index++) {
		const pair = normalized.slice(index * 2, index * 2 + 2);
		const pairValid = /^[0-9a-fA-F]{2}$/.test(pair);
		valid = valid && pairValid;
		bytes[index] = pairValid ? Number.parseInt(pair, 16) : 0;
	}
	return { bytes, valid };
}

function fixedLengthTimingSafeEqual(
	left: Uint8Array,
	right: Uint8Array,
): boolean {
	type SubtleCryptoWithTimingSafeEqual = SubtleCrypto & {
		timingSafeEqual(
			a: ArrayBuffer | ArrayBufferView,
			b: ArrayBuffer | ArrayBufferView,
		): boolean;
	};
	const workerSubtle = crypto.subtle as SubtleCryptoWithTimingSafeEqual;
	// Cloudflare Workers exposes this non-standard Web Crypto extension. Bun's
	// unit-test runtime does not, so retain a fixed-iteration fallback.
	if (typeof workerSubtle.timingSafeEqual === "function") {
		return workerSubtle.timingSafeEqual(left, right);
	}
	let mismatch = 0;
	for (let index = 0; index < 32; index++) {
		mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return mismatch === 0;
}

export async function hasValidMaintenanceSmokeBypass(
	request: Request,
	env: Env,
): Promise<boolean> {
	const providedToken = request.headers.get(MAINTENANCE_SMOKE_HEADER) ?? "";
	const expected = decodeSha256Hex(env.MAINTENANCE_SMOKE_BYPASS_SHA256 ?? "");
	const providedDigest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`${MAINTENANCE_SMOKE_HASH_DOMAIN}${providedToken}`,
			),
		),
	);
	const equal = fixedLengthTimingSafeEqual(providedDigest, expected.bytes);
	return providedToken.length > 0 && expected.valid && equal;
}

function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, "");
}

function configuredPublicLinkHostname(env: Env): string | null {
	if (!env.PUBLIC_LINK_BASE_URL) return null;
	try {
		const url = new URL(env.PUBLIC_LINK_BASE_URL);
		if (url.protocol !== "https:" || url.pathname !== "/") return null;
		return normalizeHostname(url.hostname);
	} catch {
		return null;
	}
}

export function isApprovedPublicHostRequest(
	request: Request,
	env: Env,
): boolean {
	const url = new URL(request.url);
	const hostname = normalizeHostname(url.hostname);
	const publicHostnames = new Set([HOSTED_PUBLIC_LINK_HOSTNAME]);
	const configuredHostname = configuredPublicLinkHostname(env);
	if (configuredHostname) publicHostnames.add(configuredHostname);
	if (!publicHostnames.has(hostname)) return true;

	return APPROVED_PUBLIC_PATH_PREFIXES.some(
		(prefix) =>
			url.pathname.startsWith(prefix) && url.pathname.length > prefix.length,
	);
}

function publicHostNotFoundResponse(): Response {
	return Response.json(
		{ error: { code: "NOT_FOUND", message: "Not found" } },
		{
			status: 404,
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}

function maintenanceResponse(): Response {
	return Response.json(
		{
			error: {
				code: "SERVICE_MAINTENANCE",
				message: "RelayAPI is temporarily unavailable for maintenance",
				details: { target_baseline_generation: BASELINE_GENERATION },
			},
		},
		{
			status: 503,
			headers: {
				"Access-Control-Allow-Headers":
					"Authorization, Content-Type, Idempotency-Key",
				"Access-Control-Allow-Methods":
					"GET, POST, PUT, PATCH, DELETE, OPTIONS",
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Expose-Headers": "Retry-After",
				"Cache-Control": "no-store",
				"Retry-After": "60",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}

function controlHeaders(): HeadersInit {
	return {
		"Access-Control-Allow-Headers":
			"Authorization, Content-Type, Idempotency-Key",
		"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	};
}

function controlBody(state: RuntimeControlState, env: Env) {
	return {
		status: state.status,
		...(state.status === "blocked" ? { reason: state.reason } : {}),
		...(state.status === "maintenance"
			? { target_baseline_generation: state.targetBaselineGeneration }
			: state.status === "draining"
				? { target_baseline_generation: state.targetBaselineGeneration }
				: {}),
		application_baseline_generation: BASELINE_GENERATION,
		configured_baseline_generation: env.BASELINE_GENERATION,
	};
}

function responseForMethod(
	request: Request,
	body: unknown,
	init: ResponseInit,
): Response {
	if (request.method === "HEAD") {
		return new Response(null, init);
	}
	return Response.json(body, init);
}

async function probeDatabaseIdentity(env: Env): Promise<DatabaseProbeResult> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const result: unknown = await db.execute(
		sql`SELECT current_database() AS database_name, current_user AS role_name`,
	);
	if (!Array.isArray(result))
		throw new Error("Database probe returned no rows");
	const row: unknown = result[0];
	if (!row || typeof row !== "object" || Array.isArray(row)) {
		throw new Error("Database probe returned no identity");
	}
	const record = row as Record<string, unknown>;
	if (
		typeof record.database_name !== "string" ||
		typeof record.role_name !== "string"
	) {
		throw new Error("Database probe returned an invalid identity");
	}
	return { name: record.database_name, user: record.role_name };
}

function databaseProbeFailureResponse(request: Request): Response {
	return responseForMethod(
		request,
		{
			ok: false,
			error: {
				code: "DATABASE_PROBE_FAILED",
				message: "Database probe failed",
			},
		},
		{ status: 503, headers: controlHeaders() },
	);
}

async function runtimeControlEndpoint(
	request: Request,
	env: Env,
	state: RuntimeControlState,
	databaseProbe: DatabaseProbe,
): Promise<Response | null> {
	const url = new URL(request.url);
	const { pathname } = url;
	if (pathname !== CONTROL_HEALTH_PATH && pathname !== CUTOVER_SMOKE_PATH) {
		return null;
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return Response.json(
			{ error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } },
			{
				status: 405,
				headers: { ...controlHeaders(), Allow: "GET, HEAD" },
			},
		);
	}
	if (pathname === CUTOVER_SMOKE_PATH) {
		if (!(await hasValidMaintenanceSmokeBypass(request, env))) {
			return Response.json(
				{ error: { code: "NOT_FOUND", message: "Not found" } },
				{ status: 404, headers: controlHeaders() },
			);
		}
		if (
			env.DEPLOYMENT_MODE === "self_hosted" &&
			url.searchParams.get("probe") === "database"
		) {
			try {
				const database = await databaseProbe(env);
				return responseForMethod(
					request,
					{ ok: true, control: controlBody(state, env), database },
					{ status: 200, headers: controlHeaders() },
				);
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "self_host_database_probe_failed",
						worker: "api",
						error: error instanceof Error ? error.name : "UnknownError",
					}),
				);
				return databaseProbeFailureResponse(request);
			}
		}
		return responseForMethod(
			request,
			{ ok: true, control: controlBody(state, env) },
			{ status: 200, headers: controlHeaders() },
		);
	}
	return responseForMethod(request, controlBody(state, env), {
		status: state.status === "open" ? 200 : 503,
		headers: {
			...controlHeaders(),
			...(state.status === "open" ? {} : { "Retry-After": "60" }),
		},
	});
}

function logBlockedInvocation(input: {
	handler: "fetch" | "queue" | "scheduled" | "rpc";
	state: Exclude<RuntimeControlState, { status: "open" }>;
	queue?: string;
	messageCount?: number;
}): void {
	console.warn(
		JSON.stringify({
			event: "runtime_control_blocked",
			handler: input.handler,
			status: input.state.status,
			reason:
				input.state.status === "blocked"
					? input.state.reason
					: input.state.status,
			baseline_generation: BASELINE_GENERATION,
			...(input.queue ? { queue: input.queue } : {}),
			...(input.messageCount === undefined
				? {}
				: { message_count: input.messageCount }),
		}),
	);
}

/**
 * WorkerEntrypoint RPC methods do not pass through the default exported
 * handler. Every private RPC that can reach durable state must call this gate
 * before doing work.
 */
export async function assertRuntimeOpenForInternalRpc(env: Env): Promise<void> {
	const state = await readRuntimeControl(env);
	if (state.status === "open") return;
	logBlockedInvocation({ handler: "rpc", state });
	throw new Error(
		"RelayAPI internal RPC is unavailable while runtime is closed",
	);
}

export function createControlledWorker(
	dependencies: ControlledWorkerDependencies,
	runtimeControlReader: (
		env: Env,
	) => Promise<RuntimeControlState> = readRuntimeControl,
	databaseProbe: DatabaseProbe = probeDatabaseIdentity,
): ControlledWorker {
	const worker = {
		async fetch(request, env, ctx) {
			if (!isApprovedPublicHostRequest(request, env)) {
				return publicHostNotFoundResponse();
			}

			const state = await runtimeControlReader(env);
			const controlResponse = await runtimeControlEndpoint(
				request,
				env,
				state,
				databaseProbe,
			);
			if (controlResponse) return controlResponse;
			if (state.status === "open") {
				return dependencies.fetch(request, env, ctx);
			}

			logBlockedInvocation({ handler: "fetch", state });
			return maintenanceResponse();
		},

		async queue(batch, env, ctx) {
			const state = await runtimeControlReader(env);
			if (state.status === "open" || state.status === "draining") {
				return dependencies.queue(batch, env, ctx);
			}

			logBlockedInvocation({
				handler: "queue",
				state,
				queue: batch.queue,
				messageCount: batch.messages.length,
			});
			batch.retryAll({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
		},

		async scheduled(event, env, ctx) {
			const state = await runtimeControlReader(env);
			if (state.status === "open") {
				return dependencies.scheduled(event, env, ctx);
			}

			logBlockedInvocation({ handler: "scheduled", state });
		},
	} satisfies ExportedHandler<Env> & ControlledWorker;
	return worker;
}
