// ---------------------------------------------------------------------------
// Ad Audience Service — manage custom audiences and user uploads
// ---------------------------------------------------------------------------

import {
	adAccounts,
	adAudiences,
	adAudienceUsers,
	createDb,
	eq,
	socialAccounts,
} from "@relayapi/db";
import { and, sql } from "drizzle-orm";
import { normalizeContactPhone } from "../lib/contact-phone";
import type { Env } from "../types";
import { resolveAdsAccessToken } from "./ad-access-token";
import { getAdPlatformAdapter } from "./ad-platforms";
import { AdPlatformError } from "./ad-platforms/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function getAdAccountWithToken(
	db: ReturnType<typeof createDb>,
	adAccountId: string,
	orgId: string,
	env: Env,
) {
	const [result] = await db
		.select({
			adAccount: adAccounts,
			socialAccount: socialAccounts,
		})
		.from(adAccounts)
		.innerJoin(
			socialAccounts,
			and(
				eq(adAccounts.socialAccountId, socialAccounts.id),
				eq(socialAccounts.organizationId, orgId),
			),
		)
		.where(
			and(eq(adAccounts.id, adAccountId), eq(adAccounts.organizationId, orgId)),
		)
		.limit(1);

	if (!result) return null;

	const accessToken = await resolveAdsAccessToken(result.socialAccount, env);

	return { ...result, accessToken };
}

// ---------------------------------------------------------------------------
// Discover audiences
// ---------------------------------------------------------------------------

/**
 * Import existing custom audiences from the platform into the local
 * `ad_audiences` table for an ad account. Mirrors `discoverAdAccounts` in
 * `ad-service.ts`: fetch from the platform adapter, then upsert. Without this
 * the list endpoint only ever shows audiences created through RelayAPI.
 */
export async function discoverAudiences(
	env: Env,
	orgId: string,
	adAccountId: string,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const ctx = await getAdAccountWithToken(db, adAccountId, orgId, env);
	if (!ctx) {
		throw new AdPlatformError("NOT_FOUND", "Ad account not found");
	}

	const adapter = getAdPlatformAdapter(ctx.adAccount.platform);
	if (!adapter) {
		throw new AdPlatformError(
			"UNSUPPORTED_PLATFORM",
			`No adapter for ad platform "${ctx.adAccount.platform}"`,
		);
	}

	// Pass the platform-side ad account id (e.g. Meta "act_…"), but store rows
	// under the internal adAccountId so the list query matches.
	const platformAudiences = await adapter.listAudiences(
		ctx.accessToken,
		ctx.adAccount.platformAdAccountId,
	);

	if (platformAudiences.length === 0) return;

	const CHUNK = 100;
	for (let i = 0; i < platformAudiences.length; i += CHUNK) {
		const chunk = platformAudiences.slice(i, i + CHUNK);
		await db
			.insert(adAudiences)
			.values(
				chunk.map((pa) => ({
					organizationId: orgId,
					workspaceId: ctx.adAccount.workspaceId,
					adAccountId,
					platform: ctx.adAccount.platform,
					platformAudienceId: pa.id,
					name: pa.name,
					type: pa.type,
					description: pa.description ?? null,
					size: pa.size ?? null,
					status: pa.status ?? "ready",
				})),
			)
			.onConflictDoUpdate({
				target: [adAudiences.adAccountId, adAudiences.platformAudienceId],
				set: {
					name: sql`excluded.name`,
					description: sql`excluded.description`,
					size: sql`excluded.size`,
					status: sql`excluded.status`,
					updatedAt: new Date(),
				},
			});
	}
}

// ---------------------------------------------------------------------------
// Create audience
// ---------------------------------------------------------------------------

export async function createAudience(
	env: Env,
	orgId: string,
	params: {
		adAccountId: string;
		name: string;
		type: "customer_list" | "website" | "lookalike";
		description?: string;
		pixelId?: string;
		retentionDays?: number;
		rule?: Record<string, unknown>;
		sourceAudienceId?: string;
		country?: string;
		ratio?: number;
		customerFileSource?: string;
	},
) {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const ctx = await getAdAccountWithToken(db, params.adAccountId, orgId, env);
	if (!ctx) throw new AdPlatformError("NOT_FOUND", "Ad account not found");

	const adapter = getAdPlatformAdapter(ctx.adAccount.platform);
	if (!adapter) throw new AdPlatformError("UNSUPPORTED_PLATFORM", "No adapter");

	// Resolve source audience's platform ID for lookalike
	let platformSourceAudienceId: string | undefined;
	if (params.type === "lookalike" && params.sourceAudienceId) {
		const [source] = await db
			.select()
			.from(adAudiences)
			.where(
				and(
					eq(adAudiences.id, params.sourceAudienceId),
					eq(adAudiences.organizationId, orgId),
				),
			)
			.limit(1);

		if (!source?.platformAudienceId) {
			throw new AdPlatformError(
				"INVALID_SOURCE",
				"Source audience not found or has no platform ID",
			);
		}
		if (source.adAccountId !== params.adAccountId) {
			throw new AdPlatformError(
				"INVALID_SOURCE",
				"Source audience does not belong to the selected ad account",
			);
		}
		platformSourceAudienceId = source.platformAudienceId;
	}

	const result = await adapter.createCustomAudience(
		ctx.accessToken,
		ctx.adAccount.platformAdAccountId,
		{
			name: params.name,
			type: params.type,
			description: params.description,
			pixelId: params.pixelId,
			retentionDays: params.retentionDays,
			rule: params.rule,
			sourceAudienceId: platformSourceAudienceId,
			country: params.country,
			ratio: params.ratio,
			customerFileSource: params.customerFileSource,
		},
	);

	const [audience] = await db
		.insert(adAudiences)
		.values({
			organizationId: orgId,
			workspaceId: ctx.adAccount.workspaceId,
			adAccountId: params.adAccountId,
			platform: ctx.adAccount.platform,
			platformAudienceId: result.platformAudienceId,
			name: params.name,
			type: params.type,
			description: params.description,
			size: result.approximateSize,
			sourceAudienceId: params.sourceAudienceId,
			lookalikeSpec:
				params.type === "lookalike"
					? { country: params.country, ratio: params.ratio }
					: null,
			retargetingRule:
				params.type === "website"
					? {
							pixelId: params.pixelId,
							retentionDays: params.retentionDays,
							rule: params.rule,
						}
					: null,
			status: result.status,
		})
		.returning();

	return audience;
}

