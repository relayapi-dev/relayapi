/**
 * Dashboard SDK client — uses @relayapi/sdk from packages/sdk.
 * Caches clients per org to avoid re-creating on every API route call.
 */

import Relay from "@relayapi/sdk";

// Cache SDK clients per organization member (survives across requests in the
// same worker/process). Dashboard credentials are principal-bound, never shared
// across every member of an organization.
const clientCache = new Map<string, { client: Relay; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute
const MAX_CACHED_CLIENTS = 256;

/**
 * Read the raw dashboard API key from KV for a given org.
 */
export async function getDashboardApiKey(
	kv: { get: (key: string) => Promise<string | null> },
	orgId: string,
	userId: string,
): Promise<string | null> {
	return kv.get(`dashboard-key:${orgId}:${userId}`);
}

function clientCacheKey(orgId: string, userId: string): string {
	return `${orgId}:${userId}`;
}

/**
 * Create a Relay SDK client for the dashboard.
 */
export function createRelayClient(apiKey: string, baseURL?: string): Relay {
  return new Relay({
    apiKey,
    baseURL: baseURL || "http://localhost:8789",
    timeout: 10_000, // 10s timeout — fail fast instead of hanging for minutes
  });
}

/**
 * Get a Relay SDK client from Astro locals (convenience for API routes).
 * Caches the client per org for 1 minute to avoid KV lookups on every request.
 * Returns null if no dashboard key is available.
 */
export async function getRelayClient(
  locals: App.Locals,
	apiBaseURL?: string,
): Promise<Relay | null> {
	const org = locals.organization;
	const user = locals.user;
	if (!org || !user) return null;

	const orgId = org.id as string;
	const userId = user.id as string;
	const now = Date.now();
	const cacheKey = clientCacheKey(orgId, userId);

	const cached = clientCache.get(cacheKey);
	if (cached && cached.expiresAt > now) return cached.client;
	if (cached) clientCache.delete(cacheKey);

	const kv = locals.kv;
	if (!kv) return null;

	const apiKey = await getDashboardApiKey(kv, orgId, userId);
	if (!apiKey) return null;

	const client = createRelayClient(apiKey, apiBaseURL);
	// Worker isolates can serve many principals over their lifetime. Prune only
	// on a cache miss so the hot path remains a single Map lookup, then cap the
	// remaining live entries to keep module-global memory bounded.
	if (clientCache.size >= MAX_CACHED_CLIENTS) {
		for (const [key, entry] of clientCache) {
			if (entry.expiresAt <= now) clientCache.delete(key);
		}
	}
	while (clientCache.size >= MAX_CACHED_CLIENTS) {
		const oldestKey = clientCache.keys().next().value;
		if (oldestKey === undefined) break;
		clientCache.delete(oldestKey);
	}
	clientCache.set(cacheKey, { client, expiresAt: now + CACHE_TTL_MS });
	return client;
}

/**
 * Clear the cached SDK client for an org (e.g. after dashboard key rotation).
 */
export function clearClientCache(orgId: string, userId?: string): void {
	if (userId) {
		clientCache.delete(clientCacheKey(orgId, userId));
		return;
	}
	for (const key of clientCache.keys()) {
		if (key.startsWith(`${orgId}:`)) clientCache.delete(key);
	}
}
