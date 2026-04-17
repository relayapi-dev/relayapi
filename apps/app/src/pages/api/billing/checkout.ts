import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { organizationSubscriptions, eq } from "@relayapi/db";
import { requireBillingAdmin } from "@/lib/api-utils";

export const POST: APIRoute = async (context) => {
  const forbidden = await requireBillingAdmin(context);
  if (forbidden) return forbidden;

  const user = context.locals.user!;
  const org = context.locals.organization!;

  const db = context.locals.db;
  const orgId = (org as any).id as string;
  const userEmail = (user as any).email as string;

  const stripe = new Stripe(env.STRIPE_SECRET_KEY as string, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Check if org already has a subscription with a Stripe customer
  const [sub] = await db
    .select()
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .limit(1);

  let customerId = sub?.stripeCustomerId;

  // Create Stripe customer if needed
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: { organizationId: orgId },
    });
    customerId = customer.id;

    // Store the customer ID
    if (sub) {
      await db
        .update(organizationSubscriptions)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(organizationSubscriptions.id, sub.id));
    } else {
      // No subscription row exists yet — create one so the webhook can find it
      await db
        .insert(organizationSubscriptions)
        .values({
          organizationId: orgId,
          stripeCustomerId: customerId,
          status: "trialing",
        });
    }
  }

  const baseUrl = context.url.origin;

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      metadata: { organizationId: orgId },
      line_items: [
        {
          price: env.STRIPE_PRO_PRICE_ID as string,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: { organizationId: orgId },
      },
      success_url: `${baseUrl}/app/billing?success=true`,
      cancel_url: `${baseUrl}/app/billing`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Stripe checkout session error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to create checkout session" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
