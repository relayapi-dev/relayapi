import { describe, expect, it } from "bun:test";
import {
	BASELINE_GENERATION,
	MAINTENANCE_SMOKE_HASH_DOMAIN,
	RUNTIME_CONTROL_CACHE_TTL_SECONDS,
} from "@relayapi/config";
import {
	APP_BASELINE_GENERATION,
	appMaintenanceResponse,
	interpretAppRuntimeControl,
	MAINTENANCE_CONTROL_KEY,
	MAINTENANCE_SMOKE_HEADER,
	readAppRuntimeControl,
} from "../lib/runtime-control";

function envWith(
	value: string | null | Error,
	extra: Partial<Cloudflare.Env> = {},
): Cloudflare.Env {
	return {
		BASELINE_GENERATION: String(
			BASELINE_GENERATION,
		) as Cloudflare.Env["BASELINE_GENERATION"],
		KV: {
			get: async (key: string, options?: { cacheTtl?: number }) => {
				expect(key).toBe(MAINTENANCE_CONTROL_KEY);
				expect(options?.cacheTtl).toBe(RUNTIME_CONTROL_CACHE_TTL_SECONDS);
				if (value instanceof Error) throw value;
				return value;
			},
		} as Cloudflare.Env["KV"],
		...extra,
	} as Cloudflare.Env;
}

function record(
	maintenance: boolean,
	generation = APP_BASELINE_GENERATION,
	mode?: "open" | "draining" | "maintenance",
): string {
	return JSON.stringify({
		schema_version: 1,
		target_baseline_generation: generation,
		maintenance,
		...(mode ? { mode } : {}),
	});
}

async function bypassDigest(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`${MAINTENANCE_SMOKE_HASH_DOMAIN}${token}`),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

