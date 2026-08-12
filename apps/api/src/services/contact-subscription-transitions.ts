import {
	contactSubscriptionEvents,
	contactSubscriptions,
	type Database,
	generateId,
} from "@relayapi/db";
import { and, eq } from "drizzle-orm";

export type ContactSubscriptionSource =
	| "automation"
	| "manual"
	| "import"
	| "api";

export type ContactSubscriptionState = "subscribed" | "unsubscribed";

export interface ContactSubscriptionTransitionInput {
	organizationId: string;
	scopeKey: string;
	contactId: string;
	listId: string;
	type: ContactSubscriptionState;
	source: ContactSubscriptionSource;
	actorId?: string | null;
	occurredAt?: Date;
}

export interface ContactSubscriptionTransitionResult {
	membership: typeof contactSubscriptions.$inferSelect;
	transitioned: boolean;
}

type ContactSubscriptionTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

type CurrentMembershipState = Pick<
	typeof contactSubscriptions.$inferSelect,
	"state" | "subscribedAt" | "unsubscribedAt" | "source" | "updatedAt"
>;

interface ProjectionOptions {
	forceEvidence?: boolean;
}

interface PersistOptions extends ProjectionOptions {
	mergedFromContactId?: string | null;
}

export interface ContactSubscriptionStateProjection
	extends CurrentMembershipState {
	transitioned: boolean;
}

export function projectContactSubscriptionTransition(
	current: CurrentMembershipState | null,
	type: ContactSubscriptionState,
	source: ContactSubscriptionSource,
	occurredAt: Date,
	options: ProjectionOptions = {},
): ContactSubscriptionStateProjection {
	if (!current) {
		return {
			state: type,
			subscribedAt: occurredAt,
			unsubscribedAt: type === "unsubscribed" ? occurredAt : null,
			source,
			updatedAt: occurredAt,
			transitioned: true,
		};
	}

	if (current.state === type) {
		if (!options.forceEvidence) {
			return { ...current, transitioned: false };
		}
		return {
			...current,
			source,
			updatedAt: occurredAt,
			transitioned: true,
		};
	}

	const targetIsActive = type === "subscribed";
	return {
		state: type,
		subscribedAt: targetIsActive ? occurredAt : current.subscribedAt,
		unsubscribedAt: targetIsActive ? null : occurredAt,
		source,
		updatedAt: occurredAt,
		transitioned: true,
	};
}

function membershipIdentity(input: ContactSubscriptionTransitionInput) {
	return and(
		eq(contactSubscriptions.organizationId, input.organizationId),
		eq(contactSubscriptions.listId, input.listId),
		eq(contactSubscriptions.contactId, input.contactId),
	);
}

function monotonicOccurredAt(requested: Date, current: Date | null): Date {
	return current
		? new Date(Math.max(requested.getTime(), current.getTime()))
		: requested;
}

async function appendProjectionEvent(
	tx: ContactSubscriptionTransaction,
	input: ContactSubscriptionTransitionInput,
	projection: ContactSubscriptionStateProjection,
	options: PersistOptions,
) {
	const eventId = generateId("subevt_");
	const [event] = await tx
		.insert(contactSubscriptionEvents)
		.values({
			id: eventId,
			organizationId: input.organizationId,
			scopeKey: input.scopeKey,
			contactId: input.contactId,
			listId: input.listId,
			type: projection.state,
			source: projection.source,
			actorId: input.actorId ?? null,
			mergedFromContactId: options.mergedFromContactId ?? null,
			occurredAt: projection.updatedAt,
		})
		.returning({
			id: contactSubscriptionEvents.id,
			ingestionSequence: contactSubscriptionEvents.ingestionSequence,
		});
	if (!event) {
		throw new Error("Failed to persist subscription event");
	}
	return event;
}

/**
 * Atomically appends immutable evidence and points the indexed current-state
 * projection at that exact event. A losing first-insert race removes only its
 * own uncommitted provisional event before evaluating the winning state.
 */
