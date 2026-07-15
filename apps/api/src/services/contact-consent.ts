import {
	contactConsentEvents,
	contactConsentStates,
	contactSuppressions,
	type Database,
	generateId,
} from "@relayapi/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

export type ConsentStatus = "granted" | "denied";

export const MAX_CONSENT_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isConsentOccurrenceTimeAllowed(
	occurredAt: Date,
	now = new Date(),
): boolean {
	return occurredAt.getTime() <= now.getTime() + MAX_CONSENT_FUTURE_SKEW_MS;
}

export function normalizeRecipientIdentifier(
	channel: string,
	identifier: string,
): string {
	const value = identifier.trim();
	if (channel === "email") return value.toLowerCase();
	if (channel === "sms" || channel === "whatsapp" || channel === "phone") {
		const digits = value.replace(/\D/g, "");
		return digits ? `+${digits}` : value;
	}
	return value.toLowerCase();
}

export async function hashRecipientIdentifier(
	channel: string,
	identifier: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(
		`${channel}:${normalizeRecipientIdentifier(channel, identifier)}`,
	);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function maskIdentifier(channel: string, identifier: string): string {
	const normalized = normalizeRecipientIdentifier(channel, identifier);
	if (channel === "email") {
		const [local, domain] = normalized.split("@");
		return domain ? `${local?.slice(0, 1) ?? "*"}***@${domain}` : "***";
	}
	return normalized.length > 4 ? `***${normalized.slice(-4)}` : "***";
}

export interface RecordConsentInput {
	organizationId: string;
	workspaceId?: string | null;
	contactId?: string | null;
	channel: string;
	purpose: string;
	identifier: string;
	status: ConsentStatus;
	source: string;
	occurredAt: Date;
	evidence?: Record<string, unknown> | null;
	policyVersion?: string | null;
	jurisdiction?: string | null;
}

export type ContactConsentTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

export async function recordContactConsent(
	db: Database,
	input: RecordConsentInput,
) {
	return db.transaction((tx) => recordContactConsentInTransaction(tx, input));
}

export async function recordContactConsentInTransaction(
	tx: ContactConsentTransaction,
	input: RecordConsentInput,
) {
	if (!isConsentOccurrenceTimeAllowed(input.occurredAt)) {
		throw new Error(
			"Consent occurredAt cannot be more than five minutes in the future",
		);
	}
	const identifierHash = await hashRecipientIdentifier(
		input.channel,
		input.identifier,
	);
	const eventId = generateId("cce_");

	const [event] = await tx
		.insert(contactConsentEvents)
		.values({
			id: eventId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId ?? null,
			contactId: input.contactId ?? null,
			channel: input.channel,
			purpose: input.purpose,
			status: input.status,
			identifierHash,
			identifierMasked: maskIdentifier(input.channel, input.identifier),
			source: input.source,
			occurredAt: input.occurredAt,
			evidence: input.evidence ?? null,
			policyVersion: input.policyVersion ?? null,
			jurisdiction: input.jurisdiction ?? null,
		})
		.returning();
	if (!event) throw new Error("Failed to persist consent event");

	const [state] = await tx
		.insert(contactConsentStates)
		.values({
			organizationId: input.organizationId,
			workspaceId: input.workspaceId ?? null,
			contactId: input.contactId ?? null,
			channel: input.channel,
			purpose: input.purpose,
			identifierHash,
			status: input.status,
			source: input.source,
			occurredAt: input.occurredAt,
			policyVersion: input.policyVersion ?? null,
			jurisdiction: input.jurisdiction ?? null,
			lastEventId: eventId,
			lastIngestionSequence: event.ingestionSequence,
		})
		.onConflictDoUpdate({
			target: [
				contactConsentStates.organizationId,
				contactConsentStates.channel,
				contactConsentStates.purpose,
				contactConsentStates.identifierHash,
			],
			set: {
				// Workspace is evidence provenance only. Consent authority is exact
				// organization + channel + purpose + normalized recipient hash.
				workspaceId: input.workspaceId ?? null,
				contactId: input.contactId ?? null,
				status: input.status,
				source: input.source,
				occurredAt: input.occurredAt,
				policyVersion: input.policyVersion ?? null,
				jurisdiction: input.jurisdiction ?? null,
				lastEventId: eventId,
				lastIngestionSequence: event.ingestionSequence,
				updatedAt: new Date(),
			},
			// Server-assigned ingestion order is authoritative. occurredAt remains
			// immutable evidence but cannot be abused to freeze future state.
			setWhere: lt(
				contactConsentStates.lastIngestionSequence,
				event.ingestionSequence,
			),
		})
		.returning();

	if (!state) return event;

	if (input.status === "granted") {
		await tx
			.delete(contactSuppressions)
			.where(
				and(
					eq(contactSuppressions.organizationId, input.organizationId),
					eq(contactSuppressions.channel, input.channel),
					eq(contactSuppressions.purpose, input.purpose),
					eq(contactSuppressions.identifierHash, identifierHash),
				),
			);
	} else if (input.status === "denied") {
		await tx
			.insert(contactSuppressions)
			.values({
				organizationId: input.organizationId,
				workspaceId: input.workspaceId ?? null,
				channel: input.channel,
				purpose: input.purpose,
				identifierHash,
				sourceEventId: eventId,
				reason: "consent_withdrawn",
			})
			.onConflictDoUpdate({
				target: [
					contactSuppressions.organizationId,
					contactSuppressions.channel,
					contactSuppressions.purpose,
					contactSuppressions.identifierHash,
				],
				set: {
					workspaceId: input.workspaceId ?? null,
					sourceEventId: eventId,
					reason: "consent_withdrawn",
				},
			});

		if (input.purpose === "marketing") {
			const recipientMatch = input.contactId
				? sql`(r.contact_id = ${input.contactId} OR r.contact_identifier_hash = ${identifierHash})`
				: sql`r.contact_identifier_hash = ${identifierHash}`;
			// unrelated purpose (for example automation) must not affect marketing.
			// Only pending work can be truthfully cancelled; a `sending` recipient may
			// already have crossed the provider request boundary.
			// Only marketing withdrawals cancel broadcast work. Consent purposes are
			// exact; there is no wildcard fallback. Only pending work can be truthfully
			// cancelled because `sending` may have crossed the provider boundary.
			// unrelated purpose (for example automation) must not affect marketing.
			// Only pending work can be truthfully cancelled; a `sending` recipient may
			// already have crossed the provider request boundary.
			await tx.execute(sql`
				UPDATE broadcast_recipients r
					   SET status = 'failed',
					       delivery_state = 'failed',
					       error = 'Consent withdrawn before delivery'
				  FROM broadcasts b
				 WHERE r.broadcast_id = b.id
				   AND b.organization_id = ${input.organizationId}
				   AND r.organization_id = b.organization_id
				   AND r.scope_key = b.scope_key
				   AND b.platform = ${input.channel}
				   AND r.status = 'pending'
				   AND ${recipientMatch}
			`);
		}
	}

	return event;
}

export interface ConsentRecipient {
	identifier: string;
	contactId?: string | null;
}

export async function getAllowedRecipientHashes(
	db: Database,
	organizationId: string,
	channel: string,
	purpose: string,
	recipients: ConsentRecipient[],
	options: { requireGrant?: boolean } = {},
): Promise<Set<string>> {
	const hashes = await Promise.all(
		recipients.map((recipient) =>
			hashRecipientIdentifier(channel, recipient.identifier),
		),
	);
	const uniqueHashes = [...new Set(hashes)];
	if (uniqueHashes.length === 0) return new Set();

	const [states, suppressions] = await Promise.all([
		db
			.select({
				identifierHash: contactConsentStates.identifierHash,
				status: contactConsentStates.status,
			})
			.from(contactConsentStates)
			.where(
				and(
					eq(contactConsentStates.organizationId, organizationId),
					eq(contactConsentStates.channel, channel),
					eq(contactConsentStates.purpose, purpose),
					inArray(contactConsentStates.identifierHash, uniqueHashes),
				),
			),
		db
			.select({ identifierHash: contactSuppressions.identifierHash })
			.from(contactSuppressions)
			.where(
				and(
					eq(contactSuppressions.organizationId, organizationId),
					eq(contactSuppressions.channel, channel),
					eq(contactSuppressions.purpose, purpose),
					inArray(contactSuppressions.identifierHash, uniqueHashes),
				),
			),
	]);

	const suppressed = new Set(suppressions.map((row) => row.identifierHash));
	const granted = new Set(
		states
			.filter((state) => state.status === "granted")
			.map((state) => state.identifierHash),
	);
	return new Set(
		uniqueHashes.filter(
			(hash) =>
				!suppressed.has(hash) &&
				(options.requireGrant === false || granted.has(hash)),
		),
	);
}
