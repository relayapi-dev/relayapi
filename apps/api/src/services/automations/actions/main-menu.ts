import { contactChannels, contacts, socialAccounts } from "@relayapi/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { GRAPH_BASE } from "../../../config/api-versions";
import { decryptAccountToken } from "../../../lib/account-token-crypto";
import { requireConsentHmacKeyConfig } from "../../../lib/consent-hmac";
import type { Action } from "../../../schemas/automation-actions";
import {
	getAllowedRecipientHashes,
	hashRecipientIdentifier,
} from "../../contact-consent";
import { decryptContactChannelRow } from "../../contact-protection";
import { applyMergeTags } from "../merge-tags";
import {
	AutomationExternalEffectKnownFailureError,
	type RunContext,
} from "../types";
import type { ActionHandler, ActionRegistry } from "./types";

type ChangeMainMenuAction = Extract<Action, { type: "change_main_menu" }>;

function triggeringAccountId(ctx: RunContext): string | null {
	if (typeof ctx.env.socialAccountId === "string")
		return ctx.env.socialAccountId;
	if (typeof ctx.context._triggering_social_account_id === "string") {
		return ctx.context._triggering_social_account_id;
	}
	const trigger = ctx.context.triggerEvent as
		| { socialAccountId?: unknown }
		| undefined;
	return typeof trigger?.socialAccountId === "string"
		? trigger.socialAccountId
		: null;
}

const changeMainMenu: ActionHandler<ChangeMainMenuAction> = async (
	action,
	ctx,
) => {
	if (ctx.channel !== "facebook") {
		throw new Error(
			"change_main_menu is supported only for Facebook Messenger",
		);
	}
	if (action.menu_payload.items.length > 20) {
		throw new Error("Messenger persistent menus support at most 20 items");
	}
	const accountId = triggeringAccountId(ctx);
	if (!accountId) {
		throw new Error("change_main_menu requires a triggering social account");
	}
	const workspaceCondition = ctx.workspaceId
		? eq(socialAccounts.workspaceId, ctx.workspaceId)
		: isNull(socialAccounts.workspaceId);
	const [account] = await ctx.db
		.select({
			id: socialAccounts.id,
			platformAccountId: socialAccounts.platformAccountId,
			accessToken: socialAccounts.accessToken,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, ctx.organizationId),
				eq(socialAccounts.platform, "facebook"),
				eq(socialAccounts.lifecycleStatus, "active"),
				workspaceCondition,
			),
		)
		.limit(1);
	if (!account?.accessToken) {
		throw new Error("change_main_menu social account is unavailable");
	}

	const contactWorkspaceCondition = ctx.workspaceId
		? eq(contacts.workspaceId, ctx.workspaceId)
		: isNull(contacts.workspaceId);
	const [channel] = await ctx.db
		.select({
			id: contactChannels.id,
			organizationId: contactChannels.organizationId,
			identifierCiphertext: contactChannels.identifierCiphertext,
			identifierHash: contactChannels.identifierHash,
			identityKeyFingerprint: contactChannels.identityKeyFingerprint,
		})
		.from(contactChannels)
		.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
		.where(
			and(
				eq(contactChannels.contactId, ctx.contactId),
				eq(contactChannels.socialAccountId, account.id),
				eq(contactChannels.platform, "facebook"),
				eq(contacts.organizationId, ctx.organizationId),
				contactWorkspaceCondition,
			),
		)
		.orderBy(desc(contactChannels.createdAt))
		.limit(1);
	if (!channel) throw new Error("change_main_menu recipient is unavailable");
	const consentKeyConfig = requireConsentHmacKeyConfig(ctx.env.ENCRYPTION_KEY);
	const plaintextChannel = await decryptContactChannelRow(
		consentKeyConfig,
		channel,
	);

	const allowed = await getAllowedRecipientHashes(
		ctx.db,
		consentKeyConfig,
		ctx.organizationId,
		"facebook",
		"automation",
		[{ identifier: plaintextChannel.identifier, contactId: ctx.contactId }],
	);
	const recipientHash = await hashRecipientIdentifier(
		consentKeyConfig,
		ctx.organizationId,
		"facebook",
		"automation",
		plaintextChannel.identifier,
	);
	if (!allowed.has(recipientHash)) {
		throw new Error(
			"change_main_menu recipient is not eligible for automation",
		);
	}

	const token = await decryptAccountToken(
		account.accessToken,
		ctx.env.ENCRYPTION_KEY as string | undefined,
		account.id,
		"access_token",
	);
	if (!token) throw new Error("change_main_menu token could not be decrypted");
	const mergeContext = {
		contact:
			(ctx.context.contact as Record<string, unknown> | undefined) ?? null,
		state: ctx.context,
	};
	const callToActions = action.menu_payload.items.map((item) =>
		item.action === "url"
			? {
					type: "web_url",
					title: applyMergeTags(item.label, mergeContext),
					url: applyMergeTags(item.url, mergeContext),
					webview_height_ratio: "full",
				}
			: {
					type: "postback",
					title: applyMergeTags(item.label, mergeContext),
					payload: applyMergeTags(item.payload, mergeContext),
				},
	);
	const fetchImpl =
		(ctx.env.mainMenuFetch as typeof fetch | undefined) ?? globalThis.fetch;
	const dispatch = async () => {
		const response = await fetchImpl(
			`${GRAPH_BASE.facebook}/${account.platformAccountId}/custom_user_settings`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					psid: plaintextChannel.identifier,
					persistent_menu: [
						{
							locale: "default",
							composer_input_disabled:
								action.menu_payload.composer_input_disabled,
							call_to_actions: callToActions,
						},
					],
				}),
			},
		);
		if (!response.ok) {
			const detail = await response.text();
			const message = `change_main_menu failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`;
			if (response.status >= 500) throw new Error(message);
			throw new AutomationExternalEffectKnownFailureError(message);
		}
		return { status: response.status };
	};

	if (ctx.executeExternalEffect) {
		await ctx.executeExternalEffect(
			{
				effectKey: `action:${action.id}`,
				kind: "automation_action",
			},
			async () => ({
				outcome: "succeeded",
				value: await dispatch(),
			}),
		);
	} else {
		await dispatch();
	}
};

export const mainMenuHandlers: ActionRegistry = {
	change_main_menu: changeMainMenu,
};
