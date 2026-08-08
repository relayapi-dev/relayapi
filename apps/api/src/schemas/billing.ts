import { z } from "@hono/zod-openapi";

export const BillingSubscription = z
	.object({
		status: z.enum(["trialing", "active", "past_due", "cancelled"]),
		cancel_at_period_end: z.boolean(),
		current_period_end: z.string().datetime().nullable(),
		has_stripe_customer: z.boolean(),
		has_stripe_subscription: z.boolean(),
		community: z.boolean().optional(),
	})
	.openapi("BillingSubscription");

export const BillingInvoice = z
	.object({
		id: z.string(),
		status: z.string(),
		period_start: z.string().datetime(),
		period_end: z.string().datetime(),
		total_cents: z.number().int(),
		stripe_hosted_url: z.string().url().nullable(),
		paid_at: z.string().datetime().nullable(),
		created_at: z.string().datetime(),
	})
	.openapi("BillingInvoice");

export const BillingStatusResponse = z
	.object({
		subscription: BillingSubscription.nullable(),
		invoices: z.array(BillingInvoice),
	})
	.openapi("BillingStatusResponse");

export const BillingUrlResponse = z
	.object({
		url: z.string().url(),
	})
	.openapi("BillingUrlResponse");

export const BillingSyncResponse = z
	.object({
		plan: z.enum(["free", "pro"]),
	})
	.openapi("BillingSyncResponse");
