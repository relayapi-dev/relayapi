import { describe, expect, it } from "bun:test";
import {
	assertStableProviderInventories,
	canonicalProviderInventory,
	captureProviderInventory,
	captureTelnyxFutureMoneyAllocations,
	providerInventorySha256,
	stripeApiKeyIsLive,
	telnyxApiKeyFingerprint,
} from "../../scripts/prelive-provider-inventory";

async function* rows<T>(values: T[]): AsyncGenerator<T> {
	for (const value of values) yield value;
}

const noMetaSources = {
	socialAccounts: [],
	adAccounts: [],
	adCampaigns: [],
	whatsappPhoneNumbers: [],
};

const metaSystemAuthority = {
	businessId: "business_1",
	accessToken: "system-user-token",
};

const stripeAttestations = {
	bankTransferFundingInstructions: "never_enabled" as const,
	legacyReceiverSources: "never_enabled" as const,
	connect: "never_enabled" as const,
	livePricingTables: "none" as const,
	accountDedicatedToRelayapi: true as const,
	unsupportedProductsDisabled: true as const,
};

const telnyxAttestations = {
	accountDedicatedToRelayapi: true as const,
	unsupportedProductsDisabled: true as const,
	scheduledPayments: "disabled" as const,
	autoRecharge: "disabled" as const,
};

const metaAttestations = {
	whatsappOutstandingInvoicesZero: true as const,
	whatsappAutomaticPaymentsDisabled: true as const,
};

const emptyTelnyxFutureMoney = {
	balance: {
		balance: "0.00",
		pending: "0.00",
		creditLimit: "100.00",
		availableCredit: "100.00",
		currency: "USD",
	},
	numberBlockOrders: [],
	advancedOrders: [],
	inexplicitNumberOrders: [],
	portingOrders: [],
	portingPhoneNumbers: [],
	portOuts: [],
};

const emptyMetaGraphFetch = Object.assign(
	async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/business_1")) {
			return Response.json({ id: "business_1" });
		}
		return Response.json({ data: [] });
	},
	{ preconnect: fetch.preconnect },
);

function testFetch(
	handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, { preconnect: fetch.preconnect });
}

function emptyStripe() {
	const empty = () => rows([]);
	return {
		accounts: {
			retrieveCurrent: async () => ({
				id: "acct_relayapi",
				settings: {
					payouts: {
						debit_negative_balances: false,
						schedule: { interval: "manual" },
					},
				},
			}),
		},
		customers: {
			list: empty,
			retrieveCashBalance: async () => ({ livemode: true, available: null }),
		},
		subscriptions: { list: empty },
		checkout: { sessions: { list: empty } },
		invoices: { list: empty },
		invoiceItems: { list: empty },
		subscriptionSchedules: { list: empty },
		paymentIntents: { list: empty },
		charges: { list: empty },
		refunds: { list: empty },
		disputes: { list: empty },
		paymentLinks: { list: empty },
		setupIntents: { list: empty },
		topups: { list: empty },
		payouts: { list: empty },
		balance: {
			retrieve: async () => ({
				livemode: true,
				available: [],
				pending: [],
				connect_reserved: [],
			}),
		},
		balanceSettings: {
			retrieve: async () => ({
				payments: {
					debit_negative_balances: false,
					payouts: {
						status: "enabled",
						schedule: { interval: "manual" },
						automatic_transfer_rules_by_currency: {},
					},
				},
			}),
		},
	};
}

function providerDefaults(credentialSha256: string) {
	return {
		stripeLivemode: true,
		expectedStripeAccountId: "acct_relayapi",
		stripeTerminalReversalPolicy: "accept_network_reversal_tail" as const,
		stripeAttestations,
		serverPriceIds: new Set(["price_base"]),
		telnyxNumbers: [],
		telnyxNumberOrders: [],
		telnyxFutureMoney: emptyTelnyxFutureMoney,
		telnyxCredentialSha256: credentialSha256,
		expectedTelnyxCredentialSha256: credentialSha256,
		telnyxAttestations,
		metaAttestations,
		metaSources: noMetaSources,
		metaSystemAuthority,
		graphFetch: emptyMetaGraphFetch,
		encryptionKey: "unused-without-meta-authorities",
	};
}

