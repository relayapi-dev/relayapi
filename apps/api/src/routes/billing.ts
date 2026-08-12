import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { getBillingPolicy } from "@relayapi/config";
import {
	apikey,
	generateId,
	organizationSubscriptions,
	subscriptionCheckoutOperations,
	user,
} from "@relayapi/db";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type Stripe from "stripe";
import {
	STRIPE_MANAGED_BY_KEY,
	STRIPE_MANAGED_BY_VALUE,
	STRIPE_SUBSCRIPTION_ROLE_KEY,
	STRIPE_SUBSCRIPTION_ROLES,
} from "../config/billing";
import { mapConcurrently } from "../lib/concurrency";
import { appPublicOrigin, isSelfHosted } from "../lib/deployment-mode";
import {
	requireAllWorkspaceScopeMiddleware,
	requireManageBillingMiddleware,
	requireViewBillingMiddleware,
	requireWriteAccessMiddleware,
} from "../middleware/permissions";
import {
	BillingStatusResponse,
	BillingSyncResponse,
	BillingUrlResponse,
} from "../schemas/billing";
import { ErrorResponse } from "../schemas/common";
import { createStripeClient } from "../services/stripe";
import { reconcileStripeBillingAuthority } from "../services/stripe-billing-authority";
import {
	hasBlockingStripeSubscription,
	isRelayApiBaseSubscription,
} from "../services/stripe-subscriptions";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
const CHECKOUT_LEASE_MS = 2 * 60 * 1_000;
const AUTH_CACHE_PAGE_SIZE = 100;
const AUTH_CACHE_DELETE_CONCURRENCY = 4;

type SubscriptionRow = typeof organizationSubscriptions.$inferSelect;

type BillingSubscriptionView = {
	status: "trialing" | "active" | "past_due" | "cancelled";
	cancel_at_period_end: boolean;
	current_period_end: string | null;
	has_stripe_customer: boolean;
	has_stripe_subscription: boolean;
};

function billingError(code: string, message: string) {
	return { error: { code, message } };
}

const requireHostedBillingMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	if (isSelfHosted(c.env)) {
		return c.json(
			{
				error: {
					code: "BILLING_DISABLED",
					message: "Billing is disabled in self-hosted community mode",
				},
			},
			404,
		);
	}
	await next();
});

for (const path of ["/checkout", "/portal", "/sync"]) {
	app.use(path, requireHostedBillingMiddleware);
	app.use(path, requireWriteAccessMiddleware);
	app.use(path, requireAllWorkspaceScopeMiddleware);
	app.use(path, requireManageBillingMiddleware);
}
app.use("/", requireViewBillingMiddleware);

async function invalidateOrganizationApiKeyCache(
	env: Env,
	db: Variables["db"],
	organizationId: string,
): Promise<void> {
	let cursor: string | null = null;
	for (;;) {
		const conditions = [eq(apikey.organizationId, organizationId)];
		if (cursor) conditions.push(gt(apikey.key, cursor));
		const keys = await db
			.select({ key: apikey.key })
			.from(apikey)
			.where(and(...conditions))
			.orderBy(asc(apikey.key))
			.limit(AUTH_CACHE_PAGE_SIZE);
		await mapConcurrently(
			keys,
			AUTH_CACHE_DELETE_CONCURRENCY,
			async ({ key }) => env.KV.delete(`apikey:${key}`),
		);
		if (keys.length < AUTH_CACHE_PAGE_SIZE) return;
		cursor = keys.at(-1)?.key ?? null;
		if (!cursor) return;
	}
}

