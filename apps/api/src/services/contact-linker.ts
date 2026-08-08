import type { Database } from "@relayapi/db";
import {
	contactChannels,
	contacts,
	generateId,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { normalizeContactPhone } from "../lib/contact-phone";
import { workspaceScopeKey } from "../lib/request-access";
import {
	deriveContactChannelIdentifierHash,
	deriveContactEmailHash,
	deriveContactNameHash,
	deriveContactPhoneHash,
	protectContactChannelIdentifier,
	protectContactValues,
} from "./contact-protection";

interface LinkResult {
	contactId: string;
	confidence: "exact" | "phone" | "email" | "name_suggestion";
}

/**
 * Attempts to find a matching contact for an inbox conversation participant.
 * Returns the best match with confidence level, or null if no match found.
 *
 * Priority chain:
 * 1. Exact channel match (identifier + account) — auto-link
 * 2. Canonical phone identity match — auto-link
 * 3. Email match (keyed contacts.email_hash matches participant metadata) — auto-link
 * 4. Name match (exact case-insensitive) — suggestion only
 */
export async function findMatchingContact(
	db: Database,
	orgId: string,
	accountId: string,
	participantPlatformId: string | null,
	participantName: string | null,
	participantMetadata: Record<string, unknown> | null | undefined,
	keyConfig: string,
): Promise<LinkResult | null> {
	if (!participantPlatformId && !participantName) return null;
	const account = await db.query.socialAccounts.findFirst({
		where: and(
			eq(socialAccounts.id, accountId),
			eq(socialAccounts.organizationId, orgId),
			eq(socialAccounts.lifecycleStatus, "active"),
		),
	});
	if (!account) return null;
	const sameAccountWorkspace = sql`${contacts.workspaceId} IS NOT DISTINCT FROM ${account.workspaceId}`;

	// Priority 1: Exact channel match (identifier + social account)
	if (participantPlatformId) {
		const identifierHash = await deriveContactChannelIdentifierHash(
			keyConfig,
			orgId,
			participantPlatformId,
		);
		const [exactMatch] = await db
			.select({ contactId: contactChannels.contactId })
			.from(contactChannels)
			.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					eq(contactChannels.socialAccountId, accountId),
					eq(contactChannels.identifierHash, identifierHash),
				),
			)
			.limit(1);

		if (exactMatch) {
			return { contactId: exactMatch.contactId, confidence: "exact" };
		}
	}

	// Priority 2: normalize provider identifiers with the same numbering-aware
	// function used by every contact writer. WhatsApp wa_id deliberately omits
	// the plus, hence allowBareInternational on this provider-bound path.
	const normalizedPhone = participantPlatformId
		? normalizeContactPhone(participantPlatformId, {
				allowBareInternational: true,
			})
		: null;
	if (normalizedPhone) {
		const phoneHash = await deriveContactPhoneHash(
			keyConfig,
			orgId,
			normalizedPhone,
		);
		const [phoneMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					eq(contacts.phoneHash, phoneHash as string),
				),
			)
			.limit(1);

		if (phoneMatch) {
			return { contactId: phoneMatch.id, confidence: "phone" };
		}
	}

	// Priority 3: Email match (from participant metadata)
	const email = participantMetadata?.email as string | undefined;
	if (email) {
		const emailHash = await deriveContactEmailHash(keyConfig, orgId, email);
		const [emailMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					eq(contacts.emailHash, emailHash),
				),
			)
			.limit(1);

		if (emailMatch) {
			return { contactId: emailMatch.id, confidence: "email" };
		}
	}

	// Priority 4: Name match (exact case-insensitive — suggestion only)
	if (participantName && participantName.length >= 2) {
		const nameHash = await deriveContactNameHash(
			keyConfig,
			orgId,
			participantName,
		);
		const [nameMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					eq(contacts.nameHash, nameHash),
				),
			)
			.limit(1);

		if (nameMatch) {
			return { contactId: nameMatch.id, confidence: "name_suggestion" };
		}
	}

	return null;
}

/**
 * Resolves a contact for an inbound automation author, creating a minimal
 * contact + channel row when no existing contact matches. The automation
 * runtime depends on `contactChannels` to know where to DM back — without this
 * step, "reply to new DM" flows fail on the first send node because the
 * author is unknown to the contact graph.
 *
 * Skips creation when the author or social account is missing. An account with
 * no workspace creates an organization-scoped contact when workspace IDs are
 * optional; required-mode activation prevents active unscoped graphs.
 */
