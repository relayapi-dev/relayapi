import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { decodeTimestampIdCursor } from "../lib/pagination-cursor";
import apiKeysRouter from "../routes/api-keys";
import connectionsRouter from "../routes/connections";
import { contactsRouter } from "../routes/contacts";
import contentTemplatesRouter from "../routes/content-templates";
import ideasRouter from "../routes/ideas";
import inboxCommentsRouter from "../routes/inbox";
import inboxRouter from "../routes/inbox-feed";
import landingPagesRouter from "../routes/landing-pages";
import postsRouter from "../routes/posts";
import qrCodesRouter from "../routes/qr-codes";
import queueRouter from "../routes/queue";
import refUrlsRouter from "../routes/ref-urls";
import signaturesRouter from "../routes/signatures";
import subscriptionListsRouter from "../routes/subscription-lists";
import threadsRouter from "../routes/threads";
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
		c.set("principalId", "prn_a");
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
		["post tags", postsRouter, "/post_1/tags?cursor=not-a-cursor"],
		["ideas", ideasRouter, "/?cursor=not-a-cursor"],
		["inbox conversations", inboxRouter, "/conversations?cursor=not-a-cursor"],
		["inbox messages", inboxRouter, "/search?q=hello&cursor=not-a-cursor"],
		["webhooks", webhooksRouter, "/?cursor=not-a-cursor"],
		["webhook logs", webhooksRouter, "/logs?cursor=not-a-cursor"],
		["API keys", apiKeysRouter, "/?cursor=not-a-cursor"],
		["contact consents", contactsRouter, "/ct_1/consents?cursor=not-a-cursor"],
		["queue failures", queueRouter, "/failures?cursor=not-a-cursor"],
		["subscription lists", subscriptionListsRouter, "/?cursor=not-a-cursor"],
		["reference URLs", refUrlsRouter, "/?cursor=not-a-cursor"],
		["QR codes", qrCodesRouter, "/?cursor=not-a-cursor"],
		["landing pages", landingPagesRouter, "/?cursor=not-a-cursor"],
		["content templates", contentTemplatesRouter, "/?cursor=not-a-cursor"],
		["connection logs", connectionsRouter, "/logs?cursor=not-a-cursor"],
		["publishing logs", postsRouter, "/logs?cursor=not-a-cursor"],
		["threads", threadsRouter, "/?cursor=not-a-cursor"],
		["idea comments", ideasRouter, "/idea_1/comments?cursor=not-a-cursor"],
		["idea activity", ideasRouter, "/idea_1/activity?cursor=not-a-cursor"],
		["signatures", signaturesRouter, "/?cursor=not-a-cursor"],
		[
			"cross-platform comments",
			inboxCommentsRouter,
			"/comments?cursor=not-a-cursor",
		],
		[
			"commented posts",
			inboxCommentsRouter,
			"/comments/by-post?cursor=not-a-cursor",
		],
		[
			"subscription-list members",
			subscriptionListsRouter,
			"/sublist_1/members?cursor=not-a-cursor",
		],
	] as const)(
		"rejects malformed %s cursors before querying",
		async (_name, router, path) => {
			const response = await request(router, path);
			expect(response.status).toBe(400);
			expect((await response.json()) as { error: { code: string } }).toEqual({
				error: expect.objectContaining({ code: "INVALID_CURSOR" }),
			});
		},
	);

	it("does not advertise ignored content-template date filters", async () => {
		const response = await request(
			contentTemplatesRouter,
			"/?from=2026-01-01T00%3A00%3A00Z",
		);
		expect(response.status).toBe(400);
	});

	// These endpoints previously emitted a raw ISO timestamp as next_cursor.
	// Accepting that shape for one release keeps clients paginating across the
	// deploy instead of 400-ing mid-scroll. `not-a-cursor` above contains no
	// ':' and so is unaffected by the shim.
	it.each([
		["content templates", contentTemplatesRouter, "/"],
		["connection logs", connectionsRouter, "/logs"],
		["publishing logs", postsRouter, "/logs"],
		["threads", threadsRouter, "/"],
		["idea comments", ideasRouter, "/idea_1/comments"],
		["idea activity", ideasRouter, "/idea_1/activity"],
		["signatures", signaturesRouter, "/"],
	] as const)(
		"still accepts a pre-composite %s cursor",
		async (_name, router, path) => {
			const response = await request(
				router,
				`${path}?cursor=${encodeURIComponent("2026-06-01T12:00:00.000Z")}`,
			);
			// The stub DB throws on any query, so reaching it proves the cursor was
			// accepted rather than rejected as malformed.
			expect(response.status).not.toBe(400);
		},
	);
});

