import {
	adAudiences,
	adAudienceUsers,
	broadcastRecipients,
	contactChannels,
	contactConsentEvents,
	contactSubscriptions,
	contacts,
	type Database,
	erasureHolds,
	inboxConversationNotes,
	inboxConversations,
	inboxMessages,
	organization,
	queueFailures,
	workspaces,
} from "@relayapi/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
	deriveProtectedContactSubjectLocator,
	requireConsentHmacKeyConfig,
} from "../lib/consent-hmac";
import { normalizeContactPhone } from "../lib/contact-phone";
import {
	normalizeRecipientIdentifier,
	recordContactConsentInTransaction,
} from "./contact-consent";
import { decryptContactChannelRows } from "./contact-protection";
import {
	enqueueExactObjectCleanup,
	enqueueQueueRescueSubjectCleanup,
} from "./external-subject-cleanup";

export const CONTACT_ERASURE_PURPOSES = [
	"marketing",
	"automation",
	"service",
] as const;

export type ContactErasureTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

export interface ErasableContact {
	id: string;
	workspaceId: string | null;
	email: string | null;
	phone: string | null;
}

interface ContactIdentity {
	contactId: string;
	workspaceId: string | null;
	channel: string;
	identifier: string;
}

export interface EraseContactsInTransactionInput {
	organizationId: string;
	contacts: readonly ErasableContact[];
	scopeAuthority: ContactErasureScopeAuthority;
	keyConfig: string;
	occurredAt: Date;
	source: string;
	evidence?: Record<string, unknown> | null;
}

export interface ContactErasureResult {
	deletedIds: string[];
	conversationsRedacted: number;
	externalCleanupJobs: number;
	broadcastRecipientsMinimized: number;
	audienceUsersDeleted: number;
}

const CONTACT_ERASURE_SCOPE_AUTHORITY = Symbol(
	"relayapi.contact-erasure-scope-authority",
);

export interface ContactErasureScopeAuthority {
	readonly [CONTACT_ERASURE_SCOPE_AUTHORITY]: true;
	readonly organizationId: string;
	readonly workspaceIds: readonly string[];
	readonly contactIds: readonly string[];
}

export class ContactErasureHeldError extends Error {
	readonly code = "CONTACT_ERASURE_HELD";

	constructor(public readonly holdId: string) {
		super("Contact deletion is paused by an active erasure hold");
		this.name = "ContactErasureHeldError";
	}
}

export class ContactErasureScopeChangedError extends Error {
	readonly code = "CONTACT_ERASURE_SCOPE_CHANGED";

	constructor() {
		super("Contact scope changed while deletion was being authorized");
		this.name = "ContactErasureScopeChangedError";
	}
}

/**
 * Establish a linearizable legal-hold decision before locking any contact.
 *
 * Hold placement takes FOR UPDATE on the same organization/workspace roots.
 * Taking the roots FOR SHARE here means either the hold wins and this call
 * observes it, or deletion wins and a racing hold waits for the erasure commit.
 */
export async function lockContactErasureScope(
	tx: ContactErasureTransaction,
	input: {
		organizationId: string;
		workspaceIds: readonly (string | null)[];
		contactIds: readonly string[];
	},
): Promise<ContactErasureScopeAuthority> {
	const workspaceIds = [
		...new Set(
			input.workspaceIds.filter(
				(workspaceId): workspaceId is string => workspaceId !== null,
			),
		),
	].sort();
	const contactIds = [...new Set(input.contactIds)].sort();

	const [lockedOrganization] = await tx
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, input.organizationId))
		.for("share")
		.limit(1);
	if (!lockedOrganization) throw new ContactErasureScopeChangedError();

	if (workspaceIds.length > 0) {
		const lockedWorkspaces = await tx
			.select({ id: workspaces.id })
			.from(workspaces)
			.where(
				and(
					eq(workspaces.organizationId, input.organizationId),
					inArray(workspaces.id, workspaceIds),
				),
			)
			.orderBy(workspaces.id)
			.for("share");
		if (lockedWorkspaces.length !== workspaceIds.length) {
			throw new ContactErasureScopeChangedError();
		}
	}

	const holdTargets = [
		and(
			eq(erasureHolds.subjectKind, "organization"),
			eq(erasureHolds.subjectId, input.organizationId),
		),
		...(workspaceIds.length > 0
			? [
					and(
						eq(erasureHolds.subjectKind, "workspace"),
						inArray(erasureHolds.subjectId, workspaceIds),
					),
				]
			: []),
	];
	const [activeHold] = await tx
		.select({ id: erasureHolds.id })
		.from(erasureHolds)
		.where(
			and(
				isNull(erasureHolds.releasedAt),
				eq(erasureHolds.organizationTombstoneId, input.organizationId),
				or(...holdTargets),
			),
		)
		.orderBy(erasureHolds.placedAt, erasureHolds.id)
		.limit(1);
	if (activeHold) throw new ContactErasureHeldError(activeHold.id);

	return {
		[CONTACT_ERASURE_SCOPE_AUTHORITY]: true,
		organizationId: input.organizationId,
		workspaceIds,
		contactIds,
	};
}

