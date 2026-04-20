/**
 * YouTube Data API v3 automation node handlers.
 *
 *  - Reply to comment:     POST /youtube/v3/comments     body: kind=comment with parentId
 *  - Send live chat msg:   POST /youtube/v3/liveChat/messages?part=snippet
 *  - Moderate comment:     POST /youtube/v3/comments/setModerationStatus?id=&moderationStatus=
 *
 * Docs: https://developers.google.com/youtube/v3/docs/comments/insert
 *       https://developers.google.com/youtube/v3/live/docs/liveChatMessages/insert
 *       https://developers.google.com/youtube/v3/docs/comments/setModerationStatus
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { API_VERSIONS } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const YT_BASE = `https://www.googleapis.com/youtube/${API_VERSIONS.youtube}`;

interface YtCtx {
	accessToken: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<YtCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "youtube account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return { accessToken, state: ctx.enrollment.state };
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

export const youtubeReplyToCommentHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const parentId =
		(ctx.node.config.parent_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	if (!text || !parentId)
		return { kind: "fail", error: "youtube_reply_to_comment needs text + parent_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(`${YT_BASE}/comments?part=snippet`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${setup.accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			snippet: {
				parentId,
				textOriginal: applyMergeTags(text, { state: setup.state }),
			},
		}),
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} from youtube comments`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { id?: string };
	return { kind: "next", state_patch: { last_reply_id: data.id } };
};

export const youtubeSendLiveChatHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const liveChatId =
		(ctx.node.config.live_chat_id as string | undefined) ??
		(ctx.enrollment.state.live_chat_id as string | undefined);
	if (!text || !liveChatId)
		return { kind: "fail", error: "youtube_send_live_chat needs text + live_chat_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${YT_BASE}/liveChat/messages?part=snippet`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				snippet: {
					liveChatId,
					type: "textMessageEvent",
					textMessageDetails: {
						messageText: applyMergeTags(text, { state: setup.state }),
					},
				},
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} from youtube live chat`,
		};
	}
	return { kind: "next" };
};

export const youtubeModerateCommentHandler: NodeHandler = async (ctx) => {
	const commentId =
		(ctx.node.config.comment_id as string | undefined) ??
		(ctx.enrollment.state.comment_id as string | undefined);
	const status =
		(ctx.node.config.moderation_status as string | undefined) ?? "heldForReview";
	if (!commentId)
		return { kind: "fail", error: "youtube_moderate_comment needs comment_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const url = `${YT_BASE}/comments/setModerationStatus?id=${encodeURIComponent(commentId)}&moderationStatus=${encodeURIComponent(status)}`;
	const res = await fetchWithTimeout(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${setup.accessToken}` },
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} moderating youtube comment`,
		};
	}
	return { kind: "next" };
};
