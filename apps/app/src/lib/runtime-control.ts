import {
	BASELINE_GENERATION,
	MAINTENANCE_CONTROL_KEY,
	MAINTENANCE_SMOKE_HASH_DOMAIN,
	RUNTIME_CONTROL_CACHE_TTL_SECONDS,
} from "@relayapi/config";
import { createDb, sql } from "@relayapi/db";

export const APP_BASELINE_GENERATION = BASELINE_GENERATION;
export { MAINTENANCE_CONTROL_KEY };
export const MAINTENANCE_SMOKE_HEADER = "x-relayapi-maintenance-smoke-bypass";

const CONTROL_HEALTH_PATH = "/health/control";
const CUTOVER_SMOKE_PATH = "/internal/cutover-smoke";

type AppRuntimeControl =
	| { status: "open" }
	| { status: "maintenance" }
	| { status: "draining" }
	| {
			status: "blocked";
			reason:
				| "configuration_mismatch"
				| "read_failed"
				| "malformed"
				| "generation_mismatch";
	  };

type DatabaseProbeResult = { name: string; user: string };
type DatabaseProbe = (env: Cloudflare.Env) => Promise<DatabaseProbeResult>;

function parseRecord(raw: string): {
	target_baseline_generation: number;
	maintenance: boolean;
	mode: "open" | "draining" | "maintenance";
} | null {
	if (raw.length > 1_024) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		record.schema_version !== 1 ||
		!Number.isSafeInteger(record.target_baseline_generation) ||
		(record.target_baseline_generation as number) < 1 ||
		typeof record.maintenance !== "boolean" ||
		(record.mode !== undefined &&
			record.mode !== "open" &&
			record.mode !== "draining" &&
			record.mode !== "maintenance")
	) {
		return null;
	}
	const mode =
		record.mode === undefined
			? record.maintenance
				? "maintenance"
				: "open"
			: record.mode;
	if (record.maintenance !== (mode === "maintenance")) return null;
	return {
		target_baseline_generation: record.target_baseline_generation as number,
		maintenance: record.maintenance,
		mode,
	};
}

function decodeExpectedDigest(value: string | undefined): {
	bytes: Uint8Array;
	valid: boolean;
} {
	const source = value ?? "";
	const normalized = source.padEnd(64, "0").slice(0, 64);
	const bytes = new Uint8Array(32);
	let valid = source.length === 64;
	for (let index = 0; index < bytes.length; index++) {
		const pair = normalized.slice(index * 2, index * 2 + 2);
		const pairIsHex = /^[0-9a-fA-F]{2}$/.test(pair);
		valid = valid && pairIsHex;
		bytes[index] = pairIsHex ? Number.parseInt(pair, 16) : 0;
	}
	return { bytes, valid };
}

function fixedLengthEqual(left: Uint8Array, right: Uint8Array): boolean {
	let mismatch = 0;
	for (let index = 0; index < 32; index++) {
		mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
	}
	return mismatch === 0;
}

