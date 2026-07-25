import {
	account,
	apikey,
	session as authSession,
	type createDb,
	inviteTokens,
	media,
	member,
	organization,
	posts,
	user,
} from "@relayapi/db";
import { APIError } from "better-auth/api";
import { and, eq, inArray, sql } from "drizzle-orm";
import { clearClientCache } from "./relay";

type Database = ReturnType<typeof createDb>;

interface KeyCache {
	delete(key: string): Promise<void>;
}

function hasRole(value: string, role: string): boolean {
	return value
		.split(",")
		.map((item) => item.trim())
		.includes(role);
}

/**
 * Delete an identity from the database as one atomic operation.
 *
 * Better Auth invokes this from its first session/account/user delete.before
 * hook and skips its later non-transactional child deletes. Holding the user
 * row lock prevents new principal-bound API keys once the reference FK exists;
 * KV invalidation happens before any database mutation, so a KV failure rolls
 * the transaction back without locking out a surviving user.
 */
export async function deleteUserAtomically(
	db: Database,
	kv: KeyCache | undefined,
	userId: string,
): Promise<void> {
	if (!kv) {
		throw new APIError("SERVICE_UNAVAILABLE", {
			code: "IDENTITY_DELETION_UNAVAILABLE",
			message: "Identity deletion is temporarily unavailable.",
		});
	}

	const revokedKeys = await db.transaction(async (tx) => {
		const deletingUsers = await tx
			.select({ id: user.id })
			.from(user)
			.where(eq(user.id, userId))
			.limit(1)
			.for("update");
		if (deletingUsers.length === 0) return [];

		const memberships = await tx
			.select({ organizationId: member.organizationId, role: member.role })
			.from(member)
			.where(eq(member.userId, userId))
			.for("update");

		const ownedOrganizationIds = memberships
			.filter((membership) => hasRole(membership.role, "owner"))
			.map((membership) => membership.organizationId)
			.sort();

		// PostgreSQL has already locked this identity's member tuples. Acquire the
		// shared owner-advisory locks next, in a stable order, and organization
		// rows last. Tenant erasure and the member invariant use the same
		// universally enforceable member -> advisory -> organization order.
		for (const organizationId of ownedOrganizationIds) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`relayapi:org-owner:${organizationId}`}))`,
			);
		}

		if (ownedOrganizationIds.length > 0) {
			const activeOrganizations = await tx
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						inArray(organization.id, ownedOrganizationIds),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.for("share");
			const activeOwnedOrganizationIds = activeOrganizations.map(
				(row) => row.id,
			);

			if (activeOwnedOrganizationIds.length > 0) {
				const ownerCandidates = await tx
					.select({
						organizationId: member.organizationId,
						userId: member.userId,
						role: member.role,
					})
					.from(member)
					.where(inArray(member.organizationId, activeOwnedOrganizationIds));

				const soleOwnerOrganizations = activeOwnedOrganizationIds.filter(
					(organizationId) =>
						ownerCandidates.filter(
							(candidate) =>
								candidate.organizationId === organizationId &&
								hasRole(candidate.role, "owner"),
						).length <= 1,
				);

				if (soleOwnerOrganizations.length > 0) {
					throw new APIError("CONFLICT", {
						code: "SOLE_ORGANIZATION_OWNER",
						message:
							"Transfer ownership or delete the organization before deleting this user.",
						details: { organization_ids: soleOwnerOrganizations },
					});
				}
			}
		}

		const principalKeys = await tx
			.select({
				id: apikey.id,
				key: apikey.key,
				organizationId: apikey.organizationId,
				metadata: apikey.metadata,
			})
			.from(apikey)
			.where(eq(apikey.referenceId, userId))
			.for("update");

		const dashboardKeys = principalKeys.filter((row) => {
			const metadata = row.metadata as Record<string, unknown> | null;
			return metadata?.principal_type === "dashboard_user";
		});

		// Keep every database row intact until all external invalidations succeed.
		// A partial KV failure is safe: invalidated entries can be repopulated from
		// the still-authoritative database and the transaction commits no writes.
		await Promise.all(
			dashboardKeys.flatMap((key) => {
				const entries = [kv.delete(`apikey:${key.key}`)];
				if (key.organizationId) {
					entries.push(
						kv.delete(`dashboard-key:${key.organizationId}:${userId}`),
					);
				}
				return entries;
			}),
		);

		if (dashboardKeys.length > 0) {
			await tx
				.delete(apikey)
				.where(
					and(
						eq(apikey.referenceId, userId),
						sql`${apikey.metadata}->>'principal_type' = 'dashboard_user'`,
					),
				);
		}

		// A non-dashboard key is organization-owned. Detach only its creator
		// attribution so the service integration survives the user's departure.
		await tx
			.update(apikey)
			.set({ referenceId: null, updatedAt: new Date() })
			.where(eq(apikey.referenceId, userId));

		// Preserve durable content while removing or anonymizing user attribution.
		// These writes also make deletion safe before the reinforcing FK migration
		// has reached every environment.
		await tx.delete(inviteTokens).where(eq(inviteTokens.createdBy, userId));
		await tx
			.update(inviteTokens)
			.set({ usedBy: null })
			.where(eq(inviteTokens.usedBy, userId));
		await tx
			.update(media)
			.set({ uploadedBy: null })
			.where(eq(media.uploadedBy, userId));
		await tx
			.update(posts)
			.set({ createdBy: null })
			.where(eq(posts.createdBy, userId));

		// Better Auth normally issues these as separate committed statements. Keep
		// them in this transaction so a later FK or owner-invariant failure restores
		// the complete login identity.
		await tx.delete(authSession).where(eq(authSession.userId, userId));
		await tx.delete(account).where(eq(account.userId, userId));
		await tx.delete(user).where(eq(user.id, userId));
		return dashboardKeys;
	});

	for (const organizationId of new Set(
		revokedKeys.flatMap((key) =>
			key.organizationId ? [key.organizationId] : [],
		),
	)) {
		clearClientCache(organizationId, userId);
	}
}
