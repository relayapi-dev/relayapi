// Cross-tenant scope guarantees for cursor pagination.
//
// The original defect: list routes resolved a client's id cursor with
// `.where(eq(table.id, cursor))` and no tenant predicate, so a cursor was a
// probe for row existence in another organization. Scoping that lookup fixed
// the leak but introduced a second one: the lookup also carried the caller's
// mutable filters (status, search, lifecycle), so a cursor issued seconds
// earlier 400'd as soon as its boundary row changed state or was deleted.
//
// The resolution is structural rather than defensive — the sort key travels
// inside the cursor, so there is no second query to probe with. These tests
// pin that property: exactly one query per list request, with the tenant scope
// in it, and no route reintroducing a boundary-row lookup.

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { PgDialect } from "drizzle-orm/pg-core";
import { encodeTimestampIdCursor } from "../lib/pagination-cursor";
import segmentsRouter from "../routes/segments";
import type { Env, Variables } from "../types";

type CapturedCondition = {
	getSQL(): Parameters<PgDialect["sqlToQuery"]>[0];
};

function countingDb(captured: CapturedCondition[], calls: { select: number }) {
	// biome-ignore lint/suspicious/noExplicitAny: focused Drizzle query stub
	const query: any = {
		select: () => {
			calls.select += 1;
			return query;
		},
		from: () => query,
		where: (condition: CapturedCondition) => {
			captured.push(condition);
			return query;
		},
		orderBy: () => query,
		limit: async () => [],
	};
	return query;
}

function scopedApp(captured: CapturedCondition[], calls: { select: number }) {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_a");
		c.set("workspaceScope", ["ws_a"]);
		c.set("db", countingDb(captured, calls) as never);
		await next();
	});
	app.route("/", segmentsRouter);
	return app;
}

describe("scoped cursor pagination", () => {
	it("carries the tenant scope in the page query and issues no second query", async () => {
		const captured: CapturedCondition[] = [];
		const calls = { select: 0 };
		const cursor = encodeTimestampIdCursor(
			"2026-06-01T12:00:00.000000Z",
			"seg_foreign",
		);

		const response = await scopedApp(captured, calls).request(
			`/?workspace_id=ws_a&cursor=${encodeURIComponent(cursor)}`,
			{},
			{} as Env,
		);

		expect(response.status).toBe(200);
		// One query means there is no boundary-row lookup to probe with: the
		// cross-tenant surface is gone structurally, not merely guarded.
		expect(calls.select).toBe(1);
		expect(captured).toHaveLength(1);

		const pageCondition = captured[0];
		if (!pageCondition) throw new Error("page condition was not captured");
		const compiled = new PgDialect().sqlToQuery(pageCondition.getSQL());
		expect(compiled.sql).toContain('"segments"."organization_id" = $');
		expect(compiled.sql).toContain('"segments"."workspace_id" = $');
		expect(compiled.params).toEqual(
			expect.arrayContaining(["org_a", "ws_a", "seg_foreign"]),
		);
	});

	it("rejects an undecodable cursor before touching the database", async () => {
		const captured: CapturedCondition[] = [];
		const calls = { select: 0 };

		const response = await scopedApp(captured, calls).request(
			"/?workspace_id=ws_a&cursor=seg_foreign",
			{},
			{} as Env,
		);

		expect(response.status).toBe(400);
		const body: unknown = await response.json();
		expect(body).toEqual({
			error: {
				code: "INVALID_CURSOR",
				message: "The pagination cursor is invalid or unsupported",
			},
		});
		expect(calls.select).toBe(0);
	});

	// Anti-contract: `cursorRow` is the name every boundary-row lookup used.
	// Its absence is what keeps the pattern from being copied back in.
	const selfContainedCursorRoutes = [
		["tags.ts"],
		["media.ts"],
		["contacts.ts"],
		["accounts.ts"],
		["segments.ts"],
		["cross-post-actions.ts"],
		["invite.ts"],
		["ai-knowledge.ts"],
		["automation-runs.ts"],
		["automations.ts"],
		["short-links.ts"],
		["auto-post-rules.ts"],
		["ai-agents.ts"],
		["custom-fields.ts"],
	];

	it.each(selfContainedCursorRoutes)(
		"%s resolves its cursor without a boundary-row lookup",
		async (file) => {
			const source = await Bun.file(
				new URL(`../routes/${file}`, import.meta.url),
			).text();
			expect(source).not.toContain("cursorRow");
			expect(source).toContain("tryDecodeTimestampIdCursor(");
			expect(source).toContain("encodeTimestampIdCursor(");
		},
	);

	// The two routes that cannot carry their sort key in an opaque timestamp
	// cursor keep a lookup, but it must be scoped to immutable conditions only.
	const scopeOnlyAnchorRoutes = [
		// (name, id) sort key — name is mutable text.
		["workspaces.ts", "scopeConditions", "workspaces.id"],
		// Ordered by id alone; supporting indexes are (broadcast_id, status, id).
		["broadcasts.ts", "scopeConditions", "broadcastRecipients.id"],
	];

	it.each(scopeOnlyAnchorRoutes)(
		"%s anchors its cursor on immutable scope only",
		async (file, scopeSet, idColumn) => {
			const source = await Bun.file(
				new URL(`../routes/${file}`, import.meta.url),
			).text();
			expect(source).toContain(
				`.where(and(...${scopeSet}, eq(${idColumn}, cursor)))`,
			);
			expect(source).toContain(
				"if (!cursorRow) return c.json(INVALID_CURSOR_BODY, 400);",
			);
		},
	);
});
