/**
 * Discord automation node handlers.
 *
 * Discord bots send messages by posting to a **channel**, not to a user.
 * For DMs, create a DM channel with `POST /users/@me/channels` (requires the user
 * to share a guild with the bot) — we treat the `contactChannels.identifier`
 * as the channel_id the bot should post into.
 *
 * Docs: https://discord.com/developers/docs/resources/channel#create-message
 *       https://discord.com/developers/docs/resources/channel#edit-message
 *       https://discord.com/developers/docs/resources/channel#create-reaction
 *       https://discord.com/developers/docs/resources/channel#start-thread-without-message
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

const DISCORD_BASE = "https://discord.com/api/v10";

interface DiscordCtx {
	botToken: string;
	channelId: string;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<DiscordCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "discord bot not found or missing token" };
	let channelId: string | undefined =
		(ctx.node.config.channel_id as string | undefined) ??
		(ctx.enrollment.state.channel_id as string | undefined);
	if (!channelId && ctx.enrollment.contact_id) {
		const chan = await findScopedContactChannel(ctx.db, {
			contactId: ctx.enrollment.contact_id,
			platform: "discord",
			socialAccountId: accountId,
		});
		channelId = chan?.identifier;
	}
	if (!channelId) return { kind: "fail", error: "no discord channel_id" };
	const botToken = await decryptToken(account.accessToken, ctx.env.ENCRYPTION_KEY);
	return { botToken, channelId, state: ctx.enrollment.state };
}

function isFailResult(x: unknown): x is NodeExecutionResult {
	return (
		typeof x === "object" &&
		x !== null &&
		"kind" in x &&
		(x as { kind: string }).kind === "fail"
	);
}

async function discordCall(
	botToken: string,
	path: string,
	method: string,
	body?: unknown,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(`${DISCORD_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bot ${botToken}`,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
		timeout: 10_000,
	});
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as { message?: string };
		return {
			kind: "fail",
			error: err.message ?? `HTTP ${res.status} from discord ${path}`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as { id?: string };
	return {
		kind: "next",
		state_patch: data.id ? { last_message_id: data.id } : undefined,
	};
}

// ---------------------------------------------------------------------------

export const discordSendMessageHandler: NodeHandler = async (ctx) => {
	const content = ctx.node.config.content as string | undefined;
	if (!content) return { kind: "fail", error: "discord_send_message missing 'content'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return discordCall(setup.botToken, `/channels/${setup.channelId}/messages`, "POST", {
		content: applyMergeTags(content, { state: setup.state }),
	});
};

export const discordSendEmbedHandler: NodeHandler = async (ctx) => {
	const embeds = ctx.node.config.embeds as unknown[] | undefined;
	if (!embeds || embeds.length === 0)
		return { kind: "fail", error: "discord_send_embed missing 'embeds'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return discordCall(setup.botToken, `/channels/${setup.channelId}/messages`, "POST", {
		embeds,
	});
};

export const discordSendComponentsHandler: NodeHandler = async (ctx) => {
	const content = ctx.node.config.content as string | undefined;
	const components = ctx.node.config.components as unknown[] | undefined;
	if (!components || components.length === 0)
		return { kind: "fail", error: "discord_send_components missing 'components'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return discordCall(setup.botToken, `/channels/${setup.channelId}/messages`, "POST", {
		content: content ? applyMergeTags(content, { state: setup.state }) : undefined,
		components,
	});
};

export const discordSendAttachmentHandler: NodeHandler = async (ctx) => {
	const url = ctx.node.config.url as string | undefined;
	const content = ctx.node.config.content as string | undefined;
	if (!url) return { kind: "fail", error: "discord_send_attachment missing 'url'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	// Simplest form: paste the URL in the content so Discord unfurls it. True
	// multipart file uploads are a separate flow (require fetching the bytes).
	return discordCall(setup.botToken, `/channels/${setup.channelId}/messages`, "POST", {
		content: [
			content ? applyMergeTags(content, { state: setup.state }) : "",
			url,
		]
			.filter(Boolean)
			.join("\n"),
	});
};

export const discordReactHandler: NodeHandler = async (ctx) => {
	const messageId =
		(ctx.node.config.message_id as string | undefined) ??
		(ctx.enrollment.state.last_message_id as string | undefined);
	const emoji = ctx.node.config.emoji as string | undefined;
	if (!messageId || !emoji)
		return { kind: "fail", error: "discord_react needs message_id + emoji" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return discordCall(
		setup.botToken,
		`/channels/${setup.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
		"PUT",
	);
};

export const discordEditMessageHandler: NodeHandler = async (ctx) => {
	const messageId =
		(ctx.node.config.message_id as string | undefined) ??
		(ctx.enrollment.state.last_message_id as string | undefined);
	const content = ctx.node.config.content as string | undefined;
	if (!messageId || !content)
		return { kind: "fail", error: "discord_edit_message needs message_id + content" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return discordCall(
		setup.botToken,
		`/channels/${setup.channelId}/messages/${messageId}`,
		"PATCH",
		{ content: applyMergeTags(content, { state: setup.state }) },
	);
};

export const discordStartThreadHandler: NodeHandler = async (ctx) => {
	const name = ctx.node.config.name as string | undefined;
	const autoArchive = (ctx.node.config.auto_archive_duration as number | undefined) ?? 60;
	if (!name) return { kind: "fail", error: "discord_start_thread missing 'name'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const messageId = ctx.node.config.message_id as string | undefined;
	const path = messageId
		? `/channels/${setup.channelId}/messages/${messageId}/threads`
		: `/channels/${setup.channelId}/threads`;
	return discordCall(setup.botToken, path, "POST", {
		name,
		auto_archive_duration: autoArchive,
		type: 11, // public thread
	});
};
