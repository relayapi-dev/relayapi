import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { member, organizationSubscriptions } from "./schema";

/**
 * Counts the FREE organizations a user OWNS (member.role === "owner").
 *
 * An org is "paid" only when its subscription status is "active" — matching the
 * KV feature-gating in apps/api stripe-webhooks. A "trialing" row is just a
 * placeholder written when Stripe checkout is initiated, before any payment, so
 * orgs with no subscription row or a trialing/past_due/cancelled status all
 * count as free. The LEFT JOIN + `!== "active"` filter is NULL-safe, so the
 * common free case (no subscription row) is counted.
 *
 * Only owned orgs count, so the "upgrade an org" limit message stays truthful:
 * orgs a user was merely invited to don't consume their free-org quota.
 */
export async function countOwnedFreeOrganizationsForUser(
	db: Database,
	userId: string,
): Promise<number> {
	const rows = await db
		.select({ status: organizationSubscriptions.status })
		.from(member)
		.leftJoin(
			organizationSubscriptions,
			eq(organizationSubscriptions.organizationId, member.organizationId),
		)
		.where(and(eq(member.userId, userId), eq(member.role, "owner")));

	return rows.filter((row) => row.status !== "active").length;
}
