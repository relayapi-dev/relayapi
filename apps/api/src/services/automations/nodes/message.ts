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

import { contactChannels, contacts, socialAccounts } from "@relayapi/db";
import { and, desc, eq } from "drizzle-orm";
import { decryptAccountToken } from "../../../lib/account-token-crypto";
import type {
	MessageBlock,
	QuickReply,
} from "../../../schemas/automation-graph";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "../../contact-consent";
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
			// Only park when there's a timeout to eventually wake the run — an
			// empty message with no interactive ports and no timeout has no resume
			// path and would wedge the run (see §4 below for the same reasoning).
			if (cfg.wait_for_reply && cfg.no_response_timeout_min) {
				const timeoutAt = new Date(
					ctx.now.getTime() + cfg.no_response_timeout_min * 60_000,
				);
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
		const recipient = await resolveRecipient(ctx);
		if (!recipient) {
			return {
				result: "fail",
				error: new Error("could not resolve recipient for contact"),
			};
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
		// wedge the run forever — the contact can't produce a button./quick_reply
		// port event, and a plain text reply can't resume a message-kind wait.
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

		// A plain `wait_for_reply` (no interactive elements) is only honored when
		// the operator also set a `no_response_timeout_min` — without a timeout
		// AND without any resumable interactive port, the run would never advance
		// (no text-reply resume path exists for message-kind waits in v1). Parking
		// indefinitely on a plain reply just wedges the run, so fall through to
		// `next` instead.
		const plainWaitWithTimeout =
			!!cfg.wait_for_reply && !!cfg.no_response_timeout_min;
		const shouldWait = hasInteractive || plainWaitWithTimeout;

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
	const allowed = await getAllowedRecipientHashes(
		db,
		ctx.organizationId,
		ctx.channel,
		"automation",
		[{ identifier: channelRow.identifier, contactId: ctx.contactId }],
	);
	const recipientHash = await hashRecipientIdentifier(
		ctx.channel,
		channelRow.identifier,
	);
	if (!allowed.has(recipientHash)) return null;

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
				...(ctx.workspaceId
					? [eq(socialAccounts.workspaceId, ctx.workspaceId)]
					: []),
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
