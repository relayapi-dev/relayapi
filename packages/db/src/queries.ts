import {
	type BillingPolicyInput,
	getBillingPolicy,
	hasOrganizationRole,
} from "@relayapi/config";
import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { member, organizationSubscriptions } from "./schema";

export interface OwnedOrganizationBillingProjection extends BillingPolicyInput {
	role: string;
}

export function countFreeOwnedOrganizations(
	rows: readonly OwnedOrganizationBillingProjection[],
	now = new Date(),
): number {
	return rows.filter(
		(row) =>
			hasOrganizationRole(row.role, "owner") &&
			getBillingPolicy(row, now).entitlement === "free",
	).length;
}

/**
 * Counts organizations the user effectively owns whose canonical runtime
 * entitlement is Free. Better Auth can persist compound roles, while paid
 * authority includes complimentary subscriptions, proven trials, and active
 * past-due grace periods in addition to active Stripe subscriptions.
 *
 * Only owned orgs count, so the "upgrade an org" limit message stays truthful:
 * orgs a user was merely invited to don't consume their free-org quota.
 */
export async function countOwnedFreeOrganizationsForUser(
	db: Pick<Database, "select">,
	userId: string,
	now = new Date(),
): Promise<number> {
	const rows = await db
		.select({
			role: member.role,
			status: organizationSubscriptions.status,
			source: organizationSubscriptions.source,
			stripeSubscriptionId: organizationSubscriptions.stripeSubscriptionId,
			trialEndsAt: organizationSubscriptions.trialEndsAt,
			delinquentAt: organizationSubscriptions.delinquentAt,
			graceEndsAt: organizationSubscriptions.graceEndsAt,
			currentPeriodStart: organizationSubscriptions.currentPeriodStart,
			currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
		})
		.from(member)
		.leftJoin(
			organizationSubscriptions,
			eq(organizationSubscriptions.organizationId, member.organizationId),
		)
		.where(eq(member.userId, userId));

	return countFreeOwnedOrganizations(rows, now);
}
