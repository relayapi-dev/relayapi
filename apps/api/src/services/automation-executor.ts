/**
 * Automation rule action executor — runs action arrays against the DB
 * and platform APIs.
 */

import type { Database } from "@relayapi/db";
import { socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { GRAPH_BASE } from "../config/api-versions";
import { maybeDecrypt } from "../lib/crypto";
import { fetchWithTimeout } from "../lib/fetch-timeout";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import type { Env } from "../types";
import { updateConversation } from "./inbox-persistence";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionDef {
	type: string;
	params?: Record<string, unknown>;
}

export interface ActionContext {
	conversationId: string;
	messageId: string;
	orgId: string;
	platform: string;
	accountId: string;
	platformMessageId?: string | null;
}

export interface ActionResult {
	type: string;
	success: boolean;
	error?: string;
}

// ---------------------------------------------------------------------------
// Individual action handlers
// ---------------------------------------------------------------------------

async function handleLabel(
	params: Record<string, unknown> | undefined,
	ctx: ActionContext,
	db: Database,
): Promise<ActionResult> {
	try {
		const labels = params?.labels;
		if (!Array.isArray(labels)) {
			return { type: "label", success: false, error: "Missing labels array" };
		}
		await updateConversation(db, ctx.conversationId, ctx.orgId, {
			labels: labels as string[],
		});
		return { type: "label", success: true };
	} catch (err) {
		return {
			type: "label",
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

async function handleArchive(
	ctx: ActionContext,
	db: Database,
): Promise<ActionResult> {
	try {
		await updateConversation(db, ctx.conversationId, ctx.orgId, {
			status: "archived",
		});
		return { type: "archive", success: true };
	} catch (err) {
		return {
			type: "archive",
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

async function handleSetPriority(
	params: Record<string, unknown> | undefined,
	ctx: ActionContext,
	db: Database,
): Promise<ActionResult> {
	try {
		const priority = params?.priority;
		if (typeof priority !== "string") {
			return {
				type: "set_priority",
				success: false,
				error: "Missing priority string",
			};
		}
		await updateConversation(db, ctx.conversationId, ctx.orgId, {
			priority,
		});
		return { type: "set_priority", success: true };
	} catch (err) {
		return {
			type: "set_priority",
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

async function handleHide(
	ctx: ActionContext,
	env: Env,
	db: Database,
): Promise<ActionResult> {
	// Only supported for Facebook and Instagram
	// Docs: https://developers.facebook.com/docs/graph-api/reference/comment/
	if (ctx.platform !== "facebook" && ctx.platform !== "instagram") {
		return {
			type: "hide",
			success: false,
			error: `Hide not supported for platform: ${ctx.platform}`,
		};
	}

	if (!ctx.platformMessageId) {
		return { type: "hide", success: false, error: "Missing platformMessageId — cannot call Graph API without the platform comment ID" };
	}

	try {
		const [account] = await db
			.select({ accessToken: socialAccounts.accessToken })
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.id, ctx.accountId),
					eq(socialAccounts.organizationId, ctx.orgId),
					eq(socialAccounts.platform, ctx.platform),
				),
			)
			.limit(1);

		const token = await maybeDecrypt(account?.accessToken, env.ENCRYPTION_KEY);
		if (!token) {
			return { type: "hide", success: false, error: "No access token for account" };
		}

		// Graph API: Hide a comment — POST /{comment-id}?is_hidden=true
		const res = await fetchWithTimeout(
			`${GRAPH_BASE.facebook}/${ctx.platformMessageId}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ is_hidden: true }),
				timeout: 10_000,
			},
		);

		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as {
				error?: { message?: string };
			};
			return {
				type: "hide",
				success: false,
				error: body.error?.message ?? `Graph API returned HTTP ${res.status}`,
			};
		}

		return { type: "hide", success: true };
	} catch (err) {
		return {
			type: "hide",
			success: false,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

async function handleReply(
	params: Record<string, unknown> | undefined,
): Promise<ActionResult> {
	// Full reply requires complex per-platform API calls — defer to later
	console.log(
		`[automation] reply action logged (deferred): ${JSON.stringify(params)}`,
	);
	return {
		type: "reply",
		success: false,
		error: "Reply action is not yet implemented. Remove this action from your automation rule.",
	};
}

async function handleEscalate(
	params: Record<string, unknown> | undefined,
	ctx: ActionContext,
): Promise<ActionResult> {
	const webhookUrl = params?.webhook_url;
	if (typeof webhookUrl !== "string") {
		return {
			type: "escalate",
			success: false,
			error: "Missing webhook_url param",
		};
	}

	if (await isBlockedUrlWithDns(webhookUrl)) {
		return { type: "escalate", success: false, error: "Webhook URL targets a blocked address" };
	}

	try {
		const res = await fetchWithTimeout(webhookUrl, {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event: "automation.escalate",
				conversation_id: ctx.conversationId,
				message_id: ctx.messageId,
				organization_id: ctx.orgId,
				platform: ctx.platform,
				account_id: ctx.accountId,
				timestamp: new Date().toISOString(),
			}),
			timeout: 10_000,
		});

		if (!res.ok) {
			return {
				type: "escalate",
				success: false,
				error: `Webhook returned HTTP ${res.status}`,
			};
		}
		return { type: "escalate", success: true };
	} catch (err) {
		return {
			type: "escalate",
			success: false,
			error: err instanceof Error ? err.message : "Fetch failed",
		};
	}
}

async function handleNotify(
	params: Record<string, unknown> | undefined,
	ctx: ActionContext,
): Promise<ActionResult> {
	const webhookUrl = params?.webhook_url;
	if (typeof webhookUrl !== "string") {
		return {
			type: "notify",
			success: false,
			error: "Missing webhook_url param",
		};
	}

	if (await isBlockedUrlWithDns(webhookUrl)) {
		return { type: "notify", success: false, error: "Webhook URL targets a blocked address" };
	}

	try {
		const res = await fetchWithTimeout(webhookUrl, {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				event: "automation.notify",
				conversation_id: ctx.conversationId,
				message_id: ctx.messageId,
				organization_id: ctx.orgId,
				platform: ctx.platform,
				account_id: ctx.accountId,
				notification_type: params?.type ?? "default",
				message: params?.message ?? null,
				timestamp: new Date().toISOString(),
			}),
			timeout: 10_000,
		});

		if (!res.ok) {
			return {
				type: "notify",
				success: false,
				error: `Webhook returned HTTP ${res.status}`,
			};
		}
		return { type: "notify", success: true };
	} catch (err) {
		return {
			type: "notify",
			success: false,
			error: err instanceof Error ? err.message : "Fetch failed",
		};
	}
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function executeActions(
	actions: ActionDef[],
	context: ActionContext,
	env: Env,
	db: Database,
): Promise<ActionResult[]> {
	const results: ActionResult[] = [];

	for (const action of actions) {
		let result: ActionResult;

		switch (action.type) {
			case "label":
				result = await handleLabel(action.params, context, db);
				break;
			case "archive":
				result = await handleArchive(context, db);
				break;
			case "set_priority":
				result = await handleSetPriority(action.params, context, db);
				break;
			case "hide":
				result = await handleHide(context, env, db);
				break;
			case "reply":
				result = await handleReply(action.params);
				break;
			case "escalate":
				result = await handleEscalate(action.params, context);
				break;
			case "notify":
				result = await handleNotify(action.params, context);
				break;
			default:
				result = {
					type: action.type,
					success: false,
					error: `Unknown action type: ${action.type}`,
				};
		}

		results.push(result);
	}

	return results;
}
