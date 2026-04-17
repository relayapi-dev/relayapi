/**
 * X (Twitter) API v2 automation node handlers.
 *
 * Docs:
 *  - DMs:         https://docs.x.com/x-api/direct-messages/manage/introduction
 *  - Tweets:      https://docs.x.com/x-api/posts/creation-of-a-post
 *  - Likes:       https://docs.x.com/x-api/posts/likes
 *  - Retweets:    https://docs.x.com/x-api/posts/retweets
 *
 * Tier gating: the Pay-per-Use tier permits 3 DM conversation subs and 1 webhook.
 */

import { contactChannels, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const TWITTER_BASE = "https://api.x.com/2";

interface TwitterCtx {
	accessToken: string;
	userId: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<TwitterCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "twitter account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		accessToken,
		userId: account.platformAccountId,
		state: ctx.enrollment.state,
	};
}

async function recipientFromContact(
	ctx: NodeExecutionContext,
): Promise<string | null> {
	if (!ctx.enrollment.contact_id) return null;
	const chan = await ctx.db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, ctx.enrollment.contact_id),
			eq(contactChannels.platform, "twitter"),
		),
	});
	return chan?.identifier ?? null;
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function twitterCall(
	accessToken: string,
	path: string,
	method: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
	const res = await fetchWithTimeout(`${TWITTER_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
		timeout: 10_000,
	});
	const json = await res.json().catch(() => ({}));
	return { ok: res.ok, status: res.status, json };
}

function failFromTwitter(status: number, json: unknown): NodeExecutionResult {
	const err = json as { detail?: string; errors?: Array<{ message: string }> };
	return {
		kind: "fail",
		error: err?.errors?.[0]?.message ?? err?.detail ?? `HTTP ${status} from x.com`,
	};
}

// ---------------------------------------------------------------------------

export const twitterSendDmHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "twitter_send_dm missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const recipient = await recipientFromContact(ctx);
	if (!recipient) return { kind: "fail", error: "contact has no twitter identifier" };
	const { ok, status, json } = await twitterCall(
		setup.accessToken,
		`/dm_conversations/with/${recipient}/messages`,
		"POST",
		{ text: applyMergeTags(text, { state: setup.state }) },
	);
	if (!ok) return failFromTwitter(status, json);
	const data = json as { data?: { dm_event_id?: string } };
	return { kind: "next", state_patch: { last_message_id: data.data?.dm_event_id } };
};

export const twitterSendDmMediaHandler: NodeHandler = async (ctx) => {
	const text = (ctx.node.config.text as string | undefined) ?? "";
	const mediaId = ctx.node.config.media_id as string | undefined;
	if (!mediaId)
		return {
			kind: "fail",
			error: "twitter_send_dm_media requires 'media_id' (upload via X media endpoint first)",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const recipient = await recipientFromContact(ctx);
	if (!recipient) return { kind: "fail", error: "contact has no twitter identifier" };
	const { ok, status, json } = await twitterCall(
		setup.accessToken,
		`/dm_conversations/with/${recipient}/messages`,
		"POST",
		{
			text: applyMergeTags(text, { state: setup.state }),
			attachments: [{ media_id: mediaId }],
		},
	);
	if (!ok) return failFromTwitter(status, json);
	const data = json as { data?: { dm_event_id?: string } };
	return { kind: "next", state_patch: { last_message_id: data.data?.dm_event_id } };
};

export const twitterReplyToTweetHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const tweetId =
		(ctx.node.config.tweet_id as string | undefined) ??
		(ctx.enrollment.state.tweet_id as string | undefined);
	if (!text || !tweetId)
		return { kind: "fail", error: "twitter_reply_to_tweet needs text + tweet_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const { ok, status, json } = await twitterCall(
		setup.accessToken,
		`/tweets`,
		"POST",
		{
			text: applyMergeTags(text, { state: setup.state }),
			reply: { in_reply_to_tweet_id: tweetId },
		},
	);
	if (!ok) return failFromTwitter(status, json);
	const data = json as { data?: { id?: string } };
	return { kind: "next", state_patch: { last_reply_id: data.data?.id } };
};

export const twitterLikeTweetHandler: NodeHandler = async (ctx) => {
	const tweetId =
		(ctx.node.config.tweet_id as string | undefined) ??
		(ctx.enrollment.state.tweet_id as string | undefined);
	if (!tweetId) return { kind: "fail", error: "twitter_like_tweet needs tweet_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const { ok, status, json } = await twitterCall(
		setup.accessToken,
		`/users/${setup.userId}/likes`,
		"POST",
		{ tweet_id: tweetId },
	);
	if (!ok) return failFromTwitter(status, json);
	return { kind: "next" };
};

export const twitterRetweetHandler: NodeHandler = async (ctx) => {
	const tweetId =
		(ctx.node.config.tweet_id as string | undefined) ??
		(ctx.enrollment.state.tweet_id as string | undefined);
	if (!tweetId) return { kind: "fail", error: "twitter_retweet needs tweet_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const { ok, status, json } = await twitterCall(
		setup.accessToken,
		`/users/${setup.userId}/retweets`,
		"POST",
		{ tweet_id: tweetId },
	);
	if (!ok) return failFromTwitter(status, json);
	return { kind: "next" };
};
