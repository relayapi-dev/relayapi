import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import {
  organizationSubscriptions,
  eq,
} from "@relayapi/db";

export const GET: APIRoute = async (context) => {
  const user = context.locals.user;
  const org = context.locals.organization;
  if (!user || !org) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = context.locals.db;
  const orgId = (org as any).id as string;

  const [sub] = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .limit(1);

  let subscriptionData = sub
    ? {
        status: sub.status,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        currentPeriodEnd: sub.currentPeriodEnd instanceof Date ? sub.currentPeriodEnd.toISOString() : sub.currentPeriodEnd,
        hasStripeCustomer: !!sub.stripeCustomerId,
        hasStripeSubscription: !!sub.stripeSubscriptionId,
      }
    : null;

  let stripeInvoices: Array<{
    id: string;
    status: string;
    periodStart: string;
    periodEnd: string;
    totalCents: number;
    stripeHostedUrl: string | null;
    paidAt: string | null;
    createdAt: string;
  }> = [];

  if (sub?.stripeCustomerId && env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
        httpClient: Stripe.createFetchHttpClient(),
      });

      // Retrieve subscription directly by ID first (works for any status including past_due),
      // fall back to listing by customer only if no subscription ID is stored.
      let stripeSub: any = null;

      const [directSub, invoicesResult] = await Promise.all([
        sub.stripeSubscriptionId
          ? stripe.subscriptions.retrieve(sub.stripeSubscriptionId).catch((err: any) => {
              // 404 = subscription deleted in Stripe
              if (err?.statusCode === 404) return null;
              throw err;
            })
          : stripe.subscriptions.list({
              customer: sub.stripeCustomerId,
              limit: 1,
            }).then((res) => res.data[0] ?? null),
        stripe.invoices.list({
          customer: sub.stripeCustomerId,
          limit: 12,
        }),
      ]);

      stripeSub = directSub;

      if (stripeSub) {
        type SubStatus = "trialing" | "active" | "past_due" | "cancelled";
        const statusMap: Record<string, SubStatus> = {
          active: "active",
          past_due: "past_due",
          canceled: "cancelled",
          unpaid: "past_due",
          trialing: "trialing",
          incomplete: "active",
          incomplete_expired: "cancelled",
          paused: "cancelled",
        };
        const newStatus: SubStatus = statusMap[stripeSub.status] ?? "cancelled";

        const firstItem = stripeSub.items?.data?.[0];
        const periodEnd = firstItem
          ? new Date(firstItem.current_period_end * 1000)
          : null;

        // The Stripe Customer Portal uses `cancel_at` (specific timestamp) rather than
        // `cancel_at_period_end` (boolean). Check BOTH to detect scheduled cancellation.
        const isCancelling = stripeSub.cancel_at_period_end || !!stripeSub.cancel_at;

        // Update DB if state drifted
        const dbUpdates: Record<string, any> = {};
        if (sub.status !== newStatus) dbUpdates.status = newStatus;
        if (sub.cancelAtPeriodEnd !== isCancelling)
          dbUpdates.cancelAtPeriodEnd = isCancelling;
        if (sub.stripeSubscriptionId !== stripeSub.id)
          dbUpdates.stripeSubscriptionId = stripeSub.id;
        if (periodEnd) dbUpdates.currentPeriodEnd = periodEnd;

        if (Object.keys(dbUpdates).length > 0) {
          dbUpdates.updatedAt = new Date();
          await db
            .update(organizationSubscriptions)
            .set(dbUpdates)
            .where(eq(organizationSubscriptions.organizationId, orgId));
        }

        subscriptionData = {
          status: newStatus,
          cancelAtPeriodEnd: isCancelling,
          currentPeriodEnd: periodEnd?.toISOString() ?? (sub.currentPeriodEnd instanceof Date ? sub.currentPeriodEnd.toISOString() : sub.currentPeriodEnd),
          hasStripeCustomer: true,
          hasStripeSubscription: true,
        };
      } else {
        // No active subscription found in Stripe — fully cancelled
        if (sub.status !== "cancelled" || sub.stripeSubscriptionId !== null) {
          await db
            .update(organizationSubscriptions)
            .set({
              status: "cancelled",
              stripeSubscriptionId: null,
              cancelAtPeriodEnd: false,
              updatedAt: new Date(),
            })
            .where(eq(organizationSubscriptions.organizationId, orgId));
        }

        subscriptionData = {
          status: "cancelled" as const,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: sub.currentPeriodEnd instanceof Date ? sub.currentPeriodEnd.toISOString() : sub.currentPeriodEnd,
          hasStripeCustomer: true,
          hasStripeSubscription: false,
        };
      }

      stripeInvoices = invoicesResult.data.map((inv) => ({
        id: inv.id,
        status: inv.status === "paid" ? "paid" : inv.status === "open" ? "finalized" : inv.status || "draft",
        periodStart: new Date(inv.period_start * 1000).toISOString(),
        periodEnd: new Date(inv.period_end * 1000).toISOString(),
        totalCents: inv.amount_due,
        stripeHostedUrl: inv.hosted_invoice_url ?? null,
        paidAt: inv.status === "paid" ? new Date(inv.status_transitions?.paid_at ? inv.status_transitions.paid_at * 1000 : Date.now()).toISOString() : null,
        createdAt: new Date(inv.created * 1000).toISOString(),
      }));
    } catch (err) {
      console.error("Failed to fetch Stripe data:", err);
    }
  }

  return new Response(
    JSON.stringify({
      subscription: subscriptionData,
      invoices: stripeInvoices,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};
