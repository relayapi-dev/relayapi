/**
 * Dashboard SDK client — uses @relayapi/sdk from packages/sdk.
 * Caches clients per org to avoid re-creating on every API route call.
 */

import Relay from "@relayapi/sdk";

// Cache SDK clients per org ID (survives across requests in the same worker/process)
const clientCache = new Map<string, { client: Relay; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Read the raw dashboard API key from KV for a given org.
 */
export async function getDashboardApiKey(
  kv: { get: (key: string) => Promise<string | null> },
  orgId: string,
): Promise<string | null> {
  return kv.get(`dashboard-key:${orgId}`);
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
  if (!org) return null;

  const orgId = (org as any).id as string;
  const now = Date.now();

  // Check cache first
  const cached = clientCache.get(orgId);
  if (cached && cached.expiresAt > now) {
    return cached.client;
  }

  const kv = locals.kv;
  if (!kv) return null;

  const apiKey = await getDashboardApiKey(kv, orgId);
  if (!apiKey) return null;

  const client = createRelayClient(apiKey, apiBaseURL);

  // Cache for 1 minute
  clientCache.set(orgId, { client, expiresAt: now + CACHE_TTL_MS });

  return client;
}

/**
 * Clear the cached SDK client for an org (e.g. after dashboard key rotation).
 */
export function clearClientCache(orgId: string): void {
  clientCache.delete(orgId);
}
