/**
 * Dashboard SDK client — uses @relayapi/sdk from packages/sdk.
 * Caches clients per org to avoid re-creating on every API route call.
 */

import { LEGACY_CREDENTIAL_VERSION } from "@relayapi/db";
import Relay from "@relayapi/sdk";
import {
	decryptDashboardCredential,
	type DashboardCredentialPointer,
} from "./dashboard-key-envelope";
import {
	cacheRelayClient,
	getCachedRelayClient,
} from "./relay-client-cache";

export { clearClientCache } from "./relay-client-cache";

function credentialVersionForUser(user: Record<string, unknown>): string {
	return typeof user.credentialVersion === "string" && user.credentialVersion
		? user.credentialVersion
		: LEGACY_CREDENTIAL_VERSION;
}

export async function getDashboardCredentialPointer(
	kv: { get: (key: string) => Promise<string | null> },
	orgId: string,
	userId: string,
	secret: string,
): Promise<DashboardCredentialPointer | null> {
	const pointerName = `dashboard-key:${orgId}:${userId}`;
	const envelope = await kv.get(pointerName);
	if (!envelope) return null;
	try {
		return await decryptDashboardCredential(envelope, secret, pointerName);
	} catch {
		return null;
	}
}

/**
 * Read the raw dashboard API key from KV for a given org.
 */
export async function getDashboardApiKey(
	kv: { get: (key: string) => Promise<string | null> },
	orgId: string,
	userId: string,
	secret: string,
): Promise<string | null> {
	return (
		await getDashboardCredentialPointer(kv, orgId, userId, secret)
	)?.apiKey ?? null;
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
	const credentialVersion = credentialVersionForUser(user);
	const now = Date.now();

	const cached = getCachedRelayClient(
		orgId,
		userId,
		credentialVersion,
		now,
	);
	if (cached) return cached;

	const kv = locals.kv;
	if (!kv) return null;

	const pointer = await getDashboardCredentialPointer(
		kv,
		orgId,
		userId,
		locals.dashboardCredentialSecret,
	);
	if (!pointer || pointer.credentialVersion !== credentialVersion) return null;

	const client = createRelayClient(pointer.apiKey, apiBaseURL);
	cacheRelayClient(orgId, userId, credentialVersion, client, now);
	return client;
}
