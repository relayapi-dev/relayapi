// ---------------------------------------------------------------------------
// External Post Sync — Per-Platform Rate Limit Config
// ---------------------------------------------------------------------------

export interface PlatformRateLimit {
	/** Max requests per window */
	requestsPerWindow: number;
	/** Window size in seconds */
	windowSec: number;
	/** Posts per request (for budgeting) */
	postsPerRequest: number;
}

export const PLATFORM_RATE_LIMITS: Record<string, PlatformRateLimit> = {
	facebook: { requestsPerWindow: 200, windowSec: 3600, postsPerRequest: 25 },
	instagram: { requestsPerWindow: 200, windowSec: 3600, postsPerRequest: 25 },
	twitter: { requestsPerWindow: 900, windowSec: 900, postsPerRequest: 100 },
	linkedin: { requestsPerWindow: 100, windowSec: 86400, postsPerRequest: 50 },
	youtube: {
		requestsPerWindow: 10000,
		windowSec: 86400,
		postsPerRequest: 50,
	},
	tiktok: { requestsPerWindow: 600, windowSec: 60, postsPerRequest: 20 },
	threads: { requestsPerWindow: 200, windowSec: 3600, postsPerRequest: 25 },
	pinterest: { requestsPerWindow: 1000, windowSec: 3600, postsPerRequest: 25 },
};

/**
 * Parse rate-limit headers from a platform API response.
 * Returns null if no rate limit headers are present.
 *
 * Note: Meta APIs (Facebook, Instagram, Threads) use JSON-valued headers
 * (`x-app-usage`, `x-business-use-case-usage`) rather than plain numeric
 * values, so we must handle both formats.
 */
export function parseRateLimitHeaders(
	headers: Headers,
): { remaining: number; resetAt: Date } | null {
	// Standard numeric headers (Twitter, LinkedIn, etc.)
	const remaining =
		headers.get("x-ratelimit-remaining") ??
		headers.get("x-rate-limit-remaining");
	const reset =
		headers.get("x-ratelimit-reset") ??
		headers.get("x-rate-limit-reset");

	// Meta JSON headers (Facebook, Instagram, Threads)
	const appUsage = headers.get("x-app-usage");
	const bizUsage = headers.get("x-business-use-case-usage");

	// Try standard numeric headers first
	if (remaining != null || reset != null) {
		const remainingNum = remaining ? Number.parseInt(remaining, 10) : 0;

		let resetAt: Date;
		if (reset) {
			const resetNum = Number.parseInt(reset, 10);
			if (Number.isNaN(resetNum)) {
				resetAt = new Date(Date.now() + 900_000);
			} else {
				// If < 1e10, it's a relative seconds value; otherwise epoch seconds
				resetAt =
					resetNum < 1e10
						? new Date(Date.now() + resetNum * 1000)
						: new Date(resetNum * 1000);
			}
		} else {
			resetAt = new Date(Date.now() + 900_000);
		}

		return {
			remaining: Number.isNaN(remainingNum) ? 0 : remainingNum,
			resetAt,
		};
	}

	// Parse Meta x-app-usage JSON: {"call_count":N, "total_cputime":N, "total_time":N}
	if (appUsage) {
		try {
			const usage = JSON.parse(appUsage);
			const callCount = typeof usage.call_count === "number" ? usage.call_count : 0;
			// Meta usage is percentage-based (0-100), estimate remaining as inverse
			const estimatedRemaining = Math.max(0, 100 - callCount);
			return {
				remaining: estimatedRemaining,
				// If usage > 80%, back off for 15 minutes; otherwise no imminent limit
				resetAt: new Date(Date.now() + (callCount > 80 ? 900_000 : 3600_000)),
			};
		} catch {
			// Malformed JSON — ignore
		}
	}

	// Parse Meta x-business-use-case-usage JSON
	if (bizUsage) {
		try {
			const parsed = JSON.parse(bizUsage);
			if (!parsed || typeof parsed !== "object") return null;
			// Structure: { "<biz_id>": [{ "call_count": N, "estimated_time_to_regain_access": N, ... }] }
			const usageByBusiness = parsed as Record<string, unknown>;
			const [firstKey] = Object.keys(usageByBusiness);
			if (!firstKey) return null;

			const firstValue = usageByBusiness[firstKey];
			const entry = Array.isArray(firstValue) ? firstValue[0] : firstValue;
			if (entry && typeof entry === "object") {
				const usageEntry = entry as {
					call_count?: unknown;
					estimated_time_to_regain_access?: unknown;
				};
				const callCount = typeof usageEntry.call_count === "number"
					? usageEntry.call_count
					: 0;
				const regainMin = typeof usageEntry.estimated_time_to_regain_access === "number"
					? usageEntry.estimated_time_to_regain_access
					: 0;
				return {
					remaining: Math.max(0, 100 - callCount),
					resetAt: regainMin > 0
						? new Date(Date.now() + regainMin * 60_000)
						: new Date(Date.now() + 3600_000),
				};
			}
		} catch {
			// Malformed JSON — ignore
		}
	}

	return null;
}
