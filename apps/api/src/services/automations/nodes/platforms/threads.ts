/**
 * Threads automation node handlers.
 *
 * Threads uses its own base (graph.threads.net/v1.0) — version pinned in
 * config/api-versions.ts via GRAPH_BASE.threads.
 *
 * Reply:  POST {GRAPH_BASE.threads}/{threads-user-id}/threads  with reply_to_id + text
 *         then POST /{threads-user-id}/threads_publish  with creation_id
 * Hide reply: POST {GRAPH_BASE.threads}/{reply-id}/manage_reply  {hide: true}
 *
 * Docs: https://developers.facebook.com/docs/threads/posts
 *       https://developers.facebook.com/docs/threads/reply-moderation
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { GRAPH_BASE } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface ThreadsCtx {
	accessToken: string;
	userId: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<ThreadsCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "threads account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		accessToken,
		userId: account.platformAccountId,
		state: ctx.enrollment.state,
	};
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

export const threadsReplyToPostHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const replyToId =
		(ctx.node.config.reply_to_id as string | undefined) ??
		(ctx.enrollment.state.post_id as string | undefined);
	if (!text || !replyToId)
		return {
			kind: "fail",
			error: "threads_reply_to_post needs text + reply_to_id",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;

	// Step 1 — create the reply container.
	const createRes = await fetchWithTimeout(
		`${GRAPH_BASE.threads}/${setup.userId}/threads`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				media_type: "TEXT",
				text: applyMergeTags(text, { state: setup.state }),
				reply_to_id: replyToId,
			}),
			timeout: 10_000,
		},
	);
	if (!createRes.ok) {
		const err = (await createRes.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${createRes.status} creating thread container`,
		};
	}
	const createData = (await createRes.json().catch(() => ({}))) as { id?: string };
	const creationId = createData.id;
	if (!creationId)
		return { kind: "fail", error: "threads reply container returned no id" };

	// Step 2 — publish the container.
	const pubRes = await fetchWithTimeout(
		`${GRAPH_BASE.threads}/${setup.userId}/threads_publish`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ creation_id: creationId }),
			timeout: 10_000,
		},
	);
	if (!pubRes.ok) {
		const err = (await pubRes.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${pubRes.status} publishing thread reply`,
		};
	}
	const pubData = (await pubRes.json().catch(() => ({}))) as { id?: string };
	return { kind: "next", state_patch: { last_reply_id: pubData.id } };
};

export const threadsHideReplyHandler: NodeHandler = async (ctx) => {
	const replyId =
		(ctx.node.config.reply_id as string | undefined) ??
		(ctx.enrollment.state.reply_id as string | undefined);
	if (!replyId) return { kind: "fail", error: "threads_hide_reply needs reply_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.threads}/${replyId}/manage_reply`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ hide: true }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} hiding threads reply`,
		};
	}
	return { kind: "next" };
};
