/**
 * Shared helpers for inbox route handlers.
 *
 * Used by:
 * - inbox.ts (comments, reviews)
 * - inbox-feed.ts (conversations, messaging)
 */

import {
	type createDb,
	inboxConversations,
	inboxMessages,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, or, sql } from "drizzle-orm";
import { decryptAccountToken } from "../lib/account-token-crypto";
import {
	canAccessWorkspaceScope,
	workspaceScopeSqlCondition,
} from "../lib/workspace-scope";

// ---------------------------------------------------------------------------
// Helper: look up a social account by ID scoped to the org
// ---------------------------------------------------------------------------
export async function getAccount(
	db: ReturnType<typeof createDb>,
	accountId: string,
	orgId: string,
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
) {
	const [account] = await db
		.select({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			accessToken: socialAccounts.accessToken,
			scopes: socialAccounts.scopes,
			metadata: socialAccounts.metadata,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, accountId),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.limit(1);
	if (!account) return null;
	if (!canAccessWorkspaceScope(workspaceScope, account.workspaceId))
		return null;
	return {
		...account,
		accessToken: await decryptAccountToken(
			account.accessToken,
			encryptionKey,
			account.id,
			"access_token",
		),
	};
}

type InboxConversation = typeof inboxConversations.$inferSelect;
type InboxMessage = typeof inboxMessages.$inferSelect;
type InboxAccount = typeof socialAccounts.$inferSelect;

export type ResolvedInboxTarget = {
	conversation: InboxConversation;
	message: InboxMessage | null;
	account: Omit<InboxAccount, "accessToken"> & { accessToken: string | null };
};

/**
 * Resolve the complete inbox action tuple before a provider boundary.
 *
 * The account, platform, organization and workspace are derived from the
 * persisted conversation rather than selected independently by the request.
 * `assertedAccountId` is compatibility-only: when old clients still send an
 * account id it must equal the derived account, but it never participates in
 * selecting the target. A platform conversation id is accepted only when it
 * resolves unambiguously inside the authorized scope.
 */
export async function resolveInboxTarget(
	db: ReturnType<typeof createDb>,
	params: {
		conversationId: string;
		organizationId: string;
		workspaceScope?: "all" | string[];
		messageId?: string;
		assertedAccountId?: string;
		encryptionKey?: string;
	},
): Promise<ResolvedInboxTarget | null> {
	if (
		params.workspaceScope !== undefined &&
		params.workspaceScope !== "all" &&
		params.workspaceScope.length === 0
	) {
		return null;
	}

	const conversationConditions = [
		eq(inboxConversations.organizationId, params.organizationId),
		or(
			eq(inboxConversations.id, params.conversationId),
			eq(inboxConversations.platformConversationId, params.conversationId),
		),
		eq(socialAccounts.organizationId, params.organizationId),
		eq(socialAccounts.lifecycleStatus, "active"),
		eq(inboxConversations.platform, socialAccounts.platform),
		// PostgreSQL's null-safe equality keeps organization-scoped resources
		// coherent while rejecting a workspace/account mismatch.
		sql`${inboxConversations.workspaceId} IS NOT DISTINCT FROM ${socialAccounts.workspaceId}`,
	];
	if (params.workspaceScope && params.workspaceScope !== "all") {
		conversationConditions.push(
			workspaceScopeSqlCondition(
				params.workspaceScope,
				inboxConversations.workspaceId,
			),
		);
	}

	const rows = await db
		.select({
			conversation: inboxConversations,
			account: socialAccounts,
			message: inboxMessages,
		})
		.from(inboxConversations)
		.innerJoin(
			socialAccounts,
			and(
				eq(inboxConversations.accountId, socialAccounts.id),
				eq(inboxConversations.organizationId, socialAccounts.organizationId),
			),
		)
		.leftJoin(
			inboxMessages,
			params.messageId
				? and(
						eq(inboxMessages.id, params.messageId),
						eq(inboxMessages.conversationId, inboxConversations.id),
						eq(inboxMessages.organizationId, inboxConversations.organizationId),
					)
				: sql`false`,
		)
		.where(and(...conversationConditions))
		.limit(2);

	// A provider conversation id can be reused by multiple accounts. Never let
	// a request-provided account id disambiguate that case: require the canonical
	// local conversation id instead.
	if (rows.length !== 1) return null;
	const row = rows[0];
	if (!row) return null;
	if (params.messageId && !row.message) return null;
	if (
		params.assertedAccountId !== undefined &&
		params.assertedAccountId !== row.account.id
	) {
		return null;
	}

	const accessToken =
		row.account.accessToken && params.encryptionKey
			? await decryptAccountToken(
					row.account.accessToken,
					params.encryptionKey,
					row.account.id,
					"access_token",
				)
			: null;

	return {
		conversation: row.conversation,
		message: row.message,
		account: { ...row.account, accessToken },
	};
}

// ---------------------------------------------------------------------------
// Helper: look up all social accounts for an org, optionally filtered
// ---------------------------------------------------------------------------
export async function getAccountsForOrg(
	db: ReturnType<typeof createDb>,
	orgId: string,
	opts?: { platform?: string; accountId?: string },
	encryptionKey?: string,
	workspaceScope: "all" | string[] = "all",
	maxAccounts: number = 50,
) {
	if (opts?.accountId) {
		const account = await getAccount(
			db,
			opts.accountId,
			orgId,
			encryptionKey,
			workspaceScope,
		);
		return account ? [account] : [];
	}
	const conditions = [eq(socialAccounts.organizationId, orgId)];
	if (opts?.platform) {
		conditions.push(
			eq(
				socialAccounts.platform,
				opts.platform as typeof socialAccounts.$inferSelect.platform,
			),
		);
	}
	if (workspaceScope !== "all") {
		conditions.push(
			workspaceScopeSqlCondition(workspaceScope, socialAccounts.workspaceId),
		);
	}
	const accounts = await db
		.select({
			id: socialAccounts.id,
			organizationId: socialAccounts.organizationId,
			platform: socialAccounts.platform,
			platformAccountId: socialAccounts.platformAccountId,
			username: socialAccounts.username,
			displayName: socialAccounts.displayName,
			avatarUrl: socialAccounts.avatarUrl,
			accessToken: socialAccounts.accessToken,
			scopes: socialAccounts.scopes,
			metadata: socialAccounts.metadata,
			workspaceId: socialAccounts.workspaceId,
		})
		.from(socialAccounts)
		.where(and(...conditions))
		.limit(maxAccounts);
	return Promise.all(
		accounts.map(async (a) => ({
			...a,
			accessToken: await decryptAccountToken(
				a.accessToken,
				encryptionKey,
				a.id,
				"access_token",
			),
		})),
	);
}

// ---------------------------------------------------------------------------
// Instagram Login tokens (prefix "IGAA") must use graph.instagram.com
// Facebook Login tokens (prefix "EAAC") must use graph.facebook.com
// ---------------------------------------------------------------------------
export function igGraphHost(token: string): string {
	return token.startsWith("IGAA")
		? "graph.instagram.com"
		: "graph.facebook.com";
}
