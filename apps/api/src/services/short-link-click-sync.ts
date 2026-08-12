import { createDb, shortLinks } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import {
	exponentialBackoffSeconds,
	type ProviderReadErrorClass,
	SHORT_LINK_POLL,
} from "../lib/async-policy";
import type { Env } from "../types";
import { resolveExternalShortLinkProvider } from "./short-link-configuration";
import {
	analyticsTargetForShortLink,
	type ExternalShortLinkProviderType,
} from "./short-link-lifecycle";

/**
 * Sync click counts for recently-created short links.
 * Runs on the 5-minute cron. PostgreSQL owns due time and the fenced claim;
 * external providers are processed in equal per-tenant slices.
 */
export async function syncShortLinkClicks(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const leaseExpiresAt = new Date(
		now.getTime() + SHORT_LINK_POLL.leaseSeconds * 1000,
	);
	const claimed = await db
		.update(shortLinks)
		.set({
			clickSyncGeneration: sql`${shortLinks.clickSyncGeneration} + 1`,
			clickSyncLeaseExpiresAt: leaseExpiresAt,
			clickSyncStartedAt: now,
			clickSyncAttempts: sql`${shortLinks.clickSyncAttempts} + 1`,
		})
		.where(
			sql`${shortLinks.id} IN (
				SELECT ranked.id
				FROM (
					SELECT
						sl.id,
						sl.organization_id,
						sl.next_click_sync_at,
						row_number() OVER (
							PARTITION BY sl.organization_id
							ORDER BY sl.next_click_sync_at, sl.id
						) AS tenant_rank
					FROM short_links sl
					WHERE sl.provider <> 'relayapi'
						AND sl.creation_status = 'active'
						AND sl.short_url IS NOT NULL
						AND sl.credential_version IS NOT NULL
						AND sl.created_at > ${sevenDaysAgo}
						AND sl.next_click_sync_at <= ${now}
						AND sl.click_sync_attempts < ${SHORT_LINK_POLL.maxAutomaticAttempts}
						AND (
							sl.click_sync_lease_expires_at IS NULL
							OR sl.click_sync_lease_expires_at <= ${now}
						)
				) ranked
				WHERE ranked.tenant_rank <= ${SHORT_LINK_POLL.maxClaimsPerTenant}
				ORDER BY
					ranked.tenant_rank,
					ranked.next_click_sync_at,
					ranked.organization_id,
					ranked.id
				LIMIT ${SHORT_LINK_POLL.maxClaimsPerRun}
			)`,
		)
		.returning();
	if (claimed.length === 0) return;

	const groups = new Map<
		string,
		{
			organizationId: string;
			provider: ExternalShortLinkProviderType;
			credentialVersion: number;
			links: Array<typeof shortLinks.$inferSelect>;
		}
	>();

	for (const link of claimed) {
		if (
			link.provider === "relayapi" ||
			link.credentialVersion === null ||
			!analyticsTargetForShortLink(link)
		) {
			await finishShortLinkFailure(
				db,
				link,
				now,
				new Error("Short-link historical provider identity is incomplete"),
				"permanent",
			);
			continue;
		}
		const provider = link.provider as ExternalShortLinkProviderType;
		const key = `${link.organizationId}:${provider}:${link.credentialVersion}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				organizationId: link.organizationId,
				provider,
				credentialVersion: link.credentialVersion,
				links: [],
			};
			groups.set(key, group);
		}
		group.links.push(link);
	}

	for (const [
		,
		{ organizationId, provider: providerType, credentialVersion, links },
	] of groups) {
		try {
			const resolved = await resolveExternalShortLinkProvider({
				db,
				organizationId,
				provider: providerType,
				credentialVersion,
				encryptionKey: env.ENCRYPTION_KEY,
			});
			if (!resolved) {
				throw new PermanentShortLinkPollError(
					"Historical short-link credential could not be resolved",
				);
			}

			const targets = links.flatMap((link) => {
				const target = analyticsTargetForShortLink(link);
				return target ? [target] : [];
			});
			const counts = await resolved.provider.getClickCounts(
				resolved.apiKey,
				targets,
			);
			const succeeded = links.flatMap((link) => {
				const count = counts.get(link.id);
				return count === undefined ? [] : [{ link, count }];
			});
			if (succeeded.length > 0) {
				const valuesList = sql.join(
					succeeded.map(
						({ link, count }) =>
							sql`(${link.id}::text, ${link.clickSyncGeneration}::int, ${count}::int)`,
					),
					sql`, `,
				);
				const nextPollAt = new Date(
					now.getTime() + SHORT_LINK_POLL.successIntervalSeconds * 1000,
				);
				await db.execute(sql`
					UPDATE short_links AS s
					SET click_count = v.count,
						last_click_sync_at = ${now},
						next_click_sync_at = ${nextPollAt},
						click_sync_lease_expires_at = NULL,
						click_sync_started_at = NULL,
						click_sync_attempts = 0,
						click_sync_last_error = NULL,
						click_sync_last_error_class = NULL
					FROM (VALUES ${valuesList}) AS v(id, generation, count)
					WHERE s.id = v.id
						AND s.organization_id = ${organizationId}
						AND s.click_sync_generation = v.generation
						AND s.click_sync_started_at = ${now}
				`);
			}
			const missing = links.filter((link) => !counts.has(link.id));
			await Promise.allSettled(
				missing.map((link) =>
					finishShortLinkFailure(
						db,
						link,
						now,
						new Error("Provider returned no click count for the claimed link"),
						"transient",
					),
				),
			);
		} catch (error) {
			const errorClass =
				error instanceof PermanentShortLinkPollError
					? "permanent"
					: "transient";
			await Promise.allSettled(
				links.map((link) =>
					finishShortLinkFailure(db, link, now, error, errorClass),
				),
			);
		}
	}
}

class PermanentShortLinkPollError extends Error {}

async function finishShortLinkFailure(
	db: ReturnType<typeof createDb>,
	link: typeof shortLinks.$inferSelect,
	claimStartedAt: Date,
	error: unknown,
	errorClass: ProviderReadErrorClass,
): Promise<void> {
	const failedAt = new Date();
	const delaySeconds = exponentialBackoffSeconds(
		link.clickSyncAttempts,
		SHORT_LINK_POLL.retry,
		`${link.id}:${link.clickSyncAttempts}`,
	);
	const message = error instanceof Error ? error.message : String(error);
	const budgetExhausted =
		link.clickSyncAttempts >= SHORT_LINK_POLL.maxAutomaticAttempts;
	await db
		.update(shortLinks)
		.set({
			nextClickSyncAt: new Date(
				failedAt.getTime() +
					(errorClass === "permanent" ? 24 * 60 * 60 : delaySeconds) * 1000,
			),
			clickSyncLeaseExpiresAt: null,
			clickSyncStartedAt: null,
			clickSyncLastError: (budgetExhausted
				? `Automatic click poll attempt budget reached; polling is suspended until the provider configuration changes or a live refresh succeeds. ${message}`
				: message
			).slice(0, 1000),
			clickSyncLastErrorClass: errorClass,
		})
		.where(
			and(
				eq(shortLinks.id, link.id),
				eq(shortLinks.organizationId, link.organizationId),
				eq(shortLinks.clickSyncGeneration, link.clickSyncGeneration),
				eq(shortLinks.clickSyncStartedAt, claimStartedAt),
			),
		);
}
