import {
	accountRevocationJobs,
	adAccounts,
	automationBindings,
	automationEntrypoints,
	autoPostRules,
	broadcasts,
	connectionLogs,
	type Database,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";

/**
 * Identity of a social account needed to compute its KV cache keys.
 */
export interface AccountCacheIdentity {
	/** social_accounts.id (the internal account id, e.g. `acc_...`) */
	accountId: string;
	platform: string;
	/** social_accounts.platform_account_id (the platform-side id) */
	platformAccountId?: string | null;
	/** social_accounts.webhook_account_id (Instagram fallback resolution id) */
	webhookAccountId?: string | null;
}

/**
 * Build the list of KV cache keys that reference a social account and must be
 * invalidated when it is disconnected/deleted. Keeping the key formats here in
 * one place mirrors the producers in `routes/platform-webhooks.ts` and
 * `routes/inbox.ts`, so a disconnect stops serving the stale account before the
 * entries' TTLs expire.
 *
 * Notes:
 * - `platform-account:{platform}:{id}` is the account-resolution cache used by
 *   `resolveAccounts`. We clear it for both the platform account id and the
 *   webhook account id (Instagram resolves via the latter when entry.id is the
 *   IGBA id). When other orgs still have the same platform account connected,
 *   the next webhook re-populates the cache with the remaining accounts.
 * - `msg-dedup:{accountId}:{mid}` is intentionally omitted: it is keyed on the
 *   per-message id (not enumerable here) and carries a short 300s TTL.
 */
export function buildAccountCacheKeys(
	identity: AccountCacheIdentity,
): string[] {
	const { accountId, platform, platformAccountId, webhookAccountId } = identity;
	const keys = new Set<string>();

	// Account-resolution cache (platform-webhooks resolveAccounts)
	if (platformAccountId) {
		keys.add(`platform-account:${platform}:${platformAccountId}`);
	}
	if (webhookAccountId && webhookAccountId !== platformAccountId) {
		keys.add(`platform-account:${platform}:${webhookAccountId}`);
	}

	// Per-account caches keyed on the internal account id
	keys.add(`ig-sender-id:${accountId}`);
	keys.add(`sync-dedup:${accountId}`);
	keys.add(`inbox-posts:${accountId}`);

	return [...keys];
}

/**
 * Best-effort invalidation of every KV cache entry referencing a social
 * account. Safe to run from a request path via `executionCtx.waitUntil`; each
 * delete swallows its own error so one failure does not abort the rest.
 */
export async function invalidateAccountCaches(
	kv: KVNamespace,
	identity: AccountCacheIdentity,
): Promise<void> {
	const keys = buildAccountCacheKeys(identity);
	await Promise.all(keys.map((key) => kv.delete(key).catch(() => {})));
}

/**
 * Lifecycle-safe disconnect. Despite the historical function name, this no
 * longer deletes the account or any immutable history. The durable account row
 * is immediately excluded from active work, account-scoped configuration is
 * paused, an audit snapshot is committed, and a revocation job retains the
 * encrypted credential until the provider outcome is reconciled.
 */
export async function deleteConnectedAccountGraph(
	db: Database,
	accountId: string,
): Promise<undefined>;
export async function deleteConnectedAccountGraph<T>(
	db: Database,
	accountId: string,
	onDisconnected: (
		tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
		account: typeof socialAccounts.$inferSelect,
	) => Promise<T>,
): Promise<T | undefined>;
export async function deleteConnectedAccountGraph<T>(
	db: Database,
	accountId: string,
	onDisconnected?: (
		tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
		account: typeof socialAccounts.$inferSelect,
	) => Promise<T>,
): Promise<T | undefined> {
	return db.transaction(async (tx) => {
		const [account] = await tx
			.select()
			.from(socialAccounts)
			.where(eq(socialAccounts.id, accountId))
			.for("update")
			.limit(1);
		if (account?.lifecycleStatus !== "active") return;

		const now = new Date();
		await tx
			.insert(accountRevocationJobs)
			.values({
				accountId: account.id,
				organizationId: account.organizationId,
				platform: account.platform,
				accessTokenCiphertext: account.accessToken,
				refreshTokenCiphertext: account.refreshToken,
				sourceTokenVersion: account.tokenVersion,
				status: "pending",
				nextAttemptAt: now,
			})
			.onConflictDoUpdate({
				target: accountRevocationJobs.accountId,
				set: {
					accessTokenCiphertext: account.accessToken,
					refreshTokenCiphertext: account.refreshToken,
					sourceTokenVersion: account.tokenVersion,
					status: "pending",
					attempts: 0,
					nextAttemptAt: now,
					leaseExpiresAt: null,
					lastError: null,
					providerResponse: null,
					completedAt: null,
					updatedAt: now,
				},
			});

		await tx.insert(connectionLogs).values({
			organizationId: account.organizationId,
			socialAccountId: account.id,
			platform: account.platform,
			event: "disconnecting",
			message: `Disconnect requested for ${account.displayName || account.username || account.platform}`,
			snapshot: {
				account_id: account.id,
				platform: account.platform,
				platform_account_id: account.platformAccountId,
				username: account.username,
				display_name: account.displayName,
				workspace_id: account.workspaceId,
				requested_at: now.toISOString(),
			},
		});

		await tx
			.update(socialAccounts)
			.set({
				lifecycleStatus: "disconnecting",
				disconnectRequestedAt: now,
				disconnectReason: "user_requested",
				tokenExpiresAt: null,
				updatedAt: now,
			})
			.where(eq(socialAccounts.id, accountId));

		await tx
			.update(autoPostRules)
			.set({ status: "paused", updatedAt: now })
			.where(
				and(
					eq(autoPostRules.organizationId, account.organizationId),
					sql`${autoPostRules.accountIds} @> ${JSON.stringify([accountId])}::jsonb`,
				),
			);
		await tx
			.update(broadcasts)
			.set({
				status: "cancelled",
				completedAt: now,
				leaseExpiresAt: null,
				revision: sql`${broadcasts.revision} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(broadcasts.socialAccountId, accountId),
					inArray(broadcasts.status, ["draft", "scheduled", "sending"]),
				),
			);
		await tx
			.update(automationEntrypoints)
			.set({ status: "disabled", updatedAt: now })
			.where(eq(automationEntrypoints.socialAccountId, accountId));
		await tx
			.update(automationBindings)
			.set({ status: "inactive", updatedAt: now })
			.where(eq(automationBindings.socialAccountId, accountId));
		await tx
			.update(adAccounts)
			.set({ status: "disconnected", updatedAt: now })
			.where(eq(adAccounts.socialAccountId, accountId));

		return onDisconnected?.(tx, account);
	});
}
