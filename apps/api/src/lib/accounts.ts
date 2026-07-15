import { type createDb, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { decryptAccountTokens } from "./account-token-crypto";

/**
 * Fetches a social account owned by the given org, with decrypted tokens.
 * Returns null if account not found or doesn't belong to the org.
 */
export async function getOwnedAccount(
	db: ReturnType<typeof createDb>,
	id: string,
	orgId: string,
	encryptionKey?: string,
) {
	const [account] = await db
		.select()
		.from(socialAccounts)
		.where(
			and(
				eq(socialAccounts.id, id),
				eq(socialAccounts.organizationId, orgId),
				eq(socialAccounts.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (!account) return null;
	return decryptAccountTokens(account, encryptionKey);
}
