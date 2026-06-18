import type { APIRoute } from "astro";
import { apikey, generateId, organizationSubscriptions, eq } from "@relayapi/db";
import { PRICING } from "@relayapi/config";
import { clearClientCache } from "@/lib/relay";

async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(): string {
  const bytes = new Uint8Array(29);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `rlay_live_${hex}`;
}

// PRICING imported from @relayapi/config

// Mirror the API's apikey:* KV TTL convention (apps/api/src/middleware/auth.ts
// API_KEY_KV_TTL_SECONDS = 600). The short TTL is a deliberate revocation
// backstop: a key disabled/mutated in the DB stops authenticating within 10 min,
// and the API middleware rehydrates an expired entry from the DB on first use.
const APIKEY_KV_TTL_SECONDS = 600; // 10 min

export const POST: APIRoute = async (context) => {
  const user = context.locals.user;
  const org = context.locals.organization;

  if (!user || !org) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const orgId = org.id as string;
  const kv = context.locals.kv;
  const db = context.locals.db;

  // Check if dashboard key already exists and is still valid
  const existing = await kv.get(`dashboard-key:${orgId}`);
  if (existing) {
    // Verify the key is still valid by checking the DB apikey row (exists +
    // enabled) rather than KV presence. The apikey:* KV cache has a 10 min TTL,
    // so a naturally-expired-but-still-valid entry would otherwise trigger needless
    // key rotation; the API middleware re-hydrates expired entries on first use.
    const existingHash = await hashKey(existing);
    const [row] = await db
      .select({ enabled: apikey.enabled })
      .from(apikey)
      .where(eq(apikey.key, existingHash))
      .limit(1);
    if (row?.enabled) {
      // Key still valid
      return new Response(
        JSON.stringify({ ok: true }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // Stale key — delete it and create a new one
    await kv.delete(`dashboard-key:${orgId}`);
    clearClientCache(orgId);
  }

  // Look up subscription to determine plan
  const [sub] = await db
    .select({ status: organizationSubscriptions.status })
    .from(organizationSubscriptions)
    .where(eq(organizationSubscriptions.organizationId, orgId))
    .limit(1);

  // A subscription in `trialing` status is a Pro trial — treat it as pro so the
  // org is not silently throttled to the free plan (200 calls / 100 rpm). This
  // matches billing/sync.ts (isPro = active || trialing) and status reporting.
  const plan: "free" | "pro" =
    sub?.status === "active" || sub?.status === "trialing" ? "pro" : "free";
  const callsIncluded = plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;

  // Generate key
  const rawKey = generateRawKey();
  const hashedKey = await hashKey(rawKey);
  const prefix = "rlay_live_";
  const start = rawKey.slice(0, 8);
  const keyId = generateId("key_");

  // Insert into DB
  await db.insert(apikey).values({
    id: keyId,
    name: "Dashboard",
    key: hashedKey,
    start,
    prefix,
    organizationId: orgId,
    referenceId: user.id as string,
    enabled: true,
  });

  // Write to KV for API auth lookup
  const kvData = {
    org_id: orgId,
    key_id: keyId,
    permissions: ["read", "write"],
    workspace_scope: "all",
    expires_at: null,
    rate_limit_max: plan === "pro" ? PRICING.proRateLimitMax : PRICING.freeRateLimitMax,
    rate_limit_window: plan === "pro" ? PRICING.proRateLimitWindow : PRICING.freeRateLimitWindow,
    plan,
    calls_included: callsIncluded,
  };
  await kv.put(`apikey:${hashedKey}`, JSON.stringify(kvData), {
    expirationTtl: APIKEY_KV_TTL_SECONDS,
  });

  // Store raw key for dashboard retrieval
  await kv.put(`dashboard-key:${orgId}`, rawKey);
  clearClientCache(orgId);

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 201, headers: { "Content-Type": "application/json" } }
  );
};