async function hasSmokeBypass(
	request: Request,
	cfEnv: Cloudflare.Env,
): Promise<boolean> {
	const token = request.headers.get(MAINTENANCE_SMOKE_HEADER) ?? "";
	const expected = decodeExpectedDigest(cfEnv.MAINTENANCE_SMOKE_BYPASS_SHA256);
	const provided = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${MAINTENANCE_SMOKE_HASH_DOMAIN}${token}`),
		),
	);
	return (
		token.length > 0 &&
		expected.valid &&
		fixedLengthEqual(provided, expected.bytes)
	);
}

async function probeDatabaseIdentity(
	cfEnv: Cloudflare.Env,
): Promise<DatabaseProbeResult> {
	const db = createDb(cfEnv.HYPERDRIVE.connectionString);
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

export async function readAppRuntimeControl(
	cfEnv: Cloudflare.Env,
): Promise<AppRuntimeControl> {
	if (cfEnv.BASELINE_GENERATION !== String(APP_BASELINE_GENERATION)) {
		return { status: "blocked", reason: "configuration_mismatch" };
	}
	let raw: string | null;
	try {
		raw = await cfEnv.KV.get(MAINTENANCE_CONTROL_KEY, {
			type: "text",
			cacheTtl: RUNTIME_CONTROL_CACHE_TTL_SECONDS,
		});
	} catch {
		return { status: "blocked", reason: "read_failed" };
	}
	return interpretAppRuntimeControl(raw, APP_BASELINE_GENERATION);
}

export function interpretAppRuntimeControl(
	raw: string | null,
	baselineGeneration: number,
): AppRuntimeControl {
	if (raw === null) return { status: "open" };
	const record = parseRecord(raw);
	if (!record) return { status: "blocked", reason: "malformed" };
	if (record.target_baseline_generation !== baselineGeneration) {
		return { status: "blocked", reason: "generation_mismatch" };
	}
	return { status: record.mode };
}

export async function appMaintenanceResponse(
	request: Request,
	cfEnv: Cloudflare.Env,
	databaseProbe: DatabaseProbe = probeDatabaseIdentity,
): Promise<Response | null> {
	const state = await readAppRuntimeControl(cfEnv);
	const url = new URL(request.url);
	const { pathname } = url;
	if (pathname === CONTROL_HEALTH_PATH || pathname === CUTOVER_SMOKE_PATH) {
		const headers: HeadersInit = {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		};
		if (request.method !== "GET" && request.method !== "HEAD") {
			return Response.json(
				{
					error: {
						code: "METHOD_NOT_ALLOWED",
						message: "Method not allowed",
					},
				},
				{ status: 405, headers: { ...headers, Allow: "GET, HEAD" } },
			);
		}
		const control = {
			status: state.status,
			...(state.status === "blocked" ? { reason: state.reason } : {}),
			application_baseline_generation: APP_BASELINE_GENERATION,
			configured_baseline_generation: cfEnv.BASELINE_GENERATION,
		};
		if (pathname === CUTOVER_SMOKE_PATH) {
			if (!(await hasSmokeBypass(request, cfEnv))) {
				return Response.json(
					{ error: { code: "NOT_FOUND", message: "Not found" } },
					{ status: 404, headers },
				);
			}
			if (
				cfEnv.DEPLOYMENT_MODE === "self_hosted" &&
				url.searchParams.get("probe") === "database"
			) {
				try {
					const database = await databaseProbe(cfEnv);
					return request.method === "HEAD"
						? new Response(null, { status: 200, headers })
						: Response.json(
								{ ok: true, control, database },
								{ status: 200, headers },
							);
				} catch (error) {
					console.error(
						JSON.stringify({
							event: "self_host_database_probe_failed",
							worker: "app",
							error: error instanceof Error ? error.name : "UnknownError",
						}),
					);
					return request.method === "HEAD"
						? new Response(null, { status: 503, headers })
						: Response.json(
								{
									ok: false,
									error: {
										code: "DATABASE_PROBE_FAILED",
										message: "Database probe failed",
									},
								},
								{ status: 503, headers },
							);
				}
			}
			return request.method === "HEAD"
				? new Response(null, { status: 200, headers })
				: Response.json({ ok: true, control }, { status: 200, headers });
		}
		const status = state.status === "open" ? 200 : 503;
		const responseHeaders = {
			...headers,
			...(state.status === "open" ? {} : { "Retry-After": "60" }),
		};
		return request.method === "HEAD"
			? new Response(null, { status, headers: responseHeaders })
			: Response.json(control, { status, headers: responseHeaders });
	}
	if (state.status === "open") return null;
	console.warn(
		JSON.stringify({
			event: "app_runtime_control_blocked",
			status: state.status,
			reason: state.status === "blocked" ? state.reason : state.status,
			baseline_generation: APP_BASELINE_GENERATION,
		}),
	);
	return Response.json(
		{
			error: {
				code: "SERVICE_MAINTENANCE",
				message: "RelayAPI is temporarily unavailable for maintenance",
				details: {
					target_baseline_generation: APP_BASELINE_GENERATION,
				},
			},
		},
		{
			status: 503,
			headers: {
				"Cache-Control": "no-store",
				"Retry-After": "60",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}
