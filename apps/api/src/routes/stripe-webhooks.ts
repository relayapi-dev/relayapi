import {
	apikey,
	createDb,
	invoices,
	organizationSubscriptions,
	whatsappPhoneNumbers,
} from "@relayapi/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { sendNotificationToOrg } from "../services/notification-manager";
import { createStripeClient } from "../services/stripe";
import type { Env, KVKeyData } from "../types";
import { PRICING } from "../types";

const app = new Hono<{ Bindings: Env }>();

/** Extract subscription ID from an invoice's parent field */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	const details = invoice.parent?.subscription_details;
	if (!details) return null;
	return typeof details.subscription === "string"
		? details.subscription
		: (details.subscription?.id ?? null);
}

/** Get current_period_start/end from the first subscription item */
function getSubscriptionPeriod(subscription: Stripe.Subscription): {
	start: Date;
	end: Date;
} {
	const firstItem = subscription.items?.data?.[0];
	const now = new Date();
	return {
		start: firstItem ? new Date(firstItem.current_period_start * 1000) : now,
		end: firstItem ? new Date(firstItem.current_period_end * 1000) : now,
	};
}

app.post("/", async (c) => {
	const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);
	const body = await c.req.text();
	const sig = c.req.header("stripe-signature");

	if (!sig) return c.json({ error: "Missing signature" }, 400);

	let event: Stripe.Event;
	try {
		event = await stripe.webhooks.constructEventAsync(
			body,
			sig,
			c.env.STRIPE_WEBHOOK_SECRET,
		);
	} catch (err) {
		console.error("Stripe webhook signature verification failed:", err);
		return c.json({ error: "Invalid signature" }, 400);
	}

	// Acknowledge immediately, process async
	const ctx = c.executionCtx;
	ctx.waitUntil(handleEvent(event, c.env));

	return c.json({ received: true });
});