async function transitionContactSubscriptionInTransaction(
	tx: ContactSubscriptionTransaction,
	input: ContactSubscriptionTransitionInput,
	options: PersistOptions = {},
): Promise<ContactSubscriptionTransitionResult> {
	const requestedAt = input.occurredAt ?? new Date();
	const identity = membershipIdentity(input);
	let [membership] = await tx
		.select()
		.from(contactSubscriptions)
		.where(identity)
		.for("update")
		.limit(1);

	if (membership && membership.scopeKey !== input.scopeKey) {
		throw new Error("Subscription membership scope mismatch");
	}

	let transitionOccurredAt = monotonicOccurredAt(
		requestedAt,
		membership?.updatedAt ?? null,
	);
	let projection = projectContactSubscriptionTransition(
		membership ?? null,
		input.type,
		input.source,
		transitionOccurredAt,
		options,
	);
	if (!projection.transitioned && membership) {
		return { membership, transitioned: false };
	}

	let event = await appendProjectionEvent(tx, input, projection, options);

	if (!membership) {
		const [inserted] = await tx
			.insert(contactSubscriptions)
			.values({
				organizationId: input.organizationId,
				scopeKey: input.scopeKey,
				contactId: input.contactId,
				listId: input.listId,
				state: projection.state,
				subscribedAt: projection.subscribedAt,
				unsubscribedAt: projection.unsubscribedAt,
				source: projection.source,
				lastEventId: event.id,
				lastEventSequence: event.ingestionSequence,
				updatedAt: projection.updatedAt,
			})
			.onConflictDoNothing({
				target: [
					contactSubscriptions.organizationId,
					contactSubscriptions.listId,
					contactSubscriptions.contactId,
				],
			})
			.returning();
		if (inserted) {
			return { membership: inserted, transitioned: true };
		}

		// The event never became authoritative and remains inside this
		// transaction, so removing it does not rewrite committed history.
		await tx
			.delete(contactSubscriptionEvents)
			.where(eq(contactSubscriptionEvents.id, event.id));
		[membership] = await tx
			.select()
			.from(contactSubscriptions)
			.where(identity)
			.for("update")
			.limit(1);
		if (!membership) {
			throw new Error("Failed to persist subscription membership");
		}
		if (membership.scopeKey !== input.scopeKey) {
			throw new Error("Subscription membership scope mismatch");
		}

		transitionOccurredAt = monotonicOccurredAt(
			requestedAt,
			membership.updatedAt,
		);
		projection = projectContactSubscriptionTransition(
			membership,
			input.type,
			input.source,
			transitionOccurredAt,
			options,
		);
		if (!projection.transitioned) {
			return { membership, transitioned: false };
		}
		event = await appendProjectionEvent(tx, input, projection, options);
	}

	const [updated] = await tx
		.update(contactSubscriptions)
		.set({
			state: projection.state,
			subscribedAt: projection.subscribedAt,
			unsubscribedAt: projection.unsubscribedAt,
			source: projection.source,
			lastEventId: event.id,
			lastEventSequence: event.ingestionSequence,
			updatedAt: projection.updatedAt,
		})
		.where(identity)
		.returning();
	if (!updated) {
		throw new Error("Failed to update subscription membership");
	}
	return { membership: updated, transitioned: true };
}

export async function transitionContactSubscription(
	db: Database,
	input: ContactSubscriptionTransitionInput,
): Promise<ContactSubscriptionTransitionResult> {
	return db.transaction((tx) =>
		transitionContactSubscriptionInTransaction(tx, input),
	);
}

export interface MergeContactSubscriptionInput {
	organizationId: string;
	scopeKey: string;
	sourceContactId: string;
	targetContactId: string;
	actorId?: string | null;
	occurredAt?: Date;
}

/**
 * Reconciles current list state during a contact merge without touching prior
 * events. Existing target state wins, matching the public merge contract. A
 * fresh target event records the source identity and becomes the exact
 * provenance for every affected target projection.
 */
export async function mergeContactSubscriptionProjections(
	tx: ContactSubscriptionTransaction,
	input: MergeContactSubscriptionInput,
): Promise<number> {
	const sourceMemberships = await tx
		.select()
		.from(contactSubscriptions)
		.where(
			and(
				eq(contactSubscriptions.organizationId, input.organizationId),
				eq(contactSubscriptions.contactId, input.sourceContactId),
			),
		)
		.orderBy(contactSubscriptions.listId)
		.for("update");

	for (const sourceMembership of sourceMemberships) {
		if (sourceMembership.scopeKey !== input.scopeKey) {
			throw new Error("Source subscription membership scope mismatch");
		}
		const [targetMembership] = await tx
			.select()
			.from(contactSubscriptions)
			.where(
				and(
					eq(contactSubscriptions.organizationId, input.organizationId),
					eq(contactSubscriptions.listId, sourceMembership.listId),
					eq(contactSubscriptions.contactId, input.targetContactId),
				),
			)
			.for("update")
			.limit(1);
		if (targetMembership && targetMembership.scopeKey !== input.scopeKey) {
			throw new Error("Target subscription membership scope mismatch");
		}

		const authoritative = targetMembership ?? sourceMembership;
		await transitionContactSubscriptionInTransaction(
			tx,
			{
				organizationId: input.organizationId,
				scopeKey: input.scopeKey,
				contactId: input.targetContactId,
				listId: sourceMembership.listId,
				type: authoritative.state,
				source: authoritative.source,
				actorId: input.actorId ?? null,
				occurredAt: input.occurredAt,
			},
			{
				forceEvidence: true,
				mergedFromContactId: input.sourceContactId,
			},
		);
	}

	if (sourceMemberships.length > 0) {
		await tx
			.delete(contactSubscriptions)
			.where(
				and(
					eq(contactSubscriptions.organizationId, input.organizationId),
					eq(contactSubscriptions.contactId, input.sourceContactId),
				),
			);
	}
	return sourceMemberships.length;
}
