import type { APIRoute } from "astro";
import {
  organization,
  organizationSubscriptions,
  usageRecords,
  eq,
} from "@relayapi/db";
import { sql, desc } from "drizzle-orm";

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

  try {
    const subs = await db
      .select({
        id: organizationSubscriptions.id,
        organizationId: organizationSubscriptions.organizationId,
        status: organizationSubscriptions.status,
        monthlyPriceCents: organizationSubscriptions.monthlyPriceCents,
        postsIncluded: organizationSubscriptions.postsIncluded,
        pricePerPostCents: organizationSubscriptions.pricePerPostCents,
        currentPeriodStart: organizationSubscriptions.currentPeriodStart,
        currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
        trialEndsAt: organizationSubscriptions.trialEndsAt,
        createdAt: organizationSubscriptions.createdAt,
        orgName: organization.name,
        orgSlug: organization.slug,
      })
      .from(organizationSubscriptions)
      .leftJoin(
        organization,
        eq(organizationSubscriptions.organizationId, organization.id)
      )
      .orderBy(desc(organizationSubscriptions.createdAt));

    // Get current usage for each org
    const now = new Date().toISOString();
    const usage = await db
      .select({
        organizationId: usageRecords.organizationId,
        apiCallsCount: usageRecords.apiCallsCount,
        apiCallsIncluded: usageRecords.apiCallsIncluded,
        overageCalls: usageRecords.overageCalls,
        overageCallsCostCents: usageRecords.overageCallsCostCents,
      })
      .from(usageRecords)
      .where(sql`${usageRecords.periodStart} <= ${now} AND ${usageRecords.periodEnd} >= ${now}`);

    const usageMap = new Map(usage.map((u) => [u.organizationId, u]));

    const result = subs.map((s) => {
      const u = usageMap.get(s.organizationId);
      return {
        ...s,
        apiCallsUsed: u?.apiCallsCount || 0,
        apiCallsIncluded: u?.apiCallsIncluded || 200,
        overageCalls: u?.overageCalls || 0,
        overageCostCents: u?.overageCallsCostCents || 0,
      };
    });

    return new Response(JSON.stringify({ subscriptions: result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Admin subscriptions API error:", e);
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
    const { id, status, monthlyPriceCents, postsIncluded, pricePerPostCents } =
      body;

    if (!id) {
      return new Response(
        JSON.stringify({ error: "Subscription ID required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const updates: Record<string, any> = {};
    if (status !== undefined) updates.status = status;
    if (monthlyPriceCents !== undefined)
      updates.monthlyPriceCents = monthlyPriceCents;
    if (postsIncluded !== undefined) updates.postsIncluded = postsIncluded;
    if (pricePerPostCents !== undefined)
      updates.pricePerPostCents = pricePerPostCents;

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ error: "No fields to update" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    updates.updatedAt = new Date();

    await db
      .update(organizationSubscriptions)
      .set(updates)
      .where(eq(organizationSubscriptions.id, id));

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Admin subscription update error:", e);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
