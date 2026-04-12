import { eq, and, ilike } from "drizzle-orm";
import type { Database } from "@relayapi/db";
import { contacts, contactChannels } from "@relayapi/db";

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
