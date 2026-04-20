import { contactChannels } from "@relayapi/db";
import type { Database } from "@relayapi/db";
import { and, eq } from "drizzle-orm";

export async function findScopedContactChannel(
	db: Database,
	input: {
		contactId: string;
		platform: string;
		socialAccountId: string;
	},
) {
	return db.query.contactChannels.findFirst({
		where: and(
			eq(contactChannels.contactId, input.contactId),
			eq(contactChannels.platform, input.platform),
			eq(contactChannels.socialAccountId, input.socialAccountId),
		),
	});
}
