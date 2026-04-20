/**
 * Mastodon automation node handlers.
 *
 *  Reply:     POST /api/v1/statuses                 body: status, in_reply_to_id
 *  Favourite: POST /api/v1/statuses/:id/favourite
 *  Boost:     POST /api/v1/statuses/:id/reblog
 *  DM:        POST /api/v1/statuses                 body: status, visibility=direct, in@user
 *
 * Docs: https://docs.joinmastodon.org/methods/statuses/
 *
 * Each instance has its own base URL — stored on the account metadata as
 * `instance_url` (e.g. "https://mastodon.social").
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { findScopedContactChannel } from "../../contact-channel";
import { applyMergeTags } from "../../merge-tags";
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface MastoCtx {
	accessToken: string;
	instanceUrl: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<MastoCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "mastodon account not found or missing token" };
	const meta = (account.metadata as Record<string, unknown> | null) ?? {};
	const instanceUrl = (meta.instance_url as string | undefined) ?? "";
	if (!instanceUrl)
		return { kind: "fail", error: "mastodon account missing instance_url in metadata" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return {
		accessToken,
		instanceUrl: instanceUrl.replace(/\/$/, ""),
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

async function mastoCall(
	c: MastoCtx,
	path: string,
	body?: unknown,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(`${c.instanceUrl}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${c.accessToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { error?: string };
		return { kind: "fail", error: err.error ?? `HTTP ${res.status} from mastodon` };
	}
	const data = (await res.json().catch(() => ({}))) as { id?: string };
	return {
		kind: "next",
		state_patch: data.id ? { last_status_id: data.id } : undefined,
	};
}

export const mastodonReplyHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const inReplyToId =
		(ctx.node.config.in_reply_to_id as string | undefined) ??
		(ctx.enrollment.state.status_id as string | undefined);
	if (!text || !inReplyToId)
		return { kind: "fail", error: "mastodon_reply needs text + in_reply_to_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return mastoCall(setup, "/api/v1/statuses", {
		status: applyMergeTags(text, { state: setup.state }),
		in_reply_to_id: inReplyToId,
		visibility: ctx.node.config.visibility ?? "public",
	});
};

export const mastodonFavouriteHandler: NodeHandler = async (ctx) => {
	const statusId =
		(ctx.node.config.status_id as string | undefined) ??
		(ctx.enrollment.state.status_id as string | undefined);
	if (!statusId) return { kind: "fail", error: "mastodon_favourite needs status_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return mastoCall(setup, `/api/v1/statuses/${statusId}/favourite`);
};

export const mastodonBoostHandler: NodeHandler = async (ctx) => {
	const statusId =
		(ctx.node.config.status_id as string | undefined) ??
		(ctx.enrollment.state.status_id as string | undefined);
	if (!statusId) return { kind: "fail", error: "mastodon_boost needs status_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return mastoCall(setup, `/api/v1/statuses/${statusId}/reblog`);
};

export const mastodonSendDmHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "mastodon_send_dm missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const chan = await findScopedContactChannel(ctx.db, {
		contactId: ctx.enrollment.contact_id,
		platform: "mastodon",
		socialAccountId: trigger.account_id!,
	});
	if (!chan)
		return {
			kind: "fail",
			error: "contact has no mastodon handle for this account",
		};
	return mastoCall(setup, "/api/v1/statuses", {
		status: `@${chan.identifier} ${applyMergeTags(text, { state: setup.state })}`,
		visibility: "direct",
	});
};