export async function ensureContactForAuthor(
	db: Database,
	orgId: string,
	socialAccountId: string,
	platform: string,
	authorId: string | null,
	authorName: string | null,
	keyConfig: string,
): Promise<string | null> {
	if (!authorId) return null;

	const existing = await findMatchingContact(
		db,
		orgId,
		socialAccountId,
		authorId,
		authorName,
		null,
		keyConfig,
	);
	if (existing && existing.confidence !== "name_suggestion") {
		// An "exact" match already matched ON the (socialAccount, identifier)
		// channel row, so the channel link provably exists — skip the redundant
		// ensureChannelLink existence SELECT. Only phone/email matches may lack a
		// channel row for this (platform, socialAccount, identifier) tuple, so
		// link it now for those so future sends find it without re-matching.
		if (existing.confidence !== "exact") {
			await ensureChannelLink(
				db,
				orgId,
				existing.contactId,
				socialAccountId,
				platform,
				authorId,
				keyConfig,
			);
		}
		return existing.contactId;
	}

	const account = await db.query.socialAccounts.findFirst({
		where: and(
			eq(socialAccounts.id, socialAccountId),
			eq(socialAccounts.organizationId, orgId),
		),
	});
	if (!account) return null;

	// Only treat the author id as a phone number for channels whose identifiers
	// ARE phone numbers (WhatsApp wa_id, SMS E.164). Telegram/Instagram/Facebook
	// ids are plain integers that pass a naive /\d{7,15}/ test, so writing them
	// to the protected contact phone produces a bogus identity that the phone
	// matcher could later
	// collide against an unrelated WhatsApp/SMS participant.
	const PHONE_PLATFORMS = new Set(["whatsapp", "sms", "twilio"]);
	const phoneCanonical = PHONE_PLATFORMS.has(platform)
		? normalizeContactPhone(authorId, { allowBareInternational: true })
		: null;
	const phone = phoneCanonical ? authorId : null;
	const contactId = generateId("ct_");
	const protectedContact = await protectContactValues(
		keyConfig,
		orgId,
		contactId,
		{
			name: authorName ?? null,
			email: null,
			phone,
			metadata: null,
		},
	);
	const phoneHash = phone
		? await deriveContactPhoneHash(keyConfig, orgId, phone)
		: null;
	const channelId = generateId("cc_");
	const protectedChannel = await protectContactChannelIdentifier(keyConfig, {
		id: channelId,
		organizationId: orgId,
		identifier: authorId,
	});

	const created = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(contacts)
			.values({
				id: contactId,
				organizationId: orgId,
				workspaceId: account.workspaceId,
				...protectedContact,
			})
			.onConflictDoNothing()
			.returning({ id: contacts.id });
		if (!row) return null;
		await tx.insert(contactChannels).values({
			id: channelId,
			organizationId: orgId,
			scopeKey: workspaceScopeKey(account.workspaceId),
			contactId: row.id,
			socialAccountId,
			platform: platform as typeof contactChannels.$inferInsert.platform,
			...protectedChannel,
		});
		return row;
	});
	if (!created && phoneCanonical) {
		const [concurrent] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					account.workspaceId
						? eq(contacts.workspaceId, account.workspaceId)
						: isNull(contacts.workspaceId),
					eq(contacts.phoneHash, phoneHash as string),
				),
			)
			.limit(1);
		if (concurrent) {
			await ensureChannelLink(
				db,
				orgId,
				concurrent.id,
				socialAccountId,
				platform,
				authorId,
				keyConfig,
			);
			return concurrent.id;
		}
	}
	if (!created) return null;

	return created.id;
}

async function ensureChannelLink(
	db: Database,
	organizationId: string,
	contactId: string,
	socialAccountId: string,
	platform: string,
	identifier: string,
	keyConfig: string,
): Promise<void> {
	const [relationship] = await db
		.select({
			contactId: contacts.id,
			workspaceId: contacts.workspaceId,
		})
		.from(contacts)
		.innerJoin(
			socialAccounts,
			and(
				eq(socialAccounts.id, socialAccountId),
				eq(socialAccounts.organizationId, organizationId),
				sql`${socialAccounts.workspaceId} IS NOT DISTINCT FROM ${contacts.workspaceId}`,
			),
		)
		.where(
			and(
				eq(contacts.id, contactId),
				eq(contacts.organizationId, organizationId),
			),
		)
		.limit(1);
	if (!relationship) return;
	const identifierHash = await deriveContactChannelIdentifierHash(
		keyConfig,
		organizationId,
		identifier,
	);
	const existing = await db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, contactId),
			eq(contactChannels.socialAccountId, socialAccountId),
			eq(contactChannels.identifierHash, identifierHash),
		),
	});
	if (existing) return;
	const id = generateId("cc_");
	const protectedIdentifier = await protectContactChannelIdentifier(keyConfig, {
		id,
		organizationId,
		identifier,
	});
	try {
		await db.insert(contactChannels).values({
			id,
			organizationId,
			scopeKey: workspaceScopeKey(relationship.workspaceId),
			contactId,
			socialAccountId,
			platform: platform as typeof contactChannels.$inferInsert.platform,
			...protectedIdentifier,
		});
	} catch {
		// Unique index on (social_account_id, identifier) means a race with
		// another inbox event racing to link the same author can fail the
		// insert — safe to swallow; the row we wanted exists.
	}
}
