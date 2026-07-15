import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { decodeTimestampIdCursor } from "../lib/pagination-cursor";
import apiKeysRouter from "../routes/api-keys";
import { contactsRouter } from "../routes/contacts";
import ideasRouter from "../routes/ideas";
import inboxRouter from "../routes/inbox-feed";
import postsRouter from "../routes/posts";
import queueRouter from "../routes/queue";
import webhooksRouter from "../routes/webhooks";
import {
	listConversations,
	searchMessages,
} from "../services/inbox-persistence";
import type { Env, Variables } from "../types";

const throwingDb = new Proxy(
	{},
	{
		get() {
			throw new Error("malformed cursor reached the database");
		},
	},
);

function request(router: typeof postsRouter, path: string) {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_a");
		c.set("keyId", "key_a");
		c.set("permissions", ["read", "write", "manage_api_keys"]);
		c.set("workspaceScope", "all");
		c.set("db", throwingDb as never);
		await next();
	});
	app.route("/", router);
	return app.request(path, {}, {} as Env);
}

describe("affected cursor routes", () => {
	it.each([
		["posts", postsRouter, "/?cursor=not-a-cursor"],
		["ideas", ideasRouter, "/?cursor=not-a-cursor"],
		["inbox conversations", inboxRouter, "/conversations?cursor=not-a-cursor"],
		["inbox messages", inboxRouter, "/search?q=hello&cursor=not-a-cursor"],
		["webhooks", webhooksRouter, "/?cursor=not-a-cursor"],
		["webhook logs", webhooksRouter, "/logs?cursor=not-a-cursor"],
		["API keys", apiKeysRouter, "/?cursor=not-a-cursor"],
		["contact consents", contactsRouter, "/ct_1/consents?cursor=not-a-cursor"],
		["queue failures", queueRouter, "/failures?cursor=not-a-cursor"],
	] as const)("rejects malformed %s cursors before querying", async (_name, router, path) => {
		const response = await request(router, path);
		expect(response.status).toBe(400);
		expect((await response.json()) as { error: { code: string } }).toEqual({
			error: expect.objectContaining({ code: "INVALID_CURSOR" }),
		});
	});
});

function pageDb(rows: Array<Record<string, unknown>>) {
	const calls = { select: 0, orderByArity: 0 };
	// biome-ignore lint/suspicious/noExplicitAny: focused Drizzle query stub
	const query: any = {
		select: () => {
			calls.select++;
			return query;
		},
		from: () => query,
		where: () => query,
		orderBy: (...order: unknown[]) => {
			calls.orderByArity = order.length;
			return query;
		},
		limit: async (limit: number) => rows.slice(0, limit),
	};
	return { calls, db: query };
}

describe("inbox composite cursor results", () => {
	const timestamp = new Date("2026-07-13T12:00:00.123Z");
	const cursorTimestamp = "2026-07-13T12:00:00.123456Z";

	it("encodes updated_at and id without a cursor lookup query", async () => {
		const { calls, db } = pageDb([
			{ id: "conv_c", updatedAt: timestamp, cursorTimestamp },
			{ id: "conv_b", updatedAt: timestamp, cursorTimestamp },
			{ id: "conv_a", updatedAt: timestamp, cursorTimestamp },
		]);
		const result = await listConversations(db, "org_a", { limit: 2 });

		expect(result.has_more).toBe(true);
		expect(decodeTimestampIdCursor(result.next_cursor ?? "")).toEqual({
			timestamp: cursorTimestamp,
			id: "conv_b",
		});
		expect(calls.select).toBe(1);
		expect(calls.orderByArity).toBe(2);
	});

	it("encodes created_at and id for message search in the same query", async () => {
		const { calls, db } = pageDb([
			{ id: "msg_c", createdAt: timestamp, cursorTimestamp },
			{ id: "msg_b", createdAt: timestamp, cursorTimestamp },
			{ id: "msg_a", createdAt: timestamp, cursorTimestamp },
		]);
		const result = await searchMessages(db, "org_a", "hello", { limit: 2 });

		expect(decodeTimestampIdCursor(result.next_cursor ?? "")).toEqual({
			timestamp: cursorTimestamp,
			id: "msg_b",
		});
		expect(calls.select).toBe(1);
		expect(calls.orderByArity).toBe(2);
	});
});
