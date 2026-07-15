import { env } from "cloudflare:workers";
import {
	API_KEY_CACHE_TTL_SECONDS,
	getBillingPolicy,
	PRICING,
} from "@relayapi/config";
import { apikey, eq, organizationSubscriptions } from "@relayapi/db";
import type { APIRoute } from "astro";
import Stripe from "stripe";
import { requireBillingAdmin } from "@/lib/api-utils";

type LocalSubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";

function mapStripeStatus(
	status: Stripe.Subscription.Status,
): LocalSubscriptionStatus {
	if (status === "active" || status === "trialing") return status;
	if (status === "past_due" || status === "unpaid") return "past_due";
	return "cancelled";
}

async function findEntitledSubscription(
	stripe: Stripe,
	customerId: string,
): Promise<Stripe.Subscription | null> {
	let startingAfter: string | undefined;
	let trialing: Stripe.Subscription | null = null;
	for (;;) {
		// Omitting status returns all non-canceled subscriptions, so active and
		// trialing can be found with one request in the normal case.
		const page = await stripe.subscriptions.list({
			customer: customerId,
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		for (const subscription of page.data) {
			if (subscription.status === "active") return subscription;
			if (subscription.status === "trialing" && !trialing) {
				trialing = subscription;
			}
		}
		if (!page.has_more) return trialing;
		const lastSubscription = page.data.at(-1);
		if (!lastSubscription) return trialing;
		startingAfter = lastSubscription.id;
	}
}

export const POST: APIRoute = async (context) => {
  const forbidden = await requireBillingAdmin(context);
  if (forbidden) return forbidden;

  const org = context.locals.organization;
  if (!org) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }
  const db = context.locals.db;
  const kv = context.locals.kv;
  const orgId = org.id as string;

  const [sub] = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .limit(1);

  if (!sub?.stripeCustomerId) {
    return Response.json({ plan: "free" });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  // If we have a subscription ID, fetch it directly to get the full state
  if (sub.stripeSubscriptionId) {
    try {
			const subscription = await stripe.subscriptions.retrieve(
				sub.stripeSubscriptionId,
			);

      const firstItem = subscription.items?.data?.[0];
      const periodStart = firstItem
        ? new Date(firstItem.current_period_start * 1000)
        : new Date();
      const periodEnd = firstItem
        ? new Date(firstItem.current_period_end * 1000)
        : new Date();

			const newStatus = mapStripeStatus(subscription.status);
			const trialEndsAt = subscription.trial_end
				? new Date(subscription.trial_end * 1000)
				: null;
			const decision = getBillingPolicy({
				status: newStatus,
				stripeSubscriptionId: subscription.id,
				trialEndsAt,
				currentPeriodStart: periodStart,
				currentPeriodEnd: periodEnd,
			});

      // The Stripe Customer Portal uses `cancel_at` (timestamp) rather than
      // `cancel_at_period_end` (boolean). Check BOTH to detect scheduled cancellation.
			const isCancelling =
				subscription.cancel_at_period_end || !!subscription.cancel_at;

      await db
        .update(organizationSubscriptions)
        .set({
          status: newStatus as typeof sub.status,
          cancelAtPeriodEnd: isCancelling,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
					trialEndsAt,
          ...(newStatus === "cancelled" ? { stripeSubscriptionId: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizationSubscriptions.organizationId, orgId));

			await syncKeysToKV(db, kv, orgId, decision);

			return Response.json({ plan: decision.entitlement });
    } catch (err: unknown) {
      // Subscription was deleted in Stripe (404) — downgrade
      const statusCode =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode?: number }).statusCode
          : undefined;
      if (statusCode === 404) {
        await db
          .update(organizationSubscriptions)
          .set({
            status: "cancelled",
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          })
          .where(eq(organizationSubscriptions.organizationId, orgId));

				await syncKeysToKV(
					db,
					kv,
					orgId,
					getBillingPolicy({ status: "cancelled" }),
				);
        return Response.json({ plan: "free" });
      }
      throw err;
    }
  }

  // No subscription ID — check if there's a new active subscription
	const activeSub = await findEntitledSubscription(
		stripe,
		sub.stripeCustomerId,
	);
  if (!activeSub) {
    return Response.json({ plan: "free" });
  }

  const firstItem = activeSub.items?.data?.[0];
  const periodStart = firstItem
    ? new Date(firstItem.current_period_start * 1000)
    : new Date();
  const periodEnd = firstItem
    ? new Date(firstItem.current_period_end * 1000)
    : new Date();

	const syncedStatus = mapStripeStatus(activeSub.status);
	const trialEndsAt = activeSub.trial_end
		? new Date(activeSub.trial_end * 1000)
		: null;
	const decision = getBillingPolicy({
		status: syncedStatus,
		stripeSubscriptionId: activeSub.id,
		trialEndsAt,
		currentPeriodStart: periodStart,
		currentPeriodEnd: periodEnd,
	});

  await db
    .update(organizationSubscriptions)
    .set({
			status: syncedStatus,
      stripeSubscriptionId: activeSub.id,
			cancelAtPeriodEnd:
				activeSub.cancel_at_period_end || !!activeSub.cancel_at,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
			trialEndsAt,
      updatedAt: new Date(),
    })
    .where(eq(organizationSubscriptions.organizationId, orgId));

	await syncKeysToKV(db, kv, orgId, decision);
	return Response.json({ plan: decision.entitlement });
};

async function syncKeysToKV(
  db: App.Locals["db"],
  kv: App.Locals["kv"],
  orgId: string,
	decision: ReturnType<typeof getBillingPolicy>,
) {
  const orgKeys = await db
    .select({ key: apikey.key })
    .from(apikey)
    .where(eq(apikey.organizationId, orgId));

  for (const k of orgKeys) {
    const raw = await kv.get(`apikey:${k.key}`);
    if (raw) {
      const data = JSON.parse(raw);
			data.plan = decision.entitlement;
			data.calls_included =
				decision.entitlement === "pro"
					? PRICING.proCallsIncluded
					: PRICING.freeCallsIncluded;
			data.period_start = decision.usagePeriod?.start.toISOString() ?? null;
			data.period_end = decision.usagePeriod?.end.toISOString() ?? null;
      await kv.put(`apikey:${k.key}`, JSON.stringify(data), {
				expirationTtl: API_KEY_CACHE_TTL_SECONDS,
      });
    }
  }
}
