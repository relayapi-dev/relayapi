/**
 * Pure billing logic functions extracted from Astro route handlers.
 * These accept dependencies as arguments so they can be tested without Astro.
 */

import { PRICING } from "@relayapi/config";

// ── Types ──

export interface SubscriptionRow {
	id: string;
	organizationId: string;
	status: string;
	stripeCustomerId: string | null;
	stripeSubscriptionId: string | null;
	cancelAtPeriodEnd: boolean;
	currentPeriodEnd: Date | string | null;
	monthlyPriceCents: number;
}

export interface SubscriptionData {
	status: string;
	cancelAtPeriodEnd: boolean;
	currentPeriodEnd: Date | string | null;
	hasStripeCustomer: boolean;
	hasStripeSubscription: boolean;
}

export interface InvoiceData {
	id: string;
	status: string;
	periodStart: string;
	periodEnd: string;
	totalCents: number;
	stripeHostedUrl: string | null;
	paidAt: string | null;
	createdAt: string;
}

export interface StripeLike {
	subscriptions: {
		retrieve: (id: string) => Promise<any>;
		list: (params: any) => Promise<{ data: any[] }>;
	};
	invoices: {
		list: (params: any) => Promise<{ data: any[] }>;
	};
	customers: {
		create: (params: any) => Promise<{ id: string }>;
	};
	checkout: {
		sessions: {
			create: (params: any) => Promise<{ url: string }>;
		};
	};
}

export interface DbLike {
	select: (fields?: any) => any;
	update: (table: any) => any;
	insert: (table: any) => any;
}

export interface KVLike {
	get: (key: string, opts?: any) => Promise<any>;
	put: (key: string, value: string, opts?: any) => Promise<void>;
}

// ── Status mapping ──

const STATUS_MAP: Record<string, string> = {
	active: "active",
	past_due: "past_due",
	canceled: "cancelled",
	unpaid: "past_due",
	trialing: "trialing",
	incomplete: "active",
	incomplete_expired: "cancelled",
	paused: "cancelled",
};

// ── getSubscriptionStatus ──

export async function getSubscriptionStatus(deps: {
	db: DbLike;
	stripe: StripeLike;
	orgId: string;
	sub: SubscriptionRow | null;
	orgSubsTable: any;
	eqFn: (col: any, val: any) => any;
}): Promise<{ subscription: SubscriptionData | null; invoices: InvoiceData[] }> {
	const { db, stripe, orgId, sub, orgSubsTable, eqFn } = deps;

	let subscriptionData: SubscriptionData | null = sub
		? {
				status: sub.status,
				cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
				currentPeriodEnd: sub.currentPeriodEnd,
				hasStripeCustomer: !!sub.stripeCustomerId,
				hasStripeSubscription: !!sub.stripeSubscriptionId,
			}
		: null;

	let invoices: InvoiceData[] = [];

	if (!sub?.stripeCustomerId) {
		return { subscription: subscriptionData, invoices };
	}

	// Live-sync from Stripe
	const subscriptions = await stripe.subscriptions.list({
		customer: sub.stripeCustomerId,
		limit: 1,
	});

	const stripeSub = subscriptions.data[0];

	if (stripeSub) {
		const newStatus = STATUS_MAP[stripeSub.status] || "cancelled";
		const firstItem = stripeSub.items?.data?.[0];
		const periodEnd = firstItem
			? new Date(firstItem.current_period_end * 1000)
			: null;

		// Update DB if drifted
		const dbUpdates: Record<string, any> = {};
		if (sub.status !== newStatus) dbUpdates.status = newStatus;
		if (sub.cancelAtPeriodEnd !== stripeSub.cancel_at_period_end)
			dbUpdates.cancelAtPeriodEnd = stripeSub.cancel_at_period_end;
		if (sub.stripeSubscriptionId !== stripeSub.id)
			dbUpdates.stripeSubscriptionId = stripeSub.id;
		if (periodEnd) dbUpdates.currentPeriodEnd = periodEnd;

		if (Object.keys(dbUpdates).length > 0) {
			dbUpdates.updatedAt = new Date();
			await db
				.update(orgSubsTable)
				.set(dbUpdates)
				.where(eqFn(orgSubsTable.organizationId, orgId));
		}

		subscriptionData = {
			status: newStatus,
			cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
			currentPeriodEnd: periodEnd?.toISOString() ?? sub.currentPeriodEnd,
			hasStripeCustomer: true,
			hasStripeSubscription: true,
		};
	} else {
		// No subscription in Stripe — fully cancelled
		if (sub.status !== "cancelled" || sub.stripeSubscriptionId !== null) {
			await db
				.update(orgSubsTable)
				.set({
					status: "cancelled",
					stripeSubscriptionId: null,
					cancelAtPeriodEnd: false,
					updatedAt: new Date(),
				})
				.where(eqFn(orgSubsTable.organizationId, orgId));
		}

		subscriptionData = {
			status: "cancelled",
			cancelAtPeriodEnd: false,
			currentPeriodEnd: sub.currentPeriodEnd,
			hasStripeCustomer: true,
			hasStripeSubscription: false,
		};
	}

	// Fetch invoices
	const stripeInvoices = await stripe.invoices.list({
		customer: sub.stripeCustomerId,
		limit: 12,
	});

	invoices = stripeInvoices.data.map((inv: any) => ({
		id: inv.id,
		status:
			inv.status === "paid"
				? "paid"
				: inv.status === "open"
					? "finalized"
					: inv.status || "draft",
		periodStart: new Date(inv.period_start * 1000).toISOString(),
		periodEnd: new Date(inv.period_end * 1000).toISOString(),
		totalCents: inv.amount_due,
		stripeHostedUrl: inv.hosted_invoice_url ?? null,
		paidAt:
			inv.status === "paid"
				? new Date(
						inv.status_transitions?.paid_at
							? inv.status_transitions.paid_at * 1000
							: Date.now(),
					).toISOString()
				: null,
		createdAt: new Date(inv.created * 1000).toISOString(),
	}));

	return { subscription: subscriptionData, invoices };
}