function uniqueContactIdentities(
	rows: readonly ContactIdentity[],
): ContactIdentity[] {
	const identities = new Map<string, ContactIdentity>();
	for (const row of rows) {
		const normalized = normalizeRecipientIdentifier(
			row.channel,
			row.identifier,
		);
		const key = `${row.channel.trim().toLowerCase()}\u0000${normalized}`;
		if (!identities.has(key)) identities.set(key, row);
	}
	return [...identities.values()];
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function erasedConversationPlatformId(conversationId: string): string {
	return `erased:${conversationId}`;
}

/**
 * Complete contact privacy erasure under the caller's existing transaction.
 *
 * Consent withdrawal, external cleanup intent, pre-boundary cancellation,
 * unknown-effect fencing, content minimization, Queue payload redaction, and
 * the final contact delete share one commit boundary.
 */
export async function eraseContactsInTransaction(
	tx: ContactErasureTransaction,
	input: EraseContactsInTransactionInput,
): Promise<ContactErasureResult> {
	const keyConfig = requireConsentHmacKeyConfig(input.keyConfig);
	if (input.contacts.length === 0) {
		return {
			deletedIds: [],
			conversationsRedacted: 0,
			externalCleanupJobs: 0,
			broadcastRecipientsMinimized: 0,
			audienceUsersDeleted: 0,
		};
	}
	const contactIds = [...new Set(input.contacts.map(({ id }) => id))];
	if (contactIds.length !== input.contacts.length) {
		throw new Error("Contact erasure input contains duplicate contacts");
	}
	const authorizedWorkspaceIds = new Set(input.scopeAuthority.workspaceIds);
	const authorizedContactIds = new Set(input.scopeAuthority.contactIds);
	if (
		input.scopeAuthority[CONTACT_ERASURE_SCOPE_AUTHORITY] !== true ||
		input.scopeAuthority.organizationId !== input.organizationId ||
		input.contacts.some(
			(contact) =>
				!authorizedContactIds.has(contact.id) ||
				(contact.workspaceId !== null &&
					!authorizedWorkspaceIds.has(contact.workspaceId)),
		)
	) {
		throw new ContactErasureScopeChangedError();
	}

	const protectedChannelRows = await tx
		.select()
		.from(contactChannels)
		.where(
			and(
				eq(contactChannels.organizationId, input.organizationId),
				inArray(contactChannels.contactId, contactIds),
			),
		);
	const channelRows = (
		await decryptContactChannelRows(keyConfig, protectedChannelRows)
	).map((row) => ({
		contactId: row.contactId,
		channel: row.platform,
		identifier: row.identifier,
	}));
	const contactById = new Map(
		input.contacts.map((contact) => [contact.id, contact]),
	);
	const identities = uniqueContactIdentities([
		...input.contacts.flatMap((contact): ContactIdentity[] => [
			...(contact.email
				? [
						{
							contactId: contact.id,
							workspaceId: contact.workspaceId,
							channel: "email",
							identifier: contact.email,
						},
					]
				: []),
			...(contact.phone
				? [
						{
							contactId: contact.id,
							workspaceId: contact.workspaceId,
							channel: "sms",
							identifier: contact.phone,
						},
						{
							contactId: contact.id,
							workspaceId: contact.workspaceId,
							channel: "whatsapp",
							identifier: contact.phone,
						},
					]
				: []),
		]),
		...channelRows.map((row) => ({
			contactId: row.contactId,
			workspaceId: contactById.get(row.contactId)?.workspaceId ?? null,
			channel: row.channel,
			identifier: row.identifier,
		})),
	]);

	const deletionIdentifierHashes = new Set<string>();
	for (const identity of identities) {
		for (const purpose of CONTACT_ERASURE_PURPOSES) {
			const event = await recordContactConsentInTransaction(tx, keyConfig, {
				organizationId: input.organizationId,
				workspaceId: identity.workspaceId,
				// Denial authority must survive the contact row and its cascading
				// grant projection.
				contactId: null,
				channel: identity.channel,
				purpose,
				identifier: identity.identifier,
				status: "denied",
				source: input.source,
				occurredAt: input.occurredAt,
				evidence: input.evidence ?? { reason: "contact_erased" },
			});
			deletionIdentifierHashes.add(event.logicalIdentifierHash);
		}
	}

	const subjectLocators = await Promise.all(
		input.contacts.map(async (contact) => ({
			contact,
			locator: await deriveProtectedContactSubjectLocator(
				keyConfig,
				input.organizationId,
				contact.id,
			),
		})),
	);
	const subjectIdByLocator = new Map(
		subjectLocators.map(({ contact, locator }) => [
			locator.contactSubjectLocator,
			contact.id,
		]),
	);

	const conversations = await tx
		.select({
			id: inboxConversations.id,
			contactId: inboxConversations.contactId,
			contactSubjectLocator: inboxConversations.contactSubjectLocator,
			workspaceId: inboxConversations.workspaceId,
			participantAvatarObjectKey: inboxConversations.participantAvatarObjectKey,
		})
		.from(inboxConversations)
		.where(
			and(
				eq(inboxConversations.organizationId, input.organizationId),
				or(
					inArray(inboxConversations.contactId, contactIds),
					inArray(
						inboxConversations.contactSubjectLocator,
						subjectLocators.map(({ locator }) => locator.contactSubjectLocator),
					),
				),
			),
		)
		.for("update");
	const conversationIds = conversations.map(({ id }) => id);

	let externalCleanupJobs = 0;
	for (const conversation of conversations) {
		if (!conversation.participantAvatarObjectKey) continue;
		const subjectId =
			conversation.contactId ??
			(conversation.contactSubjectLocator
				? subjectIdByLocator.get(conversation.contactSubjectLocator)
				: undefined);
		if (!subjectId) {
			throw new Error(
				"Contact-linked conversation is missing its protected subject locator",
			);
		}
		const inserted = await enqueueExactObjectCleanup(
			tx,
			{
				subjectKind: "contact",
				subjectId,
				organizationId: input.organizationId,
				workspaceId: conversation.workspaceId,
				bucket: "media",
				objectLocator: conversation.participantAvatarObjectKey,
			},
			input.occurredAt,
		);
		if (inserted) externalCleanupJobs++;
	}
	for (const contact of input.contacts) {
		const inserted = await enqueueQueueRescueSubjectCleanup(
			tx,
			{
				subjectKind: "contact",
				subjectId: contact.id,
				organizationId: input.organizationId,
				workspaceId: contact.workspaceId,
			},
			input.occurredAt,
		);
		if (inserted) externalCleanupJobs++;
	}

	if (conversationIds.length > 0) {
		// A pending/in-flight effect can no longer replay a payload containing the
		// erased subject. Unknown effects keep their provider-boundary evidence
		// and remain unknown; completed effects keep their terminal outcome.
		await tx.execute(sql`
			UPDATE inbox_event_effects AS effect
			   SET status = CASE
			                  WHEN effect.status IN ('pending', 'in_flight')
			                    THEN 'unknown'
			                  ELSE effect.status
			                END,
			       replay_payload = NULL,
			       lease_token = CASE
			                       WHEN effect.status = 'in_flight'
			                         THEN effect.lease_token + 1
			                       ELSE effect.lease_token
			                     END,
			       lease_expires_at = NULL,
			       last_enqueued_at = NULL,
			       error = CASE
			                 WHEN effect.status = 'completed' THEN effect.error
			                 ELSE 'subject_identity_erased'
			               END,
			       updated_at = ${input.occurredAt}
			 WHERE effect.organization_id = ${input.organizationId}
			   AND EXISTS (
			         SELECT 1
			           FROM inbox_messages AS message
			          WHERE message.conversation_id = ANY(${conversationIds}::text[])
			            AND message.organization_id = effect.organization_id
			            AND message.account_id = effect.account_id
			            AND message.platform_message_id = effect.platform_event_id
			       )
		`);

		await tx
			.update(inboxMessages)
			.set({
				authorName: null,
				authorPlatformId: null,
				authorAvatarUrl: null,
				text: null,
				attachments: [],
				sentimentScore: null,
				classification: null,
				platformData: {},
				isLiked: false,
				contentRedactedAt: input.occurredAt,
			})
			.where(
				and(
					eq(inboxMessages.organizationId, input.organizationId),
					inArray(inboxMessages.conversationId, conversationIds),
				),
			);
		await tx
			.delete(inboxConversationNotes)
			.where(
				and(
					eq(inboxConversationNotes.organizationId, input.organizationId),
					inArray(inboxConversationNotes.conversationId, conversationIds),
				),
			);
		for (const conversation of conversations) {
			await tx
				.update(inboxConversations)
				.set({
					contactId: null,
					platformConversationId: erasedConversationPlatformId(conversation.id),
					participantName: null,
					participantPlatformId: null,
					participantAvatar: null,
					participantAvatarObjectKey: null,
					participantMetadata: {},
					status: "archived",
					labels: [],
					unreadCount: 0,
					lastMessageText: null,
					sentimentAvg: null,
					closedAt: input.occurredAt,
					contentExpiresAt: input.occurredAt,
					contentRedactedAt: input.occurredAt,
					updatedAt: input.occurredAt,
				})
				.where(
					and(
						eq(inboxConversations.id, conversation.id),
						eq(inboxConversations.organizationId, input.organizationId),
					),
				);
		}
	}

	let broadcastRecipientsMinimized = 0;
	const identifierHashes = [...deletionIdentifierHashes];
	if (identifierHashes.length > 0) {
		const minimized = await tx
			.update(broadcastRecipients)
			.set({
				contactIdentifier: null,
				variables: null,
				piiErasedAt: input.occurredAt,
				status: sql`CASE
					WHEN ${broadcastRecipients.status} = 'pending'
						OR (${broadcastRecipients.status} = 'sending'
							AND ${broadcastRecipients.requestMayHaveBeenSentAt} IS NULL)
						THEN 'cancelled'
					WHEN ${broadcastRecipients.status} = 'sending'
						THEN 'unknown'
					ELSE ${broadcastRecipients.status}
				END`,
				deliveryState: sql`CASE
					WHEN ${broadcastRecipients.status} = 'pending'
						OR (${broadcastRecipients.status} = 'sending'
							AND ${broadcastRecipients.requestMayHaveBeenSentAt} IS NULL)
						THEN 'cancelled'
					WHEN ${broadcastRecipients.status} = 'sending'
						THEN 'unknown'
					ELSE ${broadcastRecipients.deliveryState}
				END`,
				claimedAt: sql`CASE
					WHEN ${broadcastRecipients.status} = 'sending'
						AND ${broadcastRecipients.requestMayHaveBeenSentAt} IS NOT NULL
						THEN ${broadcastRecipients.claimedAt}
					ELSE NULL
				END`,
				error: "subject_identity_erased",
			})
			.where(
				and(
					eq(broadcastRecipients.organizationId, input.organizationId),
					or(
						inArray(broadcastRecipients.contactId, contactIds),
						inArray(
							broadcastRecipients.contactIdentifierHash,
							identifierHashes,
						),
					),
				),
			)
			.returning({ id: broadcastRecipients.id });
		broadcastRecipientsMinimized = minimized.length;
	}

	const audienceEmailHashes = await Promise.all(
		input.contacts.flatMap(({ email }) =>
			email ? [sha256Hex(email.trim().toLowerCase())] : [],
		),
	);
	const audiencePhoneHashes = await Promise.all(
		input.contacts.flatMap(({ phone }) => {
			if (!phone) return [];
			const canonical = normalizeContactPhone(phone, {
				allowBareInternational: true,
			});
			return canonical ? [sha256Hex(canonical.slice(1))] : [];
		}),
	);
	let audienceUsersDeleted = 0;
	if (audienceEmailHashes.length > 0 || audiencePhoneHashes.length > 0) {
		const audiencePredicates = [
			...(audienceEmailHashes.length > 0
				? [inArray(adAudienceUsers.emailHash, audienceEmailHashes)]
				: []),
			...(audiencePhoneHashes.length > 0
				? [inArray(adAudienceUsers.phoneHash, audiencePhoneHashes)]
				: []),
		];
		const deletedAudienceUsers = await tx
			.delete(adAudienceUsers)
			.where(
				and(
					or(...audiencePredicates),
					sql`EXISTS (
						SELECT 1
						  FROM ${adAudiences}
						 WHERE ${adAudiences.id} = ${adAudienceUsers.audienceId}
						   AND ${adAudiences.organizationId} = ${input.organizationId}
					)`,
				),
			)
			.returning({ id: adAudienceUsers.id });
		audienceUsersDeleted = deletedAudienceUsers.length;
	}

	await tx
		.update(contactConsentEvents)
		.set({
			contactId: null,
			identifierMasked: null,
			evidence: null,
		})
		.where(
			and(
				eq(contactConsentEvents.organizationId, input.organizationId),
				or(
					inArray(contactConsentEvents.contactId, contactIds),
					...(identifierHashes.length > 0
						? [
								inArray(
									contactConsentEvents.logicalIdentifierHash,
									identifierHashes,
								),
							]
						: []),
				),
			),
		);

	await tx
		.update(queueFailures)
		.set({
			contactIds: sql`ARRAY(
				SELECT value
				  FROM unnest(${queueFailures.contactIds}) AS value
				 WHERE NOT (value = ANY(${contactIds}::text[]))
			)`,
			payloadCiphertext: null,
			payloadKeyId: null,
			payloadRedactedAt: sql`COALESCE(${queueFailures.payloadRedactedAt}, ${input.occurredAt})`,
			status: sql`CASE
				WHEN ${queueFailures.status} = 'replay_claimed' THEN 'replay_unknown'
				WHEN ${queueFailures.status} IN ('replay_unknown', 'replayed', 'dismissed')
					THEN ${queueFailures.status}
				ELSE 'dismissed'
			END`,
			resolvedAt: sql`CASE
				WHEN ${queueFailures.status} IN ('replayed', 'dismissed')
					THEN ${queueFailures.resolvedAt}
				WHEN ${queueFailures.status} IN ('replay_claimed', 'replay_unknown')
					THEN NULL
				ELSE COALESCE(${queueFailures.resolvedAt}, ${input.occurredAt})
			END`,
			replayClaimToken: null,
			replayClaimExpiresAt: null,
			error: "subject_identity_erased",
		})
		.where(sql`${queueFailures.contactIds} && ${contactIds}::text[]`);

	// Subscription events intentionally outlive a merge source contact. For a
	// true erasure, walk the immutable merge lineage backwards, remove the live
	// projections first, then drain every linked event without rewriting it.
	await tx
		.delete(contactSubscriptions)
		.where(
			and(
				eq(contactSubscriptions.organizationId, input.organizationId),
				inArray(contactSubscriptions.contactId, contactIds),
			),
		);
	await tx.execute(sql`
		WITH RECURSIVE subscription_subjects(contact_id) AS (
			SELECT unnest(${contactIds}::text[])
			UNION
			SELECT event.merged_from_contact_id
			FROM contact_subscription_events AS event
			INNER JOIN subscription_subjects AS subject
				ON event.contact_id = subject.contact_id
			WHERE event.organization_id = ${input.organizationId}
				AND event.merged_from_contact_id IS NOT NULL
		)
		DELETE FROM contact_subscription_events AS event
		WHERE event.organization_id = ${input.organizationId}
			AND event.contact_id IN (
				SELECT contact_id FROM subscription_subjects
			)
	`);

	const deleted = await tx
		.delete(contacts)
		.where(
			and(
				eq(contacts.organizationId, input.organizationId),
				inArray(contacts.id, contactIds),
			),
		)
		.returning({ id: contacts.id });
	if (deleted.length !== contactIds.length) {
		throw new Error("Contact erasure lost its locked contact set");
	}

	return {
		deletedIds: deleted.map(({ id }) => id),
		conversationsRedacted: conversations.length,
		externalCleanupJobs,
		broadcastRecipientsMinimized,
		audienceUsersDeleted,
	};
}
