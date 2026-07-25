import { env } from "cloudflare:workers";
import {
	eq,
	generateId,
	organizationSubscriptions,
	subscriptionCheckoutOperations,
} from "@relayapi/db";
import type { APIRoute } from "astro";
import { and, inArray, isNull, lte, or, sql } from "drizzle-orm";
import Stripe from "stripe";
import { requireBillingAdmin } from "@/lib/api-utils";
import { isSelfHostedDeployment } from "@/lib/deployment-mode";

const CHECKOUT_LEASE_MS = 2 * 60 * 1_000;
const BLOCKING_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
	"active",
	"trialing",
	"past_due",
	"unpaid",
	"incomplete",
	"paused",
]);

async function hasBlockingSubscription(
	stripe: Stripe,
	customerId: string,
): Promise<boolean> {
	let startingAfter: string | undefined;
	for (;;) {
		// Stripe returns every non-canceled status when status is omitted. This
		// keeps the common path to one request while still checking every page.
		const page = await stripe.subscriptions.list({
			customer: customerId,
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		if (
			page.data.some((subscription) =>
				BLOCKING_SUBSCRIPTION_STATUSES.has(subscription.status),
			)
		) {
			return true;
		}
		if (!page.has_more) return false;
		const lastSubscription = page.data.at(-1);
		if (!lastSubscription) return false;
		startingAfter = lastSubscription.id;
	}
}

function errorResponse(
	code: string,
	message: string,
	status: number,
): Response {
	return Response.json({ error: { code, message } }, { status });
}

export const POST: APIRoute = async (context) => {
	if (isSelfHostedDeployment(env)) {
		return errorResponse(
			"BILLING_DISABLED",
			"Billing is disabled in self-hosted community mode",
			404,
		);
	}
  const forbidden = await requireBillingAdmin(context);
  if (forbidden) return forbidden;

  const user = context.locals.user;
  const org = context.locals.organization;
  if (!user || !org) {
		return errorResponse("UNAUTHORIZED", "Not authenticated", 401);
  }

  const db = context.locals.db;
  const orgId = org.id as string;
  const userEmail = user.email as string;
  const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
    httpClient: Stripe.createFetchHttpClient(),
  });

	// Expire a locally-created Checkout Session only after Stripe's absolute
	// expiry. This releases the partial unique index without a request race.
	const [liveOperation] = await db
		.select()
		.from(subscriptionCheckoutOperations)
		.where(
			and(
				eq(subscriptionCheckoutOperations.organizationId, orgId),
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
		liveOperation.sessionExpiresAt > new Date() &&
		liveOperation.stripeCheckoutUrl
	) {
		return Response.json({ url: liveOperation.stripeCheckoutUrl });
	}
	if (
		liveOperation?.status === "created" &&
		liveOperation.sessionExpiresAt &&
		liveOperation.sessionExpiresAt <= new Date()
	) {
		await db
			.update(subscriptionCheckoutOperations)
			.set({ status: "expired", updatedAt: new Date() })
			.where(
				and(
					eq(subscriptionCheckoutOperations.id, liveOperation.id),
					eq(subscriptionCheckoutOperations.status, "created"),
					lte(subscriptionCheckoutOperations.sessionExpiresAt, new Date()),
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
				organizationId: orgId,
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
						eq(subscriptionCheckoutOperations.organizationId, orgId),
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
		return errorResponse(
			"CHECKOUT_STATE_CONFLICT",
			"Could not establish a checkout operation",
			409,
		);
	}
	if (
		operation.status === "created" &&
		operation.stripeCheckoutUrl &&
		operation.sessionExpiresAt &&
		operation.sessionExpiresAt > new Date()
	) {
		return Response.json({ url: operation.stripeCheckoutUrl });
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
		return errorResponse(
			"CHECKOUT_IN_PROGRESS",
			"A checkout is already being prepared",
			409,
		);
	}

	try {
		const [subscriptionRow] = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .limit(1);

		let customerId =
			claimed.stripeCustomerId ?? subscriptionRow?.stripeCustomerId;
  if (!customerId) {
			const customer = await stripe.customers.create(
				{
      email: userEmail,
      metadata: { organizationId: orgId },
				},
				{ idempotencyKey: `relayapi:customer:${orgId}` },
			);
    customerId = customer.id;

      await db
        .insert(organizationSubscriptions)
        .values({
          organizationId: orgId,
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

		// Local billing state is not authoritative here. Stripe is queried before
		// creating another Session so delayed webhooks cannot allow duplicates.
		if (await hasBlockingSubscription(stripe, customerId)) {
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
			return errorResponse(
				"SUBSCRIPTION_ALREADY_EXISTS",
				"This organization already has a Stripe subscription",
				409,
			);
		}

		const session = await stripe.checkout.sessions.create(
			{
      customer: customerId,
      mode: "subscription",
				metadata: {
					organizationId: orgId,
					checkoutOperationId: claimed.id,
				},
      line_items: [
        {
          price: env.STRIPE_PRO_PRICE_ID as string,
          quantity: 1,
        },
      ],
      subscription_data: {
					metadata: {
						organizationId: orgId,
						checkoutOperationId: claimed.id,
      },
				},
				success_url: `${context.url.origin}/app/billing?success=true`,
				cancel_url: `${context.url.origin}/app/billing`,
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
			return errorResponse(
				"CHECKOUT_STATE_CONFLICT",
				"Checkout was created but its local claim changed; retry safely",
				503,
			);
		}
		return Response.json({ url: completed.url });
	} catch (error) {
		// The request may have crossed Stripe's boundary. Keep the operation live
		// and retry it with the same Stripe idempotency key on the next attempt.
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
		return errorResponse(
			"CHECKOUT_RETRYABLE",
			"Checkout could not be prepared; retrying is safe",
			503,
    );
  }
};
