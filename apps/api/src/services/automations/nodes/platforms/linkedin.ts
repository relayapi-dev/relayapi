/**
 * LinkedIn automation node handlers.
 *
 * Uses the LinkedIn Versioned REST API (YYYYMM format pinned in api-versions.ts).
 *
 *  - Reply to comment:  POST /rest/socialActions/{urn}/comments
 *  - React to post:     POST /rest/reactions?actor={memberUrn}
 *
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions
 *       https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/reaction-api
 *
 * Note (from audit): `r_member_social` is currently closed to new apps per
 * Microsoft docs. Approved Community Management API apps only.
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { API_VERSIONS } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const LI_BASE = "https://api.linkedin.com/rest";

interface LiCtx {
	accessToken: string;
	memberUrn: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<LiCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "linkedin account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		accessToken,
		memberUrn: `urn:li:person:${account.platformAccountId}`,
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

function liHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		"LinkedIn-Version": API_VERSIONS.linkedin,
		"X-Restli-Protocol-Version": "2.0.0",
	};
}

/**
 * Replies to an existing LinkedIn comment. LinkedIn treats a reply as a nested
 * comment whose `parentComment` points at the parent and whose `object` points
 * at the original share:
 *
 *   POST /rest/socialActions/{commentUrn}/comments
 *   body: { actor, object, parentComment, message }
 *
 * A top-level comment on a share would be the older
 *   POST /rest/socialActions/{shareUrn}/comments
 * with only { actor, message } — that's NOT what this node does. Use the
 * comment-level URL + both parent references so LinkedIn threads the reply
 * correctly. See https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions
 */
export const linkedinReplyToCommentHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const commentUrn =
		(ctx.node.config.comment_urn as string | undefined) ??
		(ctx.enrollment.state.comment_urn as string | undefined);
	const shareUrn =
		(ctx.node.config.share_urn as string | undefined) ??
		(ctx.enrollment.state.share_urn as string | undefined);
	if (!text || !commentUrn || !shareUrn)
		return {
			kind: "fail",
			error:
				"linkedin_reply_to_comment needs text + comment_urn (parent) + share_urn (original post)",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${LI_BASE}/socialActions/${encodeURIComponent(commentUrn)}/comments`,
		{
			method: "POST",
			headers: liHeaders(setup.accessToken),
			body: JSON.stringify({
				actor: setup.memberUrn,
				object: shareUrn,
				parentComment: commentUrn,
				message: { text: applyMergeTags(text, { state: setup.state }) },
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from linkedin` };
	}
	return { kind: "next" };
};

export const linkedinReactToPostHandler: NodeHandler = async (ctx) => {
	const reactionType =
		(ctx.node.config.reaction as string | undefined) ?? "LIKE";
	const shareUrn =
		(ctx.node.config.share_urn as string | undefined) ??
		(ctx.enrollment.state.share_urn as string | undefined);
	if (!shareUrn)
		return { kind: "fail", error: "linkedin_react_to_post needs share_urn" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${LI_BASE}/reactions?actor=${encodeURIComponent(setup.memberUrn)}`,
		{
			method: "POST",
			headers: liHeaders(setup.accessToken),
			body: JSON.stringify({ reactionType, root: shareUrn }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from linkedin` };
	}
	return { kind: "next" };
};
