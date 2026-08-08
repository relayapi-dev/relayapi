import {
	apikey,
	session as authSession,
	type createDb,
	member,
	organizationPrincipals,
	principalWorkspaceGrants,
} from "@relayapi/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { clearClientCache } from "./relay-client-cache";

type Database = ReturnType<typeof createDb>;

interface KeyCache {
	delete(key: string): Promise<void>;
}

/**
 * Revoke principal-bound dashboard credentials after membership removal.
 * The authoritative absence check makes this safe even if a caller is invoked
 * for a rejected or concurrently lost owner exit.
 */
export async function revokeDashboardPrincipal(
	db: Database,
	kv: KeyCache | undefined,
	organizationId: string,
	userId: string,
): Promise<void> {
	const membershipStillExists = await db
		.select({ id: member.id })
		.from(member)
		.where(
			and(eq(member.organizationId, organizationId), eq(member.userId, userId)),
		)
		.limit(1);
	if (membershipStillExists.length > 0) return;

	const keys = await db.transaction(async (tx) => {
		const rows = await tx
			.select({ key: apikey.key, principalId: apikey.principalId })
			.from(apikey)
			.where(
				and(
					eq(apikey.organizationId, organizationId),
					eq(apikey.referenceId, userId),
					sql`EXISTS (
						SELECT 1
						FROM ${organizationPrincipals} AS principal_row
						WHERE principal_row.id = ${apikey.principalId}
							AND principal_row.organization_id = ${apikey.organizationId}
							AND principal_row.kind = 'member'
					)`,
				),
			);
		if (rows.length > 0) {
			await tx
				.update(apikey)
				.set({ enabled: false })
				.where(
					and(
						eq(apikey.organizationId, organizationId),
						eq(apikey.referenceId, userId),
						sql`EXISTS (
							SELECT 1
							FROM ${organizationPrincipals} AS principal_row
							WHERE principal_row.id = ${apikey.principalId}
								AND principal_row.organization_id = ${apikey.organizationId}
								AND principal_row.kind = 'member'
						)`,
					),
				);
			const principalIds = [...new Set(rows.map((row) => row.principalId))];
			await tx
				.delete(principalWorkspaceGrants)
				.where(
					and(
						eq(principalWorkspaceGrants.organizationId, organizationId),
						inArray(principalWorkspaceGrants.principalId, principalIds),
					),
				);
			await tx
				.update(organizationPrincipals)
				.set({
					lifecycleStatus: "disabled",
					disabledAt: new Date(),
					updatedAt: new Date(),
					memberId: null,
				})
				.where(
					and(
						eq(organizationPrincipals.organizationId, organizationId),
						inArray(organizationPrincipals.id, principalIds),
						eq(organizationPrincipals.kind, "member"),
					),
				);
		}
		await tx
			.update(authSession)
			.set({ activeOrganizationId: null, updatedAt: new Date() })
			.where(
				and(
					eq(authSession.userId, userId),
					eq(authSession.activeOrganizationId, organizationId),
				),
			);
		return rows;
	});

	if (kv) {
		await Promise.all([
			kv.delete(`dashboard-key:${organizationId}:${userId}`),
			...keys.map((key) => kv.delete(`apikey:${key.key}`)),
		]);
	}
	clearClientCache(organizationId, userId);
}