// ── syncSubscription ──

export async function syncSubscription(deps: {
	db: DbLike;
	stripe: StripeLike;
	kv: KVLike;
	orgId: string;
	sub: SubscriptionRow;
	orgSubsTable: any;
	apikeyTable: any;
	eqFn: (col: any, val: any) => any;
}): Promise<{ plan: "free" | "pro" }> {
	const { db, stripe, kv, orgId, sub, orgSubsTable, apikeyTable, eqFn } = deps;

	if (!sub.stripeCustomerId) {
		return { plan: "free" };
	}

	const SYNC_STATUS_MAP: Record<string, string> = {
		active: "active",
		past_due: "past_due",
		canceled: "cancelled",
		unpaid: "past_due",
		trialing: "trialing",
	};

	// Try by subscription ID first
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

			const newStatus = SYNC_STATUS_MAP[subscription.status] || "cancelled";
			const isPro = newStatus === "active" || newStatus === "trialing";

			await db
				.update(orgSubsTable)
				.set({
					status: newStatus,
					cancelAtPeriodEnd: subscription.cancel_at_period_end,
					currentPeriodStart: periodStart,
					currentPeriodEnd: periodEnd,
					...(newStatus === "cancelled"
						? { stripeSubscriptionId: null }
						: {}),
					updatedAt: new Date(),
				})
				.where(eqFn(orgSubsTable.organizationId, orgId));

			const plan = isPro ? "pro" : "free";
			const callsIncluded = isPro ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;
			await syncKeysToKV(db, kv, orgId, plan, callsIncluded, apikeyTable, eqFn);
			return { plan: plan as "free" | "pro" };
		} catch (err: any) {
			if (err?.statusCode === 404) {
				await db
					.update(orgSubsTable)
					.set({
						status: "cancelled",
						stripeSubscriptionId: null,
						cancelAtPeriodEnd: false,
						updatedAt: new Date(),
					})
					.where(eqFn(orgSubsTable.organizationId, orgId));

				await syncKeysToKV(db, kv, orgId, "free", PRICING.freeCallsIncluded, apikeyTable, eqFn);
				return { plan: "free" };
			}
			throw err;
		}
	}

	// No subscription ID — list active subscriptions
	const subscriptions = await stripe.subscriptions.list({
		customer: sub.stripeCustomerId,
		status: "active",
		limit: 1,
	});

	const activeSub = subscriptions.data[0];
	if (!activeSub) {
		return { plan: "free" };
	}

	const firstItem = activeSub.items?.data?.[0];
	const periodStart = firstItem
		? new Date(firstItem.current_period_start * 1000)
		: new Date();
	const periodEnd = firstItem
		? new Date(firstItem.current_period_end * 1000)
		: new Date();

	await db
		.update(orgSubsTable)
		.set({
			status: "active",
			stripeSubscriptionId: activeSub.id,
			cancelAtPeriodEnd: activeSub.cancel_at_period_end,
			currentPeriodStart: periodStart,
			currentPeriodEnd: periodEnd,
			updatedAt: new Date(),
		})
		.where(eqFn(orgSubsTable.organizationId, orgId));

	await syncKeysToKV(db, kv, orgId, "pro", PRICING.proCallsIncluded, apikeyTable, eqFn);
	return { plan: "pro" };
}

// ── Shared KV sync ──

async function syncKeysToKV(
	db: DbLike,
	kv: KVLike,
	orgId: string,
	plan: string,
	callsIncluded: number,
	apikeyTable: any,
	eqFn: (col: any, val: any) => any,
) {
	const orgKeys = await db
		.select({ key: apikeyTable.key })
		.from(apikeyTable)
		.where(eqFn(apikeyTable.organizationId, orgId));

	for (const k of orgKeys) {
		const raw = await kv.get(`apikey:${k.key}`);
		if (raw) {
			const data = typeof raw === "string" ? JSON.parse(raw) : raw;
			data.plan = plan;
			data.calls_included = callsIncluded;
			await kv.put(`apikey:${k.key}`, JSON.stringify(data));
		}
	}
}
