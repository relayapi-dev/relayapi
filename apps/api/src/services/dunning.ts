import {
	createDb,
	organizationSubscriptions,
	invoices,
	dunningEvents,
	organization,
	member,
	user,
} from "@relayapi/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createStripeClient } from "./stripe";
import {
	sendPaymentFailedReminder,
	sendPlanDeactivatedEmail,
} from "./email";
import type { Env } from "../types";

/**
 * Process dunning for past_due subscriptions.
 * Runs daily at 9am UTC via cron.
 *
 * Timeline:
 * - Day 1+: Send first reminder email
 * - Day 7+: Send second reminder email
 * - Day 14+: Cancel Stripe subscription (triggers webhook → downgrades plan)
 */
export async function processDunning(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();

	// Find all past_due subscriptions
	const pastDueSubs = await db
		.select({
			subId: organizationSubscriptions.id,
			orgId: organizationSubscriptions.organizationId,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			stripeCustomerId: organizationSubscriptions.stripeCustomerId,
		})
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.status, "past_due"))
		.limit(100);

	for (const sub of pastDueSubs) {
		try {
			// Find the unpaid invoice for this org
			// Get the most recent unpaid invoice (deterministic ordering)
			const [unpaidInvoice] = await db
				.select()
				.from(invoices)
				.where(
					and(
						eq(invoices.organizationId, sub.orgId),
						eq(invoices.status, "finalized"),
						isNull(invoices.paidAt),
					),
				)
				.orderBy(desc(invoices.finalizedAt))
				.limit(1);

			if (!unpaidInvoice) continue;

			const failedAt = unpaidInvoice.finalizedAt || unpaidInvoice.createdAt;
			const daysSinceFailure = Math.floor(
				(now.getTime() - failedAt.getTime()) / (1000 * 60 * 60 * 24),
			);

			// Get existing dunning events for this invoice
			const existingEvents = await db
				.select({ event: dunningEvents.event })
				.from(dunningEvents)
				.where(eq(dunningEvents.invoiceId, unpaidInvoice.id));

			const sentEvents = new Set(existingEvents.map((e) => e.event));

			// Get billing email (org owner's email)
			const billingEmail = await getOrgOwnerEmail(db, sub.orgId);
			if (!billingEmail) continue;

			// Get org name
			const [org] = await db
				.select({ name: organization.name })
				.from(organization)
				.where(eq(organization.id, sub.orgId))
				.limit(1);
			const orgName = org?.name || "your workspace";

			// Day 1+: First reminder
			if (daysSinceFailure >= 1 && !sentEvents.has("reminder_1d")) {
				await sendPaymentFailedReminder(
					env.EMAIL_QUEUE,
					env.RESEND_API_KEY,
					{
						to: billingEmail,
						orgName,
						invoiceUrl: unpaidInvoice.stripeHostedUrl,
						portalUrl: "https://relayapi.dev/app/billing",
						isSecondReminder: false,
					},
				);

				await db.insert(dunningEvents).values({
					organizationId: sub.orgId,
					invoiceId: unpaidInvoice.id,
					stripeInvoiceId: unpaidInvoice.stripeInvoiceId,
					event: "reminder_1d",
					sentAt: now,
				});
			}

			// Day 7+: Second reminder
			if (daysSinceFailure >= 7 && !sentEvents.has("reminder_7d")) {
				await sendPaymentFailedReminder(
					env.EMAIL_QUEUE,
					env.RESEND_API_KEY,
					{
						to: billingEmail,
						orgName,
						invoiceUrl: unpaidInvoice.stripeHostedUrl,
						portalUrl: "https://relayapi.dev/app/billing",
						isSecondReminder: true,
					},
				);

				await db.insert(dunningEvents).values({
					organizationId: sub.orgId,
					invoiceId: unpaidInvoice.id,
					stripeInvoiceId: unpaidInvoice.stripeInvoiceId,
					event: "reminder_7d",
					sentAt: now,
				});
			}

			// Day 14+: Deactivate
			if (daysSinceFailure >= 14 && !sentEvents.has("deactivated_14d")) {
				// Cancel the Stripe subscription — this triggers the
				// customer.subscription.deleted webhook which handles
				// DB status update and KV downgrade
				if (!sub.stripeSubscriptionId) {
					console.error(`Dunning: no stripeSubscriptionId for org ${sub.orgId}, skipping deactivation`);
					continue;
				}

				const stripe = createStripeClient(env.STRIPE_SECRET_KEY);
				await stripe.subscriptions.cancel(sub.stripeSubscriptionId);

				// Only send deactivation email and record event after confirmed cancellation
				await sendPlanDeactivatedEmail(
					env.EMAIL_QUEUE,
					env.RESEND_API_KEY,
					{
						to: billingEmail,
						orgName,
					},
				);

				await db.insert(dunningEvents).values({
					organizationId: sub.orgId,
					invoiceId: unpaidInvoice.id,
					stripeInvoiceId: unpaidInvoice.stripeInvoiceId,
					event: "deactivated_14d",
					sentAt: now,
				});
			}
		} catch (err) {
			console.error(`Dunning failed for org ${sub.orgId}:`, err);
		}
	}
}

async function getOrgOwnerEmail(
	db: ReturnType<typeof createDb>,
	orgId: string,
): Promise<string | null> {
	const [ownerMember] = await db
		.select({ email: user.email })
		.from(member)
		.innerJoin(user, eq(member.userId, user.id))
		.where(
			and(
				eq(member.organizationId, orgId),
				eq(member.role, "owner"),
			),
		)
		.limit(1);

	return ownerMember?.email ?? null;
}
