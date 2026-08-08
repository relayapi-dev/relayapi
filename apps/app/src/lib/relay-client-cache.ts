import type Relay from "@relayapi/sdk";

const clientCache = new Map<string, { client: Relay; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;
const MAX_CACHED_CLIENTS = 256;

function clientCacheKey(
	orgId: string,
	userId: string,
	credentialVersion: string,
): string {
	return `${orgId}:${userId}:${credentialVersion}`;
}

export function getCachedRelayClient(
	orgId: string,
	userId: string,
	credentialVersion: string,
	now: number,
): Relay | null {
	const key = clientCacheKey(orgId, userId, credentialVersion);
	const cached = clientCache.get(key);
	if (cached && cached.expiresAt > now) return cached.client;
	if (cached) clientCache.delete(key);
	return null;
}

export function cacheRelayClient(
	orgId: string,
	userId: string,
	credentialVersion: string,
	client: Relay,
	now: number,
): void {
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
	clientCache.set(clientCacheKey(orgId, userId, credentialVersion), {
		client,
		expiresAt: now + CACHE_TTL_MS,
	});
}

/**
 * Clear the cached SDK client for an organization after credential or
 * principal changes. This module deliberately has no Astro type dependency so
 * identity-deletion database fixtures exercise the production transaction.
 */
export function clearClientCache(orgId: string, userId?: string): void {
	if (userId) {
		for (const key of clientCache.keys()) {
			if (key.startsWith(`${orgId}:${userId}:`)) clientCache.delete(key);
		}
		return;
	}
	for (const key of clientCache.keys()) {
		if (key.startsWith(`${orgId}:`)) clientCache.delete(key);
	}
}
