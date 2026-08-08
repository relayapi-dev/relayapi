import { type Database, organizationSubscriptions } from "@relayapi/db";
import { eq } from "drizzle-orm";

type SubscriptionTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

/**
 * Materialize and lock the one-per-organization subscription/settings row.
 *
 * Free organizations start without a row, so SELECT ... FOR UPDATE/SHARE alone
 * cannot serialize a concurrent first checkout, administrative grant, or tool
 * reservation. The unique-key insert is the absent-row lock: a concurrent
 * inserter waits, then every path observes and locks the same committed row.
 */
export async function lockOrganizationSubscription(
	tx: SubscriptionTransaction,
	organizationId: string,
	mode: "share" | "update",
): Promise<typeof organizationSubscriptions.$inferSelect> {
	await tx
		.insert(organizationSubscriptions)
		.values({ organizationId })
		.onConflictDoNothing({
			target: organizationSubscriptions.organizationId,
		});
	const [subscription] = await tx
		.select()
		.from(organizationSubscriptions)
		.where(eq(organizationSubscriptions.organizationId, organizationId))
		.for(mode)
		.limit(1);
	if (!subscription) {
		throw new Error(
			"Organization subscription row disappeared after materialization",
		);
	}
	return subscription;
}
