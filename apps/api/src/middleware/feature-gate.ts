import { createMiddleware } from "hono/factory";
import type { Env, Variables } from "../types";

export const proOnlyMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (c.get("plan") === "free") {
		return c.json(
			{
				error: {
					code: "PLAN_UPGRADE_REQUIRED",
					message:
						"This feature requires a Pro plan. Upgrade to access analytics, inbox, and more.",
				},
			},
			403,
		);
	}
	return next();
});

export const aiEnabledMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (!c.get("aiEnabled")) {
		return c.json(
			{
				error: {
					code: "AI_NOT_ENABLED",
					message:
						"AI features are not enabled for your organization. Contact your administrator to enable the AI add-on.",
				},
			},
			403,
		);
	}
	return next();
});