describe("timestamp cursor route contracts", () => {
	it.each([
		[
			"content-templates.ts",
			"contentTemplates.createdAt",
			"contentTemplates.id",
		],
		["connections.ts", "connectionLogs.createdAt", "connectionLogs.id"],
		["posts.ts", "postTargets.updatedAt", "postTargets.id"],
		["threads.ts", "posts.createdAt", "posts.id"],
		["ideas.ts", "ideaComments.createdAt", "ideaComments.id"],
		["ideas.ts", "ideaActivity.createdAt", "ideaActivity.id"],
		["signatures.ts", "signatures.createdAt", "signatures.id"],
		// Converted from boundary-row lookups to self-contained composite cursors.
		["tags.ts", "tags.createdAt", "tags.id"],
		["media.ts", "media.createdAt", "media.id"],
		["contacts.ts", "contacts.createdAt", "contacts.id"],
		["accounts.ts", "socialAccounts.connectedAt", "socialAccounts.id"],
		["segments.ts", "segments.createdAt", "segments.id"],
		[
			"cross-post-actions.ts",
			"crossPostActions.createdAt",
			"crossPostActions.id",
		],
		["invite.ts", "inviteTokens.createdAt", "inviteTokens.id"],
		["ai-knowledge.ts", "aiKnowledgeBases.createdAt", "aiKnowledgeBases.id"],
		[
			"ai-knowledge.ts",
			"aiKnowledgeDocuments.createdAt",
			"aiKnowledgeDocuments.id",
		],
		["automation-runs.ts", "automationRuns.startedAt", "automationRuns.id"],
		["automations.ts", "automations.createdAt", "automations.id"],
		["short-links.ts", "shortLinks.createdAt", "shortLinks.id"],
		["auto-post-rules.ts", "autoPostRules.createdAt", "autoPostRules.id"],
		["ai-agents.ts", "aiAgents.createdAt", "aiAgents.id"],
		[
			"custom-fields.ts",
			"customFieldDefinitions.createdAt",
			"customFieldDefinitions.id",
		],
		["broadcasts.ts", "broadcasts.createdAt", "broadcasts.id"],
	] as const)(
		"uses a deterministic, precision-preserving keyset in %s",
		async (file, timestampColumn, idColumn) => {
			const source = await Bun.file(
				new URL(`../routes/${file}`, import.meta.url),
			).text();
			// Biome wraps long calls onto several lines with a trailing comma, so
			// match against a compacted copy rather than pinning one line break.
			const compact = source.replace(/\s+/g, "").replace(/,\)/g, ")");
			expect(source).toContain(
				`(${`\${${timestampColumn}}`}, ${`\${${idColumn}}`}) <`,
			);
			expect(compact).toContain(
				`.orderBy(desc(${timestampColumn}),desc(${idColumn}))`,
			);
			expect(source).toContain(`to_char(${`\${${timestampColumn}}`}`);
		},
	);

	it("pages step runs ascending with an explicit bigint cast", async () => {
		// automation_step_runs.id is bigserial, so a decoded string id would be
		// compared as text without the cast.
		const source = await Bun.file(
			new URL("../routes/automation-runs.ts", import.meta.url),
		).text();
		const interp = (expression: string) => `\${${expression}}`;
		expect(source).toContain(
			`(${interp("automationStepRuns.executedAt")}, ${interp("automationStepRuns.id")}) > (${interp("key.timestamp")}::timestamptz, ${interp("key.id")}::bigint)`,
		);
		expect(source).toContain(
			".orderBy(asc(automationStepRuns.executedAt), asc(automationStepRuns.id))",
		);
		expect(source).toContain(`to_char(${interp("automationStepRuns.executedAt")}`);
	});

	it("namespaces inbox tie-breakers across providers, accounts, and posts", async () => {
		const source = await Bun.file(
			new URL("../routes/inbox.ts", import.meta.url),
		).text();
		expect(source).toContain("comment.platform,");
		expect(source).toContain("comment.account_id,");
		expect(source).toContain("comment.post_id,");
		expect(source).toContain("comment.id,");
		expect(source).toContain("encodeTimestampIdCursor(");
		expect(source).toContain("isTimestampIdAfterCursor(");
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
