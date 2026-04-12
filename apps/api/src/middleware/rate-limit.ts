import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

export const rateLimitMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const keyId = c.get("keyId");
	const plan = c.get("plan");

	const limiter =
		plan === "pro" ? c.env.PRO_RATE_LIMITER : c.env.FREE_RATE_LIMITER;

	const { success } = await limiter.limit({ key: keyId });

	if (!success) {
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
