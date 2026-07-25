import {
	contactConsentEvents,
	contactConsentStates,
	contactSuppressions,
	type Database,
	ideaGroups,
	member,
	organization,
	user,
	workspaces,
} from "@relayapi/db";
import { eq } from "drizzle-orm";

type OrganizationInsert = typeof organization.$inferInsert;

function ownerUserId(organizationId: string): string {
	return `fixture_owner_${organizationId}`;
}

/**
 * Creates an active organization together with its required owner.
 *
 * The owner invariant is enforced by a deferred database constraint, so all
 * three rows must be committed in one transaction. IDs and emails are derived
 * from the organization ID to keep each fixture deterministic and isolated.
 */
export async function insertOwnedFixtureOrganization(
	db: Database,
	values: OrganizationInsert,
): Promise<void> {
	const organizationId = values.id;
	const userId = ownerUserId(organizationId);

	await db.transaction(async (tx) => {
		await tx.insert(user).values({
			id: userId,
			name: "Fixture Organization Owner",
			email: `${userId}@fixtures.relayapi.test`,
			emailVerified: true,
		});
		await tx.insert(organization).values(values);
		await tx.insert(member).values({
			id: `fixture_member_${organizationId}`,
			userId,
			organizationId,
			role: "owner",
		});
	});
}

/**
 * Deletes workspace-retained consent facts before deleting fixture workspaces.
 *
 * Consent evidence deliberately restricts workspace deletion in production.
 * Database-backed tests that exercise consent must therefore remove the
 * projection rows and immutable evidence explicitly during fixture teardown.
 */
export async function deleteOwnedFixtureWorkspaces(
	db: Database,
	organizationId: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(contactSuppressions)
			.where(eq(contactSuppressions.organizationId, organizationId));
		await tx
			.delete(contactConsentStates)
			.where(eq(contactConsentStates.organizationId, organizationId));
		await tx
			.delete(contactConsentEvents)
			.where(eq(contactConsentEvents.organizationId, organizationId));
		await tx
			.delete(workspaces)
			.where(eq(workspaces.organizationId, organizationId));
	});
}

/** Deletes the organization (cascading its member) and its fixture user. */
export async function deleteOwnedFixtureOrganization(
	db: Database,
	organizationId: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		// Organization creation provisions an organization-scoped default idea
		// group whose production FK deliberately does not cascade.
		await tx
			.delete(ideaGroups)
			.where(eq(ideaGroups.organizationId, organizationId));
		await tx.delete(organization).where(eq(organization.id, organizationId));
		await tx.delete(user).where(eq(user.id, ownerUserId(organizationId)));
	});
}
