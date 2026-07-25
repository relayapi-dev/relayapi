// apps/api/src/services/automations/nodes/message.ts
//
// Composite `message` node handler. Renders a list of MessageBlocks,
// dispatches them to the right channel via `dispatchAutomationMessage`,
// and decides whether to park the run on `wait_input` (when there are any
// interactive buttons / quick replies, or when `wait_for_reply` is set) or
// advance through `next`.
//
// Design spec: docs/superpowers/specs/2026-04-21-manychat-parity-automation-rebuild.md
//   §5  (message blocks)
//   §8.3 (runner)
//   §11 (message composer)

import {
	contactChannels,
	contacts,
	type inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { GRAPH_BASE } from "../../../config/api-versions";
import { decryptAccountToken } from "../../../lib/account-token-crypto";
import { workspaceScopeKey } from "../../../lib/request-access";
import type {
	MessageBlock,
	QuickReply,
} from "../../../schemas/automation-graph";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "../../contact-consent";
import { authorizeConversationReply } from "../../conversation-reply-authorization";
import type {
	SendMessageRequest,
	SendMessageResult,
} from "../../message-sender";
import { applyMergeTags } from "../merge-tags";
import {
	type AutomationChannel,
	CHANNEL_CAPABILITIES,
	CHANNEL_SUPPORTS_BUTTONS,
	CHANNEL_SUPPORTS_QUICK_REPLIES,
	dispatchAutomationMessage,
} from "../platforms";
import type { NodeHandler, RunContext } from "../types";

type SendTransport = (req: SendMessageRequest) => Promise<SendMessageResult>;

type MessageConfig = {
	blocks?: MessageBlock[];
	quick_replies?: QuickReply[];
	wait_for_reply?: boolean;
	no_response_timeout_min?: number;
	typing_indicator_seconds?: number;
	delivery?: "direct" | "comment_private_reply";
};

export function automationMessageDeliveryError(result: {
	sent: Array<{ skipped?: boolean }>;
	errors: Array<unknown>;
}): Error | null {
	if (result.errors.length > 0) {
		return new Error(
			`automation message delivery failed for ${result.errors.length} block(s)`,
		);
	}
	if (result.sent.every((item) => item.skipped)) {
		return new Error("automation message delivered no blocks");
	}
	return null;
}

export const messageHandler: NodeHandler<MessageConfig> = {
	kind: "message",
	async handle(node, ctx) {
		const cfg = node.config ?? ({} as MessageConfig);
		const blocks = cfg.blocks ?? [];
		const quickReplies = cfg.quick_replies ?? [];

		// Fast path: an empty message (no blocks, no quick replies) has nothing
		// to render and nothing to wait for. Skip recipient resolution so we
		// don't fail runs whose message node is still a placeholder.
		if (blocks.length === 0 && quickReplies.length === 0) {
			// An explicit reply wait is also useful as a wait-only step after a
			// previous prompt. Ordinary inbound text/attachments resume it through
			// `next`, so the timeout remains optional just as it is for non-empty
			// messages.
			if (cfg.wait_for_reply) {
				const timeoutAt = cfg.no_response_timeout_min
					? new Date(ctx.now.getTime() + cfg.no_response_timeout_min * 60_000)
					: undefined;
				return {
					result: "wait_input",
					timeout_at: timeoutAt,
					payload: { sent_count: 0, skipped_count: 0, errors: [] },
				};
			}
			return {
				result: "advance",
				via_port: "next",
				payload: { sent_count: 0, skipped_count: 0, errors: [] },
			};
		}

		// 1. Merge-tag resolution ------------------------------------------------
		const mergeCtx = buildMergeContext(ctx);
		const renderedBlocks = resolveMergeTagsInBlocks(blocks, mergeCtx);
		const renderedQuickReplies = quickReplies.map((qr) => ({
			...qr,
			label: applyMergeTags(qr.label, mergeCtx),
		}));

		// 2. Recipient resolution ------------------------------------------------
		const recipient = await resolveRecipient(
			ctx,
			cfg.delivery === "comment_private_reply",
		);
		if (!recipient) {
			return {
				result: "fail",
				error: new Error("could not resolve recipient for contact"),
			};
		}

		if (cfg.delivery === "comment_private_reply") {
			if (renderedQuickReplies.length > 0 || renderedBlocks.length !== 1) {
				return {
					result: "fail",
					error: new Error(
						"comment private replies require exactly one text block and no quick replies",
					),
				};
			}
			const block = renderedBlocks[0];
			if (block?.type !== "text" || block.buttons?.length) {
				return {
					result: "fail",
					error: new Error(
						"comment private replies support one button-free text block",
					),
				};
			}
			try {
				const providerReference = await dispatchCommentPrivateReply(
					ctx,
					recipient,
					block.text,
				);
				return {
					result: "advance",
					via_port: "next",
					payload: {
						sent_count: 1,
						skipped_count: 0,
						errors: [],
						provider_reference: providerReference,
					},
				};
			} catch (error) {
				return {
					result: "fail",
					error: error instanceof Error ? error : new Error(String(error)),
				};
			}
		}

		// 3. Dispatch ------------------------------------------------------------
		const sendResult = await dispatchAutomationMessage({
			channel: ctx.channel as AutomationChannel,
			socialAccountId: recipient.socialAccountId,
			recipient: {
				contactId: ctx.contactId,
				platformContactId: recipient.platformContactId,
				conversationId: ctx.conversationId,
			},
			blocks: renderedBlocks,
			quickReplies: renderedQuickReplies,
			typingDelayMs: cfg.typing_indicator_seconds
				? cfg.typing_indicator_seconds * 1000
				: undefined,
			credentials: {
				accessToken: recipient.accessToken,
				platformAccountId: recipient.accountPlatformId,
			},
			idempotencyKey: ctx.effectIdempotencyKey,
			sendTransport: ctx.env?.sendTransport as SendTransport | undefined,
		});

		const payload = {
			sent_count: sendResult.sent.filter((s) => !s.skipped).length,
			skipped_count: sendResult.sent.filter((s) => s.skipped).length,
			errors: sendResult.errors,
		};

		// A provider failure is not a successful automation step. In particular,
		// never park on wait_input when the prompt/buttons were not fully delivered:
		// the contact cannot answer UI they never received. Partial delivery is also
		// failed explicitly; replay requires the durable per-block effect ledger
		// rather than pretending the node advanced successfully.
		const deliveryError = automationMessageDeliveryError(sendResult);
		if (deliveryError) {
			return {
				result: "fail",
				error: deliveryError,
				payload,
			};
		}

		// 4. Decide whether to wait ---------------------------------------------
		// Only count interactive elements the CHANNEL can actually deliver. The
		// dispatcher silently skips branch buttons / quick replies on channels
		// that don't support them (e.g. WhatsApp has no quick replies and no
		// card/gallery), so waiting for a tap on UI that was never sent would
		// wedge the run forever — the contact can't produce that interactive port.
		const channel = ctx.channel as AutomationChannel;
		const channelCaps = CHANNEL_CAPABILITIES[channel];
		const deliverableBranchButton =
			!!channelCaps &&
			CHANNEL_SUPPORTS_BUTTONS[channel] &&
			hasDeliverableBranchButton(renderedBlocks, channelCaps);
		const deliverableQuickReply =
			renderedQuickReplies.length > 0 &&
			CHANNEL_SUPPORTS_QUICK_REPLIES[channel];
		const hasInteractive = deliverableBranchButton || deliverableQuickReply;

		// An explicit plain-text wait resumes through the message node's `next`
		// port when the next ordinary inbound DM arrives. Interactive payloads
		// continue to use their derived button/quick-reply ports. A timeout is
		// optional; when present, the scheduler advances through `no_response`.
		const shouldWait = hasInteractive || cfg.wait_for_reply === true;

		if (shouldWait) {
			const timeoutAt = cfg.no_response_timeout_min
				? new Date(ctx.now.getTime() + cfg.no_response_timeout_min * 60_000)
				: undefined;
			return { result: "wait_input", timeout_at: timeoutAt, payload };
		}

		return { result: "advance", via_port: "next", payload };
	},
};

// ---------------------------------------------------------------------------
// Helpers (local to message node — not exported)
// ---------------------------------------------------------------------------

type MergeContext = {
	contact: Record<string, unknown> | null;
	state: Record<string, unknown>;
};

function buildMergeContext(ctx: RunContext): MergeContext {
	return {
		contact:
			(ctx.context.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context,
	};
}

/**
 * Walk every MessageBlock and substitute `{{merge.tags}}` in any text-bearing
 * field: block text / caption, card titles & subtitles, button labels, and
 * nested gallery cards. Non-text blocks (audio, file, pure media) are passed
 * through unchanged.
 */
function resolveMergeTagsInBlocks(
	blocks: MessageBlock[],
	mergeCtx: MergeContext,
): MessageBlock[] {
	return blocks.map((block) => renderBlock(block, mergeCtx));
}

function renderBlock(
	block: MessageBlock,
	mergeCtx: MergeContext,
): MessageBlock {
	switch (block.type) {
		case "text":
			return {
				...block,
				text: applyMergeTags(block.text ?? "", mergeCtx),
				buttons: block.buttons?.map((b) => ({
					...b,
					label: applyMergeTags(b.label, mergeCtx),
				})),
			};
		case "image":
		case "video":
			return {
				...block,
				caption: block.caption
					? applyMergeTags(block.caption, mergeCtx)
					: block.caption,
			};
		case "card":
			return {
				...block,
				title: applyMergeTags(block.title, mergeCtx),
				subtitle: block.subtitle
					? applyMergeTags(block.subtitle, mergeCtx)
					: block.subtitle,
				buttons: block.buttons?.map((b) => ({
					...b,
					label: applyMergeTags(b.label, mergeCtx),
				})),
			};
		case "gallery":
			return {
				...block,
				cards: block.cards.map((c) => ({
					...c,
					title: applyMergeTags(c.title, mergeCtx),
					subtitle: c.subtitle
						? applyMergeTags(c.subtitle, mergeCtx)
						: c.subtitle,
					buttons: c.buttons?.map((b) => ({
						...b,
						label: applyMergeTags(b.label, mergeCtx),
					})),
				})),
			};
		// audio, file, delay — no user-visible text to merge
		default:
			return block;
	}
}

/**
 * A message implicitly awaits a reply if ANY block the channel can actually
 * deliver carries a `branch` button. Blocks whose type the channel doesn't
 * support (e.g. card/gallery on WhatsApp) are skipped — their buttons are
 * never sent, so we must not park the run waiting for a tap that can't happen.
 */
function hasDeliverableBranchButton(
	blocks: MessageBlock[],
	channelCaps: Record<MessageBlock["type"], boolean>,
): boolean {
	for (const block of blocks) {
		if (!channelCaps[block.type]) continue;
		if (block.type === "text" || block.type === "card") {
			if (block.buttons?.some((b) => b.type === "branch")) return true;
		}
		if (block.type === "gallery") {
			for (const c of block.cards) {
				if (c.buttons?.some((b) => b.type === "branch")) return true;
			}
		}
	}
	return false;
}

type ResolvedRecipient = {
	socialAccountId: string;
	platformContactId: string;
	accessToken: string;
	accountPlatformId: string;
};

export function buildCommentPrivateReplyRequest(
	channel: "instagram" | "facebook",
	input: {
		commentId: string;
		accountPlatformId: string;
		accessToken: string;
		text: string;
	},
): { url: string; body: Record<string, unknown> } {
	if (channel === "instagram") {
		const base = input.accessToken.startsWith("IGAA")
			? GRAPH_BASE.instagram
			: GRAPH_BASE.facebook;
		return {
			url: `${base}/${input.accountPlatformId}/messages`,
			body: {
				recipient: { comment_id: input.commentId },
				message: { text: input.text },
			},
		};
	}
	return {
		url: `${GRAPH_BASE.facebook}/${input.commentId}/private_replies`,
		body: { message: input.text },
	};
}

async function dispatchCommentPrivateReply(
	ctx: RunContext,
	recipient: ResolvedRecipient,
	text: string,
): Promise<string | null> {
	const triggerEvent = ctx.context.triggerEvent as
		| { payload?: { comment_id?: unknown } }
		| undefined;
	const commentId =
		typeof triggerEvent?.payload?.comment_id === "string"
			? triggerEvent.payload.comment_id
			: typeof ctx.context.comment_id === "string"
				? ctx.context.comment_id
				: null;
	if (!commentId) throw new Error("comment private reply requires comment_id");
	if (ctx.channel !== "instagram" && ctx.channel !== "facebook") {
		throw new Error("comment private replies require Instagram or Facebook");
	}

	const fetchImpl =
		(ctx.env.privateReplyFetch as typeof fetch | undefined) ?? globalThis.fetch;
	// Meta Instagram API, “Private Replies”: POST /{ig-user-id}/messages with
	// recipient.comment_id and message.text. Messenger Page comments use the
	// comment's /private_replies edge.
	const request = buildCommentPrivateReplyRequest(ctx.channel, {
		commentId,
		accountPlatformId: recipient.accountPlatformId,
		accessToken: recipient.accessToken,
		text,
	});
	const response = await fetchImpl(request.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${recipient.accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request.body),
	});
	const raw = await response.text();
	if (!response.ok) {
		throw new Error(
			`comment private reply failed (${response.status})${raw ? `: ${raw.slice(0, 500)}` : ""}`,
		);
	}
	let parsed: { message_id?: string; id?: string } = {};
	try {
		parsed = raw ? (JSON.parse(raw) as typeof parsed) : {};
	} catch {
		// A successful response with an empty/non-JSON body is still successful.
	}
	return parsed.message_id ?? parsed.id ?? null;
}

/**
 * Resolve which `(social_account, contact_channel)` pair this message should
 * be delivered through. Order of precedence:
 *   1. `ctx.env.socialAccountId` — explicit override (used by tests and by the
 *      resume path where we already know the account from the inbound event).
 *   2. `contact_channels` row for (contact, channel), newest first.
 *
 * Returns null when no matching channel membership exists — the caller will
 * route the run to the handler's `fail` outcome.
 */
async function resolveRecipient(
	ctx: RunContext,
	allowCommentPrivateReply = false,
): Promise<ResolvedRecipient | null> {
	const db = ctx.db;
	if (!db) return null;

	// Look for the contact_channels row matching this contact + channel.
	// If an explicit socialAccountId override is provided, scope to it.
	const overrideAccountId = ctx.env?.socialAccountId as string | undefined;

	const conditions = [
		eq(contactChannels.contactId, ctx.contactId),
		eq(
			contactChannels.platform,
			ctx.channel as typeof contactChannels.$inferSelect.platform,
		),
		eq(contacts.organizationId, ctx.organizationId),
	];
	if (overrideAccountId) {
		conditions.push(eq(contactChannels.socialAccountId, overrideAccountId));
	}

	const [channelRow] = await db
		.select({
			socialAccountId: contactChannels.socialAccountId,
			identifier: contactChannels.identifier,
			createdAt: contactChannels.createdAt,
		})
		.from(contactChannels)
		.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
		.where(and(...conditions))
		.orderBy(desc(contactChannels.createdAt))
		.limit(1);

	if (!channelRow) return null;
	const recipientHash = await hashRecipientIdentifier(
		ctx.channel,
		channelRow.identifier,
	);
	const recipient = [
		{ identifier: channelRow.identifier, contactId: ctx.contactId },
	];
	const triggerEvent = ctx.context.triggerEvent as
		| { kind?: unknown; payload?: { comment_id?: unknown } }
		| undefined;
	const commentPrivateReplyAuthorized =
		allowCommentPrivateReply &&
		(triggerEvent?.kind === "comment_created" ||
			triggerEvent?.kind === "live_comment") &&
		typeof triggerEvent.payload?.comment_id === "string";
	const [explicitAutomationGrant, notAutomationSuppressed, serviceReply] =
		await Promise.all([
			getAllowedRecipientHashes(
				db,
				ctx.organizationId,
				ctx.channel,
				"automation",
				recipient,
			),
			getAllowedRecipientHashes(
				db,
				ctx.organizationId,
				ctx.channel,
				"automation",
				recipient,
				{ requireGrant: false },
			),
			ctx.conversationId
				? authorizeConversationReply(db, {
						organizationId: ctx.organizationId,
						scopeKey: workspaceScopeKey(ctx.workspaceId ?? null),
						conversationId: ctx.conversationId,
						accountId: channelRow.socialAccountId,
						platform: ctx.channel as typeof inboxMessages.$inferSelect.platform,
						recipientIdentifier: channelRow.identifier,
						now: ctx.now,
					})
				: Promise.resolve({
						authorized: false as const,
						reason: "no_inbound" as const,
					}),
		]);
	// Automation suppression is an absolute veto. Otherwise a durable explicit
	// grant or the exact, bounded inbound-conversation service capability may
	// authorize this send. Inbound discovery never becomes broad consent.
	if (
		!notAutomationSuppressed.has(recipientHash) ||
		(!explicitAutomationGrant.has(recipientHash) &&
			!serviceReply.authorized &&
			!commentPrivateReplyAuthorized)
	) {
		return null;
	}

	const [acc] = await db
		.select({
			id: socialAccounts.id,
			platformAccountId: socialAccounts.platformAccountId,
			accessToken: socialAccounts.accessToken,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, channelRow.socialAccountId),
				eq(socialAccounts.organizationId, ctx.organizationId),
				eq(socialAccounts.lifecycleStatus, "active"),
				ctx.workspaceId
					? eq(socialAccounts.workspaceId, ctx.workspaceId)
					: isNull(socialAccounts.workspaceId),
			),
		)
		.limit(1);

	if (!acc?.accessToken) return null;

	const encKey = ctx.env?.ENCRYPTION_KEY as string | undefined;
	const token = await decryptAccountToken(
		acc.accessToken,
		encKey,
		acc.id,
		"access_token",
	);
	if (!token) return null;

	return {
		socialAccountId: acc.id,
		platformContactId: channelRow.identifier,
		accessToken: token,
		accountPlatformId: acc.platformAccountId,
	};
}
