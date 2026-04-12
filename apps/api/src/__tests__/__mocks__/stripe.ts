import type Stripe from "stripe";

// ── Mock Stripe Client ──

export function createMockStripe(overrides?: Record<string, unknown>) {
	return {
		webhooks: {
			constructEventAsync: async (
				_body: string,
				_sig: string,
				_secret: string,
			) => {
				throw new Error("constructEventAsync not configured for this test");
			},
		},
		subscriptions: {
			retrieve: async (_id: string) => createMockSubscription(),
			list: async (_params?: unknown) => ({ data: [] as any[] }),
			update: async (_id: string, _params?: unknown) =>
				createMockSubscription(),
			cancel: async (_id: string) => createMockSubscription(),
		},
		invoices: {
			list: async (_params?: unknown) => ({ data: [] as any[] }),
		},
		invoiceItems: {
			create: async (_params?: unknown) => ({ id: "ii_mock" }),
		},
		customers: {
			create: async (_params?: unknown) => ({ id: "cus_mock" }),
		},
		checkout: {
			sessions: {
				create: async (_params?: unknown) => ({
					url: "https://checkout.stripe.com/mock",
				}),
			},
		},
		billingPortal: {
			sessions: {
				create: async (_params?: unknown) => ({
					url: "https://billing.stripe.com/mock",
				}),
			},
		},
		...overrides,
	};
}

// ── Mock Stripe Objects ──

export function createMockSubscription(
	overrides?: Partial<{
		id: string;
		status: string;
		cancel_at_period_end: boolean;
		metadata: Record<string, string>;
		customer: string;
		items: { data: Array<{ current_period_start: number; current_period_end: number }> };
	}>,
) {
	const now = Math.floor(Date.now() / 1000);
	return {
		id: "sub_test_123",
		status: "active",
		cancel_at_period_end: false,
		metadata: {},
		customer: "cus_test_123",
		items: {
			data: [
				{
					current_period_start: now - 30 * 86400,
					current_period_end: now + 30 * 86400,
				},
			],
		},
		...overrides,
	};
}

// ── Stripe Event Factories ──

let eventCounter = 0;
function eventId() {
	return `evt_test_${++eventCounter}`;
}

export function createCheckoutCompletedEvent(overrides?: {
	sessionId?: string;
	subscriptionId?: string;
	customerId?: string;
	mode?: string;
	metadata?: Record<string, string>;
}): Stripe.Event {
	return {
		id: eventId(),
		type: "checkout.session.completed",
		data: {
			object: {
				id: overrides?.sessionId ?? "cs_test_123",
				mode: overrides?.mode ?? "subscription",
				subscription: overrides?.subscriptionId ?? "sub_test_123",
				customer: overrides?.customerId ?? "cus_test_123",
				metadata: overrides?.metadata ?? { organizationId: "org_test_123" },
			},
		},
	} as unknown as Stripe.Event;
}

export function createSubscriptionUpdatedEvent(overrides?: {
	subscriptionId?: string;
	status?: string;
	cancelAtPeriodEnd?: boolean;
	metadata?: Record<string, string>;
	periodStart?: number;
	periodEnd?: number;
}): Stripe.Event {
	const now = Math.floor(Date.now() / 1000);
	return {
		id: eventId(),
		type: "customer.subscription.updated",
		data: {
			object: {
				id: overrides?.subscriptionId ?? "sub_test_123",
				status: overrides?.status ?? "active",
				cancel_at_period_end: overrides?.cancelAtPeriodEnd ?? false,
				metadata: overrides?.metadata ?? {},
				items: {
					data: [
						{
							current_period_start:
								overrides?.periodStart ?? now - 30 * 86400,
							current_period_end: overrides?.periodEnd ?? now + 30 * 86400,
						},
					],
				},
			},
		},
	} as unknown as Stripe.Event;
}

export function createSubscriptionDeletedEvent(overrides?: {
	subscriptionId?: string;
}): Stripe.Event {
	const now = Math.floor(Date.now() / 1000);
	return {
		id: eventId(),
		type: "customer.subscription.deleted",
		data: {
			object: {
				id: overrides?.subscriptionId ?? "sub_test_123",
				status: "canceled",
				cancel_at_period_end: false,
				metadata: {},
				items: {
					data: [
						{
							current_period_start: now - 30 * 86400,
							current_period_end: now,
						},
					],
				},
			},
		},
	} as unknown as Stripe.Event;
}

export function createInvoiceFinalizedEvent(overrides?: {
	invoiceId?: string;
	subscriptionId?: string;
	amountDue?: number;
	hostedUrl?: string | null;
	periodStart?: number;
	periodEnd?: number;
}): Stripe.Event {
	const now = Math.floor(Date.now() / 1000);
	return {
		id: eventId(),
		type: "invoice.finalized",
		data: {
			object: {
				id: overrides?.invoiceId ?? "in_test_123",
				parent: overrides?.subscriptionId
					? {
							subscription_details: {
								subscription: overrides.subscriptionId,
							},
						}
					: {
							subscription_details: {
								subscription: "sub_test_123",
							},
						},
				amount_due: overrides?.amountDue ?? 500,
				hosted_invoice_url: overrides?.hostedUrl ?? "https://stripe.com/invoice/mock",
				period_start: overrides?.periodStart ?? now - 30 * 86400,
				period_end: overrides?.periodEnd ?? now,
			},
		},
	} as unknown as Stripe.Event;
}

export function createInvoicePaidEvent(overrides?: {
	invoiceId?: string;
	subscriptionId?: string;
}): Stripe.Event {
	return {
		id: eventId(),
		type: "invoice.paid",
		data: {
			object: {
				id: overrides?.invoiceId ?? "in_test_123",
				parent: {
					subscription_details: {
						subscription: overrides?.subscriptionId ?? "sub_test_123",
					},
				},
			},
		},
	} as unknown as Stripe.Event;
}

export function createInvoicePaymentFailedEvent(overrides?: {
	invoiceId?: string;
	subscriptionId?: string;
}): Stripe.Event {
	return {
		id: eventId(),
		type: "invoice.payment_failed",
		data: {
			object: {
				id: overrides?.invoiceId ?? "in_test_123",
				parent: {
					subscription_details: {
						subscription: overrides?.subscriptionId ?? "sub_test_123",
					},
				},
			},
		},
	} as unknown as Stripe.Event;
}