// ---------------------------------------------------------------------------
// Upload users to audience
// ---------------------------------------------------------------------------

export interface HashedAudienceUser {
	emailHash?: string;
	phoneHash?: string;
}

/**
 * Preserve SQL NULL for an absent identifier. Empty-string sentinels make the
 * partial unique index treat every email-only (or phone-only) member as the
 * same opposite identifier and silently discard valid audience members.
 */
export function storedAudienceUsers(
	audienceId: string,
	hashedUsers: readonly HashedAudienceUser[],
) {
	return hashedUsers
		.filter((user) => user.emailHash || user.phoneHash)
		.map((user) => ({
			audienceId,
			emailHash: user.emailHash ?? null,
			phoneHash: user.phoneHash ?? null,
		}));
}

export async function addUsersToAudience(
	env: Env,
	orgId: string,
	audienceId: string,
	users: { email?: string; phone?: string }[],
) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [audience] = await db
		.select()
		.from(adAudiences)
		.where(
			and(
				eq(adAudiences.id, audienceId),
				eq(adAudiences.organizationId, orgId),
			),
		)
		.limit(1);

	if (!audience) throw new AdPlatformError("NOT_FOUND", "Audience not found");
	if (audience.type !== "customer_list") {
		throw new AdPlatformError(
			"INVALID_TYPE",
			"Can only add users to customer_list audiences",
		);
	}
	if (!audience.platformAudienceId) {
		throw new AdPlatformError(
			"INVALID_STATE",
			"Audience has no platform ID yet",
		);
	}

	// Hash user data
	const hashedUsers = await Promise.all(
		users.map(async (u) => {
			const phoneCanonical = u.phone
				? normalizeContactPhone(u.phone, { allowBareInternational: true })
				: null;
			return {
				emailHash: u.email
					? await sha256(u.email.trim().toLowerCase())
					: undefined,
				// Meta expects country-code digits before hashing, without the E.164
				// presentation plus. Canonicalize first so formatting variants agree.
				phoneHash: phoneCanonical
					? await sha256(phoneCanonical.slice(1))
					: undefined,
			};
		}),
	);

	// Batch insert into DB (dedup via the per-identifier partial unique indexes).
	const validUsers = storedAudienceUsers(audienceId, hashedUsers);

	let storedCount = 0;
	const CHUNK = 500;
	for (let i = 0; i < validUsers.length; i += CHUNK) {
		const chunk = validUsers.slice(i, i + CHUNK);
		const result = await db
			.insert(adAudienceUsers)
			.values(chunk)
			.onConflictDoNothing()
			.returning({ id: adAudienceUsers.id });
		storedCount += result.length;
	}

	// Upload to platform
	const ctx = await getAdAccountWithToken(db, audience.adAccountId, orgId, env);
	if (!ctx) throw new AdPlatformError("NOT_FOUND", "Ad account not found");

	const adapter = getAdPlatformAdapter(ctx.adAccount.platform);
	if (!adapter) throw new AdPlatformError("UNSUPPORTED_PLATFORM", "No adapter");

	const platformResult = await adapter.addUsersToAudience(
		ctx.accessToken,
		audience.platformAudienceId,
		hashedUsers.filter((u) => u.emailHash || u.phoneHash),
	);

	return {
		added: platformResult.added,
		invalid: platformResult.invalid,
		stored: storedCount,
	};
}

// ---------------------------------------------------------------------------
// Delete audience
// ---------------------------------------------------------------------------

export async function deleteAudience(
	env: Env,
	orgId: string,
	audienceId: string,
) {
	const db = createDb(env.HYPERDRIVE.connectionString);

	const [audience] = await db
		.select()
		.from(adAudiences)
		.where(
			and(
				eq(adAudiences.id, audienceId),
				eq(adAudiences.organizationId, orgId),
			),
		)
		.limit(1);

	if (!audience) throw new AdPlatformError("NOT_FOUND", "Audience not found");

	// Delete from platform
	if (audience.platformAudienceId) {
		const ctx = await getAdAccountWithToken(
			db,
			audience.adAccountId,
			orgId,
			env,
		);
		if (!ctx) {
			throw new AdPlatformError(
				"NOT_FOUND",
				"Ad account credentials are unavailable; provider audience was not deleted",
			);
		}
		const adapter = getAdPlatformAdapter(ctx.adAccount.platform);
		if (!adapter) {
			throw new AdPlatformError(
				"UNSUPPORTED_PLATFORM",
				"Provider audience deletion is unavailable for this platform",
			);
		}
		// Provider deletion is authoritative. Never report local success while
		// the provider may still retain and use the audience.
		await adapter.deleteAudience(
			ctx.accessToken,
			audience.platformAudienceId,
		);
	}

	// Delete from DB (cascades to ad_audience_users)
	await db.delete(adAudiences).where(eq(adAudiences.id, audienceId));
}
