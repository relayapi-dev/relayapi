import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { createDb, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { ErrorResponse } from "../schemas/common";
import {
	BookmarkBody,
	EngagementResponse,
	FollowBody,
	RetweetBody,
} from "../schemas/twitter-engagement";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

// --- Shared response definitions ---

const engagementResponses = {
	200: {
		description: "Action result",
		content: { "application/json": { schema: EngagementResponse } },
	},
	401: {
		description: "Unauthorized or missing token",
		content: { "application/json": { schema: EngagementResponse } },
	},
	403: {
		description: "Forbidden",
		content: { "application/json": { schema: EngagementResponse } },
	},
	404: {
		description: "Account not found",
		content: { "application/json": { schema: EngagementResponse } },
	},
	429: {
		description: "Rate limited by Twitter",
		content: { "application/json": { schema: EngagementResponse } },
	},
	502: {
		description: "Twitter API error",
		content: { "application/json": { schema: EngagementResponse } },
	},
} as const;

// --- Route definitions ---

const retweet = createRoute({
	operationId: "retweet",
	method: "post",
	path: "/retweet",
	tags: ["Twitter"],
	summary: "Retweet a tweet",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: RetweetBody } } },
	},
	responses: engagementResponses,
});

const undoRetweet = createRoute({
	operationId: "undoRetweet",
	method: "delete",
	path: "/retweet",
	tags: ["Twitter"],
	summary: "Undo a retweet",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: RetweetBody } } },
	},
	responses: engagementResponses,
});

const bookmark = createRoute({
	operationId: "bookmarkTweet",
	method: "post",
	path: "/bookmark",
	tags: ["Twitter"],
	summary: "Bookmark a tweet",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BookmarkBody } } },
	},
	responses: engagementResponses,
});

const removeBookmark = createRoute({
	operationId: "removeBookmark",
	method: "delete",
	path: "/bookmark",
	tags: ["Twitter"],
	summary: "Remove a bookmark",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: BookmarkBody } } },
	},
	responses: engagementResponses,
});

const follow = createRoute({
	operationId: "followUser",
	method: "post",
	path: "/follow",
	tags: ["Twitter"],
	summary: "Follow a user",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: FollowBody } } },
	},
	responses: engagementResponses,
});

const unfollow = createRoute({
	operationId: "unfollowUser",
	method: "delete",
	path: "/follow",
	tags: ["Twitter"],
	summary: "Unfollow a user",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: FollowBody } } },
	},
	responses: engagementResponses,
});

// --- Helpers ---

async function getTwitterAccount(
	db: ReturnType<typeof createDb>,
	accountId: string,
	orgId: string,
	encryptionKey: string | undefined,
	workspaceScope: "all" | string[] = "all",
) {
	const [account] = await db
		.select({
			id: socialAccounts.id,
			platformAccountId: socialAccounts.platformAccountId,
			accessToken: socialAccounts.accessToken,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.platform, "twitter"),
			),
		)
		.limit(1);
	if (!account) return null;
	if (workspaceScope !== "all") {
		if (!account.workspaceId || !workspaceScope.includes(account.workspaceId)) {
			return null;
		}
	}
	return {
		...account,
		accessToken: await maybeDecrypt(account.accessToken, encryptionKey),
	};
}

interface TwitterApiError {
	errors?: Array<{ message: string; code: number }>;
	detail?: string;
	title?: string;
}

function parseTwitterError(
	status: number,
	body: TwitterApiError,
): { message: string; code?: number } {
	const twitterError = body.errors?.[0];
	const message =
		twitterError?.message ??
		body.detail ??
		body.title ??
		`Twitter API error (HTTP ${status})`;
	return { message, code: twitterError?.code };
}

// --- Route handlers ---

app.openapi(retweet, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, tweet_id } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getTwitterAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json({ success: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Twitter account not found" } }, 404);
	}
	if (!account.accessToken) {
		return c.json({ success: false, error: { code: "TOKEN_MISSING", message: "Twitter account has no access token" } }, 401);
	}

	const res = await fetch(
		`https://api.twitter.com/2/users/${account.platformAccountId}/retweets`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ tweet_id }),
		},
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as TwitterApiError;
		const { message, code } = parseTwitterError(res.status, body);
		return c.json({ success: false, error: { code: "TWITTER_API_ERROR", message, twitter_error_code: code } }, 502);
	}
	return c.json({ success: true, data: { retweeted: true } }, 200);
});

