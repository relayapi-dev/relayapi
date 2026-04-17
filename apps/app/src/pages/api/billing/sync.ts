import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { organizationSubscriptions, apikey, eq } from "@relayapi/db";
import { PRICING } from "@relayapi/config";
import { requireBillingAdmin } from "@/lib/api-utils";

export const POST: APIRoute = async (context) => {
  const forbidden = await requireBillingAdmin(context);
  if (forbidden) return forbidden;

  const org = context.locals.organization!;
  const db = context.locals.db;
  const kv = context.locals.kv;
  const orgId = (org as any).id as string;

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
      const subscription = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);

      const firstItem = subscription.items?.data?.[0];
      const periodStart = firstItem
        ? new Date(firstItem.current_period_start * 1000)
        : new Date();
      const periodEnd = firstItem
        ? new Date(firstItem.current_period_end * 1000)
        : new Date();

      const statusMap: Record<string, string> = {
        active: "active",
        past_due: "past_due",
        canceled: "cancelled",
        unpaid: "past_due",
        trialing: "trialing",
      };
      const newStatus = statusMap[subscription.status] || "cancelled";
      const isPro = newStatus === "active" || newStatus === "trialing";

      // The Stripe Customer Portal uses `cancel_at` (timestamp) rather than
      // `cancel_at_period_end` (boolean). Check BOTH to detect scheduled cancellation.
      const isCancelling = subscription.cancel_at_period_end || !!subscription.cancel_at;

      await db
        .update(organizationSubscriptions)
        .set({
          status: newStatus as typeof sub.status,
          cancelAtPeriodEnd: isCancelling,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          ...(newStatus === "cancelled" ? { stripeSubscriptionId: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizationSubscriptions.organizationId, orgId));

      const plan = isPro ? "pro" : "free";
      const callsIncluded = isPro ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;
      await syncKeysToKV(db, kv, orgId, plan, callsIncluded);

      return Response.json({ plan });
    } catch (err: any) {
      // Subscription was deleted in Stripe (404) — downgrade
      if (err?.statusCode === 404) {
        await db
          .update(organizationSubscriptions)
          .set({
            status: "cancelled",
            stripeSubscriptionId: null,
            cancelAtPeriodEnd: false,
            updatedAt: new Date(),
          })
          .where(eq(organizationSubscriptions.organizationId, orgId));

        await syncKeysToKV(db, kv, orgId, "free", PRICING.freeCallsIncluded);
        return Response.json({ plan: "free" });
      }
      throw err;
    }
  }

  // No subscription ID — check if there's a new active subscription
  const subscriptions = await stripe.subscriptions.list({
    customer: sub.stripeCustomerId,
    status: "active",
    limit: 1,
  });

  const activeSub = subscriptions.data[0];
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

  await db
    .update(organizationSubscriptions)
    .set({
      status: "active",
      stripeSubscriptionId: activeSub.id,
      cancelAtPeriodEnd: activeSub.cancel_at_period_end || !!activeSub.cancel_at,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      updatedAt: new Date(),
    })
    .where(eq(organizationSubscriptions.organizationId, orgId));

  await syncKeysToKV(db, kv, orgId, "pro", PRICING.proCallsIncluded);
  return Response.json({ plan: "pro" });
};

async function syncKeysToKV(
  db: any,
  kv: any,
  orgId: string,
  plan: string,
  callsIncluded: number,
) {
  const orgKeys = await db
    .select({ key: apikey.key })
    .from(apikey)
    .where(eq(apikey.organizationId, orgId));

  for (const k of orgKeys) {
    const raw = await kv.get(`apikey:${k.key}`);
    if (raw) {
      const data = JSON.parse(raw);
      data.plan = plan;
      data.calls_included = callsIncluded;
      await kv.put(`apikey:${k.key}`, JSON.stringify(data), {
        expirationTtl: 86400 * 365,
      });
    }
  }
}
