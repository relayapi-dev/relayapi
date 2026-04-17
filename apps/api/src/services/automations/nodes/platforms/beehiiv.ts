/**
 * Beehiiv automation node handlers.
 *
 *  Add subscriber:         POST /v2/publications/:id/subscriptions
 *  Publish post:           POST /v2/publications/:id/posts       (or actually it's schedule)
 *  Enroll into automation: POST /v2/publications/:id/automations/:auto_id/journeys
 *
 * Docs: https://developers.beehiiv.com/docs/v2
 *
 * `platformAccountId` stores the publication_id. `accessToken` is the API key.
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

const BEEHIIV_BASE = "https://api.beehiiv.com/v2";

interface BhCtx {
	apiKey: string;
	publicationId: string;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<BhCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "beehiiv account not found or missing token" };
	const apiKey = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return { apiKey, publicationId: account.platformAccountId };
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function beehiivPost(
	apiKey: string,
	path: string,
	body: unknown,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(`${BEEHIIV_BASE}${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from beehiiv` };
	}
	return { kind: "next" };
}

export const beehiivAddSubscriberHandler: NodeHandler = async (ctx) => {
	const email = ctx.node.config.email as string | undefined;
	if (!email)
		return { kind: "fail", error: "beehiiv_add_subscriber missing 'email'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return beehiivPost(setup.apiKey, `/publications/${setup.publicationId}/subscriptions`, {
		email,
		reactivate_existing: ctx.node.config.reactivate_existing ?? true,
		send_welcome_email: ctx.node.config.send_welcome_email ?? false,
		utm_source: ctx.node.config.utm_source ?? "automation",
		utm_campaign: ctx.node.config.utm_campaign,
		referring_site: ctx.node.config.referring_site,
	});
};

export const beehiivPublishPostHandler: NodeHandler = async (ctx) => {
	const postId = ctx.node.config.post_id as string | undefined;
	if (!postId)
		return { kind: "fail", error: "beehiiv_publish_post needs post_id (pre-created draft)" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	// Beehiiv publishes via status transition — use the update endpoint.
	const res = await fetchWithTimeout(
		`${BEEHIIV_BASE}/publications/${setup.publicationId}/posts/${postId}`,
		{
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${setup.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ status: "confirmed" }),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return { kind: "fail", error: err.message ?? `HTTP ${res.status} from beehiiv` };
	}
	return { kind: "next" };
};

export const beehiivEnrollAutomationHandler: NodeHandler = async (ctx) => {
	const email = ctx.node.config.email as string | undefined;
	const automationId = ctx.node.config.automation_id as string | undefined;
	if (!email || !automationId)
		return {
			kind: "fail",
			error: "beehiiv_enroll_automation needs email + automation_id",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return beehiivPost(
		setup.apiKey,
		`/publications/${setup.publicationId}/automations/${automationId}/journeys`,
		{ email },
	);
};
