/**
 * Bluesky (AT Protocol) automation node handlers.
 *
 * Records API:
 *  - POST https://bsky.social/xrpc/com.atproto.repo.createRecord
 *    with collection app.bsky.feed.{post|like|repost}.
 * Chat API (DMs):
 *  - POST https://api.bsky.chat/xrpc/chat.bsky.convo.sendMessage
 *
 * Docs: https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 *       https://docs.bsky.app/docs/api/chat-bsky-convo-send-message
 *
 * The account's accessToken is the AT Protocol access JWT.
 * `platformAccountId` stores the DID of the account.
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { findScopedContactChannel } from "../../contact-channel";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const PDS_BASE = "https://bsky.social/xrpc";
const CHAT_BASE = "https://api.bsky.chat/xrpc";

interface BskyCtx {
	accessJwt: string;
	did: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<BskyCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "bluesky account not found or missing token" };
	const accessJwt = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return { accessJwt, did: account.platformAccountId, state: ctx.enrollment.state };
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function createRecord(
	c: BskyCtx,
	collection: string,
	record: Record<string, unknown>,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(`${PDS_BASE}/com.atproto.repo.createRecord`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${c.accessJwt}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ repo: c.did, collection, record }),
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from bluesky` };
	}
	const data = (await res.json().catch(() => ({}))) as { uri?: string; cid?: string };
	return {
		kind: "next",
		state_patch: {
			last_post_uri: data.uri,
			last_post_cid: data.cid,
		},
	};
}

export const blueskyReplyHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	const parentUri =
		(ctx.node.config.parent_uri as string | undefined) ??
		(ctx.enrollment.state.post_uri as string | undefined);
	const parentCid =
		(ctx.node.config.parent_cid as string | undefined) ??
		(ctx.enrollment.state.post_cid as string | undefined);
	if (!text || !parentUri || !parentCid)
		return {
			kind: "fail",
			error: "bluesky_reply needs text + parent_uri + parent_cid",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return createRecord(setup, "app.bsky.feed.post", {
		text: applyMergeTags(text, { state: setup.state }),
		createdAt: new Date().toISOString(),
		reply: {
			parent: { uri: parentUri, cid: parentCid },
			root: { uri: parentUri, cid: parentCid },
		},
	});
};

export const blueskyLikeHandler: NodeHandler = async (ctx) => {
	const uri =
		(ctx.node.config.subject_uri as string | undefined) ??
		(ctx.enrollment.state.post_uri as string | undefined);
	const cid =
		(ctx.node.config.subject_cid as string | undefined) ??
		(ctx.enrollment.state.post_cid as string | undefined);
	if (!uri || !cid)
		return { kind: "fail", error: "bluesky_like needs subject_uri + subject_cid" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return createRecord(setup, "app.bsky.feed.like", {
		subject: { uri, cid },
		createdAt: new Date().toISOString(),
	});
};

export const blueskyRepostHandler: NodeHandler = async (ctx) => {
	const uri =
		(ctx.node.config.subject_uri as string | undefined) ??
		(ctx.enrollment.state.post_uri as string | undefined);
	const cid =
		(ctx.node.config.subject_cid as string | undefined) ??
		(ctx.enrollment.state.post_cid as string | undefined);
	if (!uri || !cid)
		return { kind: "fail", error: "bluesky_repost needs subject_uri + subject_cid" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return createRecord(setup, "app.bsky.feed.repost", {
		subject: { uri, cid },
		createdAt: new Date().toISOString(),
	});
};

export const blueskySendDmHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "bluesky_send_dm missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };
	const chan = await findScopedContactChannel(ctx.db, {
		contactId: ctx.enrollment.contact_id,
		platform: "bluesky",
		socialAccountId: ctx.snapshot.trigger.account_id!,
	});
	if (!chan)
		return {
			kind: "fail",
			error: "contact has no bluesky DID for this account",
		};

	// Chat API requires a convoId. First get/create the conversation with the recipient DID.
	const getConvoRes = await fetchWithTimeout(
		`${CHAT_BASE}/chat.bsky.convo.getConvoForMembers?members=${encodeURIComponent(chan.identifier)}`,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${setup.accessJwt}`,
				"atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
			},
			timeout: 10_000,
		},
	);
	if (!getConvoRes.ok) {
		return { kind: "fail", error: `failed to resolve bluesky convo: HTTP ${getConvoRes.status}` };
	}
	const convoData = (await getConvoRes.json().catch(() => ({}))) as {
		convo?: { id?: string };
	};
	const convoId = convoData.convo?.id;
	if (!convoId) return { kind: "fail", error: "bluesky returned no convo id" };

	const res = await fetchWithTimeout(`${CHAT_BASE}/chat.bsky.convo.sendMessage`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${setup.accessJwt}`,
			"Content-Type": "application/json",
			"atproto-proxy": "did:web:api.bsky.chat#bsky_chat",
		},
		body: JSON.stringify({
			convoId,
			message: { text: applyMergeTags(text, { state: setup.state }) },
		}),
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return {
			kind: "fail",
			error: err.message ?? `HTTP ${res.status} from bluesky chat`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { id?: string };
	return { kind: "next", state_patch: { last_message_id: data.id } };
};
