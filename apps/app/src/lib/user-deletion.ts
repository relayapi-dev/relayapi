import {
	apikey,
	member,
	session as authSession,
	type createDb,
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
 * Prepare an identity for deletion before Better Auth removes auth.user.
 *
 * The database hook is shared by self-service and administrator deletion. It
 * serializes with ownership changes, refuses to orphan an organization,
 * revokes user-bound dashboard credentials, and deliberately leaves
 * organization-owned service credentials intact with nullable creator audit.
 */
export async function prepareUserDeletion(
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
		const memberships = await tx
			.select({ organizationId: member.organizationId, role: member.role })
			.from(member)
			.where(eq(member.userId, userId))
			.for("update");

		const ownedOrganizationIds = memberships
			.filter((membership) => hasRole(membership.role, "owner"))
			.map((membership) => membership.organizationId)
			.sort();

		// The same advisory-lock namespace is used for every organization in a
		// stable order, preventing delete/transfer races and cross-org deadlocks.
		for (const organizationId of ownedOrganizationIds) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`relayapi:org-owner:${organizationId}`}))`,
			);
		}

		if (ownedOrganizationIds.length > 0) {
			const ownerCandidates = await tx
				.select({
					organizationId: member.organizationId,
					userId: member.userId,
					role: member.role,
				})
				.from(member)
				.where(inArray(member.organizationId, ownedOrganizationIds))
				.for("update");

			const soleOwnerOrganizations = ownedOrganizationIds.filter(
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

		if (dashboardKeys.length > 0) {
			await tx.delete(apikey).where(
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

		await tx.delete(authSession).where(eq(authSession.userId, userId));
		return dashboardKeys;
	});

	// Better Auth has not removed the user yet. If invalidation fails, the
	// deletion aborts and can be retried while the database credentials remain
	// revoked.
	await Promise.all(
		revokedKeys.flatMap((key) => {
			const entries = [kv.delete(`apikey:${key.key}`)];
			if (key.organizationId) {
				entries.push(
					kv.delete(`dashboard-key:${key.organizationId}:${userId}`),
				);
			}
			return entries;
		}),
	);

	for (const organizationId of new Set(
		revokedKeys.flatMap((key) =>
			key.organizationId ? [key.organizationId] : [],
		),
	)) {
		clearClientCache(organizationId, userId);
	}
}
