/**
 * Listmonk (self-hosted) automation node handlers.
 *
 *  Add subscriber: POST /api/subscribers
 *  Send campaign:  POST /api/campaigns/:id/status   { status: "running" }
 *
 * Docs: https://listmonk.app/docs/apis/subscribers/
 *       https://listmonk.app/docs/apis/campaigns/
 *
 * Listmonk is self-hosted — the instance URL is in account metadata.instance_url.
 * Auth is Basic (API user + API token).
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface LmCtx {
	basicAuth: string;
	instanceUrl: string;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<LmCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "listmonk account not found or missing token" };
	const token = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	const meta = (account.metadata as Record<string, unknown> | null) ?? {};
	const instanceUrl = (meta.instance_url as string | undefined) ?? "";
	const apiUser = (meta.api_user as string | undefined) ?? account.username ?? "";
	if (!instanceUrl || !apiUser)
		return {
			kind: "fail",
			error: "listmonk account missing instance_url or api_user in metadata",
		};
	return {
		basicAuth: `Basic ${btoa(`${apiUser}:${token}`)}`,
		instanceUrl: instanceUrl.replace(/\/$/, ""),
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

export const listmonkAddSubscriberHandler: NodeHandler = async (ctx) => {
	const email = ctx.node.config.email as string | undefined;
	const listIds = ctx.node.config.list_ids as number[] | undefined;
	if (!email) return { kind: "fail", error: "listmonk_add_subscriber missing 'email'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(`${setup.instanceUrl}/api/subscribers`, {
		method: "POST",
		headers: {
			Authorization: setup.basicAuth,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			email,
			name: ctx.node.config.name ?? email,
			status: "enabled",
			lists: listIds ?? [],
			attribs: ctx.node.config.attribs,
		}),
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from listmonk` };
	}
	return { kind: "next" };
};

export const listmonkSendCampaignHandler: NodeHandler = async (ctx) => {
	const campaignId = ctx.node.config.campaign_id as number | string | undefined;
	if (campaignId === undefined)
		return { kind: "fail", error: "listmonk_send_campaign needs campaign_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${setup.instanceUrl}/api/campaigns/${campaignId}/status`,
		{
			method: "PUT",
			headers: {
				Authorization: setup.basicAuth,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ status: "running" }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from listmonk` };
	}
	return { kind: "next" };
};
