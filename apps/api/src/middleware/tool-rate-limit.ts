import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

/**
 * Per-org daily rate limit for tool endpoints (downloads, transcripts).
 * Uses KV counters with 48h TTL for automatic cleanup.
 * Limit is configurable per org via `daily_tool_limit` on the subscription.
 */
export const toolRateLimitMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const orgId = c.get("orgId");
	const limit = c.get("dailyToolLimit");

	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
	const key = `tool-usage:${orgId}:${today}`;

	// Increment BEFORE checking to minimize race condition window.
	// Note: KV is not atomic — concurrent requests may still undercount slightly,
	// but this is acceptable for a low-volume daily quota (2-10/day).
	const current = parseInt((await c.env.KV.get(key)) ?? "0", 10);
	const newCount = current + 1;
	await c.env.KV.put(key, String(newCount), { expirationTtl: 172800 });

	if (newCount > limit) {
		return c.json(
			{
				error: {
					code: "DAILY_TOOL_LIMIT",
					message: `Daily tool limit reached (${limit}/day). Upgrade your plan or contact support for higher limits.`,
				},
			},
			429,
		);
	}

	await next();
});
