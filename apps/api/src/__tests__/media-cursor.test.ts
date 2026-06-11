// Regression guard for GET /v1/media pagination.
//
// Original bug: the route accepted `cursor` (via PaginationParams) but the
// handler never read it, so page 2 was unreachable. First fix used a bare
// `createdAt` cursor, which silently dropped rows that share a created_at
// across a page boundary and truncated Postgres microseconds. Current fix:
// a composite (created_at, id) keyset — next_cursor is the last row's opaque
// id; the handler reads that row's created_at as ::text and binds it back with
// a ::timestamptz cast so ties and sub-millisecond timestamps page correctly.
// (Tie/microsecond correctness needs a live DB; these stub tests assert the
// cursor wiring and id-based next_cursor.)

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env, Variables } from "../types";

const PAGE = 20; // route default limit

function makeRows(n: number, startMs: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: `med_${String(i).padStart(3, "0")}`,
		storageKey: `org_test/med_${i}`,
		filename: `f${i}.png`,
		mimeType: "image/png",
		size: 100 + i,
		width: 10,
		height: 10,
		duration: null,
		createdAt: new Date(startMs - i * 60_000),
	}));
}

// Chainable Drizzle stub that records the where() condition tree and resolves
// `limit+1` rows so has_more is true.
function makeStubDb(rows: ReturnType<typeof makeRows>) {
	const captured: { where: unknown[] } = { where: [] };
	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	const q: any = {
		select: () => q,
		from: () => q,
		where: (cond: unknown) => {
			captured.where.push(cond);
			return q;
		},
		orderBy: () => q,
		limit: async (n: number) => rows.slice(0, n),
	};
	return { db: q, captured };
}

async function makeApp(rows: ReturnType<typeof makeRows>) {
	const { default: mediaRouter } = await import("../routes/media");
	const { db, captured } = makeStubDb(rows);

	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_test");
		c.set("workspaceScope", "all");
		// biome-ignore lint/suspicious/noExplicitAny: stub db for route test
		c.set("db", db as any);
		await next();
	});
	app.route("/v1/media", mediaRouter);

	const env = {
		// Offline HMAC presigning — fake creds work, no network involved
		R2_ACCESS_KEY_ID: "test-access-key",
		R2_SECRET_ACCESS_KEY: "test-secret-key",
		CF_ACCOUNT_ID: "test-account",
	} as unknown as Env;

	return {
		captured,
		request: (path: string) => app.request(path, {}, env),
	};
}

describe("GET /v1/media cursor pagination", () => {
	it("returns the last item's id as next_cursor when a next page exists", async () => {
		const rows = makeRows(PAGE + 1, Date.parse("2026-06-01T12:00:00Z"));
		const { request } = await makeApp(rows);
		const res = await request("/v1/media");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: unknown[];
			next_cursor: string | null;
			has_more: boolean;
		};
		expect(body.has_more).toBe(true);
		expect(body.data).toHaveLength(PAGE);
		expect(body.next_cursor).not.toBeNull();
		// Composite keyset: the cursor is the opaque id of the last returned row
		// (the handler resolves its created_at server-side for the (created_at,id)
		// comparison, so the client cursor stays an id).
		expect(body.next_cursor).toBe(rows[PAGE - 1]!.id);
	});

	it("applies the cursor as an additional where condition", async () => {
		const rows = makeRows(5, Date.parse("2026-06-01T12:00:00Z"));
		const { request, captured } = await makeApp(rows);

		// Recursively size a drizzle SQL condition tree — more conditions in
		// the and(...) produce more nested query chunks.
		// biome-ignore lint/suspicious/noExplicitAny: drizzle SQL internals
		const treeSize = (x: any): number => {
			if (!x || typeof x !== "object") return 1;
			if (Array.isArray(x.queryChunks))
				// biome-ignore lint/suspicious/noExplicitAny: drizzle SQL internals
				return x.queryChunks.reduce((s: number, c: any) => s + treeSize(c), 1);
			return 1;
		};

		const first = await request("/v1/media");
		expect(first.status).toBe(200);
		const baselineSize = treeSize(captured.where.at(-1));

		const withCursor = await request(
			`/v1/media?cursor=${encodeURIComponent("2026-06-01T11:58:00.000Z")}`,
		);
		expect(withCursor.status).toBe(200);
		const cursorSize = treeSize(captured.where.at(-1));

		// The condition tree must grow when a cursor is supplied
		expect(cursorSize).toBeGreaterThan(baselineSize);
	});

	it("ignores an unparsable cursor instead of erroring", async () => {
		const rows = makeRows(3, Date.parse("2026-06-01T12:00:00Z"));
		const { request } = await makeApp(rows);
		const res = await request("/v1/media?cursor=med_notadate");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: unknown[]; has_more: boolean };
		expect(body.has_more).toBe(false);
		expect(body.data).toHaveLength(3);
	});
});
