import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

export const rateLimitMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const orgId = c.get("orgId");
	const plan = c.get("plan");

	const limiter =
		plan === "pro" ? c.env.PRO_RATE_LIMITER : c.env.FREE_RATE_LIMITER;
	const keyLimiter =
		plan === "pro"
			? c.env.PRO_KEY_BURST_LIMITER
			: c.env.FREE_KEY_BURST_LIMITER;

	// This binding is an approximate edge shield. PostgreSQL remains canonical
	// for billable/tool quotas, and every API key in an organization shares the
	// same request-rate budget.
	const [organizationResult, keyResult] = await Promise.all([
		limiter.limit({ key: orgId }),
		keyLimiter.limit({ key: c.get("keyId") }),
	]);

	if (!organizationResult.success || !keyResult.success) {
		// Workers Rate Limit bindings expose only the fixed window, not an exact
		// reset timestamp. A conservative full-window hint prevents hot retries.
		c.header("Retry-After", "60");
		return c.json(
			{
				error: {
					code: "RATE_LIMITED",
					message: "Rate limit exceeded. Please try again shortly.",
				},
			},
			429,
		);
	}

	await next();
});