app.openapi(undoRetweet, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, tweet_id } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getTwitterAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json({ success: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Twitter account not found" } }, 404);
	}
	if (!account.accessToken) {
		return c.json({ success: false, error: { code: "TOKEN_MISSING", message: "Twitter account has no access token" } }, 401);
	}

	const res = await fetch(
		`https://api.twitter.com/2/users/${account.platformAccountId}/retweets/${tweet_id}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${account.accessToken}` } },
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as TwitterApiError;
		const { message, code } = parseTwitterError(res.status, body);
		return c.json({ success: false, error: { code: "TWITTER_API_ERROR", message, twitter_error_code: code } }, 502);
	}
	return c.json({ success: true, data: { retweeted: false } }, 200);
});

app.openapi(bookmark, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, tweet_id } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getTwitterAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json({ success: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Twitter account not found" } }, 404);
	}
	if (!account.accessToken) {
		return c.json({ success: false, error: { code: "TOKEN_MISSING", message: "Twitter account has no access token" } }, 401);
	}

	const res = await fetch(
		`https://api.twitter.com/2/users/${account.platformAccountId}/bookmarks`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ tweet_id }),
		},
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as TwitterApiError;
		const { message, code } = parseTwitterError(res.status, body);
		return c.json({ success: false, error: { code: "TWITTER_API_ERROR", message, twitter_error_code: code } }, 502);
	}
	return c.json({ success: true, data: { bookmarked: true } }, 200);
});

app.openapi(removeBookmark, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, tweet_id } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getTwitterAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json({ success: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Twitter account not found" } }, 404);
	}
	if (!account.accessToken) {
		return c.json({ success: false, error: { code: "TOKEN_MISSING", message: "Twitter account has no access token" } }, 401);
	}

	const res = await fetch(
		`https://api.twitter.com/2/users/${account.platformAccountId}/bookmarks/${tweet_id}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${account.accessToken}` } },
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as TwitterApiError;
		const { message, code } = parseTwitterError(res.status, body);
		return c.json({ success: false, error: { code: "TWITTER_API_ERROR", message, twitter_error_code: code } }, 502);
	}
	return c.json({ success: true, data: { bookmarked: false } }, 200);
});

app.openapi(follow, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, target_user_id } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getTwitterAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json({ success: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Twitter account not found" } }, 404);
	}
	if (!account.accessToken) {
		return c.json({ success: false, error: { code: "TOKEN_MISSING", message: "Twitter account has no access token" } }, 401);
	}

	const res = await fetch(
		`https://api.twitter.com/2/users/${account.platformAccountId}/following`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${account.accessToken}`, "Content-Type": "application/json" },
			body: JSON.stringify({ target_user_id }),
		},
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as TwitterApiError;
		const { message, code } = parseTwitterError(res.status, body);
		return c.json({ success: false, error: { code: "TWITTER_API_ERROR", message, twitter_error_code: code } }, 502);
	}
	const data = (await res.json().catch(() => ({}))) as { data?: { following?: boolean; pending_follow?: boolean } };
	return c.json({
		success: true,
		data: {
			following: data?.data?.following ?? true,
			pending_follow: data?.data?.pending_follow ?? false,
		},
	}, 200);
});

app.openapi(unfollow, async (c) => {
	const orgId = c.get("orgId");
	const { account_id, target_user_id } = c.req.valid("json");
	const db = createDb(c.env.HYPERDRIVE.connectionString);

	const account = await getTwitterAccount(db, account_id, orgId, c.env.ENCRYPTION_KEY, c.get("workspaceScope"));
	if (!account) {
		return c.json({ success: false, error: { code: "ACCOUNT_NOT_FOUND", message: "Twitter account not found" } }, 404);
	}
	if (!account.accessToken) {
		return c.json({ success: false, error: { code: "TOKEN_MISSING", message: "Twitter account has no access token" } }, 401);
	}

	const res = await fetch(
		`https://api.twitter.com/2/users/${account.platformAccountId}/following/${target_user_id}`,
		{ method: "DELETE", headers: { Authorization: `Bearer ${account.accessToken}` } },
	);

	if (!res.ok) {
		const body = (await res.json().catch(() => ({}))) as TwitterApiError;
		const { message, code } = parseTwitterError(res.status, body);
		return c.json({ success: false, error: { code: "TWITTER_API_ERROR", message, twitter_error_code: code } }, 502);
	}
	return c.json({ success: true, data: { following: false } }, 200);
});

export default app;
