import Stripe from "stripe";

let cachedClient: Stripe | null = null;
let cachedKey: string | null = null;

export function createStripeClient(secretKey: string): Stripe {
	if (cachedClient && cachedKey === secretKey) return cachedClient;
	cachedClient = new Stripe(secretKey, {
		httpClient: Stripe.createFetchHttpClient(),
	});
	cachedKey = secretKey;
	return cachedClient;
}
