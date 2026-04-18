import { eq, and, ilike } from "drizzle-orm";
import type { Database } from "@relayapi/db";
import { contacts, contactChannels, socialAccounts } from "@relayapi/db";

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

	// Priority 1: Exact channel match (identifier + social account)
	if (participantPlatformId) {
		const [exactMatch] = await db
			.select({ contactId: contactChannels.contactId })
			.from(contactChannels)
			.innerJoin(contacts, eq(contacts.id, contactChannels.contactId))
			.where(
				and(
					eq(contacts.organizationId, orgId),
					eq(contactChannels.socialAccountId, accountId),
					eq(contactChannels.identifier, participantPlatformId),
				),
			)
			.limit(1);

		if (exactMatch) {
			return { contactId: exactMatch.contactId, confidence: "exact" };
		}
	}

	// Priority 2: Phone match (if identifier looks like a phone number)
	if (participantPlatformId && /^\+?\d{7,15}$/.test(participantPlatformId)) {
		const [phoneMatch] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(
				and(
					eq(contacts.organizationId, orgId),
					eq(contacts.phone, participantPlatformId),
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
					eq(contacts.email, email),
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
 * Skips creation when any of: no author id, social account missing, or the
 * social account has no workspace bound. Returns `null` in those cases so
 * callers can fall back to an anonymous enrollment.
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
		// Promote an exact match. If the match came via phone/email but no
		// channel row exists for this (platform, socialAccount, identifier),
		// link the channel now so future sends can find it without re-matching.
		await ensureChannelLink(
			db,
			existing.contactId,
			socialAccountId,
			platform,
			authorId,
		);
		return existing.contactId;
	}

	const account = await db.query.socialAccounts.findFirst({
		where: eq(socialAccounts.id, socialAccountId),
	});
	if (!account?.workspaceId) {
		// No workspace to scope the contact into — bail rather than create an
		// orphan row. The automation will enroll anonymously; downstream nodes
		// that require a contact will fail with a clear error instead of
		// silently writing to a half-initialized contact.
		return null;
	}

	const [created] = await db
		.insert(contacts)
		.values({
			organizationId: orgId,
			workspaceId: account.workspaceId,
			name: authorName ?? null,
			// Phone-shaped identifiers (e.g. WhatsApp wa_id, SMS E.164) go into
			// the contacts.phone column so condition nodes and merge tags work
			// without extra lookups.
			phone: /^\+?\d{7,15}$/.test(authorId) ? authorId : null,
		})
		.returning({ id: contacts.id });
	if (!created) return null;

	await db.insert(contactChannels).values({
		contactId: created.id,
		socialAccountId,
		platform,
		identifier: authorId,
	});

	return created.id;
}

async function ensureChannelLink(
	db: Database,
	contactId: string,
	socialAccountId: string,
	platform: string,
	identifier: string,
): Promise<void> {
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
			contactId,
			socialAccountId,
			platform,
			identifier,
		});
	} catch {
		// Unique index on (social_account_id, identifier) means a race with
		// another inbox event racing to link the same author can fail the
		// insert — safe to swallow; the row we wanted exists.
	}
}