async function reconcileSubscription(
	env: Env,
	db: Variables["db"],
	organizationId: string,
	existing: SubscriptionRow,
	stripe: Stripe,
): Promise<{
	view: BillingSubscriptionView;
	plan: "free" | "pro";
}> {
	const customerId = existing.stripeCustomerId;
	// Complimentary grants deliberately retain historical Stripe customer
	// identity for late invoices and credits. Customer identity alone is not
	// authority to replace the complimentary projection from Stripe.
	if (existing.source !== "stripe" || !customerId) {
		const decision = getBillingPolicy({
			status: existing.status,
			source: existing.source,
			stripeSubscriptionId: existing.stripeSubscriptionId,
			trialEndsAt: existing.trialEndsAt,
			delinquentAt: existing.delinquentAt,
			graceEndsAt: existing.graceEndsAt,
			currentPeriodStart: existing.currentPeriodStart,
			currentPeriodEnd: existing.currentPeriodEnd,
		});
		return {
			view: {
				status: existing.status,
				cancel_at_period_end: existing.cancelAtPeriodEnd,
				current_period_end: existing.currentPeriodEnd?.toISOString() ?? null,
				has_stripe_customer: Boolean(customerId),
				has_stripe_subscription: Boolean(existing.stripeSubscriptionId),
			},
			plan: decision.entitlement,
		};
	}

	const repaired = await reconcileStripeBillingAuthority(env, db, {
		organizationId,
		ownerId: `billing-sync:${organizationId}:${crypto.randomUUID()}`,
		stripe,
	});
	if (repaired.state === "pending") {
		throw (
			repaired.error ??
			new Error(`Stripe billing authority is pending: ${repaired.reason}`)
		);
	}
	const [current] = await db
		.select()
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.limit(1);
	if (!current) {
		throw new Error(
			"Subscription projection disappeared during reconciliation",
		);
	}
	await invalidateOrganizationApiKeyCache(env, db, organizationId);
	const decision = getBillingPolicy(current);
	return {
		view: {
			status: current.status,
			cancel_at_period_end: current.cancelAtPeriodEnd,
			current_period_end: current.currentPeriodEnd?.toISOString() ?? null,
			has_stripe_customer: true,
			has_stripe_subscription: Boolean(current.stripeSubscriptionId),
		},
		plan: decision.entitlement,
	};
}