describe("pre-live external-provider inventory", () => {
	it("blocks every account-wide provider resource that can still mutate money", async () => {
		const stripe = {
			...emptyStripe(),
			accounts: {
				retrieveCurrent: async () => ({
					id: "acct_relayapi",
					country: "US",
					default_currency: "usd",
					settings: {
						payouts: {
							debit_negative_balances: false,
							schedule: { interval: "manual" },
						},
					},
				}),
			},
			customers: {
				list: () =>
					rows([
						{
							id: "cus_managed",
							balance: 0,
							currency: "usd",
							invoice_credit_balance: {},
							metadata: { organizationId: "org_1" },
						},
					]),
				retrieveCashBalance: async () => ({
					livemode: true,
					available: null,
				}),
			},
			subscriptions: {
				list: () =>
					rows([
						{
							id: "sub_active",
							customer: "cus_managed",
							status: "active",
							metadata: {
								relayapi_managed_by: "relayapi",
								relayapi_role: "base",
								organizationId: "org_1",
							},
							items: {
								data: [
									{
										id: "si_base",
										price: { id: "price_base" },
										quantity: 1,
									},
								],
							},
						},
						{
							id: "sub_terminal",
							customer: "cus_managed",
							status: "canceled",
							items: { data: [] },
						},
					]),
			},
			checkout: {
				sessions: {
					list: () =>
						rows([
							{
								id: "cs_open",
								customer: "cus_managed",
								subscription: null,
								status: "open",
								payment_status: "unpaid",
								mode: "subscription",
							},
						]),
				},
			},
			invoices: {
				list: ({ status }: { status: "draft" | "open" }) =>
					rows(
						status === "draft"
							? [
									{
										id: "in_draft",
										customer: "cus_managed",
										subscription: "sub_active",
										status,
										currency: "usd",
										amount_due: 100,
									},
								]
							: [],
					),
			},
			invoiceItems: {
				list: () =>
					rows([
						{
							id: "ii_pending",
							customer: "cus_managed",
							invoice: null,
							subscription: "sub_active",
							currency: "usd",
							amount: 100,
						},
					]),
			},
			subscriptionSchedules: {
				list: () =>
					rows([
						{
							id: "sub_sched_active",
							customer: "cus_managed",
							status: "active",
							subscription: "sub_active",
						},
					]),
			},
			paymentIntents: {
				list: () =>
					rows([
						{
							id: "pi_processing",
							customer: "cus_managed",
							status: "processing",
							amount: 100,
							currency: "usd",
						},
					]),
			},
			refunds: {
				list: () =>
					rows([
						{
							id: "re_pending",
							status: "pending",
							amount: 100,
							currency: "usd",
							charge: "ch_1",
							payment_intent: "pi_processing",
						},
					]),
			},
			disputes: {
				list: () =>
					rows([
						{
							id: "dp_open",
							status: "needs_response",
							amount: 100,
							currency: "usd",
							charge: "ch_1",
							payment_intent: "pi_processing",
						},
					]),
			},
		};

		const inventory = await captureProviderInventory({
			...providerDefaults("a".repeat(64)),
			stripe,
			telnyxNumbers: [
				{
					id: "tel_phone_1",
					phoneNumber: "+12025550123",
					status: "active",
					customerReference: "relayapi",
				},
			],
			telnyxNumberOrders: [
				{
					id: "order_pending",
					status: "pending",
					customerReference: "relayapi",
					phoneNumbers: ["+12025550124"],
					updatedAt: "2026-07-31T12:00:00Z",
				},
			],
		});

		expect(
			inventory.blockingResources.map(
				(resource) => `${resource.provider}:${resource.kind}:${resource.id}`,
			),
		).toEqual([
			"stripe:checkout_session:cs_open",
			"stripe:collectible_invoice:in_draft",
			"stripe:dispute:dp_open",
			"stripe:payment_intent:pi_processing",
			"stripe:pending_invoice_item:ii_pending",
			"stripe:refund:re_pending",
			"stripe:subscription_schedule:sub_sched_active",
			"stripe:subscription:sub_active",
			"telnyx:number_order:order_pending",
			"telnyx:owned_phone_number:tel_phone_1",
		]);
		expect(inventory.stripe.subscriptions).toHaveLength(2);
		expect(inventory.stripe.subscriptions[0]?.managed).toBe(true);
		expect(inventory.telnyx.phoneNumbers[0]?.phoneNumberSha256).toMatch(
			/^[0-9a-f]{64}$/,
		);
		expect(canonicalProviderInventory(inventory)).not.toContain("+12025550123");
		expect(providerInventorySha256(inventory)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces a stable empty blocking set only after provider readback is empty", async () => {
		const inventory = await captureProviderInventory({
			...providerDefaults("b".repeat(64)),
			stripe: emptyStripe(),
		});

		expect(inventory.blockingResources).toEqual([]);
		expect(canonicalProviderInventory(inventory)).toBe(
			canonicalProviderInventory(inventory),
		);
		expect(() =>
			assertStableProviderInventories(inventory, inventory),
		).not.toThrow();
		const changed = structuredClone(inventory);
		changed.stripe.account.defaultCurrency = "eur";
		expect(() => assertStableProviderInventories(inventory, changed)).toThrow(
			"changed between consecutive complete captures",
		);
	});

	it("treats conflicting configured/effective Meta state as nonterminal", async () => {
		const graphFetch = Object.assign(
			async (input: RequestInfo | URL): Promise<Response> => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/business_1")) {
					return Response.json({ id: "business_1" });
				}
				if (url.pathname.endsWith("/me/adaccounts")) {
					return Response.json({
						data: [
							{
								id: "act_1",
								account_status: 1,
								currency: "USD",
								balance: "0",
							},
						],
					});
				}
				if (url.pathname.endsWith("/act_1/campaigns")) {
					return Response.json({
						data: [
							{
								id: "campaign_1",
								status: "ARCHIVED",
								effective_status: "ACTIVE",
							},
						],
					});
				}
				return Response.json({ data: [] });
			},
			{ preconnect: fetch.preconnect },
		);
		const inventory = await captureProviderInventory({
			...providerDefaults("c".repeat(64)),
			stripe: emptyStripe(),
			graphFetch,
		});

		expect(inventory.meta.campaigns[0]?.terminal).toBe(false);
		expect(inventory.blockingResources).toContainEqual({
			provider: "meta",
			kind: "ad_campaign",
			id: "campaign_1",
			status: "ACTIVE",
			managed: true,
		});
	});

	it("sorts local authority sources and blocks retained credential gaps", async () => {
		const phones = [
			{
				id: "phone_b",
				organizationId: "org_1",
				socialAccountId: null,
				providerNumberId: null,
				waPhoneNumberId: null,
				status: "released",
			},
			{
				id: "phone_a",
				organizationId: "org_1",
				socialAccountId: null,
				providerNumberId: null,
				waPhoneNumberId: null,
				status: "released",
			},
		];
		const source = {
			...noMetaSources,
			socialAccounts: [
				{
					id: "social_inactive",
					organizationId: "org_1",
					platform: "whatsapp",
					accessToken: null,
					tokenVersion: 1,
					metadata: { waba_id: "waba_orphan" },
					lifecycleStatus: "disconnected",
				},
			],
			whatsappPhoneNumbers: phones,
		};
		const capture = (whatsappPhoneNumbers: typeof phones) =>
			captureProviderInventory({
				...providerDefaults("d".repeat(64)),
				stripe: emptyStripe(),
				metaSources: { ...source, whatsappPhoneNumbers },
			});

		const forward = await capture(phones);
		const reverse = await capture([...phones].reverse());
		expect(forward.meta.sourceRowsSha256).toBe(reverse.meta.sourceRowsSha256);
		expect(forward.blockingResources).toContainEqual({
			provider: "meta",
			kind: "whatsapp_authority_gap",
			id: "social_inactive",
			status: "missing_access_token",
			managed: true,
		});
	});

	it("rejects non-live or unexpected provider identities before inventory approval", async () => {
		expect(stripeApiKeyIsLive("sk_live_secret")).toBe(true);
		expect(stripeApiKeyIsLive("rk_live_restricted")).toBe(true);
		expect(stripeApiKeyIsLive("sk_test_secret")).toBe(false);
		expect(stripeApiKeyIsLive("pk_live_publishable")).toBe(false);
		const fingerprint = telnyxApiKeyFingerprint("KEY-example");
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(fingerprint).toBe(telnyxApiKeyFingerprint("KEY-example"));

		await expect(
			captureProviderInventory({
				...providerDefaults("e".repeat(64)),
				stripe: emptyStripe(),
				stripeLivemode: false,
			}),
		).rejects.toThrow("live-mode API key");
		await expect(
			captureProviderInventory({
				...providerDefaults("f".repeat(64)),
				stripe: emptyStripe(),
				expectedStripeAccountId: "acct_wrong",
			}),
		).rejects.toThrow("Stripe account identity mismatch");
		await expect(
			captureProviderInventory({
				...providerDefaults("1".repeat(64)),
				stripe: emptyStripe(),
				expectedTelnyxCredentialSha256: "2".repeat(64),
			}),
		).rejects.toThrow("Telnyx API-key fingerprint mismatch");
	});

	it("blocks every newly inventoried Stripe money surface and unsafe account setting", async () => {
		const stripe = {
			...emptyStripe(),
			customers: {
				list: () =>
					rows([
						{
							id: "cus_cash",
							balance: -10,
							currency: "usd",
							invoice_credit_balance: { eur: 20 },
							metadata: {},
						},
					]),
				retrieveCashBalance: async () => ({
					livemode: true,
					available: { usd: 25 },
				}),
			},
			paymentLinks: {
				list: () => rows([{ id: "plink_active", active: true, metadata: {} }]),
			},
			charges: {
				list: () =>
					rows([
						{
							id: "ch_uncaptured",
							amount: 100,
							amount_captured: 0,
							amount_refunded: 0,
							currency: "usd",
							status: "pending",
							paid: true,
							captured: false,
							disputed: false,
							refunded: false,
							customer: "cus_cash",
							payment_intent: null,
						},
					]),
			},
			setupIntents: {
				list: () =>
					rows([
						{
							id: "seti_processing",
							customer: "cus_cash",
							status: "processing",
							payment_method_types: ["us_bank_account"],
						},
					]),
			},
			topups: {
				list: () =>
					rows([
						{
							id: "tu_pending",
							status: "pending",
							amount: 50,
							currency: "usd",
						},
					]),
			},
			payouts: {
				list: () =>
					rows([
						{
							id: "po_transit",
							status: "in_transit",
							amount: 60,
							currency: "usd",
							automatic: true,
						},
					]),
			},
			balance: {
				retrieve: async () => ({
					livemode: true,
					available: [{ currency: "usd", amount: 1 }],
					pending: [{ currency: "eur", amount: 2 }],
					connect_reserved: [{ currency: "gbp", amount: 3 }],
				}),
			},
			balanceSettings: {
				retrieve: async () => ({
					payments: {
						debit_negative_balances: true,
						payouts: {
							status: "enabled",
							schedule: { interval: "daily" },
							automatic_transfer_rules_by_currency: { usd: [{}] },
						},
					},
				}),
			},
		};
		const inventory = await captureProviderInventory({
			...providerDefaults("3".repeat(64)),
			stripe,
		});
		const kinds = new Set(
			inventory.blockingResources
				.filter((resource) => resource.provider === "stripe")
				.map((resource) => resource.kind),
		);
		for (const kind of [
			"automatic_payout_schedule",
			"automatic_negative_balance_debit",
			"automatic_balance_transfer_rule",
			"available_balance",
			"pending_balance",
			"connect_reserved_balance",
			"customer_cash_balance",
			"customer_invoice_balance",
			"customer_invoice_credit_balance",
			"charge",
			"payment_link",
			"setup_intent",
			"topup",
			"payout",
		]) {
			expect(kinds).toContain(kind);
		}
	});

	it("makes the Stripe terminal network-reversal tail an explicit policy choice", async () => {
		const stripe = {
			...emptyStripe(),
			paymentIntents: {
				list: () =>
					rows([
						{
							id: "pi_succeeded",
							customer: null,
							status: "succeeded",
							amount: 100,
							currency: "usd",
						},
					]),
			},
			charges: {
				list: () =>
					rows([
						{
							id: "ch_paid",
							customer: null,
							payment_intent: null,
							amount: 100,
							amount_captured: 100,
							amount_refunded: 0,
							currency: "usd",
							status: "succeeded",
							paid: true,
							captured: true,
							disputed: false,
							refunded: false,
						},
					]),
			},
			refunds: {
				list: () =>
					rows([
						{
							id: "re_succeeded",
							status: "succeeded",
							amount: 100,
							currency: "usd",
							charge: "ch_paid",
							payment_intent: "pi_succeeded",
						},
					]),
			},
			disputes: {
				list: () =>
					rows([
						{
							id: "dp_lost",
							status: "lost",
							amount: 100,
							currency: "usd",
							charge: "ch_paid",
							payment_intent: "pi_succeeded",
						},
					]),
			},
			topups: {
				list: () =>
					rows([
						{
							id: "tu_succeeded",
							status: "succeeded",
							amount: 100,
							currency: "usd",
						},
					]),
			},
			payouts: {
				list: () =>
					rows([
						{
							id: "po_paid",
							status: "paid",
							amount: 100,
							currency: "usd",
						},
					]),
			},
		};
		const accepting = await captureProviderInventory({
			...providerDefaults("4".repeat(64)),
			stripe,
		});
		expect(accepting.blockingResources).toEqual([]);

		const blocking = await captureProviderInventory({
			...providerDefaults("4".repeat(64)),
			stripe,
			stripeTerminalReversalPolicy: "block_terminal_history",
		});
		expect(blocking.blockingResources.map((resource) => resource.kind)).toEqual(
			["charge", "dispute", "payment_intent", "payout", "refund", "topup"],
		);
	});

	it("rejects duplicate Stripe Charge history", async () => {
		const duplicate = {
			id: "ch_duplicate",
			amount: 100,
			amount_captured: 100,
			amount_refunded: 0,
			currency: "usd",
			status: "succeeded",
			paid: true,
			captured: true,
			disputed: false,
			refunded: false,
			customer: null,
			payment_intent: null,
		};
		await expect(
			captureProviderInventory({
				...providerDefaults("b".repeat(64)),
				stripe: {
					...emptyStripe(),
					charges: { list: () => rows([duplicate, duplicate]) },
				},
			}),
		).rejects.toThrow(
			"Stripe charge inventory returned duplicate ch_duplicate",
		);
	});

	it("follows Meta paging after an empty page and preserves CurrencyAmount evidence", async () => {
		const requests: Array<{ url: URL; authorization: string | null }> = [];
		const graphFetch = testFetch(async (input, init) => {
			const url = new URL(String(input));
			requests.push({
				url,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			if (url.pathname.endsWith("/business_1")) {
				return Response.json({ id: "business_1" });
			}
			if (url.pathname.endsWith("/business_1/extendedcredits")) {
				return Response.json({
					data: [
						{
							id: "credit_zero",
							balance: { amount: "0", currency: "USD" },
							credit_available: { amount: "50", currency: "USD" },
							credit_type: "ADS",
						},
						{
							id: "credit_due",
							balance: { amount: "12.50", currency: "USD" },
							credit_available: { amount: "37.50", currency: "USD" },
							credit_type: "WHATSAPP",
						},
					],
				});
			}
			if (url.pathname.endsWith("/me/adaccounts")) {
				if (!url.searchParams.has("after")) {
					const next = new URL(url);
					next.searchParams.set("after", "cursor_2");
					next.searchParams.set("access_token", "must-not-leak");
					return Response.json({
						data: [],
						paging: {
							cursors: { after: "cursor_2" },
							next: next.href,
						},
					});
				}
				return Response.json({
					data: [
						{
							id: "act_paged",
							account_status: 1,
							currency: "USD",
							balance: "0",
						},
					],
				});
			}
			return Response.json({ data: [] });
		});
		const inventory = await captureProviderInventory({
			...providerDefaults("5".repeat(64)),
			stripe: emptyStripe(),
			graphFetch,
		});

		expect(inventory.meta.adAccounts.map((account) => account.id)).toEqual([
			"act_paged",
		]);
		expect(inventory.meta.extendedCredits[0]?.balance).toEqual({
			amount: "12.50",
			currency: "USD",
		});
		expect(inventory.blockingResources).toContainEqual({
			provider: "meta",
			kind: "extended_credit_balance",
			id: "credit_due:USD",
			status: "12.50",
			managed: true,
		});
		const secondPage = requests.find((request) =>
			request.url.searchParams.has("after"),
		);
		expect(secondPage?.url.searchParams.has("access_token")).toBe(false);
		expect(secondPage?.authorization).toBe("Bearer system-user-token");
	});

	it("fails closed on malformed Meta CurrencyAmount and unsafe pagination", async () => {
		const malformedCurrencyFetch = testFetch(async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/business_1")) {
				return Response.json({ id: "business_1" });
			}
			if (url.pathname.endsWith("/business_1/extendedcredits")) {
				return Response.json({
					data: [
						{
							id: "credit_bad",
							balance: "0",
							credit_available: { amount: "1", currency: "USD" },
						},
					],
				});
			}
			return Response.json({ data: [] });
		});
		await expect(
			captureProviderInventory({
				...providerDefaults("6".repeat(64)),
				stripe: emptyStripe(),
				graphFetch: malformedCurrencyFetch,
			}),
		).rejects.toThrow("invalid CurrencyAmount");

		const unsafePageFetch = testFetch(async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/business_1")) {
				return Response.json({ id: "business_1" });
			}
			if (url.pathname.endsWith("/me/adaccounts")) {
				return Response.json({
					data: [],
					paging: {
						cursors: { after: "cursor_2" },
						next: "https://attacker.example/me/adaccounts?after=cursor_2",
					},
				});
			}
			return Response.json({ data: [] });
		});
		await expect(
			captureProviderInventory({
				...providerDefaults("7".repeat(64)),
				stripe: emptyStripe(),
				graphFetch: unsafePageFetch,
			}),
		).rejects.toThrow("unsafe pagination link");

		const duplicatePageFetch = testFetch(async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/business_1")) {
				return Response.json({ id: "business_1" });
			}
			if (url.pathname.endsWith("/me/adaccounts")) {
				const account = {
					id: "act_duplicate",
					account_status: 1,
					currency: "USD",
					balance: "0",
				};
				if (url.searchParams.has("after")) {
					return Response.json({ data: [account] });
				}
				const next = new URL(url);
				next.searchParams.set("after", "cursor_2");
				return Response.json({
					data: [account],
					paging: {
						cursors: { after: "cursor_2" },
						next: next.href,
					},
				});
			}
			return Response.json({ data: [] });
		});
		await expect(
			captureProviderInventory({
				...providerDefaults("9".repeat(64)),
				stripe: emptyStripe(),
				graphFetch: duplicatePageFetch,
			}),
		).rejects.toThrow("duplicate provider ID act_duplicate");
	});

	it("blocks unsettled Meta ad-account balance and status independently", async () => {
		const graphFetch = testFetch(async (input) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/business_1")) {
				return Response.json({ id: "business_1" });
			}
			if (url.pathname.endsWith("/me/adaccounts")) {
				return Response.json({
					data: [
						{
							id: "act_unsettled",
							account_status: 3,
							currency: "USD",
							balance: "10.00",
						},
					],
				});
			}
			return Response.json({ data: [] });
		});
		const inventory = await captureProviderInventory({
			...providerDefaults("a".repeat(64)),
			stripe: emptyStripe(),
			graphFetch,
		});
		expect(inventory.blockingResources).toContainEqual({
			provider: "meta",
			kind: "ad_account_balance",
			id: "act_unsettled",
			status: "10.00",
			managed: true,
		});
		expect(inventory.blockingResources).toContainEqual({
			provider: "meta",
			kind: "ad_account_settlement_status",
			id: "act_unsettled",
			status: "3",
			managed: true,
		});
	});

	it("captures every documented Telnyx future-allocation family with strict metadata", async () => {
		const requested = new Map<string, URL>();
		const fetcher = testFetch(async (input) => {
			const url = new URL(String(input));
			requested.set(url.pathname, url);
			if (url.pathname.endsWith("/balance")) {
				return Response.json({
					data: {
						balance: "0.00",
						pending: "0.00",
						credit_limit: "100.00",
						available_credit: "100.00",
						currency: "USD",
					},
				});
			}
			const pageSize = Number(
				url.searchParams.get("page[size]") ??
					url.searchParams.get("page_size") ??
					"100",
			);
			const rowByPath: Record<string, Record<string, unknown>> = {
				"/v2/number_block_orders": { id: "block_1", status: "pending" },
				"/v2/advanced_orders": {
					id: "advanced_1",
					status: "pending",
					quantity: 1,
				},
				"/v2/inexplicit_number_orders": {
					id: "bulk_1",
					ordering_groups: [{ status: "pending", count_requested: 1 }],
				},
				"/v2/porting_orders": {
					id: "port_1",
					status: { value: "draft" },
					porting_phone_numbers_count: 1,
				},
				"/v2/porting_phone_numbers": {
					porting_order_id: "port_1",
					phone_number: "+12025550123",
					porting_order_status: "draft",
				},
				"/v2/portouts": {
					id: "portout_1",
					status: "authorized",
					host_messaging: true,
					phone_numbers: ["+12025550124"],
				},
			};
			const row = rowByPath[url.pathname];
			return Response.json({
				data: row ? [row] : [],
				meta: {
					page_number: 1,
					page_size: pageSize,
					total_pages: 1,
					total_results: row ? 1 : 0,
				},
			});
		});
		const inventory = await captureTelnyxFutureMoneyAllocations({
			apiKey: "KEY-example",
			fetcher,
		});
		expect(inventory.numberBlockOrders).toHaveLength(1);
		expect(inventory.advancedOrders).toHaveLength(1);
		expect(inventory.inexplicitNumberOrders).toHaveLength(1);
		expect(inventory.portingOrders).toHaveLength(1);
		expect(inventory.portingPhoneNumbers).toHaveLength(1);
		expect(inventory.portOuts).toHaveLength(1);
		expect(
			requested
				.get("/v2/inexplicit_number_orders")
				?.searchParams.get("page_size"),
		).toBe("250");
		expect(
			requested.get("/v2/number_block_orders")?.searchParams.get("page[size]"),
		).toBe("100");
	});

	it("rejects incomplete or duplicate Telnyx paged inventories", async () => {
		const fetcherFor = (duplicate: boolean) =>
			testFetch(async (input) => {
				const url = new URL(String(input));
				if (url.pathname.endsWith("/balance")) {
					return Response.json({ data: { balance: "0", pending: "0" } });
				}
				if (url.pathname.endsWith("/advanced_orders")) {
					return Response.json({
						data: [],
						meta: { total_pages: 1, total_results: 0 },
					});
				}
				if (!duplicate) return Response.json({ data: [] });
				const pageSize = Number(
					url.searchParams.get("page[size]") ??
						url.searchParams.get("page_size") ??
						"100",
				);
				const rowsForPage = url.pathname.endsWith("/number_block_orders")
					? [
							{ id: "duplicate", status: "pending" },
							{ id: "duplicate", status: "pending" },
						]
					: [];
				return Response.json({
					data: rowsForPage,
					meta: {
						page_number: 1,
						page_size: pageSize,
						total_pages: 1,
						total_results: rowsForPage.length,
					},
				});
			});

		await expect(
			captureTelnyxFutureMoneyAllocations({
				apiKey: "KEY-example",
				fetcher: fetcherFor(false),
			}),
		).rejects.toThrow("invalid pagination metadata");
		await expect(
			captureTelnyxFutureMoneyAllocations({
				apiKey: "KEY-example",
				fetcher: fetcherFor(true),
			}),
		).rejects.toThrow("duplicate duplicate");
	});

	it("blocks every nonterminal Telnyx allocation family", async () => {
		const inventory = await captureProviderInventory({
			...providerDefaults("8".repeat(64)),
			stripe: emptyStripe(),
			telnyxNumberOrders: [
				{
					id: "standard_success",
					status: "success",
					customerReference: null,
					phoneNumbers: ["+12025550120"],
					updatedAt: null,
				},
			],
			telnyxFutureMoney: {
				balance: { ...emptyTelnyxFutureMoney.balance, pending: "2.00" },
				numberBlockOrders: [
					{
						id: "block_success",
						status: "success",
						customerReference: null,
						startingNumber: "+12025550121",
						range: 1,
						phoneNumbersCount: 1,
						updatedAt: null,
					},
				],
				advancedOrders: [
					{
						id: "advanced_pending",
						statuses: ["pending"],
						customerReference: null,
						quantity: 1,
						numberOrderIds: [],
					},
					{
						id: "advanced_ordered",
						statuses: ["ordered"],
						customerReference: null,
						quantity: 1,
						numberOrderIds: ["standard_success"],
					},
				],
				inexplicitNumberOrders: [
					{
						id: "bulk_pending",
						customerReference: null,
						updatedAt: null,
						orderingGroups: [
							{
								index: 0,
								status: "pending",
								countRequested: 1,
								countAllocated: 0,
								numberOrderIds: [],
							},
						],
					},
					{
						id: "bulk_success",
						customerReference: null,
						updatedAt: null,
						orderingGroups: [
							{
								index: 0,
								status: "success",
								countRequested: 1,
								countAllocated: 1,
								numberOrderIds: ["standard_success"],
							},
						],
					},
				],
				portingOrders: [
					{
						id: "port_pending",
						status: "draft",
						customerReference: null,
						phoneNumbersCount: 1,
						updatedAt: null,
					},
					{
						id: "port_ported",
						status: "ported",
						customerReference: null,
						phoneNumbersCount: 1,
						updatedAt: null,
					},
				],
				portingPhoneNumbers: [
					{
						portingOrderId: "port_ported",
						phoneNumber: "+12025550122",
						portingOrderStatus: "ported",
						activationStatus: "active",
					},
				],
				portOuts: [
					{
						id: "portout_authorized",
						status: "authorized",
						hostMessaging: true,
						phoneNumbers: ["+12025550123"],
						updatedAt: null,
					},
				],
			},
		});
		const kinds = new Set(
			inventory.blockingResources
				.filter((resource) => resource.provider === "telnyx")
				.map((resource) => resource.kind),
		);
		for (const kind of [
			"pending_balance",
			"advanced_order",
			"inexplicit_number_order",
			"porting_order",
			"portout",
		]) {
			expect(kinds).toContain(kind);
		}
		for (const terminalHistoryId of [
			"standard_success",
			"block_success",
			"advanced_ordered",
			"bulk_success:0",
			"port_ported",
		]) {
			expect(
				inventory.blockingResources.some(
					(resource) => resource.id === terminalHistoryId,
				),
			).toBe(false);
		}
	});
});
