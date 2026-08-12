import {
	contactConsentEvents,
	contactConsentStates,
	type Database,
	generateId,
} from "@relayapi/db";
import { and, count, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
	canonicalConsentDimension,
	consentIdentityKeyFingerprint,
	deriveConsentIdentifierIdentity,
	deriveConsentLookupHashFromLogical,
	parseConsentHmacKeyRing,
} from "../lib/consent-hmac";
import { normalizeContactPhone } from "../lib/contact-phone";

export type ConsentStatus = "granted" | "denied";

export const MAX_CONSENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CONTACT_CONSENT_ORDERING_REGION = "home";
const CONSENT_HLC_LOGICAL_BITS = 16n;

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
		return (
			normalizeContactPhone(value, { allowBareInternational: true }) ?? value
		);
	}
	return value.toLowerCase();
}

export async function hashRecipientIdentifier(
	keyConfig: string,
	organizationId: string,
	channel: string,
	purpose: string,
	identifier: string,
): Promise<string> {
	const canonicalChannel = canonicalConsentDimension(channel, "channel");
	return (
		await deriveConsentIdentifierIdentity(keyConfig, {
			organizationId,
			channel: canonicalChannel,
			purpose,
			normalizedIdentifier: normalizeRecipientIdentifier(
				canonicalChannel,
				identifier,
			),
		})
	).logicalIdentifierHash;
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

export class ConsentIdentityKeyMismatchError extends Error {
	constructor(organizationId: string) {
		super(
			`Consent identity key does not match durable authority for organization ${organizationId}`,
		);
		this.name = "ConsentIdentityKeyMismatchError";
	}
}

async function assertConsentIdentityKey(
	db: Pick<Database, "selectDistinct">,
	keyConfig: string,
	organizationId: string,
): Promise<string> {
	const expected = await consentIdentityKeyFingerprint(
		keyConfig,
		organizationId,
	);
	const durable = await db
		.selectDistinct({
			identityKeyFingerprint: contactConsentStates.identityKeyFingerprint,
		})
		.from(contactConsentStates)
		.where(eq(contactConsentStates.organizationId, organizationId));
	if (durable.some((row) => row.identityKeyFingerprint !== expected)) {
		throw new ConsentIdentityKeyMismatchError(organizationId);
	}
	return expected;
}

async function lockConsentIdentity(
	tx: ContactConsentTransaction,
	organizationId: string,
): Promise<void> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`consent-identity:${organizationId}`}, 0))`,
	);
}

/**
 * Encode physical milliseconds plus a per-organization logical counter.
 *
 * The organization advisory lock serializes local allocation. A future region
 * merger advances from the greatest observed HLC, while `ordering_region` and
 * `event_id` deterministically break equal physical/logical values.
 */
export function nextConsentOrderingHlc(
	now: Date,
	previous: bigint | null,
): bigint {
	const physical = BigInt(now.getTime()) << CONSENT_HLC_LOGICAL_BITS;
	return previous !== null && previous >= physical ? previous + 1n : physical;
}

async function allocateConsentOrderingHlc(
	tx: ContactConsentTransaction,
	organizationId: string,
	now: Date,
): Promise<bigint> {
	const [latest] = await tx
		.select({ orderingHlc: contactConsentEvents.orderingHlc })
		.from(contactConsentEvents)
		.where(eq(contactConsentEvents.organizationId, organizationId))
		.orderBy(
			desc(contactConsentEvents.orderingHlc),
			desc(contactConsentEvents.orderingRegion),
			desc(contactConsentEvents.id),
		)
		.limit(1);
	return nextConsentOrderingHlc(now, latest?.orderingHlc ?? null);
}

export async function recordContactConsent(
	db: Database,
	keyConfig: string,
	input: RecordConsentInput,
) {
	return db.transaction((tx) =>
		recordContactConsentInTransaction(tx, keyConfig, input),
	);
}

export async function recordContactConsentInTransaction(
	tx: ContactConsentTransaction,
	keyConfig: string,
	input: RecordConsentInput,
) {
	if (!isConsentOccurrenceTimeAllowed(input.occurredAt)) {
		throw new Error(
			"Consent occurredAt cannot be more than five minutes in the future",
		);
	}
	const channel = canonicalConsentDimension(input.channel, "channel");
	const purpose = canonicalConsentDimension(input.purpose, "purpose");
	await lockConsentIdentity(tx, input.organizationId);
	const identityKeyFingerprint = await assertConsentIdentityKey(
		tx,
		keyConfig,
		input.organizationId,
	);
	const identity = await deriveConsentIdentifierIdentity(keyConfig, {
		organizationId: input.organizationId,
		channel,
		purpose,
		normalizedIdentifier: normalizeRecipientIdentifier(
			channel,
			input.identifier,
		),
	});
	const eventId = generateId("cce_");
	const projectionNow = new Date();
	const orderingHlc = await allocateConsentOrderingHlc(
		tx,
		input.organizationId,
		projectionNow,
	);

	const [event] = await tx
		.insert(contactConsentEvents)
		.values({
			id: eventId,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId ?? null,
			contactId: input.contactId ?? null,
			orderingHlc,
			orderingRegion: CONTACT_CONSENT_ORDERING_REGION,
			channel,
			purpose,
			status: input.status,
			logicalIdentifierHash: identity.logicalIdentifierHash,
			identifierHash: identity.identifierHash,
			identifierKeyVersion: identity.identifierKeyVersion,
			identifierMasked: maskIdentifier(channel, input.identifier),
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
			channel,
			purpose,
			logicalIdentifierHash: identity.logicalIdentifierHash,
			identifierHash: identity.identifierHash,
			identifierKeyVersion: identity.identifierKeyVersion,
			identityKeyFingerprint,
			status: input.status,
			source: input.source,
			occurredAt: input.occurredAt,
			policyVersion: input.policyVersion ?? null,
			jurisdiction: input.jurisdiction ?? null,
			lastEventId: eventId,
			lastOrderingHlc: event.orderingHlc,
			lastOrderingRegion: event.orderingRegion,
		})
		.onConflictDoUpdate({
			target: [
				contactConsentStates.organizationId,
				contactConsentStates.channel,
				contactConsentStates.purpose,
				contactConsentStates.logicalIdentifierHash,
			],
			set: {
				// Workspace is evidence provenance only. Consent authority is exact
				// organization + channel + purpose + normalized recipient hash.
				// It intentionally has no contact FK: a merge, erasure, or re-import
				// must never make an identifier's withdrawal disappear.
				workspaceId: input.workspaceId ?? null,
				identifierHash: identity.identifierHash,
				identifierKeyVersion: identity.identifierKeyVersion,
				identityKeyFingerprint,
				status: input.status,
				source: input.source,
				occurredAt: input.occurredAt,
				policyVersion: input.policyVersion ?? null,
				jurisdiction: input.jurisdiction ?? null,
				lastEventId: eventId,
				lastOrderingHlc: event.orderingHlc,
				lastOrderingRegion: event.orderingRegion,
				updatedAt: projectionNow,
			},
			// The server-owned HLC tuple is authoritative. occurredAt remains
			// immutable evidence but cannot be abused to freeze future state.
			setWhere: or(
				lt(contactConsentStates.lastOrderingHlc, event.orderingHlc),
				and(
					eq(contactConsentStates.lastOrderingHlc, event.orderingHlc),
					lt(contactConsentStates.lastOrderingRegion, event.orderingRegion),
				),
				and(
					eq(contactConsentStates.lastOrderingHlc, event.orderingHlc),
					eq(contactConsentStates.lastOrderingRegion, event.orderingRegion),
					lt(contactConsentStates.lastEventId, eventId),
				),
			),
		})
		.returning();

	if (!state) return event;

	if (input.status === "denied") {
		if (purpose === "marketing") {
			const recipientMatch = input.contactId
				? sql`(r.contact_id = ${input.contactId} OR r.contact_identifier_hash = ${identity.logicalIdentifierHash})`
				: sql`r.contact_identifier_hash = ${identity.logicalIdentifierHash}`;
			// Only marketing withdrawals cancel broadcast work. Consent purposes are
			// exact; there is no wildcard fallback. Only pending work can be truthfully
			// cancelled because `sending` may have crossed the provider boundary.
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
				   AND b.platform = ${channel}
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
	keyConfig: string,
	organizationId: string,
	channel: string,
	purpose: string,
	recipients: ConsentRecipient[],
	options: { requireGrant?: boolean } = {},
): Promise<Set<string>> {
	const canonicalChannel = canonicalConsentDimension(channel, "channel");
	const canonicalPurpose = canonicalConsentDimension(purpose, "purpose");
	const hashes = await Promise.all(
		recipients.map((recipient) =>
			hashRecipientIdentifier(
				keyConfig,
				organizationId,
				canonicalChannel,
				canonicalPurpose,
				recipient.identifier,
			),
		),
	);
	const uniqueHashes = [...new Set(hashes)];
	if (uniqueHashes.length === 0) return new Set();

	await assertConsentIdentityKey(db, keyConfig, organizationId);
	const states = await db
		.select({
			logicalIdentifierHash: contactConsentStates.logicalIdentifierHash,
			status: contactConsentStates.status,
		})
		.from(contactConsentStates)
		.where(
			and(
				eq(contactConsentStates.organizationId, organizationId),
				eq(contactConsentStates.channel, canonicalChannel),
				eq(contactConsentStates.purpose, canonicalPurpose),
				inArray(contactConsentStates.logicalIdentifierHash, uniqueHashes),
			),
		);
	const denied = new Set(
		states
			.filter((state) => state.status === "denied")
			.map((state) => state.logicalIdentifierHash),
	);
	const granted = new Set(
		states
			.filter((state) => state.status === "granted")
			.map((state) => state.logicalIdentifierHash),
	);
	return new Set(
		uniqueHashes.filter(
			(hash) =>
				!denied.has(hash) &&
				(options.requireGrant === false || granted.has(hash)),
		),
	);
}

export interface ConsentAuthorityRotationResult {
	activeVersion: string;
	rewritten: number;
	remaining: number;
}

/**
 * Rewrites current authority to the active HMAC version without plaintext.
 *
 * The stable logical HMAC is the canonical row identity. Each batch locks the
 * selected rows and changes the version/hash tuple in one transaction; send
 * authorization continues to query the logical identity, so rotation cannot
 * create a temporary allow gap. Old version keys may be retired only after
 * `remaining` reaches zero. The retained identity key is fingerprint-checked
 * before every rewrite and replacement fails closed.
 */
export async function rotateContactConsentAuthority(
	db: Database,
	keyConfig: string,
	limit = 50,
): Promise<ConsentAuthorityRotationResult> {
	const ring = parseConsentHmacKeyRing(keyConfig);
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new Error(
			"Consent authority rotation limit must be between 1 and 500",
		);
	}
	return db.transaction(async (tx) => {
		const anchors = await tx
			.selectDistinct({
				organizationId: contactConsentStates.organizationId,
				identityKeyFingerprint: contactConsentStates.identityKeyFingerprint,
			})
			.from(contactConsentStates)
			.orderBy(contactConsentStates.organizationId);
		for (const anchor of anchors) {
			await lockConsentIdentity(tx, anchor.organizationId);
			const expected = await consentIdentityKeyFingerprint(
				keyConfig,
				anchor.organizationId,
			);
			if (anchor.identityKeyFingerprint !== expected) {
				throw new ConsentIdentityKeyMismatchError(anchor.organizationId);
			}
		}

		const rows = await tx
			.select({
				id: contactConsentStates.id,
				organizationId: contactConsentStates.organizationId,
				channel: contactConsentStates.channel,
				purpose: contactConsentStates.purpose,
				logicalIdentifierHash: contactConsentStates.logicalIdentifierHash,
				identifierHash: contactConsentStates.identifierHash,
				identifierKeyVersion: contactConsentStates.identifierKeyVersion,
				identityKeyFingerprint: contactConsentStates.identityKeyFingerprint,
			})
			.from(contactConsentStates)
			.where(ne(contactConsentStates.identifierKeyVersion, ring.activeVersion))
			.orderBy(contactConsentStates.organizationId, contactConsentStates.id)
			.limit(limit)
			.for("update", { skipLocked: true });

		let rewritten = 0;
		for (const row of rows) {
			await lockConsentIdentity(tx, row.organizationId);
			const expectedFingerprint = await assertConsentIdentityKey(
				tx,
				keyConfig,
				row.organizationId,
			);
			if (row.identityKeyFingerprint !== expectedFingerprint) {
				throw new ConsentIdentityKeyMismatchError(row.organizationId);
			}
			if (row.identifierKeyVersion === ring.activeVersion) continue;
			const next = await deriveConsentLookupHashFromLogical(keyConfig, {
				organizationId: row.organizationId,
				channel: row.channel,
				purpose: row.purpose,
				logicalIdentifierHash: row.logicalIdentifierHash,
			});
			const updated = await tx
				.update(contactConsentStates)
				.set({
					identifierHash: next.identifierHash,
					identifierKeyVersion: next.identifierKeyVersion,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(contactConsentStates.id, row.id),
						eq(
							contactConsentStates.identifierKeyVersion,
							row.identifierKeyVersion,
						),
						eq(contactConsentStates.identifierHash, row.identifierHash),
						eq(
							contactConsentStates.identityKeyFingerprint,
							row.identityKeyFingerprint,
						),
					),
				)
				.returning({ id: contactConsentStates.id });
			rewritten += updated.length;
		}

		const [remainingRow] = await tx
			.select({ value: count() })
			.from(contactConsentStates)
			.where(ne(contactConsentStates.identifierKeyVersion, ring.activeVersion));
		return {
			activeVersion: ring.activeVersion,
			rewritten,
			remaining: remainingRow?.value ?? 0,
		};
	});
}
