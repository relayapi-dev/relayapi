import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { organizationSubscriptions, eq } from "@relayapi/db";

export const POST: APIRoute = async (context) => {
  try {
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

    if (!sub?.stripeCustomerId) {
      return new Response(
        JSON.stringify({ error: "No billing account found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${context.url.origin}/app/billing`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[billing/portal] Error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to create billing portal session" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
