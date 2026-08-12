import { getBillingPolicy, PRICING } from "@relayapi/config";
import { organizationSubscriptions } from "@relayapi/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { isSelfHosted } from "../lib/deployment-mode";
import type { Env, Variables } from "../types";

type FeatureGateContext = Context<{
	Bindings: Env;
	Variables: Variables;
}>;

/**
 * KV is an authentication projection, not entitlement authority. An auth-cache
 * fill that started before an administrative mutation can finish after the
 * mutation's best-effort delete and resurrect stale plan/AI values. Resolve
 * hosted feature gates from PostgreSQL once per gated request; the second gate
 * on AI routes reuses the same in-request decision.
 */
export async function refreshFeatureEntitlements(
	c: FeatureGateContext,
): Promise<void> {
	if (c.get("featureEntitlementsVerified")) return;
	if (isSelfHosted(c.env)) {
		c.set("featureEntitlementsVerified", true);
		return;
	}

	const [subscription] = await c
		.get("db")
		.select({
			status: organizationSubscriptions.status,
			source: organizationSubscriptions.source,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			trialEndsAt: organizationSubscriptions.trialEndsAt,
			delinquentAt: organizationSubscriptions.delinquentAt,
			graceEndsAt: organizationSubscriptions.graceEndsAt,
			currentPeriodStart: organizationSubscriptions.currentPeriodStart,
			currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
			aiEnabled: organizationSubscriptions.aiEnabled,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, c.get("orgId")))
		.limit(1);
	const billing = getBillingPolicy(subscription ?? { status: null });
	const plan = billing.entitlement;
	const billingSource =
		plan === "free" ? "free" : (subscription?.source ?? "stripe");
	const aiEnabled = subscription?.aiEnabled ?? false;
	const freeUsageAuthorityWasStale =
		plan === "free" &&
		(c.get("quotaMode") !== "hard" ||
			c.get("callsIncluded") !== PRICING.freeCallsIncluded ||
			c.get("billingPeriodId") !== null ||
			c.get("periodStart") != null ||
			c.get("periodEnd") != null);
	const cacheWasStale =
		plan !== c.get("plan") ||
		billingSource !== c.get("billingSource") ||
		billing.billable !== c.get("billable") ||
		aiEnabled !== c.get("aiEnabled") ||
		freeUsageAuthorityWasStale;

	c.set("plan", plan);
	c.set("billingSource", billingSource);
	c.set("billable", billing.billable);
	if (plan === "free") {
		// A feature gate can be the first request after a time-based downgrade.
		// Never leave the old paid usage authority attached to a Free decision.
		c.set("quotaMode", "hard");
		c.set("callsIncluded", PRICING.freeCallsIncluded);
		c.set("billingPeriodId", null);
		c.set("periodStart", null);
		c.set("periodEnd", null);
	}
	c.set("aiEnabled", aiEnabled);
	c.set("featureEntitlementsVerified", true);
	if (cacheWasStale) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${c.get("keyHash")}`));
	}
}

export const proOnlyMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	await refreshFeatureEntitlements(c);
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
	await refreshFeatureEntitlements(c);
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
