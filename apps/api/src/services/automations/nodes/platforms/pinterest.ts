/**
 * Pinterest v5 automation node handlers.
 *
 *  Create pin: POST /v5/pins
 *  Docs: https://developers.pinterest.com/docs/api/v5/pins-create
 *
 * `platformAccountId` stores the board_id or user's default board.
 */

import { socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { API_VERSIONS } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { applyMergeTags } from "../../merge-tags";
import { resolveEnrollmentTrigger } from "../../resolve-trigger";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

const PIN_BASE = `https://api.pinterest.com/${API_VERSIONS.pinterest}`;

export const pinterestCreatePinHandler: NodeHandler = async (ctx) => {
	const boardId = ctx.node.config.board_id as string | undefined;
	const imageUrl = ctx.node.config.image_url as string | undefined;
	const title = ctx.node.config.title as string | undefined;
	const description = ctx.node.config.description as string | undefined;
	const link = ctx.node.config.link as string | undefined;
	if (!boardId || !imageUrl || !title)
		return {
			kind: "fail",
			error: "pinterest_create_pin needs board_id + image_url + title",
		};
	const trigger = resolveEnrollmentTrigger(ctx.snapshot, ctx.enrollment.trigger_id);
	const accountId = trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "pinterest account not found or missing token" };
	const accessToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	const res = await fetchWithTimeout(`${PIN_BASE}/pins`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			board_id: boardId,
			title: applyMergeTags(title, { state: ctx.enrollment.state }),
			description: description
				? applyMergeTags(description, { state: ctx.enrollment.state })
				: undefined,
			link,
			media_source: {
				source_type: "image_url",
				url: imageUrl,
			},
		}),
		timeout: 15_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			message?: string;
			code?: number;
		};
		return {
			kind: "fail",
			error: err.message ?? `HTTP ${res.status} from pinterest`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { id?: string };
	return { kind: "next", state_patch: { last_pin_id: data.id } };
};
