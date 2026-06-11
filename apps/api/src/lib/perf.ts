import type { Context, MiddlewareHandler, Next } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

/**
 * Request-phase performance tracker.
 *
 * Enabled when env.PERF_LOGS === "1". Each /v1 middleware is wrapped with
 * `timed(name, mw)` which records how long the middleware's own work took,
 * split into `pre` (before it called next) and `post` (after next returned).
 * The innermost segment — the route handler plus zod validation — is whatever
 * remains of the total once middleware time is subtracted.
 *
 * Output per request (only when enabled):
 * - a `Server-Timing` response header (visible from curl, no tail needed)
 * - a structured console.log line (visible in `wrangler tail` / observability)
 */

let isolateRequestCount = 0;

export interface PerfSpan {
	name: string;
	/** ms spent before the middleware called next() (its own pre-work) */
	pre: number;
	/** ms spent after next() returned (its own post-work) */
	post: number;
}

export class PerfTracker {
	spans: PerfSpan[] = [];
	dbQueries: { sql: string; ms?: number }[] = [];
	start = performance.now();

	recordQuery(sql: string, ms?: number) {
		// Cap retained queries to keep log lines bounded
		if (this.dbQueries.length < 50) {
			this.dbQueries.push({ sql: sql.slice(0, 120), ms });
		}
	}
}

export function perfEnabled(env: Env): boolean {
	return (env as Env & { PERF_LOGS?: string }).PERF_LOGS === "1";
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Wrap a middleware so its own cost is recorded as a span. No-op overhead
 * when perf logging is disabled (single boolean check).
 */
export function timed(
	name: string,
	mw: MiddlewareHandler<{ Bindings: Env; Variables: Variables }>,
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
	return async (c: AppContext, next: Next) => {
		const perf = c.get("perf");
		if (!perf) return mw(c, next);

		const t0 = performance.now();
		let tNextStart = 0;
		let tNextEnd = 0;
		const res = await mw(c, async () => {
			tNextStart = performance.now();
			await next();
			tNextEnd = performance.now();
		});
		const t1 = performance.now();
		perf.spans.push({
			name,
			pre: (tNextStart || t1) - t0,
			post: tNextEnd ? t1 - tNextEnd : 0,
		});
		return res;
	};
}

/**
 * Root timing middleware. Mount FIRST so `total` covers the whole pipeline.
 */
export const perfLogMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (!perfEnabled(c.env)) return next();

	const requestIndex = isolateRequestCount++;
	const perf = new PerfTracker();
	c.set("perf", perf);

	await next();

	const total = performance.now() - perf.start;
	// Spans get pushed innermost-first; reverse for reading order.
	const spans = [...perf.spans].reverse();
	const middlewareMs = spans.reduce((s, x) => s + x.pre + x.post, 0);

	const header = [
		...spans.map(
			(s) => `${s.name};dur=${(s.pre + s.post).toFixed(1)}`,
		),
		`handler;dur=${Math.max(0, total - middlewareMs).toFixed(1)}`,
		`db;dur=0;desc="n=${perf.dbQueries.length}"`,
		`total;dur=${total.toFixed(1)}`,
	].join(", ");

	// Headers can no longer be set if the response already streamed; guard.
	try {
		c.res.headers.set("Server-Timing", header);
	} catch {
		// immutable response (e.g. WebSocket upgrade) — skip header
	}

	console.log(
		JSON.stringify({
			t: "perf",
			m: c.req.method,
			p: c.req.path,
			s: c.res.status,
			total_ms: Math.round(total * 10) / 10,
			handler_ms: Math.round(Math.max(0, total - middlewareMs) * 10) / 10,
			spans: Object.fromEntries(
				spans.map((s) => [
					s.name,
					Math.round((s.pre + s.post) * 10) / 10,
				]),
			),
			db_n: perf.dbQueries.length,
			db_q: perf.dbQueries.map((q) => q.sql.slice(0, 80)),
			// First request handled by this isolate ⇒ cold start
			cold: requestIndex === 0,
		}),
	);
});
