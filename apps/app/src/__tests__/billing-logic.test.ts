import { describe, it, expect } from "bun:test";
import {
	getSubscriptionStatus,
	syncSubscription,
	type SubscriptionRow,
	type StripeLike,
	type StripeSubscription,
	type DbLike,
	type KVLike,
} from "../lib/billing-logic";

// ── Minimal mock DB ──

interface MockChain {
	from: () => MockChain;
	where: () => MockChain;
	limit: () => MockChain;
	set: (vals: Record<string, unknown>) => MockChain;
	then: (resolve: (v: unknown[]) => void) => void;
}

function createMockDb(): DbLike & {
	_updates: Array<{ set: Record<string, unknown> }>;
} {
	const updates: Array<{ set: Record<string, unknown> }> = [];

	function chain(): MockChain {
		const c: MockChain = {
			from: () => c,
			where: () => c,
			limit: () => c,
			set: (vals: Record<string, unknown>) => {
				updates.push({ set: vals });
				return c;
			},
			// biome-ignore lint/suspicious/noThenProperty: mock mimics Drizzle's awaitable query builder; the production code awaits this chain.
			then: (resolve: (v: unknown[]) => void) => resolve([]),
		};
		return c;
	}

	return {
		// Every branch resolves to an empty result set ([]) via the chain's
		// `then`, matching the apikey lookup's "no keys" default.
		select: () => chain(),
		update: () => chain(),
		insert: () => chain(),
		_updates: updates,
	};
}

// ── Minimal mock Stripe ──

function createMockStripe(overrides?: Partial<StripeLike>): StripeLike {
	return {
		subscriptions: {
			retrieve: async () => mockStripeSubscription(),
			list: async () => ({ data: [] }),
		},
		invoices: {
			list: async () => ({ data: [] }),
		},
		customers: {
			create: async () => ({ id: "cus_mock" }),
		},
		checkout: {
			sessions: {
				create: async () => ({ url: "https://mock.stripe.com" }),
			},
		},
		...overrides,
	};
}

// ── Minimal mock KV ──

function createMockKV(): KVLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	};
}

// ── Mock table/eq ──

const orgSubsTable = {
	organizationId: { name: "organizationId" },
	id: { name: "id" },
};

const apikeyTable = {
	key: { name: "key" },
	organizationId: { name: "organizationId" },
};

const eqFn = (col: unknown, val: unknown) => ({
	_filter: (row: Record<string, unknown>) => {
		const key =
			col && typeof col === "object" && "name" in col
				? (col as { name: string }).name
				: String(col);
		return row[key] === val;
	},
});

// ── Helpers ──

function baseSub(overrides?: Partial<SubscriptionRow>): SubscriptionRow {
	return {
		id: "sub_row_1",
		organizationId: "org_test",
		status: "active",
		stripeCustomerId: "cus_test",
		stripeSubscriptionId: "sub_test",
		cancelAtPeriodEnd: false,
		currentPeriodEnd: new Date().toISOString(),
		monthlyPriceCents: 500,
		...overrides,
	};
}

const now = Math.floor(Date.now() / 1000);

