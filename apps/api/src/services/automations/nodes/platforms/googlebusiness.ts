/**
 * Google Business Profile automation node handlers.
 *
 * Reply to review: PUT mybusiness.googleapis.com/v4/{review.name}/reply
 * Post local update: POST mybusinessbusinessinformation/v1/{location}/localPosts
 * (New API split — reviews still live on v4, local posts moved to the newer API.)
 *
 * Docs: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply
 *       https://developers.google.com/my-business/content/posts-create
 *
 * Note (from audit): each end-client needs their own GBP API project. Review
 * Google's content policies before shipping. Q&A notification types are
 * deprecated as of 2025-11-03.
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

interface GbpCtx {
	accessToken: string;
	locationName: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<GbpCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "gbp account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		accessToken,
		locationName: account.platformAccountId, // e.g. "locations/123"
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

export const googlebusinessReplyToReviewHandler: NodeHandler = async (ctx) => {
	const reviewName =
		(ctx.node.config.review_name as string | undefined) ??
		(ctx.enrollment.state.review_name as string | undefined);
	const comment = ctx.node.config.comment as string | undefined;
	if (!reviewName || !comment)
		return {
			kind: "fail",
			error: "googlebusiness_reply_to_review needs review_name + comment",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				comment: applyMergeTags(comment, { state: setup.state }),
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
			error: err.error?.message ?? `HTTP ${res.status} from gbp reviews`,
		};
	}
	return { kind: "next" };
};

export const googlebusinessPostUpdateHandler: NodeHandler = async (ctx) => {
	const summary = ctx.node.config.summary as string | undefined;
	if (!summary)
		return { kind: "fail", error: "googlebusiness_post_update missing 'summary'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const body: Record<string, unknown> = {
		languageCode: ctx.node.config.language_code ?? "en",
		summary: applyMergeTags(summary, { state: setup.state }),
		topicType: ctx.node.config.topic_type ?? "STANDARD",
	};
	if (ctx.node.config.media_url) {
		body.media = [
			{
				mediaFormat: "PHOTO",
				sourceUrl: ctx.node.config.media_url,
			},
		];
	}
	if (ctx.node.config.call_to_action) {
		body.callToAction = ctx.node.config.call_to_action;
	}
	const res = await fetchWithTimeout(
		`https://mybusiness.googleapis.com/v4/${setup.locationName}/localPosts`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} posting GBP local post`,
		};
	}
	return { kind: "next" };
};
