import {
	readProviderJson,
	readProviderText,
} from "../../../lib/provider-response";
import { contactChannels, socialAccounts } from "@relayapi/db";
import { and, eq, isNull } from "drizzle-orm";
import { GRAPH_BASE } from "../../../config/api-versions";
import { decryptAccountToken } from "../../../lib/account-token-crypto";
import { decryptContactChannelRow } from "../../contact-protection";
import type { NodeHandler } from "../types";

type SocialProfileCheckConfig = {
	field?: "is_user_follow_business";
};

type InstagramProfile = {
	is_user_follow_business?: boolean | null;
};

export const socialProfileCheckHandler: NodeHandler<SocialProfileCheckConfig> =
	{
		kind: "social_profile_check",
		async handle(_node, ctx) {
			if (ctx.channel !== "instagram") {
				return {
					result: "fail",
					error: new Error(
						"social_profile_check is only available for Instagram",
					),
				};
			}
			const socialAccountId =
				(typeof ctx.env.socialAccountId === "string"
					? ctx.env.socialAccountId
					: undefined) ??
				(typeof ctx.context._triggering_social_account_id === "string"
					? ctx.context._triggering_social_account_id
					: undefined);
			if (!socialAccountId) {
				return {
					result: "fail",
					error: new Error("triggering account is missing"),
				};
			}
			const [recipient, account] = await Promise.all([
				ctx.db.query.contactChannels.findFirst({
					where: and(
						eq(contactChannels.contactId, ctx.contactId),
						eq(contactChannels.socialAccountId, socialAccountId),
						eq(contactChannels.platform, "instagram"),
					),
				}),
				ctx.db.query.socialAccounts.findFirst({
					where: and(
						eq(socialAccounts.id, socialAccountId),
						eq(socialAccounts.organizationId, ctx.organizationId),
						eq(socialAccounts.lifecycleStatus, "active"),
						ctx.workspaceId
							? eq(socialAccounts.workspaceId, ctx.workspaceId)
							: isNull(socialAccounts.workspaceId),
					),
				}),
			]);
			if (!recipient || !account?.accessToken) {
				return {
					result: "fail",
					error: new Error("Instagram profile recipient or account is missing"),
				};
			}
			const encryptionKey = ctx.env.ENCRYPTION_KEY as string | undefined;
			if (!encryptionKey) {
				return {
					result: "fail",
					error: new Error("ENCRYPTION_KEY is missing"),
				};
			}
			const token = await decryptAccountToken(
				account.accessToken,
				encryptionKey,
				account.id,
				"access_token",
			);
			if (!token) {
				return {
					result: "fail",
					error: new Error("account token could not be decrypted"),
				};
			}
			const plaintextRecipient = await decryptContactChannelRow(
				encryptionKey,
				recipient,
			);

			const fetchImpl =
				(ctx.env.profileFetch as typeof fetch | undefined) ?? globalThis.fetch;
			const base = token.startsWith("IGAA")
				? GRAPH_BASE.instagram
				: GRAPH_BASE.facebook;
			const url = new URL(`${base}/${plaintextRecipient.identifier}`);
			url.searchParams.set("fields", "is_user_follow_business");
			const response = await fetchImpl(url.toString(), {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(8_000),
			});
			if (!response.ok) {
				const detail = (await readProviderText(response).catch(() => "")).slice(
					0,
					300,
				);
				return {
					result: "fail",
					error: new Error(
						`Instagram profile lookup failed (${response.status})${detail ? `: ${detail}` : ""}`,
					),
				};
			}
			const profile = (await readProviderJson(response)) as InstagramProfile;
			const follows = profile.is_user_follow_business === true;
			ctx.context.social_profile = {
				is_user_follow_business: profile.is_user_follow_business ?? null,
				fetched_at: new Date().toISOString(),
			};
			return {
				result: "advance",
				via_port: follows ? "follows" : "not_follows",
				payload: {
					is_user_follow_business: profile.is_user_follow_business ?? null,
				},
			};
		},
	};
