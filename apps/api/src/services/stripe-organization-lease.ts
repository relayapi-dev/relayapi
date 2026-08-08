import {
	type Database,
	stripeOrganizationLeases,
} from "@relayapi/db";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

const ORGANIZATION_LEASE_MS = 15 * 60 * 1000;

type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type StripeOrganizationFence = {
	organizationId: string;
	ownerId: string;
	leaseToken: number;
};

/**
 * Serialize every Stripe-derived mutation for one organization. The token is
 * monotonically fenced in PostgreSQL; provider HTTP is never performed while
 * a database transaction is open.
 */
export async function claimStripeOrganizationFence(
	db: Database,
	organizationId: string,
	ownerId: string,
): Promise<StripeOrganizationFence | null> {
	const now = new Date();
	const [lease] = await db
		.insert(stripeOrganizationLeases)
		.values({
			organizationId,
			leaseToken: 1,
			ownerEventId: ownerId,
			leaseExpiresAt: new Date(now.getTime() + ORGANIZATION_LEASE_MS),
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: stripeOrganizationLeases.organizationId,
			set: {
				leaseToken: sql`${stripeOrganizationLeases.leaseToken} + 1`,
				ownerEventId: ownerId,
				leaseExpiresAt: new Date(now.getTime() + ORGANIZATION_LEASE_MS),
				updatedAt: now,
			},
			setWhere: or(
				isNull(stripeOrganizationLeases.leaseExpiresAt),
				lte(stripeOrganizationLeases.leaseExpiresAt, now),
				eq(stripeOrganizationLeases.ownerEventId, ownerId),
			),
		})
		.returning({ leaseToken: stripeOrganizationLeases.leaseToken });
	return lease
		? { organizationId, ownerId, leaseToken: lease.leaseToken }
		: null;
}

/**
 * Recheck and heartbeat the fencing token immediately before a financial
 * projection. The conditional UPDATE also holds the aggregate row until an
 * enclosing transaction commits.
 */
export async function assertStripeOrganizationFence(
	db: Database | BillingTransaction,
	fence: StripeOrganizationFence | null,
): Promise<void> {
	if (!fence) return;
	const now = new Date();
	const [active] = await db
		.update(stripeOrganizationLeases)
		.set({
			leaseExpiresAt: new Date(now.getTime() + ORGANIZATION_LEASE_MS),
			updatedAt: now,
		})
		.where(
			and(
				eq(stripeOrganizationLeases.organizationId, fence.organizationId),
				eq(stripeOrganizationLeases.ownerEventId, fence.ownerId),
				eq(stripeOrganizationLeases.leaseToken, fence.leaseToken),
				gt(stripeOrganizationLeases.leaseExpiresAt, now),
			),
		)
		.returning({ leaseToken: stripeOrganizationLeases.leaseToken });
	if (!active) throw new Error("Stripe organization aggregate fence was lost");
}

export async function releaseStripeOrganizationFence(
	db: Database,
	fence: StripeOrganizationFence | null,
): Promise<void> {
	if (!fence) return;
	await db
		.update(stripeOrganizationLeases)
		.set({ ownerEventId: null, leaseExpiresAt: null, updatedAt: new Date() })
		.where(
			and(
				eq(stripeOrganizationLeases.organizationId, fence.organizationId),
				eq(stripeOrganizationLeases.ownerEventId, fence.ownerId),
				eq(stripeOrganizationLeases.leaseToken, fence.leaseToken),
			),
		);
}
