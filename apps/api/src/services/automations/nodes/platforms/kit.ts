/**
 * Kit (formerly ConvertKit) v4 API automation node handlers.
 *
 *  Add subscriber: POST https://api.kit.com/v4/subscribers
 *  Add tag:        POST https://api.kit.com/v4/tags/:tag_id/subscribers
 *  Send broadcast: POST https://api.kit.com/v4/broadcasts/:id/send
 *
 * Docs: https://developers.kit.com/v4.0
 *
 * `accessToken` is the API secret / OAuth bearer.
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const KIT_BASE = "https://api.kit.com/v4";

async function loadToken(
	ctx: NodeExecutionContext,
): Promise<string | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "kit account not found or missing token" };
	return decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function kitPost(
	token: string,
	path: string,
	body?: unknown,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(`${KIT_BASE}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from kit` };
	}
	return { kind: "next" };
}

export const kitAddSubscriberHandler: NodeHandler = async (ctx) => {
	const email = ctx.node.config.email as string | undefined;
	if (!email) return { kind: "fail", error: "kit_add_subscriber missing 'email'" };
	const token = await loadToken(ctx);
	if (isFailResult(token)) return token;
	return kitPost(token, "/subscribers", {
		email_address: email,
		first_name: ctx.node.config.first_name,
		state: "active",
	});
};

export const kitAddTagHandler: NodeHandler = async (ctx) => {
	const tagId = ctx.node.config.tag_id as string | undefined;
	const email = ctx.node.config.email as string | undefined;
	if (!tagId || !email)
		return { kind: "fail", error: "kit_add_tag needs tag_id + email" };
	const token = await loadToken(ctx);
	if (isFailResult(token)) return token;
	return kitPost(token, `/tags/${tagId}/subscribers`, {
		email_address: email,
	});
};

export const kitSendBroadcastHandler: NodeHandler = async (ctx) => {
	const broadcastId = ctx.node.config.broadcast_id as string | undefined;
	if (!broadcastId)
		return { kind: "fail", error: "kit_send_broadcast needs broadcast_id" };
	const token = await loadToken(ctx);
	if (isFailResult(token)) return token;
	return kitPost(token, `/broadcasts/${broadcastId}/send`);
};
