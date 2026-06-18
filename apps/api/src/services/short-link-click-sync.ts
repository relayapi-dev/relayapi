import {
	createDb,
	shortLinkConfigs,
	shortLinks,
} from "@relayapi/db";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { maybeDecrypt } from "../lib/crypto";
import { getProvider } from "./short-link-providers";
import type { Env } from "../types";

/**
 * Sync click counts for recently-created short links.
 * Runs on the 5-minute cron. Fetches counts from the provider API in batches per org.
 */
export async function syncShortLinkClicks(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

	// Find short links created in the last 7 days that haven't been synced in the last hour
	const linksToSync = await db
		.select({
			link: shortLinks,
			config: shortLinkConfigs,
		})
		.from(shortLinks)
		.innerJoin(
			shortLinkConfigs,
			eq(shortLinks.organizationId, shortLinkConfigs.organizationId),
		)
		.where(
			and(
				gt(shortLinks.createdAt, sevenDaysAgo),
				or(
					isNull(shortLinks.lastClickSyncAt),
					lt(shortLinks.lastClickSyncAt, oneHourAgo),
				),
			),
		)
		.limit(200);

	if (linksToSync.length === 0) return;

	// Group by org to batch API calls and avoid redundant config decryption
	const byOrg = new Map<
		string,
		{
			config: typeof shortLinkConfigs.$inferSelect;
			links: Array<typeof shortLinks.$inferSelect>;
		}
	>();

	for (const row of linksToSync) {
		const orgId = row.link.organizationId;
		let group = byOrg.get(orgId);
		if (!group) {
			group = { config: row.config, links: [] };
			byOrg.set(orgId, group);
		}
		group.links.push(row.link);
	}

	for (const [, { config, links }] of byOrg) {
		if (!config.provider) continue;

		// Built-in (relayapi) links are counted directly in short_links.click_count
		// by the redirect handler's atomic SQL increment — that column IS the
		// source of truth. The provider's KV counter is no longer written, so
		// syncing it here would overwrite real click counts back to 0. Only
		// external providers (dub/short_io/bitly) keep their counts off-platform
		// and need to be pulled.
		if (config.provider === "relayapi") continue;

		try {
			if (!config.apiKey) continue;
			const provider = getProvider(
				config.provider as "dub" | "short_io" | "bitly",
			);
			const decrypted = await maybeDecrypt(config.apiKey, env.ENCRYPTION_KEY);
			if (!decrypted) continue;
			const apiKey = decrypted;
			if (!provider) continue;

			const shortUrls = links.map((l) => l.shortUrl);
			const counts = await provider.getClickCounts(apiKey, shortUrls);

			const now = new Date();
			// One batched UPDATE ... FROM (VALUES) per org instead of up to 200
			// per-row UPDATEs (which the pool's max:5 throttles into ~40 sequential
			// waves). Each row carries its own new count.
			const rows = links.map((link) => ({
				id: link.id,
				count: counts.get(link.shortUrl) ?? link.clickCount,
			}));
			if (rows.length === 0) continue;
			const valuesList = sql.join(
				rows.map((r) => sql`(${r.id}::text, ${r.count}::int)`),
				sql`, `,
			);
			await db.execute(sql`
				UPDATE short_links AS s
				SET click_count = v.count, last_click_sync_at = ${now}
				FROM (VALUES ${valuesList}) AS v(id, count)
				WHERE s.id = v.id
			`);
		} catch {
			// Per-org failure should not block other orgs
		}
	}
}
