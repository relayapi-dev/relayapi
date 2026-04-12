import { createDb, socialAccounts } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import { maybeDecrypt } from "./crypto";

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
			and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)),
		)
		.limit(1);
	if (!account) return null;
	return {
		...account,
		accessToken: await maybeDecrypt(account.accessToken, encryptionKey),
		refreshToken: await maybeDecrypt(account.refreshToken, encryptionKey),
	};
}