const getBillingStatus = createRoute({
	operationId: "getBillingStatus",
	method: "get",
	path: "/",
	tags: ["Billing"],
	summary: "Get the organization's canonical billing status and invoices",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Billing status",
			content: { "application/json": { schema: BillingStatusResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getBillingStatus, async (c) => {
	if (isSelfHosted(c.env)) {
		return c.json(
			{
				subscription: {
					status: "active" as const,
					cancel_at_period_end: false,
					current_period_end: null,
					has_stripe_customer: false,
					has_stripe_subscription: false,
					community: true,
				},
				invoices: [],
			},
			200,
		);
	}

	const db = c.get("db");
	const organizationId = c.get("orgId");
	const [existing] = await db
		.select()
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.limit(1);
	if (!existing) {
		return c.json({ subscription: null, invoices: [] }, 200);
	}

	let subscription: BillingSubscriptionView = {
		status: existing.status,
		cancel_at_period_end: existing.cancelAtPeriodEnd,
		current_period_end: existing.currentPeriodEnd?.toISOString() ?? null,
		has_stripe_customer: Boolean(existing.stripeCustomerId),
		has_stripe_subscription: Boolean(existing.stripeSubscriptionId),
	};
	let invoices: Array<{
		id: string;
		status: string;
		period_start: string;
		period_end: string;
		total_cents: number;
		stripe_hosted_url: string | null;
		paid_at: string | null;
		created_at: string;
	}> = [];

	if (existing.stripeCustomerId) {
		const stripe = await createStripeClient(c.env.STRIPE_SECRET_KEY);
		const [subscriptionResult, invoicesResult] = await Promise.allSettled([
			reconcileSubscription(c.env, db, organizationId, existing, stripe),
			stripe.invoices.list({
				customer: existing.stripeCustomerId,
				limit: 12,
			}),
		]);
		if (subscriptionResult.status === "fulfilled") {
			subscription = subscriptionResult.value.view;
		} else {
			console.error("Failed to reconcile Stripe subscription", {
				organizationId,
				error:
					subscriptionResult.reason instanceof Error
						? subscriptionResult.reason.message
						: "unknown error",
			});
		}
		if (invoicesResult.status === "fulfilled") {
			invoices = invoicesResult.value.data.map((invoice) => ({
				id: invoice.id,
				status:
					invoice.status === "paid"
						? "paid"
						: invoice.status === "open"
							? "finalized"
							: (invoice.status ?? "draft"),
				period_start: new Date(invoice.period_start * 1000).toISOString(),
				period_end: new Date(invoice.period_end * 1000).toISOString(),
				total_cents: invoice.amount_due,
				stripe_hosted_url: invoice.hosted_invoice_url ?? null,
				paid_at:
					invoice.status === "paid"
						? new Date(
								(invoice.status_transitions?.paid_at ?? invoice.created) * 1000,
							).toISOString()
						: null,
				created_at: new Date(invoice.created * 1000).toISOString(),
			}));
		} else {
			console.error("Failed to list Stripe invoices", {
				organizationId,
				error:
					invoicesResult.reason instanceof Error
						? invoicesResult.reason.message
						: "unknown error",
			});
		}
	}

	return c.json({ subscription, invoices }, 200);
});

const createCheckout = createRoute({
	operationId: "createBillingCheckout",
	method: "post",
	path: "/checkout",
	tags: ["Billing"],
	summary: "Create or resume a durable Stripe Checkout operation",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Checkout URL",
			content: { "application/json": { schema: BillingUrlResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Organization billing administration required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Billing disabled",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Checkout conflict",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "Checkout is safely retryable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createCheckout, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const stripe = await createStripeClient(c.env.STRIPE_SECRET_KEY);
	const now = new Date();

	const [liveOperation] = await db
		.select()
		.from(subscriptionCheckoutOperations)
		.where(
			and(
				eq(subscriptionCheckoutOperations.organizationId, organizationId),
				inArray(subscriptionCheckoutOperations.status, [
					"pending",
					"creating",
					"unknown",
					"created",
				]),
			),
		)
		.limit(1);

	if (
		liveOperation?.status === "created" &&
		liveOperation.sessionExpiresAt &&
		liveOperation.sessionExpiresAt > now &&
		liveOperation.stripeCheckoutUrl
	) {
		return c.json({ url: liveOperation.stripeCheckoutUrl }, 200);
	}
	if (
		liveOperation?.status === "created" &&
		liveOperation.sessionExpiresAt &&
		liveOperation.sessionExpiresAt <= now
	) {
		await db
			.update(subscriptionCheckoutOperations)
			.set({ status: "expired", updatedAt: now })
			.where(
				and(
					eq(subscriptionCheckoutOperations.id, liveOperation.id),
					eq(subscriptionCheckoutOperations.status, "created"),
					lte(subscriptionCheckoutOperations.sessionExpiresAt, now),
				),
			);
	}

	let operation =
		liveOperation?.status === "created" ? undefined : liveOperation;
	if (!operation) {
		const operationId = generateId("sco_");
		const [inserted] = await db
			.insert(subscriptionCheckoutOperations)
			.values({
				id: operationId,
				organizationId,
				idempotencyKey: `relayapi:checkout:${operationId}`,
			})
			.onConflictDoNothing()
			.returning();
		operation = inserted;
		if (!operation) {
			const [concurrent] = await db
				.select()
				.from(subscriptionCheckoutOperations)
				.where(
					and(
						eq(subscriptionCheckoutOperations.organizationId, organizationId),
						inArray(subscriptionCheckoutOperations.status, [
							"pending",
							"creating",
							"unknown",
							"created",
						]),
					),
				)
				.limit(1);
			operation = concurrent;
		}
	}

	if (!operation) {
		return c.json(
			billingError(
				"CHECKOUT_STATE_CONFLICT",
				"Could not establish a checkout operation",
			),
			409,
		);
	}
	if (
		operation.status === "created" &&
		operation.stripeCheckoutUrl &&
		operation.sessionExpiresAt &&
		operation.sessionExpiresAt > new Date()
	) {
		return c.json({ url: operation.stripeCheckoutUrl }, 200);
	}

	const leaseExpiresAt = new Date(Date.now() + CHECKOUT_LEASE_MS);
	const [claimed] = await db
		.update(subscriptionCheckoutOperations)
		.set({
			status: "creating",
			leaseToken: sql`${subscriptionCheckoutOperations.leaseToken} + 1`,
			leaseExpiresAt,
			attempts: sql`${subscriptionCheckoutOperations.attempts} + 1`,
			lastError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(subscriptionCheckoutOperations.id, operation.id),
				or(
					inArray(subscriptionCheckoutOperations.status, [
						"pending",
						"unknown",
					]),
					and(
						eq(subscriptionCheckoutOperations.status, "creating"),
						or(
							isNull(subscriptionCheckoutOperations.leaseExpiresAt),
							lte(subscriptionCheckoutOperations.leaseExpiresAt, new Date()),
						),
					),
				),
			),
		)
		.returning();
	if (!claimed) {
		return c.json(
			billingError(
				"CHECKOUT_IN_PROGRESS",
				"A checkout is already being prepared",
			),
			409,
		);
	}

	try {
		const [subscriptionRow] = await db
			.select()
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, organizationId))
			.limit(1);

		let customerId =
			claimed.stripeCustomerId ?? subscriptionRow?.stripeCustomerId;
		if (!customerId) {
			const principalUserId = c.get("principalUserId");
			const [actor] = principalUserId
				? await db
						.select({ email: user.email })
						.from(user)
						.where(eq(user.id, principalUserId))
						.limit(1)
				: [];
			const customer = await stripe.customers.create(
				{
					...(actor?.email ? { email: actor.email } : {}),
					metadata: { organizationId },
				},
				{ idempotencyKey: `relayapi:customer:${organizationId}` },
			);
			customerId = customer.id;

			await db
				.insert(organizationSubscriptions)
				.values({
					organizationId,
					stripeCustomerId: customerId,
					status: "cancelled",
				})
				.onConflictDoUpdate({
					target: organizationSubscriptions.organizationId,
					set: { stripeCustomerId: customerId, updatedAt: new Date() },
				});
			await db
				.update(subscriptionCheckoutOperations)
				.set({ stripeCustomerId: customerId, updatedAt: new Date() })
				.where(
					and(
						eq(subscriptionCheckoutOperations.id, claimed.id),
						eq(subscriptionCheckoutOperations.leaseToken, claimed.leaseToken),
					),
				);
		}

		if (await hasBlockingStripeSubscription(stripe, customerId)) {
			await db
				.update(subscriptionCheckoutOperations)
				.set({
					status: "blocked",
					leaseExpiresAt: null,
					lastError: "canonical_active_subscription_exists",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(subscriptionCheckoutOperations.id, claimed.id),
						eq(subscriptionCheckoutOperations.leaseToken, claimed.leaseToken),
					),
				);
			return c.json(
				billingError(
					"SUBSCRIPTION_ALREADY_EXISTS",
					"This organization already has a Stripe subscription",
				),
				409,
			);
		}

		const appOrigin = appPublicOrigin(c.env);
		const session = await stripe.checkout.sessions.create(
			{
				customer: customerId,
				mode: "subscription",
				metadata: {
					organizationId,
					checkoutOperationId: claimed.id,
					[STRIPE_MANAGED_BY_KEY]: STRIPE_MANAGED_BY_VALUE,
					[STRIPE_SUBSCRIPTION_ROLE_KEY]: STRIPE_SUBSCRIPTION_ROLES.base,
				},
				line_items: [{ price: c.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
				subscription_data: {
					metadata: {
						organizationId,
						checkoutOperationId: claimed.id,
						[STRIPE_MANAGED_BY_KEY]: STRIPE_MANAGED_BY_VALUE,
						[STRIPE_SUBSCRIPTION_ROLE_KEY]: STRIPE_SUBSCRIPTION_ROLES.base,
					},
				},
				success_url: `${appOrigin}/app/billing?success=true`,
				cancel_url: `${appOrigin}/app/billing`,
			},
			{ idempotencyKey: claimed.idempotencyKey },
		);
		if (!session.url) {
			throw new Error("Stripe returned a Checkout Session without a URL");
		}

		const [completed] = await db
			.update(subscriptionCheckoutOperations)
			.set({
				status: "created",
				stripeCustomerId: customerId,
				stripeCheckoutSessionId: session.id,
				stripeCheckoutUrl: session.url,
				sessionExpiresAt: new Date(session.expires_at * 1000),
				leaseExpiresAt: null,
				lastError: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(subscriptionCheckoutOperations.id, claimed.id),
					eq(subscriptionCheckoutOperations.status, "creating"),
					eq(subscriptionCheckoutOperations.leaseToken, claimed.leaseToken),
				),
			)
			.returning({ url: subscriptionCheckoutOperations.stripeCheckoutUrl });
		if (!completed?.url) {
			return c.json(
				billingError(
					"CHECKOUT_STATE_CONFLICT",
					"Checkout was created but its local claim changed; retry safely",
				),
				503,
			);
		}
		return c.json({ url: completed.url }, 200);
	} catch (error) {
		await db
			.update(subscriptionCheckoutOperations)
			.set({
				status: "unknown",
				leaseExpiresAt: new Date(),
				lastError:
					error instanceof Error
						? error.message.slice(0, 1_000)
						: "unknown checkout error",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(subscriptionCheckoutOperations.id, claimed.id),
					eq(subscriptionCheckoutOperations.leaseToken, claimed.leaseToken),
				),
			);
		console.error("Stripe checkout operation failed", {
			operationId: claimed.id,
		});
		return c.json(
			billingError(
				"CHECKOUT_RETRYABLE",
				"Checkout could not be prepared; retrying is safe",
			),
			503,
		);
	}
});

const createPortal = createRoute({
	operationId: "createBillingPortal",
	method: "post",
	path: "/portal",
	tags: ["Billing"],
	summary: "Create a Stripe customer portal session",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Customer portal URL",
			content: { "application/json": { schema: BillingUrlResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Organization billing administration required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "No billing account or billing disabled",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Billing subscription identity requires reconciliation",
			content: { "application/json": { schema: ErrorResponse } },
		},
		500: {
			description: "Stripe portal failure",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createPortal, async (c) => {
	try {
		const organizationId = c.get("orgId");
		const [subscription] = await c
			.get("db")
			.select({
				status: organizationSubscriptions.status,
				stripeCustomerId: organizationSubscriptions.stripeCustomerId,
				stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			})
			.from(organizationSubscriptions)
			.where(eq(organizationSubscriptions.organizationId, organizationId))
			.limit(1);
		if (!subscription?.stripeCustomerId || !subscription.stripeSubscriptionId) {
			return c.json(
				billingError("NO_BILLING_ACCOUNT", "No billing account found"),
				404,
			);
		}

		const stripe = await createStripeClient(c.env.STRIPE_SECRET_KEY);
		const canonicalSubscription = await stripe.subscriptions.retrieve(
			subscription.stripeSubscriptionId,
		);
		if (
			!isRelayApiBaseSubscription(canonicalSubscription) ||
			canonicalSubscription.id !== subscription.stripeSubscriptionId ||
			(typeof canonicalSubscription.customer === "string"
				? canonicalSubscription.customer
				: canonicalSubscription.customer.id) !== subscription.stripeCustomerId
		) {
			return c.json(
				billingError(
					"BILLING_IDENTITY_MISMATCH",
					"Billing subscription identity requires reconciliation",
				),
				409,
			);
		}
		const returnUrl = `${appPublicOrigin(c.env)}/app/billing`;
		const session = await stripe.billingPortal.sessions.create({
			customer: subscription.stripeCustomerId,
			configuration: c.env.STRIPE_PORTAL_CONFIGURATION_ID,
			return_url: returnUrl,
			flow_data:
				subscription.status === "past_due"
					? {
							type: "payment_method_update",
							after_completion: {
								type: "redirect",
								redirect: { return_url: returnUrl },
							},
						}
					: {
							type: "subscription_cancel",
							subscription_cancel: {
								subscription: subscription.stripeSubscriptionId,
							},
							after_completion: {
								type: "redirect",
								redirect: { return_url: returnUrl },
							},
						},
		});
		return c.json({ url: session.url }, 200);
	} catch (error) {
		console.error("Stripe billing portal session failed", {
			error: error instanceof Error ? error.message : "unknown error",
		});
		return c.json(
			billingError(
				"BILLING_PORTAL_FAILED",
				"Failed to create billing portal session",
			),
			500,
		);
	}
});

const syncBilling = createRoute({
	operationId: "syncBilling",
	method: "post",
	path: "/sync",
	tags: ["Billing"],
	summary: "Reconcile the local entitlement with Stripe",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Current entitlement",
			content: { "application/json": { schema: BillingSyncResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Organization billing administration required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Billing disabled",
			content: { "application/json": { schema: ErrorResponse } },
		},
		503: {
			description: "Billing authority reconciliation is safely retryable",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(syncBilling, async (c) => {
	const db = c.get("db");
	const organizationId = c.get("orgId");
	const [existing] = await db
		.select()
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.limit(1);
	if (!existing) {
		return c.json({ plan: "free" as const }, 200);
	}
	if (existing.source !== "stripe" || !existing.stripeCustomerId) {
		return c.json({ plan: getBillingPolicy(existing).entitlement }, 200);
	}
	const stripe = await createStripeClient(c.env.STRIPE_SECRET_KEY);
	try {
		const result = await reconcileSubscription(
			c.env,
			db,
			organizationId,
			existing,
			stripe,
		);
		return c.json({ plan: result.plan }, 200);
	} catch (error) {
		console.error("Stripe billing sync could not establish usage authority", {
			organizationId,
			error: error instanceof Error ? error.message : "unknown error",
		});
		c.header("Retry-After", "5");
		return c.json(
			billingError(
				"BILLING_AUTHORITY_PENDING",
				"Billing authority is being reconciled; retry shortly",
			),
			503,
		);
	}
});

export default app;
