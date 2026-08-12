import {
	apikey,
	type createDb,
	member,
	organizationPrincipals,
} from "@relayapi/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { clearClientCache } from "./relay-client-cache";

type Database = ReturnType<typeof createDb>;

interface KeyCache {
	delete(key: string): Promise<void>;
}

/**
 * Best-effort cleanup after the database has committed a user ban. The user's
 * credential generation is the authorization boundary; this cleanup only
 * removes projections promptly and disables short-lived dashboard bearers.
 * Service credentials remain organization-owned and are reported for review.
 */
export async function containBannedDashboardUser(
	db: Database,
	kv: KeyCache | undefined,
	userId: string,
): Promise<void> {
	const result = await db.transaction(async (tx) => {
		const memberPrincipals = await tx
			.select({ id: organizationPrincipals.id })
			.from(organizationPrincipals)
			.innerJoin(
				member,
				and(
					eq(member.id, organizationPrincipals.memberId),
					eq(member.organizationId, organizationPrincipals.organizationId),
				),
			)
			.where(
				and(
					eq(organizationPrincipals.kind, "member"),
					eq(member.userId, userId),
				),
			);
		const memberPrincipalIds = memberPrincipals.map((row) => row.id);

		const dashboardKeys = await tx
			.select({
				id: apikey.id,
				keyHash: apikey.key,
				organizationId: apikey.organizationId,
			})
			.from(apikey)
			.innerJoin(
				organizationPrincipals,
				and(
					eq(organizationPrincipals.id, apikey.principalId),
					eq(
						organizationPrincipals.organizationId,
						apikey.organizationId,
					),
					eq(organizationPrincipals.kind, "member"),
				),
			)
			.innerJoin(
				member,
				and(
					eq(member.id, organizationPrincipals.memberId),
					eq(member.organizationId, organizationPrincipals.organizationId),
					eq(member.userId, userId),
				),
			);

		if (dashboardKeys.length > 0) {
			await tx
				.update(apikey)
				.set({ enabled: false, updatedAt: new Date() })
				.where(inArray(apikey.id, dashboardKeys.map((row) => row.id)));
		}

		const serviceKeys = await tx
			.select({ id: apikey.id })
			.from(apikey)
			.innerJoin(
				organizationPrincipals,
				and(
					eq(organizationPrincipals.id, apikey.principalId),
					eq(
						organizationPrincipals.organizationId,
						apikey.organizationId,
					),
					eq(organizationPrincipals.kind, "service"),
				),
			)
			.where(
				or(
					eq(apikey.referenceId, userId),
					memberPrincipalIds.length > 0
						? inArray(
								sql<string>`${apikey.metadata}->>'created_by_principal_id'`,
								memberPrincipalIds,
							)
						: sql`false`,
				),
			);

		return { dashboardKeys, serviceKeys };
	});

	const organizationIds = [
		...new Set(result.dashboardKeys.map((row) => row.organizationId)),
	];
	for (const organizationId of organizationIds) {
		clearClientCache(organizationId, userId);
	}

	if (kv) {
		const deletes = [
			...organizationIds.map((organizationId) =>
				kv.delete(`dashboard-key:${organizationId}:${userId}`),
			),
			...result.dashboardKeys.map((row) =>
				kv.delete(`apikey:${row.keyHash}`),
			),
		];
		const settled = await Promise.allSettled(deletes);
		const failed = settled.filter((entry) => entry.status === "rejected").length;
		if (failed > 0) {
			console.error(
				JSON.stringify({
					event: "banned_user_key_cache_cleanup_incomplete",
					failed_delete_count: failed,
				}),
			);
		}
	}

	console.info(
		JSON.stringify({
			event: "banned_user_credentials_contained",
			disabled_dashboard_key_count: result.dashboardKeys.length,
			attributable_service_key_count: result.serviceKeys.length,
			attributable_service_key_ids: result.serviceKeys.map((row) => row.id),
		}),
	);
}
