// Tests for lib/perf.ts — the PERF_LOGS=1 request instrumentation.
//
// Guards: (1) zero behavior change when disabled (no header, handlers run
// unchanged), (2) Server-Timing header with total + per-middleware spans when
// enabled, (3) timed() records a span even when the wrapped middleware
// short-circuits without calling next() (e.g. auth 401).

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { perfLogMiddleware, PerfTracker, timed } from "../lib/perf";
import type { Env, Variables } from "../types";

function makeApp(perfLogs: "0" | "1") {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", perfLogMiddleware);

	const passThrough = createMiddleware<{
		Bindings: Env;
		Variables: Variables;
	}>(async (_c, next) => {
		await next();
	});

	const reject = createMiddleware<{ Bindings: Env; Variables: Variables }>(
		async (c) => c.json({ error: { code: "UNAUTHORIZED" } }, 401),
	);

	app.use("/ok/*", timed("mw1", passThrough));
	app.use("/ok/*", timed("mw2", passThrough));
	app.get("/ok/hello", (c) => {
		// Simulate handler-issued queries being counted
		c.get("perf")?.recordQuery("select 1");
		c.get("perf")?.recordQuery("select 2");
		return c.json({ ok: true });
	});

	app.use("/denied/*", timed("authlike", reject));
	app.get("/denied/x", (c) => c.json({ ok: true }));

	const env = { PERF_LOGS: perfLogs } as unknown as Env;
	const request = (path: string) =>
		app.request(path, {}, env, {
			waitUntil: () => {},
			passThroughOnException: () => {},
			props: {},
		} as unknown as ExecutionContext);
	return { request };
}

describe("perfLogMiddleware", () => {
	it("adds no Server-Timing header when PERF_LOGS is off", async () => {
		const { request } = makeApp("0");
		const res = await request("/ok/hello");
		expect(res.status).toBe(200);
		expect(res.headers.get("Server-Timing")).toBeNull();
	});

	it("emits Server-Timing with total, handler and middleware spans when enabled", async () => {
		const { request } = makeApp("1");
		const res = await request("/ok/hello");
		expect(res.status).toBe(200);
		const st = res.headers.get("Server-Timing");
		expect(st).not.toBeNull();
		expect(st).toContain("total;dur=");
		expect(st).toContain("handler;dur=");
		expect(st).toContain("mw1;dur=");
		expect(st).toContain("mw2;dur=");
		// Both recordQuery calls counted
		expect(st).toContain('desc="n=2"');
	});

	it("records a span for middleware that short-circuits without next()", async () => {
		const { request } = makeApp("1");
		const res = await request("/denied/x");
		expect(res.status).toBe(401);
		expect(res.headers.get("Server-Timing")).toContain("authlike;dur=");
	});
});

describe("PerfTracker", () => {
	it("caps retained queries at 50 and truncates long SQL", () => {
		const t = new PerfTracker();
		const longSql = "select ".padEnd(500, "x");
		for (let i = 0; i < 60; i++) t.recordQuery(longSql);
		expect(t.dbQueries.length).toBe(50);
		const firstQuery = t.dbQueries[0];
		if (!firstQuery) throw new Error("expected a recorded query");
		expect(firstQuery.sql.length).toBeLessThanOrEqual(120);
	});
});

describe("timed()", () => {
	it("is a no-op passthrough when no tracker is set", async () => {
		const app = new Hono<{ Bindings: Env; Variables: Variables }>();
		let ran = false;
		app.use(
			"*",
			timed(
				"x",
				createMiddleware(async (_c, next) => {
					ran = true;
					await next();
				}),
			),
		);
		app.get("/", (c) => c.text("ok"));
		const res = await app.request("/", {}, {} as Env);
		expect(res.status).toBe(200);
		expect(ran).toBe(true);
	});
});
