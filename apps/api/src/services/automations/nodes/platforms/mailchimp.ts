/**
 * Mailchimp Marketing API automation node handlers.
 *
 * Base URL is dc-scoped: https://{dc}.api.mailchimp.com/3.0
 * Docs: https://mailchimp.com/developer/marketing/api/
 *
 * `platformAccountId` stores the audience/list_id. The dc (data center) is
 * stored on the socialAccount metadata as `dc` (e.g. "us14"), or parsed from
 * the API key which ends with `-us14` for Mailchimp-issued keys.
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

interface McCtx {
	apiKey: string;
	dc: string;
	listId: string;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<McCtx | NodeExecutionResult> {
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "mailchimp account not found or missing token" };
	const apiKey = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	const meta = (account.metadata as Record<string, unknown> | null) ?? {};
	let dc = meta.dc as string | undefined;
	if (!dc) {
		const m = apiKey.match(/-([a-z]+\d+)$/);
		dc = m?.[1];
	}
	if (!dc)
		return { kind: "fail", error: "mailchimp account missing dc in metadata or api key suffix" };
	return { apiKey, dc, listId: account.platformAccountId };
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

function basicAuth(apiKey: string): string {
	return `Basic ${btoa(`anystring:${apiKey}`)}`;
}

function md5LowercaseEmail(email: string): string {
	// Mailchimp uses the MD5 hash of lowercased email as the subscriber identifier.
	// Lazy-load crypto to keep the handler surface compact.
	const { createHash } = require("node:crypto") as typeof import("node:crypto");
	return createHash("md5").update(email.toLowerCase()).digest("hex");
}

export const mailchimpAddMemberHandler: NodeHandler = async (ctx) => {
	const email = ctx.node.config.email as string | undefined;
	if (!email) return { kind: "fail", error: "mailchimp_add_member missing 'email'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const hash = md5LowercaseEmail(email);
	const res = await fetchWithTimeout(
		`https://${setup.dc}.api.mailchimp.com/3.0/lists/${setup.listId}/members/${hash}`,
		{
			method: "PUT", // upsert
			headers: {
				Authorization: basicAuth(setup.apiKey),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				email_address: email,
				status_if_new: ctx.node.config.double_optin ? "pending" : "subscribed",
				merge_fields: ctx.node.config.merge_fields,
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { detail?: string };
		return { kind: "fail", error: err.detail ?? `HTTP ${res.status} from mailchimp` };
	}
	return { kind: "next" };
};

export const mailchimpAddTagHandler: NodeHandler = async (ctx) => {
	const email = ctx.node.config.email as string | undefined;
	const tag = ctx.node.config.tag as string | undefined;
	if (!email || !tag)
		return { kind: "fail", error: "mailchimp_add_tag needs email + tag" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const hash = md5LowercaseEmail(email);
	const res = await fetchWithTimeout(
		`https://${setup.dc}.api.mailchimp.com/3.0/lists/${setup.listId}/members/${hash}/tags`,
		{
			method: "POST",
			headers: {
				Authorization: basicAuth(setup.apiKey),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				tags: [{ name: tag, status: "active" }],
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { detail?: string };
		return { kind: "fail", error: err.detail ?? `HTTP ${res.status} from mailchimp` };
	}
	return { kind: "next" };
};

export const mailchimpSendCampaignHandler: NodeHandler = async (ctx) => {
	const campaignId = ctx.node.config.campaign_id as string | undefined;
	if (!campaignId)
		return { kind: "fail", error: "mailchimp_send_campaign needs campaign_id" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`https://${setup.dc}.api.mailchimp.com/3.0/campaigns/${campaignId}/actions/send`,
		{
			method: "POST",
			headers: {
				Authorization: basicAuth(setup.apiKey),
				"Content-Type": "application/json",
			},
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { detail?: string };
		return { kind: "fail", error: err.detail ?? `HTTP ${res.status} from mailchimp` };
	}
	return { kind: "next" };
};
