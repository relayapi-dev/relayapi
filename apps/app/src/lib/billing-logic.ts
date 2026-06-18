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

export interface StripeSubscriptionItem {
	current_period_start: number;
	current_period_end: number;
}

export interface StripeSubscription {
	id: string;
	status: string;
	cancel_at_period_end: boolean;
	items?: { data?: StripeSubscriptionItem[] };
}

export interface StripeInvoice {
	id: string;
	status: string | null;
	period_start: number;
	period_end: number;
	amount_due: number;
	hosted_invoice_url?: string | null;
	status_transitions?: { paid_at?: number | null };
	created: number;
}

export interface StripeLike {
	subscriptions: {
		retrieve: (id: string) => Promise<StripeSubscription>;
		list: (params: Record<string, unknown>) => Promise<{
			data: StripeSubscription[];
		}>;
	};
	invoices: {
		list: (params: Record<string, unknown>) => Promise<{
			data: StripeInvoice[];
		}>;
	};
	customers: {
		create: (params: Record<string, unknown>) => Promise<{ id: string }>;
	};
	checkout: {
		sessions: {
			create: (params: Record<string, unknown>) => Promise<{ url: string }>;
		};
	};
}

export interface DbLike {
	select: (fields?: unknown) => DbQuery;
	update: (table: unknown) => DbQuery;
	insert: (table: unknown) => DbQuery;
}

// Loose fluent query builder shape: each step returns a thenable/awaitable
// builder, matching Drizzle's chained API closely enough for these helpers.
// `then` makes the builder awaitable; awaiting resolves to the row array.
export interface DbQuery {
	from: (table: unknown) => DbQuery;
	where: (cond: unknown) => DbQuery;
	set: (values: Record<string, unknown>) => DbQuery;
	then: (resolve: (rows: unknown[]) => void) => void;
}

export interface KVLike {
	get: (key: string, opts?: unknown) => Promise<unknown>;
	put: (key: string, value: string, opts?: unknown) => Promise<void>;
}

// Drizzle tables expose their columns as dynamic properties (e.g.
// `table.organizationId`), so a string-indexed record is the closest portable
// shape without depending on the concrete schema types here.
export type TableLike = Record<string, unknown>;

export type EqFn = (col: unknown, val: unknown) => unknown;

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
	orgSubsTable: TableLike;
	eqFn: EqFn;
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
		const dbUpdates: Record<string, unknown> = {};
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

	invoices = stripeInvoices.data.map((inv) => ({
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
	orgSubsTable: TableLike;
	apikeyTable: TableLike;
	eqFn: EqFn;
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
		} catch (err) {
			if (
				err &&
				typeof err === "object" &&
				"statusCode" in err &&
				(err as { statusCode?: number }).statusCode === 404
			) {
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
	apikeyTable: TableLike,
	eqFn: EqFn,
) {
	const orgKeys = (await db
		.select({ key: apikeyTable.key })
		.from(apikeyTable)
		.where(eqFn(apikeyTable.organizationId, orgId))) as Array<{
		key: string;
	}>;

	for (const k of orgKeys) {
		const raw = await kv.get(`apikey:${k.key}`);
		if (raw) {
			const data: Record<string, unknown> =
				typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>);
			data.plan = plan;
			data.calls_included = callsIncluded;
			// Mirror the API's apikey:* KV TTL convention (24h) so a rewritten auth
			// record still expires as a revocation backstop instead of persisting
			// indefinitely; the API middleware re-hydrates it from the DB on first use.
			await kv.put(`apikey:${k.key}`, JSON.stringify(data), {
				expirationTtl: 86400,
			});
		}
	}
}
