/**
 * WhatsApp Cloud API automation node handlers.
 *
 * All methods hit:  POST {GRAPH_BASE.facebook}/{phone-number-id}/messages
 * Docs:            https://developers.facebook.com/docs/whatsapp/cloud-api/messages
 *
 * Notes:
 * - Free-form text replies are only allowed inside the 24h customer-service window.
 *   Outside that window you MUST send a pre-approved `template` message.
 * - All message types set messaging_product:"whatsapp" and to:<phone-e164> / <wa-id>.
 */

import { contacts, socialAccounts } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { GRAPH_BASE } from "../../../../config/api-versions";
import { decryptToken } from "../../../../lib/crypto";
import { fetchWithTimeout } from "../../../../lib/fetch-timeout";
import { findScopedContactChannel } from "../../contact-channel";
import { applyMergeTags } from "../../merge-tags";
import type {
	NodeExecutionContext,
	NodeExecutionResult,
	NodeHandler,
} from "../../types";

interface WhatsAppCtx {
	accessToken: string;
	phoneNumberId: string;
	recipient: string;
	contact: Record<string, unknown> | null;
	state: Record<string, unknown>;
}

async function loadCtx(
	ctx: NodeExecutionContext,
): Promise<WhatsAppCtx | NodeExecutionResult> {
	const accountId = ctx.snapshot.trigger.account_id;
	if (!accountId) return { kind: "fail", error: "automation has no social account bound" };
	if (!ctx.enrollment.contact_id)
		return { kind: "fail", error: "enrollment has no contact_id" };

	const account = await ctx.db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, accountId),
	});
	if (!account?.accessToken)
		return { kind: "fail", error: "whatsapp account not found or missing token" };

	const chan = await findScopedContactChannel(ctx.db, {
		contactId: ctx.enrollment.contact_id,
		platform: "whatsapp",
		socialAccountId: accountId,
	});
	if (!chan)
		return {
			kind: "fail",
			error: "contact has no whatsapp identifier for this account",
		};

	const contact = await ctx.db.query.contacts.findFirst({
		where: eq(contacts.id, ctx.enrollment.contact_id),
	});

	const accessToken = await decryptToken(
		account.accessToken,
		ctx.env.ENCRYPTION_KEY,
	);

	return {
		accessToken,
		phoneNumberId: account.platformAccountId,
		recipient: chan.identifier,
		contact: (contact as unknown as Record<string, unknown>) ?? null,
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

async function waCall(
	c: WhatsAppCtx,
	body: Record<string, unknown>,
): Promise<NodeExecutionResult> {
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${c.phoneNumberId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${c.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to: c.recipient,
				...body,
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} from whatsapp messages API`,
		};
	}
	const data = (await res.json().catch(() => ({}))) as {
		messages?: Array<{ id: string }>;
	};
	return {
		kind: "next",
		state_patch: { last_message_id: data.messages?.[0]?.id },
	};
}

function render(template: string | undefined, c: WhatsAppCtx): string {
	if (!template) return "";
	return applyMergeTags(template, { contact: c.contact, state: c.state });
}

// ---------------------------------------------------------------------------

export const whatsappSendTextHandler: NodeHandler = async (ctx) => {
	const text = ctx.node.config.text as string | undefined;
	if (!text) return { kind: "fail", error: "whatsapp_send_text missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return waCall(setup, {
		type: "text",
		text: { body: render(text, setup), preview_url: ctx.node.config.preview_url ?? false },
	});
};

export const whatsappSendMediaHandler: NodeHandler = async (ctx) => {
	const url = ctx.node.config.url as string | undefined;
	const caption = ctx.node.config.caption as string | undefined;
	const mediaType = (ctx.node.config.media_type as string | undefined) ?? "image";
	if (!url) return { kind: "fail", error: "whatsapp_send_media missing 'url'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const type = ["image", "video", "audio", "document", "sticker"].includes(mediaType)
		? mediaType
		: "image";
	return waCall(setup, {
		type,
		[type]: {
			link: url,
			...(type !== "audio" && type !== "sticker" && caption
				? { caption: render(caption, setup) }
				: {}),
		},
	});
};

export const whatsappSendTemplateHandler: NodeHandler = async (ctx) => {
	const name = ctx.node.config.template_name as string | undefined;
	const language = (ctx.node.config.language as string | undefined) ?? "en_US";
	const components = ctx.node.config.components as unknown[] | undefined;
	if (!name) return { kind: "fail", error: "whatsapp_send_template missing 'template_name'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return waCall(setup, {
		type: "template",
		template: {
			name,
			language: { code: language },
			...(components ? { components } : {}),
		},
	});
};

export const whatsappSendInteractiveHandler: NodeHandler = async (ctx) => {
	const bodyText = ctx.node.config.text as string | undefined;
	const buttons = ctx.node.config.buttons as
		| Array<{ id: string; title: string }>
		| undefined;
	const list = ctx.node.config.list as
		| {
				button: string;
				sections: Array<{
					title?: string;
					rows: Array<{ id: string; title: string; description?: string }>;
				}>;
		  }
		| undefined;
	if (!bodyText)
		return { kind: "fail", error: "whatsapp_send_interactive missing 'text'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;

	let interactive: Record<string, unknown>;
	if (buttons && buttons.length > 0) {
		interactive = {
			type: "button",
			body: { text: render(bodyText, setup) },
			action: {
				buttons: buttons.slice(0, 3).map((b) => ({
					type: "reply",
					reply: { id: b.id, title: b.title },
				})),
			},
		};
	} else if (list) {
		interactive = {
			type: "list",
			body: { text: render(bodyText, setup) },
			action: {
				button: list.button,
				sections: list.sections,
			},
		};
	} else {
		return {
			kind: "fail",
			error: "whatsapp_send_interactive needs either 'buttons' or 'list'",
		};
	}

	return waCall(setup, { type: "interactive", interactive });
};

export const whatsappSendFlowHandler: NodeHandler = async (ctx) => {
	const flowId = ctx.node.config.flow_id as string | undefined;
	const flowToken = ctx.node.config.flow_token as string | undefined;
	const cta = (ctx.node.config.cta as string | undefined) ?? "Open";
	const bodyText = ctx.node.config.text as string | undefined;
	if (!flowId || !flowToken || !bodyText)
		return {
			kind: "fail",
			error: "whatsapp_send_flow needs flow_id + flow_token + text",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return waCall(setup, {
		type: "interactive",
		interactive: {
			type: "flow",
			body: { text: render(bodyText, setup) },
			action: {
				name: "flow",
				parameters: {
					flow_id: flowId,
					flow_token: flowToken,
					flow_cta: cta,
					flow_action: ctx.node.config.flow_action ?? "navigate",
				},
			},
		},
	});
};

export const whatsappSendLocationHandler: NodeHandler = async (ctx) => {
	const lat = ctx.node.config.latitude as number | undefined;
	const lon = ctx.node.config.longitude as number | undefined;
	if (lat === undefined || lon === undefined)
		return { kind: "fail", error: "whatsapp_send_location missing latitude/longitude" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return waCall(setup, {
		type: "location",
		location: {
			latitude: lat,
			longitude: lon,
			name: ctx.node.config.name,
			address: ctx.node.config.address,
		},
	});
};

export const whatsappSendContactsHandler: NodeHandler = async (ctx) => {
	const list = ctx.node.config.contacts as unknown[] | undefined;
	if (!list || list.length === 0)
		return { kind: "fail", error: "whatsapp_send_contacts missing 'contacts'" };
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return waCall(setup, { type: "contacts", contacts: list });
};

// The inbox-event-processor stores the inbound platform_event_id as
// `state.message_id` on the enrollment; that's the one to react to / mark
// read. We also accept `last_inbound_message_id` for backward compat with
// earlier drafts of these handlers.
function inboundMessageId(ctx: Parameters<NodeHandler>[0]): string | undefined {
	return (
		(ctx.node.config.message_id as string | undefined) ??
		(ctx.enrollment.state.message_id as string | undefined) ??
		(ctx.enrollment.state.last_inbound_message_id as string | undefined)
	);
}

export const whatsappReactHandler: NodeHandler = async (ctx) => {
	const emoji = (ctx.node.config.emoji as string | undefined) ?? "";
	const messageId = inboundMessageId(ctx);
	if (!messageId)
		return {
			kind: "fail",
			error: "whatsapp_react needs 'message_id' (node config or trigger payload)",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	return waCall(setup, {
		type: "reaction",
		reaction: { message_id: messageId, emoji },
	});
};

export const whatsappMarkReadHandler: NodeHandler = async (ctx) => {
	const messageId = inboundMessageId(ctx);
	if (!messageId)
		return {
			kind: "fail",
			error: "whatsapp_mark_read needs 'message_id' (node config or trigger payload)",
		};
	const setup = await loadCtx(ctx);
	if (isFailResult(setup)) return setup;
	const res = await fetchWithTimeout(
		`${GRAPH_BASE.facebook}/${setup.phoneNumberId}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${setup.accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messaging_product: "whatsapp",
				status: "read",
				message_id: messageId,
			}),
			timeout: 10_000,
		},
	);
	if (!res.ok) {
		const err = (await res.json().catch(() => ({}))) as {
			error?: { message?: string };
		};
		return {
			kind: "fail",
			error: err.error?.message ?? `HTTP ${res.status} marking read`,
		};
	}
	return { kind: "next" };
};
