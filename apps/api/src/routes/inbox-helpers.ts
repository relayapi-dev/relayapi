/**
 * Shared helpers for inbox route handlers.
 *
 * Used by:
 * - inbox.ts (comments, reviews)
 * - inbox-feed.ts (conversations, messaging)
 */

import { createDb, socialAccounts } from "@relayapi/db";
import { and, eq, inArray } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";

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
	if (workspaceScope !== "all") {
		if (!account.workspaceId || !workspaceScope.includes(account.workspaceId)) {
			return null;
		}
	}
	return {
		...account,
		accessToken: await maybeDecrypt(account.accessToken, encryptionKey),
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
	decrypt: boolean = true,
) {
	if (opts?.accountId) {
		const account = await getAccount(db, opts.accountId, orgId, encryptionKey, workspaceScope);
		return account ? [account] : [];
	}
	const conditions = [eq(socialAccounts.organizationId, orgId)];
	if (opts?.platform) {
		conditions.push(eq(socialAccounts.platform, opts.platform as any));
	}
	if (workspaceScope !== "all") {
		conditions.push(inArray(socialAccounts.workspaceId, workspaceScope));
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
	if (!decrypt) return accounts;
	return Promise.all(
		accounts.map(async (a) => ({
			...a,
			accessToken: await maybeDecrypt(a.accessToken, encryptionKey),
		})),
	);
}

// ---------------------------------------------------------------------------
// Instagram Login tokens (prefix "IGAA") must use graph.instagram.com
// Facebook Login tokens (prefix "EAAC") must use graph.facebook.com
// ---------------------------------------------------------------------------
export function igGraphHost(token: string): string {
	return token.startsWith("IGAA") ? "graph.instagram.com" : "graph.facebook.com";
}
