import type { Database } from "@relayapi/db";
import { postRecyclingConfigs, postTargets } from "@relayapi/db";
import { and, count, eq, ne } from "drizzle-orm";

export interface RecyclingValidationResult {
	valid: boolean;
	error?: { code: string; message: string };
	warnings?: string[];
}

export async function validateRecyclingConfig(
	db: Database,
	orgId: string,
	postId: string,
	postStatus: string,
	input: {
		expire_count?: number;
		expire_date?: string;
		content_variations?: string[];
	},
	existingConfigId?: string,
): Promise<RecyclingValidationResult> {
	const warnings: string[] = [];

	// 1. Post status must be published or scheduled
	if (!["published", "scheduled"].includes(postStatus)) {
		return {
			valid: false,
			error: {
				code: "INVALID_POST_STATUS",
				message:
					"Only published or scheduled posts can have recycling configured.",
			},
		};
	}

	// 2. Reject if any target is youtube or tiktok
	const targets = await db
		.select({ platform: postTargets.platform })
		.from(postTargets)
		.where(eq(postTargets.postId, postId));

	const platforms = targets.map((t) => t.platform);
	if (platforms.includes("youtube") || platforms.includes("tiktok")) {
		return {
			valid: false,
			error: {
				code: "PLATFORM_NOT_SUPPORTED_FOR_RECYCLING",
				message:
					"YouTube and TikTok reject duplicate content. Remove these targets before enabling recycling.",
			},
		};
	}

	// 3. At least one expiration must be set
	if (!input.expire_count && !input.expire_date) {
		return {
			valid: false,
			error: {
				code: "EXPIRATION_REQUIRED",
				message:
					"At least one of expire_count or expire_date must be set to prevent runaway recycling.",
			},
		};
	}

	// 4. Max 10 active configs per org
	const conditions = [
		eq(postRecyclingConfigs.organizationId, orgId),
		eq(postRecyclingConfigs.enabled, true),
	];
	if (existingConfigId) {
		conditions.push(ne(postRecyclingConfigs.id, existingConfigId));
	}

	const countResult = await db
		.select({ value: count() })
		.from(postRecyclingConfigs)
		.where(and(...conditions));
	const activeCount = countResult[0]?.value ?? 0;

	if (activeCount >= 10) {
		return {
			valid: false,
			error: {
				code: "MAX_RECYCLING_LIMIT_REACHED",
				message:
					"Maximum of 10 active recycling configurations per organization.",
			},
		};
	}

	// 5. Warn if twitter/pinterest without variations
	if (
		(platforms.includes("twitter") || platforms.includes("pinterest")) &&
		(!input.content_variations || input.content_variations.length === 0)
	) {
		warnings.push(
			"Twitter and Pinterest may flag duplicate content. Consider adding content_variations.",
		);
	}

	return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

export function computeNextRecycleAt(
	from: Date,
	gap: number,
	gapFreq: "day" | "week" | "month",
): Date {
	const next = new Date(from);
	switch (gapFreq) {
		case "day":
			next.setUTCDate(next.getUTCDate() + gap);
			break;
		case "week":
			next.setUTCDate(next.getUTCDate() + gap * 7);
			break;
		case "month":
			next.setUTCMonth(next.getUTCMonth() + gap);
			break;
	}
	return next;
}
