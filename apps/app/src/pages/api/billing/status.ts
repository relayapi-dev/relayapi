import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

export const GET: APIRoute = async (context) => {
	const client = await requireClient(context);
	if (client instanceof Response) return client;

	try {
		const data = await client.billing.status();
		return Response.json(
			{
				subscription: data.subscription
					? {
							status: data.subscription.status,
							cancelAtPeriodEnd: data.subscription.cancel_at_period_end,
							currentPeriodEnd: data.subscription.current_period_end,
							hasStripeCustomer: data.subscription.has_stripe_customer,
							hasStripeSubscription: data.subscription.has_stripe_subscription,
							...(data.subscription.community === undefined
								? {}
								: { community: data.subscription.community }),
						}
					: null,
				invoices: data.invoices.map((invoice) => ({
					id: invoice.id,
					status: invoice.status,
					periodStart: invoice.period_start,
					periodEnd: invoice.period_end,
					totalCents: invoice.total_cents,
					stripeHostedUrl: invoice.stripe_hosted_url,
					paidAt: invoice.paid_at,
					createdAt: invoice.created_at,
				})),
			},
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (error) {
		return handleSdkError(error);
	}
};
