import type { APIRoute } from "astro";
import {
  organization,
  member,
  organizationSubscriptions,
  usageRecords,
  apikey,
  generateId,
  eq,
} from "@relayapi/db";
import { sql, desc, count } from "drizzle-orm";
import { PRICING } from "@relayapi/config";

async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function adminGuard(context: any): Response | null {
  const user = context.locals.user;
  if (!user || (user as any).role !== "admin") {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export const GET: APIRoute = async (context) => {
  const denied = adminGuard(context);
  if (denied) return denied;

  const db = context.locals.db;
  const url = new URL(context.request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const search = url.searchParams.get("search") || "";

  try {
    // Get paginated organizations
    const conditions = [];
    if (search) {
      conditions.push(sql`(${organization.name} ILIKE ${'%' + search + '%'} OR ${organization.slug} ILIKE ${'%' + search + '%'})`);
    }

    const [totalResult] = await db
      .select({ count: count() })
      .from(organization)
      .where(conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined);
    const total = Number(totalResult?.count ?? 0);

    const orgs = await db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logo: organization.logo,
        createdAt: organization.createdAt,
      })
      .from(organization)
      .where(conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined)
      .orderBy(desc(organization.createdAt))
      .limit(limit)
      .offset(offset);

    if (orgs.length === 0) {
      return new Response(JSON.stringify({ organizations: [], total, limit, offset }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const orgIds = orgs.map((o) => o.id);

    // Get member counts only for this page of orgs
    const memberCounts = await db
      .select({
        organizationId: member.organizationId,
        count: count(),
      })
      .from(member)
      .where(sql`${member.organizationId} = ANY(${orgIds}::text[])`)
      .groupBy(member.organizationId);

    const memberCountMap = new Map(
      memberCounts.map((m) => [m.organizationId, Number(m.count)])
    );

    // Get subscriptions only for this page of orgs
    const subs = await db
      .select({
        organizationId: organizationSubscriptions.organizationId,
        status: organizationSubscriptions.status,
        monthlyPriceCents: organizationSubscriptions.monthlyPriceCents,
        currentPeriodStart: organizationSubscriptions.currentPeriodStart,
        currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
        aiEnabled: organizationSubscriptions.aiEnabled,
      })
      .from(organizationSubscriptions)
      .where(sql`${organizationSubscriptions.organizationId} = ANY(${orgIds}::text[])`);

    const subMap = new Map(subs.map((s) => [s.organizationId, s]));

    // Get current period usage only for this page of orgs
    const now = new Date().toISOString();
    const usage = await db
      .select({
        organizationId: usageRecords.organizationId,
        apiCallsCount: usageRecords.apiCallsCount,
        apiCallsIncluded: usageRecords.apiCallsIncluded,
      })
      .from(usageRecords)
      .where(sql`${usageRecords.organizationId} = ANY(${orgIds}::text[]) AND ${usageRecords.periodStart} <= ${now} AND ${usageRecords.periodEnd} >= ${now}`);

    const usageMap = new Map(usage.map((u) => [u.organizationId, u]));

    const result = orgs.map((org) => {
      const sub = subMap.get(org.id);
      const u = usageMap.get(org.id);
      return {
        id: org.id,
        name: org.name,
        slug: org.slug,
        logo: org.logo,
        createdAt: org.createdAt,
        memberCount: memberCountMap.get(org.id) || 0,
        plan: sub?.status === "active" ? "pro" : "free",
        subscriptionStatus: sub?.status || null,
        monthlyPriceCents: sub?.monthlyPriceCents || 0,
        apiCallsUsed: u?.apiCallsCount || 0,
        apiCallsIncluded: sub?.status === "active" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded,
        aiEnabled: sub?.aiEnabled ?? false,
      };
    });

    return new Response(JSON.stringify({ organizations: result, total, limit, offset }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Admin organizations API error:", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const PATCH: APIRoute = async (context) => {
  const denied = adminGuard(context);
  if (denied) return denied;

  const db = context.locals.db;

  try {
    const body = await context.request.json();
    const { organizationId, name, slug, plan, aiEnabled } = body;

    if (!organizationId) {
      return new Response(
        JSON.stringify({ error: "organizationId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Update org fields if provided
    if (name !== undefined || slug !== undefined) {
      const orgUpdates: Record<string, any> = {};
      if (name !== undefined) orgUpdates.name = name;
      if (slug !== undefined) orgUpdates.slug = slug;
      await db
        .update(organization)
        .set(orgUpdates)
        .where(eq(organization.id, organizationId));
    }

    // Update plan if provided
    if (plan === "pro" || plan === "free") {
      const [existing] = await db
        .select({ id: organizationSubscriptions.id })
        .from(organizationSubscriptions)
        .where(eq(organizationSubscriptions.organizationId, organizationId))
        .limit(1);

      if (plan === "pro") {
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        if (existing) {
          await db
            .update(organizationSubscriptions)
            .set({
              status: "active",
              monthlyPriceCents: 500,
              postsIncluded: 1000,
              pricePerPostCents: 1,
              updatedAt: now,
            })
            .where(eq(organizationSubscriptions.id, existing.id));
        } else {
          await db.insert(organizationSubscriptions).values({
            id: generateId("sub_"),
            organizationId,
            status: "active",
            monthlyPriceCents: 500,
            postsIncluded: 1000,
            pricePerPostCents: 1,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          });
        }
      } else {
        // Downgrade to free: cancel subscription
        if (existing) {
          await db
            .update(organizationSubscriptions)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(eq(organizationSubscriptions.id, existing.id));
        }
      }

      // Update current usage record's apiCallsIncluded
      const newCallsIncluded =
        plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded;
      await db
        .update(usageRecords)
        .set({ apiCallsIncluded: newCallsIncluded, updatedAt: new Date() })
        .where(eq(usageRecords.organizationId, organizationId));

      // Update KV-cached API keys for this org
      const kv = context.locals.kv;
      if (kv) {
        const keys = await db
          .select({ key: apikey.key })
          .from(apikey)
          .where(eq(apikey.organizationId, organizationId));

        const newPlanData = {
          plan,
          calls_included:
            plan === "pro" ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded,
          rate_limit_max:
            plan === "pro" ? PRICING.proRateLimitMax : PRICING.freeRateLimitMax,
          rate_limit_window:
            plan === "pro" ? PRICING.proRateLimitWindow : PRICING.freeRateLimitWindow,
        };

        for (const k of keys) {
          const kvKey = `apikey:${k.key}`;
          const raw = await kv.get(kvKey);
          const existing = raw ? JSON.parse(raw) as Record<string, any> : null;
          if (existing) {
            await kv.put(kvKey, JSON.stringify({ ...existing, ...newPlanData }), {
              expirationTtl: 86400 * 365,
            });
          }
        }
      }
    }

    // Update AI enabled flag if provided
    if (typeof aiEnabled === "boolean") {
      const [existing] = await db
        .select({ id: organizationSubscriptions.id })
        .from(organizationSubscriptions)
        .where(eq(organizationSubscriptions.organizationId, organizationId))
        .limit(1);

      if (existing) {
        await db
          .update(organizationSubscriptions)
          .set({ aiEnabled, updatedAt: new Date() })
          .where(eq(organizationSubscriptions.id, existing.id));
      }

      // Update KV-cached API keys for this org
      const kv = context.locals.kv;
      if (kv) {
        const keys = await db
          .select({ key: apikey.key })
          .from(apikey)
          .where(eq(apikey.organizationId, organizationId));

        for (const k of keys) {
          const kvKey = `apikey:${k.key}`;
          const rawKv = await kv.get(kvKey);
          const existingKv = rawKv ? JSON.parse(rawKv) as Record<string, any> : null;
          if (existingKv) {
            await kv.put(kvKey, JSON.stringify({ ...existingKv, ai_enabled: aiEnabled }), {
              expirationTtl: 86400 * 365,
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Admin org update error:", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const DELETE: APIRoute = async (context) => {
  const denied = adminGuard(context);
  if (denied) return denied;

  const db = context.locals.db;

  try {
    const body = await context.request.json();
    const { organizationId } = body;

    if (!organizationId) {
      return new Response(
        JSON.stringify({ error: "organizationId required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Delete subscription first (FK constraint)
    await db
      .delete(organizationSubscriptions)
      .where(eq(organizationSubscriptions.organizationId, organizationId));

    // Delete members
    await db
      .delete(member)
      .where(eq(member.organizationId, organizationId));

    // Delete organization
    await db
      .delete(organization)
      .where(eq(organization.id, organizationId));

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Admin org delete error:", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
