import type Stripe from "stripe";

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

/**
 * Async because the Stripe SDK (~660 KiB) is loaded via dynamic import on
 * first use — it's only needed on Stripe webhooks and provisioning routes,
 * so it stays out of cold-start module evaluation.
 */
export async function createStripeClient(secretKey: string): Promise<Stripe> {
	if (cachedClient && cachedKey === secretKey) return cachedClient;
	const { default: StripeCtor } = await import("stripe");
	cachedClient = new StripeCtor(secretKey, {
		httpClient: StripeCtor.createFetchHttpClient(),
	});
	cachedKey = secretKey;
	return cachedClient;
}
