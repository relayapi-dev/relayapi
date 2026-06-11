import {
	adAccounts,
	adAudiences,
	adCampaigns,
	adSyncLogs,
	ads,
	type Database,
	postTargets,
	socialAccounts,
} from "@relayapi/db";
import { eq, inArray } from "drizzle-orm";

/**
 * Identity of a social account needed to compute its KV cache keys. Pull these
 * fields from the account row before it is deleted from the database.
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

export async function deleteConnectedAccountGraph(
	db: Database,
	accountId: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		const adAccountRows = await tx
			.select({ id: adAccounts.id })
			.from(adAccounts)
			.where(eq(adAccounts.socialAccountId, accountId));

		const adAccountIds = adAccountRows.map((row) => row.id);

		console.log(`[accounts] Deleting account ${accountId}: removing post_targets...`);
		await tx.delete(postTargets).where(eq(postTargets.socialAccountId, accountId));

		if (adAccountIds.length > 0) {
			console.log(`[accounts] Deleting account ${accountId}: removing ad_sync_logs...`);
			await tx.delete(adSyncLogs).where(inArray(adSyncLogs.adAccountId, adAccountIds));
			console.log(`[accounts] Deleting account ${accountId}: removing ads...`);
			await tx.delete(ads).where(inArray(ads.adAccountId, adAccountIds));
			console.log(`[accounts] Deleting account ${accountId}: removing ad_campaigns...`);
			await tx
				.delete(adCampaigns)
				.where(inArray(adCampaigns.adAccountId, adAccountIds));
			console.log(`[accounts] Deleting account ${accountId}: removing ad_audiences...`);
			await tx
				.delete(adAudiences)
				.where(inArray(adAudiences.adAccountId, adAccountIds));
			console.log(`[accounts] Deleting account ${accountId}: removing ad_accounts...`);
			await tx.delete(adAccounts).where(inArray(adAccounts.id, adAccountIds));
		}

		console.log(`[accounts] Deleting account ${accountId}: removing social_accounts...`);
		await tx.delete(socialAccounts).where(eq(socialAccounts.id, accountId));
	});
}
