import type Stripe from "stripe";
import {
	STRIPE_MANAGED_BY_KEY,
	STRIPE_MANAGED_BY_VALUE,
	STRIPE_SUBSCRIPTION_ROLE_KEY,
	STRIPE_SUBSCRIPTION_ROLES,
	type StripeSubscriptionRole,
} from "../config/billing";

export type LocalSubscriptionStatus =
	| "trialing"
	| "active"
	| "past_due"
	| "cancelled";

const BLOCKING_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
	"active",
	"trialing",
	"past_due",
	"unpaid",
	"incomplete",
	"paused",
]);

const CANONICAL_SUBSCRIPTION_PRIORITY: Partial<
	Record<Stripe.Subscription.Status, number>
> = {
	active: 0,
	trialing: 1,
	past_due: 2,
	unpaid: 2,
};

export function relayApiSubscriptionRole(
	subscription: Pick<Stripe.Subscription, "metadata">,
): StripeSubscriptionRole | null {
	if (
		subscription.metadata?.[STRIPE_MANAGED_BY_KEY] !==
		STRIPE_MANAGED_BY_VALUE
	) {
		return null;
	}
	const role = subscription.metadata?.[STRIPE_SUBSCRIPTION_ROLE_KEY];
	return role === STRIPE_SUBSCRIPTION_ROLES.base ||
		role === STRIPE_SUBSCRIPTION_ROLES.phoneAddon
		? role
		: null;
}

export function isRelayApiBaseSubscription(
	subscription: Pick<Stripe.Subscription, "metadata">,
): boolean {
	return relayApiSubscriptionRole(subscription) === STRIPE_SUBSCRIPTION_ROLES.base;
}

export function mapStripeSubscriptionStatus(
	status: Stripe.Subscription.Status,
): LocalSubscriptionStatus {
	switch (status) {
		case "active":
			return "active";
		case "trialing":
			return "trialing";
		case "past_due":
		case "unpaid":
			return "past_due";
		default:
			return "cancelled";
	}
}

export function isStripeNotFound(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === "object" &&
		"statusCode" in error &&
		(error as { statusCode?: unknown }).statusCode === 404
	);
}

/**
 * Find the best current subscription without assuming Stripe's first returned
 * row is authoritative. Active outranks trialing, which outranks delinquent
 * states; terminal and incomplete states do not confer a local entitlement.
 */
export async function findCanonicalStripeSubscription(
	stripe: Stripe,
	customerId: string,
): Promise<Stripe.Subscription | null> {
	let startingAfter: string | undefined;
	let best: Stripe.Subscription | null = null;
	let bestPriority = Number.POSITIVE_INFINITY;

	for (;;) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		for (const subscription of page.data) {
			if (!isRelayApiBaseSubscription(subscription)) continue;
			const priority = CANONICAL_SUBSCRIPTION_PRIORITY[subscription.status];
			if (priority === undefined || priority >= bestPriority) continue;
			best = subscription;
			bestPriority = priority;
			if (priority === 0) return best;
		}
		if (!page.has_more) return best;
		const lastSubscription = page.data.at(-1);
		if (!lastSubscription) return best;
		startingAfter = lastSubscription.id;
	}
}

/**
 * Prefer the recorded Stripe ID (which can resolve past-due subscriptions),
 * then recover from a deleted/terminal ID by scanning the customer.
 */
export async function resolveCanonicalStripeSubscription(
	stripe: Stripe,
	customerId: string,
	recordedSubscriptionId: string | null,
): Promise<Stripe.Subscription | null> {
	if (recordedSubscriptionId) {
		try {
			const recorded = await stripe.subscriptions.retrieve(
				recordedSubscriptionId,
			);
			if (
				isRelayApiBaseSubscription(recorded) &&
				mapStripeSubscriptionStatus(recorded.status) !== "cancelled"
			) {
				return recorded;
			}
		} catch (error) {
			if (!isStripeNotFound(error)) throw error;
		}
	}
	return findCanonicalStripeSubscription(stripe, customerId);
}

/** Check every Stripe page before allowing a second Checkout Session. */
export async function hasBlockingStripeSubscription(
	stripe: Stripe,
	customerId: string,
): Promise<boolean> {
	let startingAfter: string | undefined;
	for (;;) {
		const page = await stripe.subscriptions.list({
			customer: customerId,
			limit: 100,
			...(startingAfter ? { starting_after: startingAfter } : {}),
		});
		if (
			page.data.some((subscription) =>
				isRelayApiBaseSubscription(subscription) &&
				BLOCKING_SUBSCRIPTION_STATUSES.has(subscription.status),
			)
		) {
			return true;
		}
		if (!page.has_more) return false;
		const lastSubscription = page.data.at(-1);
		if (!lastSubscription) return false;
		startingAfter = lastSubscription.id;
	}
}
