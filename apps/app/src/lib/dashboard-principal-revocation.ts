import { apikey, session as authSession, type createDb } from "@relayapi/db";
import { and, eq, sql } from "drizzle-orm";
import { clearClientCache } from "./relay";

type Database = ReturnType<typeof createDb>;

interface KeyCache {
	delete(key: string): Promise<void>;
}

/**
 * Revoke a member's principal-bound dashboard credentials before the Better
 * Auth membership deletion commits. Both administrator removal and voluntary
 * leave therefore take effect immediately in PostgreSQL, KV, sessions, and the
 * local SDK cache.
 */
export async function revokeDashboardPrincipal(
	db: Database,
	kv: KeyCache | undefined,
	organizationId: string,
	userId: string,
): Promise<void> {
	const keys = await db.transaction(async (tx) => {
		const rows = await tx
			.select({ key: apikey.key })
			.from(apikey)
			.where(
				and(
					eq(apikey.organizationId, organizationId),
					eq(apikey.referenceId, userId),
					sql`${apikey.metadata}->>'principal_type' = 'dashboard_user'`,
				),
			);
		await tx
			.update(apikey)
			.set({ enabled: false })
			.where(
				and(
					eq(apikey.organizationId, organizationId),
					eq(apikey.referenceId, userId),
					sql`${apikey.metadata}->>'principal_type' = 'dashboard_user'`,
				),
			);
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