describe("dashboard maintenance boundary", () => {
	it("opens only for a missing key or a valid open record", async () => {
		expect(await readAppRuntimeControl(envWith(null))).toEqual({
			status: "open",
		});
		expect(await readAppRuntimeControl(envWith(record(false)))).toEqual({
			status: "open",
		});
	});

	it("fails closed on malformed, unreadable, or mismatched generation state", async () => {
		expect(await readAppRuntimeControl(envWith("{"))).toMatchObject({
			status: "blocked",
			reason: "malformed",
		});
		expect(
			await readAppRuntimeControl(envWith(new Error("unavailable"))),
		).toMatchObject({ status: "blocked", reason: "read_failed" });
		expect(
			await readAppRuntimeControl(
				envWith(record(false, BASELINE_GENERATION + 1)),
			),
		).toMatchObject({
			status: "blocked",
			reason: "generation_mismatch",
		});
		expect(
			await readAppRuntimeControl(
				envWith(null, {
					BASELINE_GENERATION: String(
						BASELINE_GENERATION + 1,
					) as Cloudflare.Env["BASELINE_GENERATION"],
				}),
			),
		).toMatchObject({
			status: "blocked",
			reason: "configuration_mismatch",
		});
	});

	it("exposes only read-only control health and a domain-separated smoke", async () => {
		const token = "cutover-smoke-token";
		const cfEnv = envWith(record(true), {
			MAINTENANCE_SMOKE_BYPASS_SHA256: await bypassDigest(token),
		});
		const denied = await appMaintenanceResponse(
			new Request("https://relayapi.dev/health/control"),
			cfEnv,
		);
		expect(denied?.status).toBe(503);
		expect(await denied?.json()).toMatchObject({
			status: "maintenance",
			application_baseline_generation: APP_BASELINE_GENERATION,
		});
		const smoke = await appMaintenanceResponse(
			new Request("https://relayapi.dev/internal/cutover-smoke", {
				headers: { [MAINTENANCE_SMOKE_HEADER]: token },
			}),
			cfEnv,
		);
		expect(smoke?.status).toBe(200);
		expect(await smoke?.json()).toMatchObject({
			ok: true,
			control: { status: "maintenance" },
		});
		expect(
			await appMaintenanceResponse(
				new Request("https://relayapi.dev/app", {
					headers: { [MAINTENANCE_SMOKE_HEADER]: token },
				}),
				cfEnv,
			),
		).toMatchObject({ status: 503 });
	});

	it("blocks dashboard producers while the API drains existing Queue work", async () => {
		const cfEnv = envWith(record(false, APP_BASELINE_GENERATION, "draining"));
		expect(await readAppRuntimeControl(cfEnv)).toEqual({ status: "draining" });
		const response = await appMaintenanceResponse(
			new Request("https://relayapi.dev/app"),
			cfEnv,
		);
		expect(response).toMatchObject({ status: 503 });
	});

	it("keeps the generation-1 dashboard closed through the drain handoff", () => {
		const drain = record(false, 1, "draining");
		const nextMaintenance = record(true, 2, "maintenance");
		expect(interpretAppRuntimeControl(drain, 1)).toEqual({
			status: "draining",
		});
		expect(interpretAppRuntimeControl(nextMaintenance, 1)).toEqual({
			status: "blocked",
			reason: "generation_mismatch",
		});
		expect(interpretAppRuntimeControl(nextMaintenance, 2)).toEqual({
			status: "maintenance",
		});
	});

	it("allows the read-only smoke to attest a generation mismatch", async () => {
		const token = "cutover-smoke-token";
		const response = await appMaintenanceResponse(
			new Request("https://relayapi.dev/internal/cutover-smoke", {
				headers: { [MAINTENANCE_SMOKE_HEADER]: token },
			}),
			envWith(record(true, APP_BASELINE_GENERATION + 1), {
				MAINTENANCE_SMOKE_BYPASS_SHA256: await bypassDigest(token),
			}),
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toMatchObject({
			control: { status: "blocked", reason: "generation_mismatch" },
		});
	});

	it("runs the database identity probe only for explicit self-hosted smoke requests", async () => {
		const token = "cutover-smoke-token";
		let probes = 0;
		const cfEnv = envWith(null, {
			DEPLOYMENT_MODE: "self_hosted",
			MAINTENANCE_SMOKE_BYPASS_SHA256: await bypassDigest(token),
		});
		const response = await appMaintenanceResponse(
			new Request(
				"https://app.example.com/internal/cutover-smoke?probe=database",
				{ headers: { [MAINTENANCE_SMOKE_HEADER]: token } },
			),
			cfEnv,
			async () => {
				probes++;
				return { name: "relayapi", user: "relayapi_runtime" };
			},
		);
		expect(response?.status).toBe(200);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		expect(await response?.json()).toMatchObject({
			ok: true,
			database: { name: "relayapi", user: "relayapi_runtime" },
		});
		expect(probes).toBe(1);

		const hosted = await appMaintenanceResponse(
			new Request(
				"https://relayapi.dev/internal/cutover-smoke?probe=database",
				{ headers: { [MAINTENANCE_SMOKE_HEADER]: token } },
			),
			envWith(null, {
				MAINTENANCE_SMOKE_BYPASS_SHA256: await bypassDigest(token),
			}),
			async () => {
				probes++;
				return { name: "wrong", user: "wrong" };
			},
		);
		expect(await hosted?.json()).not.toHaveProperty("database");
		expect(probes).toBe(1);
	});

	it("returns a sanitized 503 when the self-hosted database probe fails", async () => {
		const token = "cutover-smoke-token";
		const response = await appMaintenanceResponse(
			new Request(
				"https://app.example.com/internal/cutover-smoke?probe=database",
				{ headers: { [MAINTENANCE_SMOKE_HEADER]: token } },
			),
			envWith(null, {
				DEPLOYMENT_MODE: "self_hosted",
				MAINTENANCE_SMOKE_BYPASS_SHA256: await bypassDigest(token),
			}),
			async () => {
				throw new Error("postgresql://runtime:secret@db.example.com/relayapi");
			},
		);
		expect(response?.status).toBe(503);
		const body = JSON.stringify(await response?.json());
		expect(body).toContain("DATABASE_PROBE_FAILED");
		expect(body).not.toContain("secret");
		expect(response?.headers.get("cache-control")).toBe("no-store");
	});

	it("rejects mutation methods and invalid smoke credentials", async () => {
		const cfEnv = envWith(record(true));
		const mutation = await appMaintenanceResponse(
			new Request("https://relayapi.dev/health/control", { method: "POST" }),
			cfEnv,
		);
		expect(mutation?.status).toBe(405);
		expect(mutation?.headers.get("allow")).toBe("GET, HEAD");
		const invalid = await appMaintenanceResponse(
			new Request("https://relayapi.dev/internal/cutover-smoke"),
			cfEnv,
		);
		expect(invalid?.status).toBe(404);
	});
});
