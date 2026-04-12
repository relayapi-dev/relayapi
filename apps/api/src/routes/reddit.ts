import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createDb, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { ErrorResponse, PaginationParams } from "../schemas/common";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Schemas (inline since minimal) ---

const RedditSearchQuery = PaginationParams.extend({
	query: z.string().describe("Search query"),
	subreddit: z.string().optional().describe("Limit to subreddit"),
	sort: z
		.enum(["relevance", "hot", "top", "new", "comments"])
		.default("relevance")
		.describe("Sort order"),
	time: z
		.enum(["hour", "day", "week", "month", "year", "all"])
		.default("all")
		.describe("Time filter"),
	account_id: z.string().describe("Reddit account ID"),
});

const RedditFeedQuery = PaginationParams.extend({
	subreddit: z.string().describe("Subreddit name"),
	sort: z
		.enum(["hot", "new", "top", "rising"])
		.default("hot")
		.describe("Sort order"),
	time: z
		.enum(["hour", "day", "week", "month", "year", "all"])
		.optional()
		.describe("Time filter (for top sort)"),
	account_id: z.string().describe("Reddit account ID"),
});

const RedditPost = z.object({
	id: z.string().describe("Reddit post ID"),
	subreddit: z.string().describe("Subreddit name"),
	title: z.string().describe("Post title"),
	author: z.string().describe("Post author"),
	url: z.string().describe("Post URL"),
	selftext: z.string().nullable().optional().describe("Self text"),
	score: z.number().describe("Post score"),
	num_comments: z.number().describe("Comment count"),
	created_utc: z.number().describe("Created timestamp (Unix)"),
	thumbnail: z.string().nullable().optional().describe("Thumbnail URL"),
	is_self: z.boolean().describe("Whether it's a self post"),
	nsfw: z.boolean().describe("Whether NSFW"),
});

const RedditSearchResponse = z.object({
	data: z.array(RedditPost),
	next_cursor: z.string().nullable(),
	has_more: z.boolean(),
});

// --- Reddit API response type ---

interface RedditApiResponse {
	data: {
		children: Array<{
			data: {
				id: string;
				subreddit: string;
				title: string;
				author: string;
				url: string;
				selftext: string;
				score: number;
				num_comments: number;
				created_utc: number;
				thumbnail: string;
				is_self: boolean;
				over_18: boolean;
				name: string; // fullname e.g. "t3_abc123", used as cursor
			};
		}>;
		after: string | null;
	};
}

function mapRedditPosts(children: RedditApiResponse["data"]["children"]) {
	return children.map((child) => ({
		id: child.data.id,
		subreddit: child.data.subreddit,
		title: child.data.title,
		author: child.data.author,
		url: child.data.url,
		selftext: child.data.selftext || null,
		score: child.data.score,
		num_comments: child.data.num_comments,
		created_utc: child.data.created_utc,
		thumbnail:
			child.data.thumbnail &&
			child.data.thumbnail !== "self" &&
			child.data.thumbnail !== "default" &&
			child.data.thumbnail !== "nsfw" &&
			child.data.thumbnail !== "spoiler"
				? child.data.thumbnail
				: null,
		is_self: child.data.is_self,
		nsfw: child.data.over_18,
	}));
}

const EMPTY_RESPONSE: {
	data: never[];
	next_cursor: null;
	has_more: false;
} = { data: [], next_cursor: null, has_more: false };

// --- Route definitions ---

const searchReddit = createRoute({
	operationId: "searchReddit",
	method: "get",
	path: "/search",
	tags: ["Reddit"],
	summary: "Search Reddit posts",
	security: [{ Bearer: [] }],
	request: { query: RedditSearchQuery },
	responses: {
		200: {
			description: "Search results",
			content: {
				"application/json": { schema: RedditSearchResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

const getSubredditFeed = createRoute({
	operationId: "getSubredditFeed",
	method: "get",
	path: "/feed",
	tags: ["Reddit"],
	summary: "Get subreddit feed",
	security: [{ Bearer: [] }],
	request: { query: RedditFeedQuery },
	responses: {
		200: {
			description: "Subreddit feed",
			content: {
				"application/json": { schema: RedditSearchResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

// --- Route handlers ---

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(searchReddit, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, query, subreddit, sort, time, limit, cursor } =
		c.req.valid("query");

	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const [row] = await db
		.select({ accessToken: socialAccounts.accessToken, workspaceId: socialAccounts.workspaceId })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, account_id),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row) {
		return c.json(EMPTY_RESPONSE, 200);
	}

	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) return denied;

	const token = await maybeDecrypt(row.accessToken, c.env.ENCRYPTION_KEY);
	if (!token) {
		return c.json(EMPTY_RESPONSE, 200);
	}

	const params = new URLSearchParams({
		q: query,
		sort,
		t: time,
		limit: String(limit),
	});
	if (subreddit) {
		params.set("restrict_sr", "on");
		params.set("subreddit", subreddit);
	}
	if (cursor) {
		params.set("after", cursor);
	}

	// Reddit API: Search for posts matching a query
	// https://www.reddit.com/dev/api/#GET_search
	const response = await fetch(
		`https://oauth.reddit.com/search?${params.toString()}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": "RelayAPI/1.0",
			},
		},
	);

	if (!response.ok) {
		return c.json(EMPTY_RESPONSE, 200);
	}

	const json = (await response.json()) as RedditApiResponse;
	const data = mapRedditPosts(json.data.children);

	return c.json(
		{
			data,
			next_cursor: json.data.after ?? null,
			has_more: json.data.after !== null,
		},
		200,
	);
});

// @ts-expect-error — hono-zod-openapi strict typing vs runtime response shape
app.openapi(getSubredditFeed, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, subreddit, sort, time, limit, cursor } =
		c.req.valid("query");

	const db = createDb(c.env.HYPERDRIVE.connectionString);
	const [row2] = await db
		.select({ accessToken: socialAccounts.accessToken, workspaceId: socialAccounts.workspaceId })
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, account_id),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!row2) {
		return c.json(EMPTY_RESPONSE, 200);
	}

	const denied = assertWorkspaceScope(c, row2.workspaceId);
	if (denied) return denied;

	const token2 = await maybeDecrypt(row2.accessToken, c.env.ENCRYPTION_KEY);
	if (!token2) {
		return c.json(EMPTY_RESPONSE, 200);
	}

	const params = new URLSearchParams({
		limit: String(limit),
	});
	if (time) {
		params.set("t", time);
	}
	if (cursor) {
		params.set("after", cursor);
	}

	// Reddit API: Get a subreddit's post feed sorted by hot/new/top/rising
	// https://www.reddit.com/dev/api/#GET_{sort}
	const response = await fetch(
		`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}?${params.toString()}`,
		{
			headers: {
				Authorization: `Bearer ${token2}`,
				"User-Agent": "RelayAPI/1.0",
			},
		},
	);

	if (!response.ok) {
		return c.json(EMPTY_RESPONSE, 200);
	}

	const json = (await response.json()) as RedditApiResponse;
	const data = mapRedditPosts(json.data.children);

	return c.json(
		{
			data,
			next_cursor: json.data.after ?? null,
			has_more: json.data.after !== null,
		},
		200,
	);
});

export default app;
