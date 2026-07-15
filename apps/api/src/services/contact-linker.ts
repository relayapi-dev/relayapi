import type { Database } from "@relayapi/db";
import { contactChannels, contacts, socialAccounts } from "@relayapi/db";
import { and, eq, ilike, sql } from "drizzle-orm";

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
 * 2. Phone match (contacts.phone matches participant phone) — auto-link
 * 3. Email match (contacts.email matches participant email from metadata) — auto-link
 * 4. Name match (exact case-insensitive) — suggestion only
 */
export async function findMatchingContact(
	db: Database,
	orgId: string,
	accountId: string,
	participantPlatformId: string | null,
	participantName: string | null,
	participantMetadata?: Record<string, unknown> | null,
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
		const [exactMatch] = await db
			.select({ contactId: contactChannels.contactId })
			.from(contactChannels)
			.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					eq(contactChannels.socialAccountId, accountId),
					eq(contactChannels.identifier, participantPlatformId),
				),
			)
			.limit(1);

		if (exactMatch) {
			return { contactId: exactMatch.contactId, confidence: "exact" };
		}
	}

	// Priority 2: Phone match (if identifier looks like a phone number).
	// Compare digits-only on BOTH sides so a WhatsApp wa_id like "393331234567"
	// links to a contact stored in E.164 form "+393331234567" instead of
	// duplicating the contact. (Postgres regexp_replace strips non-digits.)
	if (participantPlatformId && /^\+?\d{7,15}$/.test(participantPlatformId)) {
		const normalizedPhone = participantPlatformId.replace(/\D/g, "");
		const [phoneMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					sql`regexp_replace(${contacts.phone}, '\\D', '', 'g') = ${normalizedPhone}`,
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
		const [emailMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					eq(contacts.emailCanonical, email.trim().toLowerCase()),
				),
			)
			.limit(1);

		if (emailMatch) {
			return { contactId: emailMatch.id, confidence: "email" };
		}
	}

	// Priority 4: Name match (exact case-insensitive — suggestion only)
	if (participantName && participantName.length >= 2) {
		const [nameMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					sameAccountWorkspace,
					ilike(contacts.name, participantName),
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
): Promise<string | null> {
	if (!authorId) return null;

	const existing = await findMatchingContact(
		db,
		orgId,
		socialAccountId,
		authorId,
		authorName,
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
	// to contacts.phone produces a bogus phone that the phone matcher could later
	// collide against an unrelated WhatsApp/SMS participant.
	const PHONE_PLATFORMS = new Set(["whatsapp", "sms", "twilio"]);
	const phone =
		PHONE_PLATFORMS.has(platform) && /^\+?\d{7,15}$/.test(authorId)
			? authorId
			: null;

	const [created] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId: account.workspaceId,
			name: authorName ?? null,
			phone,
		})
		.returning({ id: contacts.id });
	if (!created) return null;

	await db.insert(contactChannels).values({
		organizationId: orgId,
		contactId: created.id,
		socialAccountId,
		platform: platform as typeof contactChannels.$inferInsert.platform,
		identifier: authorId,
	});

	return created.id;
}

async function ensureChannelLink(
	db: Database,
	organizationId: string,
	contactId: string,
	socialAccountId: string,
	platform: string,
	identifier: string,
): Promise<void> {
	const [relationship] = await db
		.select({ contactId: contacts.id })
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
	const existing = await db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, contactId),
			eq(contactChannels.socialAccountId, socialAccountId),
			eq(contactChannels.identifier, identifier),
		),
	});
	if (existing) return;
	try {
		await db.insert(contactChannels).values({
			organizationId,
			contactId,
			socialAccountId,
			platform: platform as typeof contactChannels.$inferInsert.platform,
			identifier,
		});
	} catch {
		// Unique index on (social_account_id, identifier) means a race with
		// another inbox event racing to link the same author can fail the
		// insert — safe to swallow; the row we wanted exists.
	}
}
