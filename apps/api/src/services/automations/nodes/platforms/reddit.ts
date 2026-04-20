/**
 * Reddit automation node handlers.
 *
 *  Reply to comment: POST https://oauth.reddit.com/api/comment      thing_id + text
 *  Send PM:          POST https://oauth.reddit.com/api/compose     to + subject + text
 *  Reply to modmail: POST https://oauth.reddit.com/api/mod/conversations/:id  body
 *  Submit post:      POST https://oauth.reddit.com/api/submit     sr + kind + title
 *
 * Docs: https://www.reddit.com/dev/api/
 *
 * Reddit requires a UA string per app rules. All endpoints are rate-limited to
 * ~100 QPM for OAuth clients. Commercial use is gated behind the Responsible
 * Builder Policy.
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const RDT_BASE = "https://oauth.reddit.com";
const USER_AGENT = "web:RelayAPI:1.0 (by /u/relayapi)";

interface RdtCtx {
	accessToken: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<RdtCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "reddit account not found or missing token" };
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

async function rdtFormPost(
	token: string,
	path: string,
	form: Record<string, string>,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(`${RDT_BASE}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": USER_AGENT,
		},
		body: new URLSearchParams(form).toString(),
		timeout: 10_000,
	});
	if (!res.ok) {
		return { kind: "fail", error: `HTTP ${res.status} from reddit ${path}` };
	}
	return { kind: "next" };
}

export const redditReplyToCommentHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const thingId =
		(ctx.node.config.thing_id as string | undefined) ??
		(ctx.enrollment.state.thing_id as string | undefined);
	if (!text || !thingId)
		return { kind: "fail", error: "reddit_reply_to_comment needs text + thing_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return rdtFormPost(setup.accessToken, "/api/comment", {
		api_type: "json",
		thing_id: thingId,
		text: applyMergeTags(text, { state: setup.state }),
	});
};

export const redditSendPmHandler: NodeHandler = async (ctx) => {
	const to = ctx.node.config.to as string | undefined;
	const subject = (ctx.node.config.subject as string | undefined) ?? "Hi";
	const text = ctx.node.config.text as string | undefined;
	if (!to || !text)
		return { kind: "fail", error: "reddit_send_pm needs to + text" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return rdtFormPost(setup.accessToken, "/api/compose", {
		api_type: "json",
		to,
		subject,
		text: applyMergeTags(text, { state: setup.state }),
	});
};

export const redditReplyModmailHandler: NodeHandler = async (ctx) => {
	const conversationId =
		(ctx.node.config.conversation_id as string | undefined) ??
		(ctx.enrollment.state.conversation_id as string | undefined);
	const body = ctx.node.config.body as string | undefined;
	if (!conversationId || !body)
		return { kind: "fail", error: "reddit_reply_modmail needs conversation_id + body" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return rdtFormPost(
		setup.accessToken,
		`/api/mod/conversations/${conversationId}`,
		{
			body: applyMergeTags(body, { state: setup.state }),
			isAuthorHidden: String(ctx.node.config.is_author_hidden ?? false),
			isInternal: String(ctx.node.config.is_internal ?? false),
		},
	);
};

export const redditSubmitPostHandler: NodeHandler = async (ctx) => {
	const subreddit = ctx.node.config.subreddit as string | undefined;
	const title = ctx.node.config.title as string | undefined;
	const text = ctx.node.config.text as string | undefined;
	const url = ctx.node.config.url as string | undefined;
	if (!subreddit || !title)
		return { kind: "fail", error: "reddit_submit_post needs subreddit + title" };
	if (!text && !url)
		return { kind: "fail", error: "reddit_submit_post needs either text (self post) or url (link post)" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const form: Record<string, string> = {
		api_type: "json",
		sr: subreddit,
		title,
		kind: text ? "self" : "link",
	};
	if (text) form.text = applyMergeTags(text, { state: setup.state });
	if (url) form.url = url;
	return rdtFormPost(setup.accessToken, "/api/submit", form);
};
