import { socialAccounts } from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";
import { GRAPH_BASE } from "../../../config/api-versions";
import { decryptAccountToken } from "../../../lib/account-token-crypto";
import type { Action } from "../../../schemas/automation-actions";
import { applyMergeTags } from "../merge-tags";
import {
	AutomationExternalEffectKnownFailureError,
	type RunContext,
} from "../types";
import type { ActionHandler } from "./types";

type ReplyToCommentAction = Extract<Action, { type: "reply_to_comment" }>;

type ResolvedAccount = {
	id: string;
	platform: string;
	accessToken: string | null;
};

const replyToComment: ActionHandler<ReplyToCommentAction> = async (
	action,
	ctx,
) => {
	const renderedText = applyMergeTags(action.text, {
		contact:
			(ctx.context.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context,
	}).trim();
	if (!renderedText) {
		throw new Error("reply_to_comment requires text");
	}

	const accountId = resolveTriggeringSocialAccountId(ctx);
	if (!accountId) {
		throw new Error(
			"reply_to_comment requires a triggering social account on the run context",
		);
	}

	const commentId = resolveCommentId(ctx);
	if (!commentId) {
		throw new Error(
			"reply_to_comment requires a triggering comment on the run context",
		);
	}

	const account = await loadSocialAccount(ctx, accountId);
	if (!account.accessToken) {
		throw new Error(`social account ${accountId} has no access token`);
	}
	const accessToken = account.accessToken;

	const dispatch = async () => {
		let res: Response;
		switch (account.platform) {
			case "facebook":
				res = await fetch(`${GRAPH_BASE.facebook}/${commentId}/comments`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						message: renderedText,
						access_token: accessToken,
					}),
				});
				break;
			case "instagram":
				res = await fetch(
					`${instagramGraphBase(accessToken)}/${commentId}/replies`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							message: renderedText,
							access_token: accessToken,
						}),
					},
				);
				break;
			default:
				throw new Error(
					`reply_to_comment is unsupported for platform "${account.platform}"`,
				);
		}
		if (!res.ok) {
			const detail = await summarizeErrorResponse(res);
			if (res.status >= 500) {
				throw new Error(`reply_to_comment ambiguous: ${detail}`);
			}
			throw new AutomationExternalEffectKnownFailureError(
				`reply_to_comment failed: ${detail}`,
			);
		}
		return { status: res.status };
	};

	if (ctx.executeExternalEffect) {
		await ctx.executeExternalEffect(
			{
				effectKey: `action:${action.id}`,
				kind: "automation_action",
			},
			async () => ({
				outcome: "succeeded",
				value: await dispatch(),
			}),
		);
	} else {
		await dispatch();
	}
};

async function loadSocialAccount(
	ctx: RunContext,
	accountId: string,
): Promise<ResolvedAccount> {
	const [account] = await ctx.db
		.select({
			id: socialAccounts.id,
			platform: socialAccounts.platform,
			accessToken: socialAccounts.accessToken,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, ctx.organizationId),
				eq(
					socialAccounts.platform,
					ctx.channel as typeof socialAccounts.$inferSelect.platform,
				),
				eq(socialAccounts.lifecycleStatus, "active"),
				ctx.workspaceId
					? eq(socialAccounts.workspaceId, ctx.workspaceId)
					: isNull(socialAccounts.workspaceId),
			),
		)
		.limit(1);
	if (!account) {
		throw new Error(`triggering social account "${accountId}" not found`);
	}
	return {
		id: account.id,
		platform: account.platform,
		accessToken: await resolveAccessToken(
			account.accessToken,
			ctx.env.ENCRYPTION_KEY as string | undefined,
			account.id,
		),
	};
}

function resolveTriggeringSocialAccountId(ctx: RunContext): string | null {
	const fromEnv =
		typeof ctx.env.socialAccountId === "string"
			? ctx.env.socialAccountId
			: null;
	if (fromEnv) return fromEnv;

	const persisted =
		typeof ctx.context._triggering_social_account_id === "string"
			? ctx.context._triggering_social_account_id
			: null;
	if (persisted) return persisted;

	const triggerEvent = ctx.context.triggerEvent as
		| { socialAccountId?: unknown }
		| undefined;
	return typeof triggerEvent?.socialAccountId === "string"
		? triggerEvent.socialAccountId
		: null;
}

function resolveCommentId(ctx: RunContext): string | null {
	const triggerEvent = ctx.context.triggerEvent as
		| { payload?: { comment_id?: unknown } }
		| undefined;
	const payloadCommentId = triggerEvent?.payload?.comment_id;
	if (typeof payloadCommentId === "string" && payloadCommentId.length > 0) {
		return payloadCommentId;
	}
	return typeof ctx.context.comment_id === "string" &&
		ctx.context.comment_id.length > 0
		? ctx.context.comment_id
		: null;
}

function instagramGraphBase(token: string): string {
	return token.startsWith("IGAA") ? GRAPH_BASE.instagram : GRAPH_BASE.facebook;
}

async function summarizeErrorResponse(res: Response): Promise<string> {
	const fallback = `${res.status} ${res.statusText || "request failed"}`.trim();
	try {
		const body = await res.text();
		if (!body) return fallback;
		return `${fallback} ${body.slice(0, 200)}`.trim();
	} catch {
		return fallback;
	}
}

async function resolveAccessToken(
	stored: string | null,
	encryptionKey: string | undefined,
	accountId: string,
): Promise<string | null> {
	if (!stored) return null;
	return decryptAccountToken(stored, encryptionKey, accountId, "access_token");
}

export const commentHandlers = {
	reply_to_comment: replyToComment,
};
