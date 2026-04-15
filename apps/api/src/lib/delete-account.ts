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