async function handleEvent(event: Stripe.Event, env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);

	switch (event.type) {
		case "checkout.session.completed": {
			const session = event.data.object as Stripe.Checkout.Session;
			if (session.mode !== "subscription" || !session.subscription) break;

			// Handle WhatsApp phone number checkout
			if (session.metadata?.type === "wa_phone_number") {
				const phoneNumberId = session.metadata.phoneNumberId;
				if (phoneNumberId) {
					const stripe = createStripeClient(env.STRIPE_SECRET_KEY);
					const subscription = await stripe.subscriptions.retrieve(
						session.subscription as string,
					);
					const firstItem = subscription.items?.data?.[0];
					if (firstItem) {
						await db
							.update(whatsappPhoneNumbers)
							.set({
								stripeSubscriptionItemId: firstItem.id,
								updatedAt: new Date(),
							})
							.where(eq(whatsappPhoneNumbers.id, phoneNumberId));
					}
				}
				break;
			}

			const stripe = createStripeClient(env.STRIPE_SECRET_KEY);
			const subscription = await stripe.subscriptions.retrieve(
				session.subscription as string,
			);

			// Try session metadata first, fall back to subscription metadata, then customer metadata
			const orgId =
				session.metadata?.organizationId ||
				subscription.metadata?.organizationId ||
				null;

			if (!orgId) {
				// Last resort: look up by stripeCustomerId
				const customerId = session.customer as string;
				const [existingSub] = await db
					.select({ organizationId: organizationSubscriptions.organizationId })
					.from(organizationSubscriptions)
					.where(eq(organizationSubscriptions.stripeCustomerId, customerId))
					.limit(1);

				if (!existingSub) {
					console.error(
						"checkout.session.completed: cannot resolve organizationId",
						{
							sessionId: session.id,
							customerId,
						},
					);
					break;
				}

				const period = getSubscriptionPeriod(subscription);
				await db
					.update(organizationSubscriptions)
					.set({
						status: "active",
						stripeSubscriptionId: subscription.id,
						currentPeriodStart: period.start,
						currentPeriodEnd: period.end,
						updatedAt: new Date(),
					})
					.where(
						eq(
							organizationSubscriptions.organizationId,
							existingSub.organizationId,
						),
					);

				await syncOrgKeysToKV(
					env,
					db,
					existingSub.organizationId,
					"pro",
					PRICING.proCallsIncluded,
				);
				break;
			}

			const period = getSubscriptionPeriod(subscription);

			await db
				.update(organizationSubscriptions)
				.set({
					status: "active",
					stripeCustomerId: session.customer as string,
					stripeSubscriptionId: subscription.id,
					currentPeriodStart: period.start,
					currentPeriodEnd: period.end,
					updatedAt: new Date(),
				})
				.where(eq(organizationSubscriptions.organizationId, orgId));

			// Sync KV keys to pro
			await syncOrgKeysToKV(env, db, orgId, "pro", PRICING.proCallsIncluded);
			break;
		}

		case "customer.subscription.updated": {
			const subscription = event.data.object as Stripe.Subscription;
			const [sub] = await db
				.select()
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscription.id),
				)
				.limit(1);

			if (!sub) break;

			const statusMap: Record<string, string> = {
				active: "active",
				past_due: "past_due",
				canceled: "cancelled",
				unpaid: "past_due",
				trialing: "trialing",
			};

			const newStatus = statusMap[subscription.status] || sub.status;
			const period = getSubscriptionPeriod(subscription);

			// The Stripe Customer Portal uses `cancel_at` (specific timestamp) rather than
			// `cancel_at_period_end` (boolean). Check BOTH to detect scheduled cancellation.
			const isCancelling =
				subscription.cancel_at_period_end || !!subscription.cancel_at;

			await db
				.update(organizationSubscriptions)
				.set({
					status: newStatus as typeof sub.status,
					cancelAtPeriodEnd: isCancelling,
					currentPeriodStart: period.start,
					currentPeriodEnd: period.end,
					updatedAt: new Date(),
				})
				.where(eq(organizationSubscriptions.id, sub.id));

			// If moved to past_due, downgrade KV keys
			if (newStatus === "past_due") {
				await syncOrgKeysToKV(
					env,
					db,
					sub.organizationId,
					"free",
					PRICING.freeCallsIncluded,
				);
			}
			// If back to active, upgrade KV keys
			if (newStatus === "active" && sub.status !== "active") {
				await syncOrgKeysToKV(
					env,
					db,
					sub.organizationId,
					"pro",
					PRICING.proCallsIncluded,
				);
			}
			break;
		}

		case "customer.subscription.deleted": {
			const subscription = event.data.object as Stripe.Subscription;
			const [sub] = await db
				.select()
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscription.id),
				)
				.limit(1);

			if (!sub) break;

			await db
				.update(organizationSubscriptions)
				.set({
					status: "cancelled",
					stripeSubscriptionId: null,
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				})
				.where(eq(organizationSubscriptions.id, sub.id));

			await syncOrgKeysToKV(
				env,
				db,
				sub.organizationId,
				"free",
				PRICING.freeCallsIncluded,
			);
			break;
		}

		case "invoice.finalized": {
			const invoice = event.data.object as Stripe.Invoice;
			const subscriptionId = getInvoiceSubscriptionId(invoice);
			if (!subscriptionId) break;

			const [sub] = await db
				.select()
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscriptionId),
				)
				.limit(1);

			if (!sub) break;

			const periodStart = new Date(invoice.period_start * 1000);
			const periodEnd = new Date(invoice.period_end * 1000);

			// Upsert local invoice mirror
			const [existing] = await db
				.select({ id: invoices.id })
				.from(invoices)
				.where(eq(invoices.stripeInvoiceId, invoice.id))
				.limit(1);

			if (existing) {
				await db
					.update(invoices)
					.set({
						status: "finalized",
						totalCents: invoice.amount_due,
						stripeHostedUrl: invoice.hosted_invoice_url ?? null,
						finalizedAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(invoices.id, existing.id));
			} else {
				await db.insert(invoices).values({
					organizationId: sub.organizationId,
					status: "finalized",
					periodStart,
					periodEnd,
					basePriceCents: sub.monthlyPriceCents,
					totalCents: invoice.amount_due,
					stripeInvoiceId: invoice.id,
					stripeHostedUrl: invoice.hosted_invoice_url ?? null,
					finalizedAt: new Date(),
				});
			}
			break;
		}

		case "invoice.paid": {
			const invoice = event.data.object as Stripe.Invoice;

			// Update local invoice to paid
			const [localInvoice] = await db
				.select({ id: invoices.id })
				.from(invoices)
				.where(eq(invoices.stripeInvoiceId, invoice.id))
				.limit(1);

			if (localInvoice) {
				await db
					.update(invoices)
					.set({
						status: "paid",
						paidAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(invoices.id, localInvoice.id));
			}

			// Clear dunning state if subscription was past_due
			const subscriptionId = getInvoiceSubscriptionId(invoice);
			if (subscriptionId) {
				const [sub] = await db
					.select()
					.from(organizationSubscriptions)
					.where(
						eq(organizationSubscriptions.stripeSubscriptionId, subscriptionId),
					)
					.limit(1);

				if (sub && sub.status === "past_due") {
					await db
						.update(organizationSubscriptions)
						.set({ status: "active", updatedAt: new Date() })
						.where(eq(organizationSubscriptions.id, sub.id));

					await syncOrgKeysToKV(
						env,
						db,
						sub.organizationId,
						"pro",
						PRICING.proCallsIncluded,
					);
				}
			}
			break;
		}

		case "invoice.payment_failed": {
			const invoice = event.data.object as Stripe.Invoice;
			const subscriptionId = getInvoiceSubscriptionId(invoice);
			if (!subscriptionId) break;

			const [sub] = await db
				.select()
				.from(organizationSubscriptions)
				.where(
					eq(organizationSubscriptions.stripeSubscriptionId, subscriptionId),
				)
				.limit(1);

			if (!sub) break;

			// Set subscription to past_due
			await db
				.update(organizationSubscriptions)
				.set({ status: "past_due", updatedAt: new Date() })
				.where(eq(organizationSubscriptions.id, sub.id));

			await syncOrgKeysToKV(
				env,
				db,
				sub.organizationId,
				"free",
				PRICING.freeCallsIncluded,
			);

			// Notify org members about payment failure
			sendNotificationToOrg(env, {
				type: "payment_failed",
				orgId: sub.organizationId,
				title: "Payment failed",
				body: "Your subscription payment failed. Please update your payment method to avoid losing Pro features.",
				data: { invoiceId: invoice.id },
			}).catch((err) =>
				console.error(
					"[Notification] Failed to send payment notification:",
					err,
				),
			);
			break;
		}

		default:
			break;
	}
}

async function syncOrgKeysToKV(
	env: Env,
	db: ReturnType<typeof createDb>,
	orgId: string,
	plan: "free" | "pro",
	callsIncluded: number,
	opts?: { aiEnabled?: boolean; dailyToolLimit?: number },
): Promise<void> {
	const orgKeys = await db
		.select({ key: apikey.key })
		.from(apikey)
		.where(eq(apikey.organizationId, orgId));

	for (const k of orgKeys) {
		const existing = await env.KV.get<KVKeyData>(`apikey:${k.key}`, "json");
		if (existing) {
			existing.plan = plan;
			existing.calls_included = callsIncluded;
			if (opts?.aiEnabled !== undefined) existing.ai_enabled = opts.aiEnabled;
			if (opts?.dailyToolLimit !== undefined) existing.daily_tool_limit = opts.dailyToolLimit;
			await env.KV.put(`apikey:${k.key}`, JSON.stringify(existing), {
				expirationTtl: 86400 * 365,
			});
		}
	}
}

export { handleEvent, syncOrgKeysToKV };
export default app;
