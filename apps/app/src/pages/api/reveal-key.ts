import type { APIRoute } from "astro";
import { apikey, eq } from "@relayapi/db";
import { clearClientCache } from "@/lib/relay";

// Returns the org's working API key (the dashboard key stored raw in KV) so the
// Overview "API key" card can reveal/copy it on demand — Stripe-style. The raw
// secret is returned ONLY on an explicit request, never cached, and never put in
// client storage (no-store). Presence is checked separately via
// /api/dashboard-key-status so the page never holds the secret until the user
// clicks reveal/copy.
async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const GET: APIRoute = async (ctx) => {
  const user = ctx.locals.user;
  const org = ctx.locals.organization as { id?: string } | null;
  const kv = ctx.locals.kv;
  const db = ctx.locals.db;

  if (!user || !org?.id || !kv) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Not authenticated" } },
      { status: 401 },
    );
  }

  const noStore = { "Cache-Control": "private, no-store" } as const;

  const rawKey = await kv.get(`dashboard-key:${org.id}`);
  if (!rawKey) {
    return Response.json({ key: null }, { headers: noStore });
  }

  // Validate against the DB apikey row (exists + enabled), NOT the apikey:* KV
  // auth cache: that cache has a short TTL and the API re-hydrates it from the
  // DB on use, so its absence is not revocation. Mirrors dashboard-key-status.
  const hashedKey = await hashKey(rawKey);
  const [row] = await db
    .select({ enabled: apikey.enabled })
    .from(apikey)
    .where(eq(apikey.key, hashedKey))
    .limit(1);

  if (!row?.enabled) {
    await kv.delete(`dashboard-key:${org.id}`);
    clearClientCache(org.id);
    return Response.json({ key: null }, { headers: noStore });
  }

  return Response.json({ key: rawKey }, { headers: noStore });
};
