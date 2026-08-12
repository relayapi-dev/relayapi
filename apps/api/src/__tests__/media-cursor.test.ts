// Regression guard for GET /v1/media pagination.
//
// Original bug: the route accepted `cursor` (via PaginationParams) but the
// handler never read it, so page 2 was unreachable. A bare `createdAt` cursor
// then silently dropped rows sharing a created_at across a page boundary and
// truncated Postgres microseconds. Resolving the boundary row server-side from
// an id cursor fixed that but 400'd whenever the row was deleted or filtered
// out between pages, and cost an extra round-trip.
//
// Current design: a self-contained composite (created_at, id) cursor. The sort
// key travels in the cursor, so the page query is the only query and a deleted
// boundary row cannot break the walk. `to_char(... .US"Z")` preserves Postgres
// microseconds exactly. (Tie/microsecond correctness needs a live DB; these
// stub tests assert the cursor wiring, the encoded next_cursor, and that no
// second query is issued.)

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { decodeTimestampIdCursor, encodeTimestampIdCursor } from "../lib/pagination-cursor";
import type { Env, Variables } from "../types";

const PAGE = 20; // route default limit

interface MediaCursorRow {
	id: string;
	organizationId: string;
	workspaceId: string | null;
	status: "ready";
	storageKey: string;
	url: string;
	thumbnailUrl: null;
	originalDeletedAt: Date | null;
	deletionRequestedAt: null;
	filename: string;
	mimeType: string;
	size: number;
	width: number;
	height: number;
	duration: null;
	createdAt: Date;
	cursorTimestamp: string;
}

function makeRows(n: number, startMs: number): MediaCursorRow[] {
	return Array.from({ length: n }, (_, i) => {
		const createdAt = new Date(startMs - i * 60_000);
		return {
			id: `med_${String(i).padStart(3, "0")}`,
			organizationId: "org_test",
			workspaceId: null,
			status: "ready" as const,
			storageKey: `org_test/med_${i}`,
			url: `https://cdn.example.test/org_test/med_${i}`,
			thumbnailUrl: null,
			originalDeletedAt: null,
			deletionRequestedAt: null,
			filename: `f${i}.png`,
			mimeType: "image/png",
			size: 100 + i,
			width: 10,
			height: 10,
			duration: null,
			createdAt,
			// What to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') emits.
			cursorTimestamp: `${createdAt.toISOString().slice(0, -1)}000Z`,
		};
	});
}

// Chainable Drizzle stub that records the where() condition tree, counts
// queries, and resolves `limit+1` rows so has_more is true.
function makeStubDb(rows: ReturnType<typeof makeRows>) {
	const captured: { where: unknown[] } = { where: [] };
	const calls = { select: 0 };
	// biome-ignore lint/suspicious/noExplicitAny: minimal query-builder stub
	const q: any = {
		select: () => {
			calls.select += 1;
			return q;
		},
		from: () => q,
		where: (cond: unknown) => {
			captured.where.push(cond);
			return q;
		},
		orderBy: () => q,
		limit: async (n: number) => rows.slice(0, n),
	};
	return { db: q, captured, calls };
}

async function makeApp(rows: ReturnType<typeof makeRows>) {
	const { default: mediaRouter } = await import("../routes/media");
	const { db, captured, calls } = makeStubDb(rows);

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
		calls,
		request: (path: string) => app.request(path, {}, env),
	};
}

describe("GET /v1/media cursor pagination", () => {
	it("encodes the full sort key into next_cursor without a second query", async () => {
		const rows = makeRows(PAGE + 1, Date.parse("2026-06-01T12:00:00Z"));
		const { request, calls } = await makeApp(rows);
		const res = await request("/v1/media");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: unknown[];
			next_cursor: string | null;
			has_more: boolean;
		};
		expect(body.has_more).toBe(true);
		expect(body.data).toHaveLength(PAGE);
		expect(body.data[0]).toMatchObject({
			original_available: true,
			workspace_id: null,
		});

		const lastRow = rows[PAGE - 1];
		if (!lastRow) throw new Error("expected last row");
		expect(decodeTimestampIdCursor(body.next_cursor ?? "")).toEqual({
			timestamp: lastRow.cursorTimestamp,
			id: lastRow.id,
		});
		// The cursor is self-contained, so the page query is the only query.
		expect(calls.select).toBe(1);
	});

	it("keeps paginating when the boundary row disappears between pages", async () => {
		// The whole point of carrying the sort key in the cursor: a cursor minted
		// for a row that is then deleted (or filtered out) must still resolve.
		const rows = makeRows(3, Date.parse("2026-06-01T12:00:00Z"));
		const { request, calls } = await makeApp(rows);
		const cursor = encodeTimestampIdCursor(
			"2026-06-01T11:00:00.000000Z",
			"med_deleted",
		);
		const res = await request(`/v1/media?cursor=${encodeURIComponent(cursor)}`);
		expect(res.status).toBe(200);
		expect(calls.select).toBe(1);
	});

	it("marks thumbnail-only rows unavailable for provider delivery", async () => {
		const rows = makeRows(1, Date.parse("2026-06-01T12:00:00Z"));
		const firstRow = rows[0];
		if (!firstRow) throw new Error("expected media row");
		firstRow.originalDeletedAt = new Date("2026-06-02T12:00:00Z");
		const { request } = await makeApp(rows);

		const response = await request("/v1/media");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: Array<{ original_available: boolean }>;
		};
		expect(body.data[0]?.original_available).toBe(false);
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

		const cursorRow = rows[1];
		if (!cursorRow) throw new Error("expected cursor row");
		const cursor = encodeTimestampIdCursor(
			cursorRow.cursorTimestamp,
			cursorRow.id,
		);
		const withCursor = await request(
			`/v1/media?cursor=${encodeURIComponent(cursor)}`,
		);
		expect(withCursor.status).toBe(200);
		const cursorSize = treeSize(captured.where.at(-1));

		// The condition tree must grow when a cursor is supplied
		expect(cursorSize).toBeGreaterThan(baselineSize);
	});

	// A bare media id is not a valid cursor and gets no legacy shim: unlike the
	// timestamp-cursor routes, discriminating a legacy id from an opaque cursor
	// would require keeping the boundary-row lookup this design removed.
	it("rejects an unknown cursor instead of restarting from page one", async () => {
		const rows = makeRows(3, Date.parse("2026-06-01T12:00:00Z"));
		const { request } = await makeApp(rows);
		const res = await request("/v1/media?cursor=med_notadate");
		expect(res.status).toBe(400);
		const body: unknown = await res.json();
		expect(body).toEqual({
			error: {
				code: "INVALID_CURSOR",
				message: "The pagination cursor is invalid or unsupported",
			},
		});
	});
});
