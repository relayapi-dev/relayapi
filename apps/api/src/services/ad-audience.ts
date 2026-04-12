// ---------------------------------------------------------------------------
// Ad Audience Service — manage custom audiences and user uploads
// ---------------------------------------------------------------------------

import {
	createDb,
	adAudiences,
	adAudienceUsers,
	adAccounts,
	socialAccounts,
	eq,
} from "@relayapi/db";
import { and } from "drizzle-orm";
import type { Env } from "../types";
import { getAdPlatformAdapter } from "./ad-platforms";
import { resolveAdsAccessToken } from "./ad-access-token";
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
			eq(adAccounts.socialAccountId, socialAccounts.id),
		)
		.where(
			and(
				eq(adAccounts.id, adAccountId),
				eq(adAccounts.organizationId, orgId),
			),
		)
		.limit(1);

	if (!result) return null;

	const accessToken = await resolveAdsAccessToken(result.socialAccount, env);

	return { ...result, accessToken };
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
		users.map(async (u) => ({
			emailHash: u.email
				? await sha256(u.email.trim().toLowerCase())
				: undefined,
			phoneHash: u.phone
				? await sha256(u.phone.replace(/\D/g, ""))
				: undefined,
		})),
	);

	// Batch insert into DB (dedup via unique index)
	// Use empty string instead of NULL so the unique index deduplicates correctly
	// (PostgreSQL treats NULLs as distinct in unique indexes)
	const validUsers = hashedUsers
		.filter((hu) => hu.emailHash || hu.phoneHash)
		.map((hu) => ({
			audienceId,
			emailHash: hu.emailHash ?? "",
			phoneHash: hu.phoneHash ?? "",
		}));

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
	const ctx = await getAdAccountWithToken(
		db,
		audience.adAccountId,
		orgId,
		env,
	);
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
		if (ctx) {
			const adapter = getAdPlatformAdapter(ctx.adAccount.platform);
			if (adapter) {
				try {
					await adapter.deleteAudience(
						ctx.accessToken,
						audience.platformAudienceId,
					);
				} catch {
					// Best effort
				}
			}
		}
	}

	// Delete from DB (cascades to ad_audience_users)
	await db.delete(adAudiences).where(eq(adAudiences.id, audienceId));
}
