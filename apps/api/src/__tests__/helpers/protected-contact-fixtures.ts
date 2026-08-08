import { contactChannels, generateId } from "@relayapi/db";
import {
	protectContactChannelIdentifier,
	protectContactValues,
} from "../../services/contact-protection";

export const TEST_CONTACT_ENCRYPTION_KEY = `test=${"11".repeat(32)},identity=${"12".repeat(32)}`;

export async function protectedContactFieldsFixture(
	input: {
		id: string;
		organizationId: string;
		name?: string | null;
		email?: string | null;
		phone?: string | null;
		metadata?: Record<string, unknown> | null;
	},
	keyConfig = TEST_CONTACT_ENCRYPTION_KEY,
) {
	return protectContactValues(keyConfig, input.organizationId, input.id, {
		name: input.name ?? null,
		email: input.email ?? null,
		phone: input.phone ?? null,
		metadata: input.metadata ?? null,
	});
}

export async function protectedContactFixture(
	input: Omit<
		Parameters<typeof protectedContactFieldsFixture>[0],
		"id"
	> & {
		id?: string;
		workspaceId?: string | null;
		tags?: string[];
		optedIn?: boolean;
		createdAt?: Date;
		updatedAt?: Date;
	},
	keyConfig = TEST_CONTACT_ENCRYPTION_KEY,
) {
	const id = input.id ?? generateId("ct_");
	return {
		id,
		organizationId: input.organizationId,
		...(input.workspaceId !== undefined
			? { workspaceId: input.workspaceId }
			: {}),
		...(input.tags !== undefined ? { tags: input.tags } : {}),
		...(input.optedIn !== undefined ? { optedIn: input.optedIn } : {}),
		...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
		...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
		...(await protectedContactFieldsFixture({ ...input, id }, keyConfig)),
	};
}

export async function protectedContactChannelFieldsFixture(
	input: {
		id: string;
		organizationId: string;
		identifier: string;
	},
	keyConfig = TEST_CONTACT_ENCRYPTION_KEY,
) {
	return protectContactChannelIdentifier(keyConfig, input);
}

export async function protectedContactChannelFixture(
	input: Omit<
		Parameters<typeof protectedContactChannelFieldsFixture>[0],
		"id"
	> & {
		id?: string;
		workspaceId?: string | null;
		scopeKey?: string;
		contactId: string;
		socialAccountId: string;
		platform: typeof contactChannels.$inferInsert.platform;
		createdAt?: Date;
	},
	keyConfig = TEST_CONTACT_ENCRYPTION_KEY,
) {
	const id = input.id ?? generateId("cc_");
	return {
		id,
		organizationId: input.organizationId,
		scopeKey:
			input.scopeKey ??
			(input.workspaceId ? `ws/${input.workspaceId}` : "org"),
		contactId: input.contactId,
		socialAccountId: input.socialAccountId,
		platform: input.platform,
		...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
		...(await protectedContactChannelFieldsFixture({ ...input, id }, keyConfig)),
	};
}
