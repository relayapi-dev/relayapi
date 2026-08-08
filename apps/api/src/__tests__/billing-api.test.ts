import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type Stripe from "stripe";
import {
	STRIPE_MANAGED_BY_KEY,
	STRIPE_MANAGED_BY_VALUE,
	STRIPE_SUBSCRIPTION_ROLE_KEY,
	STRIPE_SUBSCRIPTION_ROLES,
} from "../config/billing";
import billing from "../routes/billing";
import {
	findCanonicalStripeSubscription,
	hasBlockingStripeSubscription,
	mapStripeSubscriptionStatus,
	resolveCanonicalStripeSubscription,
} from "../services/stripe-subscriptions";
import type { Env, Variables } from "../types";
import { createMockEnv } from "./__mocks__/env";

function subscription(
	id: string,
	status: Stripe.Subscription.Status,
): Stripe.Subscription {
	return {
		id,
		status,
		metadata: {
			[STRIPE_MANAGED_BY_KEY]: STRIPE_MANAGED_BY_VALUE,
			[STRIPE_SUBSCRIPTION_ROLE_KEY]: STRIPE_SUBSCRIPTION_ROLES.base,
		},
	} as unknown as Stripe.Subscription;
}

function createBillingApp(options?: {
	permissions?: string[];
	db?: Variables["db"];
}) {
	const app = new Hono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("orgId", "org_test");
		c.set("principalType", "service");
		c.set(
			"permissions",
			options?.permissions ?? [
				"read",
				"write",
				"view_billing",
				"manage_billing",
			],
		);
		c.set("workspaceScope", "all");
		c.set("db", options?.db ?? ({} as Variables["db"]));
		await next();
	});
	app.route("/v1/billing", billing);
	return app;
}

describe("API-owned billing", () => {
	it("preserves the self-hosted community status and disables Stripe mutations", async () => {
		const { env } = createMockEnv();
		env.DEPLOYMENT_MODE = "self_hosted";
		const app = createBillingApp();

		const statusResponse = await app.request("/v1/billing", {}, env);
		expect(statusResponse.status).toBe(200);
		expect((await statusResponse.json()) as unknown).toEqual({
			subscription: {
				status: "active",
				cancel_at_period_end: false,
				current_period_end: null,
				has_stripe_customer: false,
				has_stripe_subscription: false,
				community: true,
			},
			invoices: [],
		});

		const checkoutResponse = await app.request(
			"/v1/billing/checkout",
			{ method: "POST" },
			env,
		);
		expect(checkoutResponse.status).toBe(404);
		expect(
			((await checkoutResponse.json()) as { error: { code: string } }).error
				.code,
		).toBe("BILLING_DISABLED");
	});

	it("returns an empty hosted status without creating billing state", async () => {
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [],
					}),
				}),
			}),
		} as unknown as Variables["db"];
		const { env } = createMockEnv();
		const response = await createBillingApp({ db }).request(
			"/v1/billing",
			{},
			env,
		);
		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toEqual({
			subscription: null,
			invoices: [],
		});
	});

	it("sync reports a complimentary Pro grant without requiring Stripe identity", async () => {
		const db = {
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () => [
							{
								status: "active",
								source: "complimentary",
								stripeCustomerId: null,
								stripeSubscriptionId: null,
								trialEndsAt: null,
								delinquentAt: null,
								graceEndsAt: null,
								currentPeriodStart: null,
								currentPeriodEnd: null,
							},
						],
					}),
				}),
			}),
		} as unknown as Variables["db"];
		const { env } = createMockEnv();
		const response = await createBillingApp({ db }).request(
			"/v1/billing/sync",
			{ method: "POST" },
			env,
		);

		expect(response.status).toBe(200);
		expect((await response.json()) as unknown).toEqual({ plan: "pro" });
	});

	it("requires explicit organization-administration authority for mutations", async () => {
		const { env } = createMockEnv();
		const response = await createBillingApp({
			permissions: ["read", "write"],
		}).request("/v1/billing/portal", { method: "POST" }, env);
		expect(response.status).toBe(403);
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe("MANAGE_BILLING_REQUIRED");
	});

	it("uses one canonical Stripe-to-local status mapping", () => {
		expect(mapStripeSubscriptionStatus("active")).toBe("active");
		expect(mapStripeSubscriptionStatus("trialing")).toBe("trialing");
		expect(mapStripeSubscriptionStatus("past_due")).toBe("past_due");
		expect(mapStripeSubscriptionStatus("unpaid")).toBe("past_due");
		expect(mapStripeSubscriptionStatus("incomplete")).toBe("cancelled");
		expect(mapStripeSubscriptionStatus("canceled")).toBe("cancelled");
	});

	it("selects the best subscription across every customer page", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const stripe = {
			subscriptions: {
				list: async (query: Record<string, unknown>) => {
					calls.push(query);
					return calls.length === 1
						? {
								data: [
									subscription("sub_past_due", "past_due"),
									subscription("sub_trial", "trialing"),
								],
								has_more: true,
							}
						: {
								data: [subscription("sub_active", "active")],
								has_more: false,
							};
				},
			},
		} as unknown as Stripe;

		expect((await findCanonicalStripeSubscription(stripe, "cus_1"))?.id).toBe(
			"sub_active",
		);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.starting_after).toBe("sub_trial");
	});

	it("recovers a deleted recorded ID by scanning the customer", async () => {
		const stripe = {
			subscriptions: {
				retrieve: async () => {
					throw { statusCode: 404 };
				},
				list: async () => ({
					data: [subscription("sub_recovered", "trialing")],
					has_more: false,
				}),
			},
		} as unknown as Stripe;

		expect(
			(await resolveCanonicalStripeSubscription(stripe, "cus_1", "sub_deleted"))
				?.id,
		).toBe("sub_recovered");
	});

	it("checks all pages before deciding Checkout is safe", async () => {
		let calls = 0;
		const stripe = {
			subscriptions: {
				list: async () => {
					calls += 1;
					return calls === 1
						? {
								data: [subscription("sub_terminal", "canceled")],
								has_more: true,
							}
						: {
								data: [subscription("sub_blocking", "incomplete")],
								has_more: false,
							};
				},
			},
		} as unknown as Stripe;

		expect(await hasBlockingStripeSubscription(stripe, "cus_1")).toBe(true);
		expect(calls).toBe(2);
	});

	it("keeps durable Checkout identity and trusted dashboard return URLs", async () => {
		const repoRoot = new URL("../../../../", import.meta.url).pathname;
		const [route, usage] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/routes/billing.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/middleware/usage-tracking.ts`).text(),
		]);

		expect(route).toContain("idempotencyKey: claimed.idempotencyKey");
		expect(route).toContain("session.expires_at");
		expect(route).not.toContain("expires_at:");
		expect(route).toContain("appPublicOrigin(c.env)");
		expect(route).not.toContain("c.req.url");
		expect(route).toContain("c.env.STRIPE_PRO_PRICE_ID");
		expect(route).toContain("requireManageBillingMiddleware");
		expect(route).toContain("invalidateOrganizationApiKeyCache");
		expect(route).toContain('existing.source !== "stripe" || !customerId');
		expect(usage).toContain('c.req.path.startsWith("/v1/billing/")');
	});
});