function mockStripeSubscription(
	overrides?: Partial<StripeSubscription>,
): StripeSubscription {
	return {
		id: "sub_test",
		status: "active",
		cancel_at_period_end: false,
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

// ── Tests ──

describe("getSubscriptionStatus", () => {
	it("returns null subscription when no DB record", async () => {
		const db = createMockDb();
		const stripe = createMockStripe();

		const result = await getSubscriptionStatus({
			db,
			stripe,
			orgId: "org_test",
			sub: null,
			orgSubsTable,
			eqFn,
		});

		expect(result.subscription).toBeNull();
		expect(result.invoices).toEqual([]);
	});

	it("live-syncs from Stripe and detects status drift", async () => {
		const db = createMockDb();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => mockStripeSubscription(),
				list: async () => ({
					data: [
						mockStripeSubscription({
							status: "canceled",
							cancel_at_period_end: false,
						}),
					],
				}),
			},
		});

		const sub = baseSub({ status: "active" });

		const result = await getSubscriptionStatus({
			db,
			stripe,
			orgId: "org_test",
			sub,
			orgSubsTable,
			eqFn,
		});

		// Should detect drift and return cancelled
		if (!result.subscription) throw new Error("expected subscription");
		expect(result.subscription.status).toBe("cancelled");
		expect(result.subscription.cancelAtPeriodEnd).toBe(false);

		// Should have triggered a DB update
		expect(db._updates.length).toBeGreaterThan(0);
		const update0 = db._updates[0];
		if (!update0) throw new Error("expected DB update");
		expect(update0.set.status).toBe("cancelled");
	});

	it("detects cancel_at_period_end from Stripe", async () => {
		const db = createMockDb();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => mockStripeSubscription(),
				list: async () => ({
					data: [
						mockStripeSubscription({
							status: "active",
							cancel_at_period_end: true,
						}),
					],
				}),
			},
		});

		const sub = baseSub({ cancelAtPeriodEnd: false });

		const result = await getSubscriptionStatus({
			db,
			stripe,
			orgId: "org_test",
			sub,
			orgSubsTable,
			eqFn,
		});

		if (!result.subscription) throw new Error("expected subscription");
		expect(result.subscription.status).toBe("active");
		expect(result.subscription.cancelAtPeriodEnd).toBe(true);
		expect(db._updates.length).toBeGreaterThan(0);
		const update0 = db._updates[0];
		if (!update0) throw new Error("expected DB update");
		expect(update0.set.cancelAtPeriodEnd).toBe(true);
	});

	it("handles empty Stripe subscription list (fully cancelled)", async () => {
		const db = createMockDb();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => mockStripeSubscription(),
				list: async () => ({ data: [] }),
			},
		});

		const sub = baseSub({ status: "active" });

		const result = await getSubscriptionStatus({
			db,
			stripe,
			orgId: "org_test",
			sub,
			orgSubsTable,
			eqFn,
		});

		if (!result.subscription) throw new Error("expected subscription");
		expect(result.subscription.status).toBe("cancelled");
		expect(result.subscription.hasStripeSubscription).toBe(false);

		// Should update DB to cancelled
		expect(db._updates.length).toBeGreaterThan(0);
		const update0 = db._updates[0];
		if (!update0) throw new Error("expected DB update");
		expect(update0.set.status).toBe("cancelled");
		expect(update0.set.stripeSubscriptionId).toBeNull();
	});

	it("returns mapped invoices from Stripe", async () => {
		const db = createMockDb();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => mockStripeSubscription(),
				list: async () => ({
					data: [mockStripeSubscription()],
				}),
			},
			invoices: {
				list: async () => ({
					data: [
						{
							id: "in_123",
							status: "paid",
							period_start: now - 30 * 86400,
							period_end: now,
							amount_due: 500,
							hosted_invoice_url: "https://stripe.com/inv/123",
							status_transitions: { paid_at: now },
							created: now - 30 * 86400,
						},
					],
				}),
			},
		});

		const sub = baseSub();

		const result = await getSubscriptionStatus({
			db,
			stripe,
			orgId: "org_test",
			sub,
			orgSubsTable,
			eqFn,
		});

		expect(result.invoices).toHaveLength(1);
		const invoice0 = result.invoices[0];
		if (!invoice0) throw new Error("expected invoice");
		expect(invoice0.id).toBe("in_123");
		expect(invoice0.status).toBe("paid");
		expect(invoice0.totalCents).toBe(500);
		expect(invoice0.stripeHostedUrl).toBe("https://stripe.com/inv/123");
	});
});

describe("syncSubscription", () => {
	it("syncs active subscription to pro", async () => {
		const db = createMockDb();
		const kv = createMockKV();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => mockStripeSubscription(),
				list: async () => ({ data: [] }),
			},
		});

		const sub = baseSub();

		const result = await syncSubscription({
			db,
			stripe,
			kv,
			orgId: "org_test",
			sub,
			orgSubsTable,
			apikeyTable,
			eqFn,
		});

		expect(result.plan).toBe("pro");
		expect(db._updates.length).toBeGreaterThan(0);
	});

	it("handles 404 for deleted subscription", async () => {
		const db = createMockDb();
		const kv = createMockKV();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => {
					const err = new Error("Not found") as Error & {
						statusCode?: number;
					};
					err.statusCode = 404;
					throw err;
				},
				list: async () => ({ data: [] }),
			},
		});

		const sub = baseSub();

		const result = await syncSubscription({
			db,
			stripe,
			kv,
			orgId: "org_test",
			sub,
			orgSubsTable,
			apikeyTable,
			eqFn,
		});

		expect(result.plan).toBe("free");
		// Should have updated DB to cancelled
		expect(db._updates.length).toBeGreaterThan(0);
		const update0 = db._updates[0];
		if (!update0) throw new Error("expected DB update");
		expect(update0.set.status).toBe("cancelled");
		expect(update0.set.stripeSubscriptionId).toBeNull();
	});

	it("finds new active subscription when no ID stored", async () => {
		const db = createMockDb();
		const kv = createMockKV();
		const stripe = createMockStripe({
			subscriptions: {
				retrieve: async () => mockStripeSubscription(),
				list: async () => ({
					data: [mockStripeSubscription({ id: "sub_new" })],
				}),
			},
		});

		const sub = baseSub({ stripeSubscriptionId: null });

		const result = await syncSubscription({
			db,
			stripe,
			kv,
			orgId: "org_test",
			sub,
			orgSubsTable,
			apikeyTable,
			eqFn,
		});

		expect(result.plan).toBe("pro");
		expect(db._updates.length).toBeGreaterThan(0);
		const update0 = db._updates[0];
		if (!update0) throw new Error("expected DB update");
		expect(update0.set.stripeSubscriptionId).toBe("sub_new");
	});

	it("returns free when no subscription at all", async () => {
		const db = createMockDb();
		const kv = createMockKV();
		const stripe = createMockStripe();

		const sub = baseSub({ stripeCustomerId: null });

		const result = await syncSubscription({
			db,
			stripe,
			kv,
			orgId: "org_test",
			sub,
			orgSubsTable,
			apikeyTable,
			eqFn,
		});

		expect(result.plan).toBe("free");
	});
});
